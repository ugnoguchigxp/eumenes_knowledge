import {
	CONTRACT_VERSION,
	KnowledgeError,
	RELATED_LIMITS,
	relatedPartialReasons,
	relatedRequestSchema,
	relatedResponseSchema,
	type ReadRelated,
	type RelatedResponse,
	type RelatedRoute,
	type Tx,
	type VectorIndex,
} from "../../contracts/index.js";
import { readGraphDocumentsInSnapshot } from "../../sqlite/graph.js";
import {
	MAX_CLUSTER_MEMBERS,
	MAX_RELATED_STARTS,
	MAX_SUMMARY_MEMBERS,
	clusterDigest,
	countUncomparedVersionsInSnapshot,
	countVersionsWithFailedMentionsInSnapshot,
	hasUnsureLinkInSnapshot,
	listLinkedMentionIdsInSnapshot,
	readEntityEvidenceInSnapshot,
	readSameClusterInTransaction,
	readSummaryInSnapshot,
	type Cluster,
	type ClusterMember,
	type SameLink,
} from "../../sqlite/links.js";
import {
	countScopeFragmentsInSnapshot,
	listFragmentOrdinalsInSnapshot,
	readFragmentPointsInSnapshot,
	readVersionSpaceInSnapshot,
	readVersionVectorsInSnapshot,
} from "../../sqlite/reads.js";
import {
	readEvidenceTargetInSnapshot,
	readSearchCoverageInSnapshot,
} from "../../sqlite/search.js";
import { searchVectorIndexInSnapshot } from "../search/vector-index.js";

type Reason = RelatedResponse["partialReasons"][number];
type Result = RelatedResponse["results"][number];
type Shared = Result["shared"][number];

/** Reciprocal rank fusion constant (kg.md §9.3, `scripts/kg-alt.ts`). */
const RRF_K = 60;

/**
 * Documents related to one document (p3.md §8, kg2.md §3.5). Everything is read from one
 * snapshot and nothing is written.
 *
 * What a caller sees: only documents in its namespaces (narrowed by `request.namespaces`) that
 * are `current` (or `unverified`, derived from the last verification).
 *
 * How they are found: for every fragment of the requested document (at most
 * `RELATED_LIMITS.fragmentsPerDocument`; more is `response_truncated`), the fragments of the
 * other documents are ranked by the routes `request.routes` names (default both) and the
 * rankings are fused (reciprocal rank fusion, k = 60), as kg.md §9.3 measured:
 * - `entities`: fragments that name an entity this fragment names, by the sum of the shared
 *   entities' IDF over the fragments in scope (a name in every fragment weighs nothing; a cluster
 *   cut at its cap, a name of more than 500 mentions, weighs nothing either), at most
 *   `RELATED_LIMITS.nearestPerFragment` per fragment. Entities are the clusters of `same` links
 *   and identity keys among current mentions (a key joins the mentions of one namespace with the
 *   same model-free key, kg2.md §3.3; `decidedBy` names it `name_key`). A cluster is read through
 *   mentions the caller may read alone (the limit of 500 mentions counts only those), so a
 *   mention outside the caller's namespaces never connects two readable ones and its number shows
 *   nowhere. The search starts from the requested document's mentions that have a `same` link or
 *   a key another document has (at most `MAX_RELATED_STARTS`; more is `response_truncated`).
 * - `embedding`: when the host passes its vector index (`deps.vectors`; without it the route is
 *   off), the nearest fragments by that index (`RELATED_LIMITS.nearestPerFragment` per
 *   fragment), without a threshold. An index that cannot run, a document without vectors, or
 *   documents of another embedding space in scope give `vector_unavailable`.
 * Documents that share an entity come first, then those the embedding alone found; within each,
 * a document's place is its best pair of fragments, equal scores by document id. Documents that
 * share only names of IDF 0 come after the other documents that share entities. Each result
 * lists its best pairs (`passages`) and the routes that found any of its pairs.
 *
 * Shared entities: one per (cluster component, other document), the most specific first. The pair
 * of mentions shown is chosen by a fixed rule, because the contract carries one pair and one
 * provenance:
 * - The requested document's side is its mention with the smallest id in the component.
 * - The other document's side is its mention nearest to that one in the `same` links
 *   (fewest links on the shortest path), the smallest id breaking ties.
 * - `decidedBy` is the provenance of the first link on that shortest path. For two mentions
 *   joined directly it is that link's own judgment; for a longer path the pair is joined only
 *   through other mentions, and the first link is the one that tied the requested document's
 *   mention to the chain.
 * A summary is returned only when every mention of the entity's whole cluster is current and
 * readable by the caller and the summary was made for exactly that cluster (of stored links).
 */
