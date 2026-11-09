import {
	CONTRACT_VERSION,
	KnowledgeError,
	relatedPartialReasons,
	relatedRequestSchema,
	relatedResponseSchema,
	type ReadRelated,
	type RelatedResponse,
	type Tx,
} from "../../contracts/index.js";
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
	readEvidenceTargetInSnapshot,
	readSearchCoverageInSnapshot,
} from "../../sqlite/search.js";

type Reason = RelatedResponse["partialReasons"][number];
type Result = RelatedResponse["results"][number];
type Shared = Result["shared"][number];

/**
 * Documents that share entities with one document (p3.md §8). Everything is read from one
 * snapshot and nothing is written.
 *
 * What a caller sees: only documents in its namespaces (narrowed by `request.namespaces`) that
 * are `current` (or `unverified`, derived from the last verification). Entities are the
 * clusters of `same` links and identity keys among current mentions (a key joins the mentions of
 * one namespace with the same model-free key, kg2.md §3.3; `decidedBy` names it `name_key`). A
 * cluster is read through mentions the
 * caller may read alone (the limit of 500 mentions counts only those), so a mention outside the
 * caller's namespaces never connects two readable ones and its number shows nowhere. The
 * search starts from the requested document's mentions that have a `same` link or a key another
 * document has (at most
 * `MAX_RELATED_STARTS`; more is `response_truncated`). A summary is returned only when every
 * mention of the entity's whole cluster is current and readable by the caller and the summary
 * was made for exactly that cluster.
 *
 * One shared entity per (cluster component, other document). The pair of mentions shown is
 * chosen by a fixed rule, because the contract carries one pair and one provenance:
 * - The requested document's side is its mention with the smallest id in the component.
 * - The other document's side is its mention nearest to that one in the `same` links
 *   (fewest links on the shortest path), the smallest id breaking ties.
 * - `decidedBy` is the provenance of the first link on that shortest path. For two mentions
 *   joined directly it is that link's own judgment; for a longer path the pair is joined only
 *   through other mentions, and the first link is the one that tied the requested document's
 *   mention to the chain.
 * The order of documents is the number of shared entities (a count, not a measure of truth),
 * then the document id.
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
	const response = deps.read((db) =>
		compute(db, {
			documentId: req.documentId,
			limit: req.limit,
			scope: [...new Set(scope)],
			now: deps.clock.now(),
			verifiedWithinMs,
			maxUnappliedAttempts: deps.options.maxUnappliedAttempts,
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
};

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
	const scope = new Set(p.scope);
	const published = target.published;
	const starts = listLinkedMentionIdsInSnapshot(
		db,
		published.versionId,
		MAX_RELATED_STARTS,
	);

	const docs = new Map<string, { member: ClusterMember; shared: Shared[] }>();
	const handled = new Set<number>();
	const clusters = new Map<number, Cluster>();
	let truncated = starts.truncated;

	for (const startId of starts.entityIds) {
		if (handled.has(startId)) continue;
		const mention = { entityId: startId };
		let cluster = clusters.get(mention.entityId);
		if (!cluster) {
			cluster = readSameClusterInTransaction(
				db,
				mention.entityId,
				MAX_CLUSTER_MEMBERS,
				p.scope,
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
			[[mention.entityId, { distance: 0, first: null }]],
		);
		const queue = [mention.entityId];
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
		const byId = new Map(readable.map((m) => [m.entityId, m] as const));
		const best = new Map<string, ClusterMember>();
		for (const id of [...reach.keys()].sort((x, y) => x - y)) {
			const member = byId.get(id) as ClusterMember;
			if (member.documentId === p.documentId) {
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

		// The summary needs the whole cluster, outside the caller's namespaces too, but only
		// whether it is the same set shows: a summary is made for clusters of at most
		// `MAX_SUMMARY_MEMBERS` mentions, so a larger one has none and is not read further.
		let summary: string | null = null;
		if (!cluster.truncated) {
			// Summaries are made for clusters of stored links: one a key join made larger has none.
			const whole = readSameClusterInTransaction(
				db,
				mention.entityId,
				MAX_SUMMARY_MEMBERS + 1,
				undefined,
				{ keys: false },
			);
			if (!whole.truncated && whole.members.length === cluster.members.length) {
				const ids = whole.members.map((m) => m.entityId);
				summary =
					readSummaryInSnapshot(db, ids[0] as number, clusterDigest(ids))
						?.summary ?? null;
			}
		}
		const mine = byId.get(mention.entityId) as ClusterMember;
		for (const other of [...best.values()].sort(
			(x, y) => x.entityId - y.entityId,
		)) {
			const first = (reach.get(other.entityId) as { first: SameLink }).first;
			const entry = docs.get(other.documentId) ?? { member: other, shared: [] };
			entry.shared.push({
				label: mine.name,
				relatedLabel: other.name,
				evidence: {
					document: readEntityEvidenceInSnapshot(db, mine.entityId),
					related: readEntityEvidenceInSnapshot(db, other.entityId),
				},
				decidedBy: {
					model: first.provenance.model,
					instructionId: first.provenance.instructionId,
					instructionVersion: first.provenance.instructionVersion,
				},
				summary,
			});
			docs.set(other.documentId, entry);
		}
	}

	const ordered = [...docs.entries()].sort(
		([idA, a], [idB, b]) =>
			b.shared.length - a.shared.length || (idA < idB ? -1 : idA > idB ? 1 : 0),
	);
	const results: Result[] = ordered
		.slice(0, p.limit)
		.map(([documentId, d], i) => ({
			rank: i + 1,
			documentId,
			namespace: d.member.namespace,
			path: d.member.path,
			title: d.member.title,
			markdownSha256: d.member.markdownSha256,
			state:
				d.member.lastVerifiedAt === null ||
				d.member.lastVerifiedAt < p.now - p.verifiedWithinMs
					? "unverified"
					: "current",
			shared: d.shared,
		}));

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
	if (truncated) reasons.add("response_truncated");
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