export const readRelated: ReadRelated = (deps, access, request) => {
	const parsed = relatedRequestSchema.safeParse(request);
	if (!parsed.success) throw new KnowledgeError("invalid_input");
	const req = parsed.data;
	const verifiedWithinMs = deps.options.verifiedWithinMs;
	if (
		typeof verifiedWithinMs !== "number" ||
		!Number.isFinite(verifiedWithinMs) ||
		verifiedWithinMs < 0 ||
		!Array.isArray(access?.namespaces)
	) {
		throw new KnowledgeError("invalid_input");
	}
	const scope = req.namespaces
		? access.namespaces.filter((n) => req.namespaces?.includes(n))
		: [...access.namespaces];
	const routes = new Set(req.routes ?? ["entities", "embedding"]);
	const response = deps.read((db) =>
		compute(db, {
			documentId: req.documentId,
			limit: req.limit,
			scope: [...new Set(scope)],
			now: deps.clock.now(),
			verifiedWithinMs,
			maxUnappliedAttempts: deps.options.maxUnappliedAttempts,
			vectors: routes.has("embedding") ? (deps.vectors ?? null) : null,
			entities: routes.has("entities"),
		}),
	);
	const checked = relatedResponseSchema.safeParse(response);
	if (!checked.success) throw new KnowledgeError("contract_mismatch");
	return checked.data;
};

type Params = {
	documentId: string;
	limit: number;
	scope: string[];
	now: number;
	verifiedWithinMs: number;
	maxUnappliedAttempts: number | undefined;
	vectors: VectorIndex | null;
	/** Whether the `entities` route is used (`request.routes`). */
	entities: boolean;
};

/** One fragment of another document, as ranked for one fragment of the requested document. */
export type RelatedFragment = {
	versionId: number;
	ordinal: number;
	/** The fused score (reciprocal rank fusion of the routes below). */
	score: number;
	routes: RelatedRoute[];
};

type Ref = { versionId: number; ordinal: number };
const refKey = (r: Ref): string => `${r.versionId}:${r.ordinal}`;

/** A shared entity before its quotations are read (only the shown ones are). */
type SharedCandidate = {
	idf: number;
	order: number;
	mine: ClusterMember;
	other: ClusterMember;
	decidedBy: Shared["decidedBy"];
	summary: string | null;
};

type Relation = {
	rankings: Map<number, RelatedFragment[]>;
	shared: Map<string, SharedCandidate[]>;
	/**
	 * Fragment pairs joined only by entities of IDF 0: they rank nothing, but a document that shares
	 * only such an entity is still related (after the documents that share more).
	 */
	weak: Map<number, { mine: number; other: Ref }[]>;
	truncated: boolean;
	vectorUnavailable: boolean;
};

/**
 * What the routes find for one version's fragments: the fused ranking of the other documents'
 * fragments for each compared fragment, the shared entities per other document, and whether
 * anything was cut.
 */
function relate(
	db: Tx,
	versionId: number,
	documentId: string,
	scopeList: readonly string[],
	vectors: VectorIndex | null,
	entities = true,
): Relation {
	const scope = new Set(scopeList);
	const allOrdinals = listFragmentOrdinalsInSnapshot(db, versionId);
	const compared = allOrdinals.slice(0, RELATED_LIMITS.fragmentsPerDocument);
	const comparedSet = new Set(compared);
	let truncated = allOrdinals.length > compared.length;
	const fragmentsInScope = countScopeFragmentsInSnapshot(db, scopeList);

	// --- Route `entities`: clusters of the requested document's mentions.
	const nodeScores = new Map<number, Map<string, number>>(
		compared.map((o) => [o, new Map()]),
	);
	const weak = new Map<number, { mine: number; other: Ref }[]>();
	const starts = entities
		? listLinkedMentionIdsInSnapshot(db, versionId, MAX_RELATED_STARTS)
		: { entityIds: [], truncated: false };
	if (starts.truncated) truncated = true;
	const shared = new Map<string, SharedCandidate[]>();
	const handled = new Set<number>();
	const clusters = new Map<number, Cluster>();
	let order = 0;
	for (const startId of starts.entityIds) {
		if (handled.has(startId)) continue;
		let cluster = clusters.get(startId);
		if (!cluster) {
			cluster = readSameClusterInTransaction(
				db,
				startId,
				MAX_CLUSTER_MEMBERS,
				scopeList,
			);
			if (!cluster.truncated) {
				for (const m of cluster.members) clusters.set(m.entityId, cluster);
			}
		}
		if (cluster.truncated) truncated = true;
		if (cluster.members.length < 2) continue;
		const readable = cluster.members.filter((m) => scope.has(m.namespace));
		const readableIds = new Set(readable.map((m) => m.entityId));
		const adjacency = new Map<number, { other: number; link: SameLink }[]>();
		for (const link of cluster.links) {
			if (!readableIds.has(link.a) || !readableIds.has(link.b)) continue;
			for (const [from, to] of [
				[link.a, link.b],
				[link.b, link.a],
			] as const) {
				const list = adjacency.get(from);
				if (list) list.push({ other: to, link });
				else adjacency.set(from, [{ other: to, link }]);
			}
		}
		for (const list of adjacency.values())
			list.sort((x, y) => x.other - y.other);

		// Breadth first from the requested document's mention: distance and the first link.
		const reach = new Map<number, { distance: number; first: SameLink | null }>(
			[[startId, { distance: 0, first: null }]],
		);
		const queue = [startId];
		for (let i = 0; i < queue.length; i++) {
			const from = queue[i] as number;
			const at = reach.get(from) as {
				distance: number;
				first: SameLink | null;
			};
			for (const { other, link } of adjacency.get(from) ?? []) {
				if (reach.has(other)) continue;
				reach.set(other, {
					distance: at.distance + 1,
					first: at.first ?? link,
				});
				queue.push(other);
			}
		}
		const reached = readable.filter((m) => reach.has(m.entityId));

		// The entity's IDF over the fragments in scope, and the fragment pairs it makes. A cluster
		// cut at its cap is a name of very many mentions: its IDF is taken as 0, not as that of the
		// part that was read.
		const fragmentsOf = new Map<string, Ref>();
		for (const m of reached) {
			const ref = { versionId: m.versionId, ordinal: m.fragmentOrdinal };
			fragmentsOf.set(refKey(ref), ref);
		}
		const idf = cluster.truncated
			? 0
			: Math.max(0, Math.log(fragmentsInScope / Math.max(1, fragmentsOf.size)));
		const mine = new Set(
			reached
				.filter((m) => m.versionId === versionId)
				.map((m) => m.fragmentOrdinal)
				.filter((o) => comparedSet.has(o)),
		);
		for (const o of [...mine].sort((x, y) => x - y)) {
			const scores = nodeScores.get(o) as Map<string, number>;
			for (const [key, ref] of fragmentsOf) {
				if (ref.versionId === versionId) continue;
				if (idf > 0) scores.set(key, (scores.get(key) ?? 0) + idf);
				else {
					const list = weak.get(ref.versionId) ?? [];
					list.push({ mine: o, other: ref });
					weak.set(ref.versionId, list);
				}
			}
		}

		const byId = new Map(readable.map((m) => [m.entityId, m] as const));
		const best = new Map<string, ClusterMember>();
		for (const id of [...reach.keys()].sort((x, y) => x - y)) {
			const member = byId.get(id) as ClusterMember;
			if (member.documentId === documentId) {
				handled.add(id);
				continue;
			}
			const current = best.get(member.documentId);
			if (
				!current ||
				(reach.get(id) as { distance: number }).distance <
					(reach.get(current.entityId) as { distance: number }).distance
			) {
				best.set(member.documentId, member);
			}
		}
		if (best.size === 0) continue;

		// The summary needs the whole cluster of stored links, outside the caller's namespaces
		// too, but only whether it is the same set shows: a summary is made for clusters of at most
		// `MAX_SUMMARY_MEMBERS` mentions, so a larger one has none and is not read further.
		let summary: string | null = null;
		if (!cluster.truncated) {
			const whole = readSameClusterInTransaction(
				db,
				startId,
				MAX_SUMMARY_MEMBERS + 1,
				undefined,
				{ keys: false },
			);
			const ids = whole.members.map((m) => m.entityId);
			const own = new Set(cluster.members.map((m) => m.entityId));
			if (
				!whole.truncated &&
				ids.length === own.size &&
				ids.every((id) => own.has(id))
			) {
				summary =
					readSummaryInSnapshot(db, ids[0] as number, clusterDigest(ids))
						?.summary ?? null;
			}
		}
		const mineMember = byId.get(startId) as ClusterMember;
		for (const other of [...best.values()].sort(
			(x, y) => x.entityId - y.entityId,
		)) {
			const first = (reach.get(other.entityId) as { first: SameLink }).first;
			const list = shared.get(other.documentId) ?? [];
			list.push({
				idf,
				order: order++,
				mine: mineMember,
				other,
				decidedBy: {
					model: first.provenance.model,
					instructionId: first.provenance.instructionId,
					instructionVersion: first.provenance.instructionVersion,
				},
				summary,
			});
			shared.set(other.documentId, list);
		}
	}

	// --- Route `embedding`: the nearest fragments by the search's index.
	const nearest = new Map<number, Ref[]>();
	let vectorUnavailable = false;
	if (vectors) {
		const space = readVersionSpaceInSnapshot(db, versionId);
		const own = space
			? readVersionVectorsInSnapshot(db, versionId, space.key)
			: [];
		if (!space || own.length === 0) vectorUnavailable = true;
		for (const v of own) {
			if (!comparedSet.has(v.ordinal)) continue;
			const found = searchVectorIndexInSnapshot(
				vectors,
				db,
				space as { key: string; dimension: number },
				v.vector,
				scopeList,
				RELATED_LIMITS.nearestPerFragment,
				versionId,
			);
			if (!found.ok) {
				vectorUnavailable = true;
				break;
			}
			// Some fragments in scope are of another embedding space: the route did not see them.
			if (found.scored < fragmentsInScope) vectorUnavailable = true;
			nearest.set(v.ordinal, found.refs);
		}
	}

	// --- Fusion, per fragment of the requested document. Equal scores keep path, then ordinal.
	const versions = new Set<number>();
	for (const scores of nodeScores.values())
		for (const key of scores.keys()) versions.add(Number(key.split(":")[0]));
	for (const refs of nearest.values())
		for (const r of refs) versions.add(r.versionId);
	const pathOf = new Map(
		readGraphDocumentsInSnapshot(db, [...versions])
			.filter((d) => scope.has(d.namespace))
			.map((d) => [d.versionId, d.path]),
	);
	const tie = (a: Ref, b: Ref): number => {
		const pa = pathOf.get(a.versionId) ?? "";
		const pb = pathOf.get(b.versionId) ?? "";
		return pa < pb ? -1 : pa > pb ? 1 : a.ordinal - b.ordinal;
	};
	const rankings = new Map<number, RelatedFragment[]>();
	for (const o of compared) {
		const fused = new Map<string, RelatedFragment>();
		const add = (r: Ref, rank: number, route: RelatedRoute) => {
			if (!pathOf.has(r.versionId)) return;
			const key = refKey(r);
			const entry = fused.get(key) ?? { ...r, score: 0, routes: [] };
			entry.score += 1 / (RRF_K + rank + 1);
			entry.routes.push(route);
			fused.set(key, entry);
		};
		const byNodes = [...(nodeScores.get(o) as Map<string, number>)]
			.map(([key, s]) => {
				const [v, ord] = key.split(":").map(Number) as [number, number];
				return { versionId: v, ordinal: ord, s };
			})
			.sort((x, y) => y.s - x.s || tie(x, y))
			.slice(0, RELATED_LIMITS.nearestPerFragment);
		byNodes.forEach((r, rank) => add(r, rank, "entities"));
		(nearest.get(o) ?? []).forEach((r, rank) => add(r, rank, "embedding"));
		rankings.set(
			o,
			[...fused.values()].sort((x, y) => y.score - x.score || tie(x, y)),
		);
	}
	return { rankings, shared, weak, truncated, vectorUnavailable };
}

/**
 * The fused ranking of the other documents' fragments for every compared fragment of one
 * published version (kg2.md §3.5; what `readRelated` orders documents by). For evaluation:
 * `scripts/kg-alt.ts` scores it with the measures of kg.md §9.3.
 */
export function rankRelatedFragmentsInSnapshot(
	db: Tx,
	versionId: number,
	documentId: string,
	scope: readonly string[],
	vectors: VectorIndex | null,
): Map<number, RelatedFragment[]> {
	return relate(db, versionId, documentId, scope, vectors).rankings;
}

function compute(db: Tx, p: Params): RelatedResponse {
	const base = () => ({
		contractVersion: CONTRACT_VERSION as 1,
		document: null,
		results: [] as Result[],
	});
	const target = readEvidenceTargetInSnapshot(db, p.documentId, p.scope);
	if (!target) {
		return {
			...base(),
			status: "not_available",
			complete: false,
			partialReasons: [],
		};
	}
	if (target.state !== "current" || !target.published) {
		return {
			...base(),
			status: "stale",
			complete: false,
			partialReasons: [
				target.state === "stale" ? "stale_documents" : "unavailable_documents",
			],
		};
	}
	const published = target.published;
	const found = relate(
		db,
		published.versionId,
		p.documentId,
		p.scope,
		p.vectors,
		p.entities,
	);

	// Documents by their best pair of fragments.
	type Pair = { mine: number; other: RelatedFragment };
	const pairsOf = new Map<number, Pair[]>();
	for (const [mine, list] of found.rankings)
		for (const other of list) {
			const pairs = pairsOf.get(other.versionId) ?? [];
			pairs.push({ mine, other });
			pairsOf.set(other.versionId, pairs);
		}
	// A document joined only by entities of IDF 0 comes after the ranked ones (score 0).
	for (const [v, list] of found.weak) {
		if (pairsOf.has(v)) continue;
		const seen = new Set<string>();
		const pairs: Pair[] = [];
		for (const w of list) {
			const key = `${w.mine}:${refKey(w.other)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push({
				mine: w.mine,
				other: { ...w.other, score: 0, routes: ["entities"] },
			});
		}
		pairsOf.set(v, pairs);
	}
	const scope = new Set(p.scope);
	const documents = new Map(
		readGraphDocumentsInSnapshot(db, [...pairsOf.keys()])
			.filter((d) => scope.has(d.namespace))
			.map((d) => [d.versionId, d]),
	);
	const ranked = [...pairsOf]
		.filter(([v]) => documents.has(v))
		.map(([v, pairs]) => {
			const sorted = [...pairs].sort(
				(x, y) =>
					y.other.score - x.other.score ||
					x.mine - y.mine ||
					x.other.ordinal - y.other.ordinal,
			);
			return {
				versionId: v,
				pairs: sorted,
				best: sorted[0]?.other.score ?? 0,
				byEntities: sorted.some((x) => x.other.routes.includes("entities")),
			};
		})
		.sort((x, y) => {
			const dx = documents.get(x.versionId)?.documentId ?? "";
			const dy = documents.get(y.versionId)?.documentId ?? "";
			return (
				Number(y.byEntities) - Number(x.byEntities) ||
				y.best - x.best ||
				(dx < dy ? -1 : dx > dy ? 1 : 0)
			);
		})
		.slice(0, p.limit);

	const shownPairs = ranked.flatMap((r) =>
		r.pairs.slice(0, RELATED_LIMITS.passagesPerResult),
	);
	const points = new Map(
		readFragmentPointsInSnapshot(db, [
			...shownPairs.map((x) => ({
				versionId: published.versionId,
				ordinal: x.mine,
			})),
			...shownPairs.map((x) => ({
				versionId: x.other.versionId,
				ordinal: x.other.ordinal,
			})),
		]).map((f) => [refKey(f), f]),
	);
	const pointOf = (versionId: number, ordinal: number) => {
		const f = points.get(refKey({ versionId, ordinal }));
		if (!f) throw new KnowledgeError("contract_mismatch");
		return {
			fragmentOrdinal: f.ordinal,
			byteStart: f.byteStart,
			byteEnd: f.byteEnd,
			quoteSha256: f.quoteSha256,
		};
	};
	const routeOrder = (routes: Iterable<RelatedRoute>): RelatedRoute[] => {
		const set = new Set(routes);
		return (["entities", "embedding"] as const).filter((r) => set.has(r));
	};
	const results: Result[] = ranked.map((r, i) => {
		const d = documents.get(r.versionId) as NonNullable<
			ReturnType<typeof documents.get>
		>;
		// Quotations are read for the shown entities only.
		const shared: Shared[] = (found.shared.get(d.documentId) ?? [])
			.sort((x, y) => y.idf - x.idf || x.order - y.order)
			.slice(0, RELATED_LIMITS.sharedPerResult)
			.map((s) => ({
				label: s.mine.name,
				relatedLabel: s.other.name,
				evidence: {
					document: readEntityEvidenceInSnapshot(db, s.mine.entityId),
					related: readEntityEvidenceInSnapshot(db, s.other.entityId),
				},
				decidedBy: s.decidedBy,
				summary: s.summary,
			}));
		return {
			rank: i + 1,
			documentId: d.documentId,
			namespace: d.namespace,
			path: d.path,
			title: d.title,
			markdownSha256: d.markdownSha256,
			state:
				d.lastVerifiedAt === null ||
				d.lastVerifiedAt < p.now - p.verifiedWithinMs
					? "unverified"
					: "current",
			routes: routeOrder(r.pairs.flatMap((x) => x.other.routes)),
			passages: r.pairs.slice(0, RELATED_LIMITS.passagesPerResult).map((x) => ({
				document: pointOf(published.versionId, x.mine),
				related: pointOf(x.other.versionId, x.other.ordinal),
				routes: routeOrder(x.other.routes),
			})),
			shared,
		};
	});

	const reasons = new Set<Reason>();
	const registry = readSearchCoverageInSnapshot(db, p.scope, p.now, {
		verifiedWithinMs: p.verifiedWithinMs,
		maxUnappliedAttempts: p.maxUnappliedAttempts,
	});
	for (const r of registry.partialReasons) reasons.add(r);
	if (countUncomparedVersionsInSnapshot(db, p.scope) > 0) {
		reasons.add("linking_pending");
	}
	if (
		hasUnsureLinkInSnapshot(db, p.scope) ||
		countVersionsWithFailedMentionsInSnapshot(db, p.scope) > 0
	) {
		reasons.add("linking_unsure");
	}
	if (found.truncated) reasons.add("response_truncated");
	if (found.vectorUnavailable) reasons.add("vector_unavailable");
	const partialReasons = relatedPartialReasons.filter((r) => reasons.has(r));
	return {
		contractVersion: CONTRACT_VERSION,
		status: "ok",
		document: {
			documentId: p.documentId,
			markdownSha256: published.markdownSha256,
		},
		results,
		complete: partialReasons.length === 0,
		partialReasons,
	};
}
