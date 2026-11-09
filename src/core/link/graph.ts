import {
	CONTRACT_VERSION,
	GRAPH_LIMITS,
	KnowledgeError,
	graphPartialReasons,
	graphRequestSchema,
	graphResponseSchema,
	type GraphResponse,
	type ReadGraph,
	type Tx,
} from "../../contracts/index.js";
import {
	readGraphDocumentsInSnapshot,
	readGraphEvidenceInSnapshot,
	readGraphMentionsInSnapshot,
	readGraphLinksInSnapshot,
	readGraphRelationsAmongInSnapshot,
	type GraphDocument,
	type GraphLink,
	type GraphMention,
	type GraphRelation,
} from "../../sqlite/graph.js";
import {
	MAX_SUMMARY_MEMBERS,
	NAME_KEY_PROVENANCE,
	clusterDigest,
	countUncomparedVersionsInSnapshot,
	countVersionsWithFailedMentionsInSnapshot,
	hasUnsureLinkInSnapshot,
	readSameClusterInTransaction,
	readSummaryInSnapshot,
} from "../../sqlite/links.js";
import { readSearchCoverageInSnapshot } from "../../sqlite/search.js";
import { normalizeForSearch } from "../text/normalize.js";
import { constrainedComponents } from "./components.js";

type Reason = GraphResponse["partialReasons"][number];
type Node = GraphResponse["nodes"][number];
type Edge = GraphResponse["edges"][number];
type EvidencePoint = Node["evidence"][number];
type Provenance = Node["decidedBy"][number];

/**
 * The knowledge graph of the caller's scope, read from one snapshot (nothing is written).
 *
 * Nodes are the components of `same` links and of identity keys (mentions of one namespace with
 * the same model-free key, kg2.md §3.3) among the current mentions the caller may read, under
 * that caller's `different` judgments as cannot-link constraints (a stored `same` link that would
 * put two mentions judged `different` into one node is not used: `linking_conflict`; a key join
 * judged `different` is simply not made).
 * Everything is computed over that read set alone, so a mention outside the scope never joins
 * or splits anything inside and nothing about it shows. Edges are the relation mentions of the
 * same versions whose two ends are read mentions of returned nodes, grouped by the two nodes,
 * direction, normalized relation name, negation and certainty. Whether mentions are the same
 * entity is a model's or a person's judgment (the links) or the model-free extractor's key
 * (`name_key`), each named in `decidedBy`; this code joins by connectivity and counts only.
 * Node and edge ids are ordinals of the returned order.
 */
export const readGraph: ReadGraph = (deps, access, request) => {
	const parsed = graphRequestSchema.safeParse(request);
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
			maxNodes: req.maxNodes,
			maxEdges: req.maxEdges,
			minDocuments: req.minDocuments,
			minEdgeDocuments: req.minEdgeDocuments,
			types: req.types ? new Set(req.types) : null,
			scope: [...new Set(scope)],
			now: deps.clock.now(),
			verifiedWithinMs,
			maxUnappliedAttempts: deps.options.maxUnappliedAttempts,
		}),
	);
	const checked = graphResponseSchema.safeParse(response);
	if (!checked.success) throw new KnowledgeError("contract_mismatch");
	return checked.data;
};

type Params = {
	maxNodes: number;
	maxEdges: number;
	minDocuments: number;
	minEdgeDocuments: number;
	types: Set<string> | null;
	scope: string[];
	now: number;
	verifiedWithinMs: number;
	maxUnappliedAttempts: number | undefined;
};

type Component = {
	/** Smallest entity id of the component. */
	anchor: number;
	/** In entity id order. */
	members: GraphMention[];
	documentIds: Set<string>;
	provenance: Provenance[];
};

/** Values by frequency, most frequent first; equal counts keep their first-seen order. */
function byFrequency(values: Iterable<string>): string[] {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([v]) => v);
}

const sorted = (values: Iterable<string>): string[] =>
	[...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

type Point = EvidencePoint & { subjectId: number };

/**
 * At most `GRAPH_LIMITS.evidencePerItem` of the points (given in subject id, position order):
 * first one per document, then the others in the same order.
 */
function pickEvidence(points: readonly Point[]): EvidencePoint[] {
	const max = GRAPH_LIMITS.evidencePerItem;
	const chosen: number[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < points.length && chosen.length < max; i++) {
		const documentId = (points[i] as Point).documentId;
		if (seen.has(documentId)) continue;
		seen.add(documentId);
		chosen.push(i);
	}
	const taken = new Set(chosen);
	for (let i = 0; i < points.length && chosen.length < max; i++) {
		if (!taken.has(i)) chosen.push(i);
	}
	return chosen.map((i) => {
		const { subjectId: _subjectId, ...point } = points[i] as Point;
		return point;
	});
}

/**
 * Components of the read mentions joined by `same` links and by identity key (mentions of one
 * namespace with the same model-free key, kg2.md §3.3), under the `different` judgments as
 * cannot-link constraints (`constrainedComponents`, the rule shared with the identity chain).
 * The links come in (entity_a, entity_b) order. `rejected` counts the stored `same` links that a
 * `different` judgment overruled; a key join a person judged `different` is simply not made.
 */
function components(
	mentions: readonly GraphMention[],
	links: ReturnType<typeof readGraphLinksInSnapshot>,
	documentOf: (versionId: number) => string,
	namespaceOf: (versionId: number) => string,
): { list: Component[]; ofEntity: Map<number, Component>; rejected: number } {
	const index = new Map<number, number>();
	mentions.forEach((m, i) => index.set(m.entityId, i));
	const norm = mentions.map((m) =>
		m.nameNorm !== "" ? m.nameNorm : normalizeForSearch(m.name),
	);
	const different: [number, number][] = [];
	const sameLinks: { a: number; b: number; link: GraphLink }[] = [];
	for (const link of links) {
		const a = index.get(link.a);
		const b = index.get(link.b);
		if (a === undefined || b === undefined) continue;
		if (link.decision === "different") different.push([a, b]);
		else sameLinks.push({ a, b, link });
	}
	const stored = sameLinks.length;
	// Key joins: each mention of a (namespace, key) group to the group's first (smallest id).
	const byKey = new Map<string, number[]>();
	mentions.forEach((m, i) => {
		if (m.nameKey === "") return;
		const key = `${namespaceOf(m.versionId)}\u0000${m.nameKey}`;
		const group = byKey.get(key);
		if (group) group.push(i);
		else byKey.set(key, [i]);
	});
	for (const [first, ...others] of byKey.values()) {
		const a = mentions[first as number] as GraphMention;
		for (const i of others) {
			const b = mentions[i] as GraphMention;
			sameLinks.push({
				a: first as number,
				b: i,
				link: {
					a: a.entityId,
					b: b.entityId,
					decision: "same",
					...NAME_KEY_PROVENANCE,
				},
			});
		}
	}
	const joined = constrainedComponents(
		norm,
		sameLinks.map((l) => [l.a, l.b] as const),
		different,
	);
	const of = joined.of;
	const used = joined.used.map(
		(i) => (sameLinks[i] as { link: GraphLink }).link,
	);
	const usedSet = new Set(joined.used);
	let rejected = 0;
	for (let i = 0; i < stored; i++) if (!usedSet.has(i)) rejected++;
	const byComp = new Map<number, Component>();
	const ofEntity = new Map<number, Component>();
	mentions.forEach((m, i) => {
		const id = of[i] as number;
		let component = byComp.get(id);
		if (!component) {
			component = {
				anchor: m.entityId,
				members: [],
				documentIds: new Set(),
				provenance: [],
			};
			byComp.set(id, component);
		}
		component.members.push(m);
		component.documentIds.add(documentOf(m.versionId));
		ofEntity.set(m.entityId, component);
	});
	for (const link of used) {
		const component = ofEntity.get(link.a) as Component;
		const known = component.provenance.some(
			(p) =>
				p.model === link.model &&
				p.instructionId === link.instructionId &&
				p.instructionVersion === link.instructionVersion,
		);
		if (!known) {
			component.provenance.push({
				model: link.model,
				instructionId: link.instructionId,
				instructionVersion: link.instructionVersion,
			});
		}
	}
	return { list: [...byComp.values()], ofEntity, rejected };
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function compute(db: Tx, p: Params): GraphResponse {
	const reasons = new Set<Reason>();
	const read = readGraphMentionsInSnapshot(
		db,
		p.scope,
		GRAPH_LIMITS.maxMentions,
	);
	if (read.truncated) reasons.add("mentions_truncated");
	const documents = new Map<number, GraphDocument>(
		readGraphDocumentsInSnapshot(db, [
			...new Set(read.mentions.map((m) => m.versionId)),
		]).map((d) => [d.versionId, d] as const),
	);
	const documentOf = (versionId: number): string =>
		(documents.get(versionId) as GraphDocument).documentId;
	const links = readGraphLinksInSnapshot(
		db,
		read.mentions.map((m) => m.entityId),
	);
	const all = components(
		read.mentions,
		links,
		documentOf,
		(versionId) => (documents.get(versionId) as GraphDocument).namespace,
	);
	if (all.rejected > 0) reasons.add("linking_conflict");

	// Nodes: more mentions, then more documents, then the label, then the smallest member id
	// (which orders equal nodes without showing in the answer). Their ids are ordinals.
	const namesOf = new Map<Component, string[]>(
		all.list.map(
			(c) => [c, byFrequency(c.members.map((m) => m.name))] as const,
		),
	);
	const labelOf = (c: Component): string =>
		(namesOf.get(c) as string[])[0] as string;
	// The request's filters (kg2.md §3.5): documents spanned and types written.
	const wanted = all.list.filter(
		(c) =>
			c.documentIds.size >= p.minDocuments &&
			(p.types === null ||
				c.members.some((m) => (p.types as Set<string>).has(m.type))),
	);
	const ordered = [...wanted].sort(
		(x, y) =>
			y.members.length - x.members.length ||
			y.documentIds.size - x.documentIds.size ||
			cmp(labelOf(x), labelOf(y)) ||
			x.anchor - y.anchor,
	);
	if (ordered.length > p.maxNodes) reasons.add("nodes_truncated");
	const kept = ordered.slice(0, p.maxNodes);
	const ordinalOf = new Map<Component, number>(
		kept.map((c, i) => [c, i + 1] as const),
	);

	const evidenceOf = (
		rows: ReturnType<typeof readGraphEvidenceInSnapshot>,
	): Map<number, Point[]> => {
		const bySubject = new Map<number, Point[]>();
		for (const e of rows) {
			const doc = documents.get(e.versionId);
			if (!doc) continue;
			const list = bySubject.get(e.subjectId) ?? [];
			list.push({
				subjectId: e.subjectId,
				documentId: doc.documentId,
				markdownSha256: doc.markdownSha256,
				fragmentOrdinal: e.fragmentOrdinal,
				byteStart: e.byteStart,
				byteEnd: e.byteEnd,
				quoteSha256: e.quoteSha256,
			});
			bySubject.set(e.subjectId, list);
		}
		return bySubject;
	};

	const keptMentions = kept.flatMap((c) => c.members);
	const mentionEvidence = evidenceOf(
		readGraphEvidenceInSnapshot(
			db,
			"entity",
			keptMentions.map((m) => m.entityId),
			GRAPH_LIMITS.evidencePerItem,
		),
	);

	const nodes: Node[] = kept.map((c, i) => {
		const names = namesOf.get(c) as string[];
		const ids = c.members.map((m) => m.entityId);
		return {
			nodeId: `n${i + 1}`,
			label: names[0] as string,
			names: names.slice(0, GRAPH_LIMITS.namesPerNode),
			types: byFrequency(c.members.map((m) => m.type)).slice(
				0,
				GRAPH_LIMITS.namesPerNode,
			),
			mentionCount: c.members.length,
			documentIds: sorted(c.documentIds),
			evidence: pickEvidence(
				ids.flatMap((id) => mentionEvidence.get(id) ?? []),
			),
			decidedBy: c.provenance,
			summary: summaryOf(db, c),
		};
	});

	// Edges: relation mentions of the returned nodes' versions, ends resolved to read mentions.
	const keyOf = (v: number, ordinal: number, localId: string): string =>
		`${v}\u0000${ordinal}\u0000${localId}`;
	const entityOfEnd = new Map<string, number>();
	for (const m of keptMentions) {
		entityOfEnd.set(
			keyOf(m.versionId, m.fragmentOrdinal, m.localId),
			m.entityId,
		);
	}
	const read2 = readGraphRelationsAmongInSnapshot(
		db,
		keptMentions.map((m) => m.entityId),
		GRAPH_LIMITS.maxRelations,
	);
	if (read2.truncated) reasons.add("relations_truncated");
	type Group = {
		/** Ties between groups of the same nodes, without any id. */
		tie: string;
		source: number;
		target: number;
		directed: boolean;
		negated: boolean;
		certainty: GraphRelation["certainty"];
		relations: GraphRelation[];
	};
	const groups = new Map<string, Group>();
	for (const r of read2.relations) {
		const s = entityOfEnd.get(
			keyOf(r.versionId, r.fragmentOrdinal, r.sourceLocalId),
		);
		const t = entityOfEnd.get(
			keyOf(r.versionId, r.fragmentOrdinal, r.targetLocalId),
		);
		if (s === undefined || t === undefined) continue;
		let source = ordinalOf.get(all.ofEntity.get(s) as Component);
		let target = ordinalOf.get(all.ofEntity.get(t) as Component);
		if (source === undefined || target === undefined) continue;
		// Both ends joined into one node (by key or by a link): a loop shows nothing.
		if (source === target) continue;
		if (!r.directed && source > target) {
			[source, target] = [target, source];
		}
		const tie = [
			r.directed ? 1 : 0,
			r.negated ? 1 : 0,
			r.certainty,
			normalizeForSearch(r.relation).trim(),
		].join("|");
		const key = `${source}|${target}|${tie}`;
		const group = groups.get(key);
		if (group) group.relations.push(r);
		else {
			groups.set(key, {
				tie,
				source,
				target,
				directed: r.directed,
				negated: r.negated,
				certainty: r.certainty,
				relations: [r],
			});
		}
	}
	const orderedGroups = [...groups.values()]
		.filter(
			(g) =>
				p.minEdgeDocuments <= 1 ||
				new Set(g.relations.map((r) => documentOf(r.versionId))).size >=
					p.minEdgeDocuments,
		)
		.sort(
			(x, y) =>
				y.relations.length - x.relations.length ||
				x.source - y.source ||
				x.target - y.target ||
				cmp(x.tie, y.tie),
		);
	if (orderedGroups.length > p.maxEdges) reasons.add("edges_truncated");
	const keptGroups = orderedGroups.slice(0, p.maxEdges);
	const relationEvidence = evidenceOf(
		readGraphEvidenceInSnapshot(
			db,
			"relation",
			keptGroups.flatMap((g) => g.relations.map((r) => r.relationId)),
			GRAPH_LIMITS.evidencePerItem,
		),
	);
	const edges: Edge[] = keptGroups.map((g, i) => {
		const conditions = new Set<string>();
		const keywords = new Set<string>();
		for (const r of g.relations) {
			if (r.condition !== null && r.condition !== "")
				conditions.add(r.condition);
			for (const k of r.keywords) keywords.add(k);
		}
		return {
			edgeId: `e${i + 1}`,
			source: `n${g.source}`,
			target: `n${g.target}`,
			directed: g.directed,
			relation: byFrequency(g.relations.map((r) => r.relation))[0] as string,
			keywords: [...keywords],
			negated: g.negated,
			certainty: g.certainty,
			conditions: [...conditions],
			mentionCount: g.relations.length,
			documentIds: sorted(
				new Set(g.relations.map((r) => documentOf(r.versionId))),
			),
			evidence: pickEvidence(
				g.relations.flatMap((r) => relationEvidence.get(r.relationId) ?? []),
			),
		};
	});

	// The answer's size (GRAPH_LIMITS.responseChars, less room for the envelope).
	const docSize = new Map<string, number>();
	for (const d of documents.values())
		docSize.set(
			d.documentId,
			JSON.stringify({
				documentId: d.documentId,
				namespace: d.namespace,
				path: d.path,
				title: d.title,
				markdownSha256: d.markdownSha256,
				state: "unverified",
			}).length + 1,
		);
	const fitted = fitGraphAnswer(
		nodes,
		edges,
		(id) => docSize.get(id) ?? 0,
		GRAPH_LIMITS.responseChars - 4_096,
	);
	if (fitted.nodes.length < nodes.length) reasons.add("nodes_truncated");
	if (fitted.edges.length < edges.length) reasons.add("edges_truncated");
	nodes.splice(0, nodes.length, ...fitted.nodes);
	edges.splice(0, edges.length, ...fitted.edges);

	// The documents the returned nodes and edges come from.
	const used = new Set<string>();
	for (const n of nodes) for (const id of n.documentIds) used.add(id);
	for (const e of edges) for (const id of e.documentIds) used.add(id);
	const byId = new Map<string, GraphDocument>();
	for (const d of documents.values()) {
		if (used.has(d.documentId) && !byId.has(d.documentId)) {
			byId.set(d.documentId, d);
		}
	}

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
	const partialReasons = graphPartialReasons.filter((r) => reasons.has(r));
	return {
		contractVersion: CONTRACT_VERSION,
		status: "ok",
		documents: sorted(byId.keys()).map((id) => {
			const d = byId.get(id) as GraphDocument;
			return {
				documentId: d.documentId,
				namespace: d.namespace,
				path: d.path,
				title: d.title,
				markdownSha256: d.markdownSha256,
				state:
					d.lastVerifiedAt === null ||
					d.lastVerifiedAt < p.now - p.verifiedWithinMs
						? ("unverified" as const)
						: ("current" as const),
			};
		}),
		nodes,
		edges,
		complete: partialReasons.length === 0,
		partialReasons,
	};
}

/**
 * Nodes and edges that fit in `room` characters of JSON with the documents they name (each
 * document counted once, `docSize` its size in the answer). When everything does not fit, the
 * first nodes in order take at most half of the room, then the edges between those nodes, in
 * order, the rest; edge ids are numbered again (node ids stay: the kept nodes are a prefix).
 * Exported for tests.
 */
export function fitGraphAnswer(
	nodes: readonly Node[],
	edges: readonly Edge[],
	docSize: (documentId: string) => number,
	room: number,
): { nodes: Node[]; edges: Edge[] } {
	const sizeOf = (x: unknown): number => JSON.stringify(x).length + 1;
	const counted = new Set<string>();
	const newDocs = (ids: readonly string[]): number => {
		let total = 0;
		for (const id of new Set(ids)) if (!counted.has(id)) total += docSize(id);
		return total;
	};
	const take = (ids: readonly string[]) => {
		for (const id of ids) counted.add(id);
	};
	const nodeSizes = nodes.map(sizeOf);
	const edgeSizes = edges.map(sizeOf);
	let whole = 0;
	for (const n of nodes) {
		whole += newDocs(n.documentIds);
		take(n.documentIds);
	}
	for (const e of edges) {
		whole += newDocs(e.documentIds);
		take(e.documentIds);
	}
	for (const x of nodeSizes) whole += x;
	for (const x of edgeSizes) whole += x;
	if (whole <= room) return { nodes: [...nodes], edges: [...edges] };

	counted.clear();
	let used = 0;
	const keptNodes: Node[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i] as Node;
		const cost = (nodeSizes[i] as number) + newDocs(n.documentIds);
		if (used + cost > room / 2) break;
		used += cost;
		take(n.documentIds);
		keptNodes.push(n);
	}
	const keptIds = new Set(keptNodes.map((n) => n.nodeId));
	const keptEdges: Edge[] = [];
	for (const e of edges) {
		if (!keptIds.has(e.source) || !keptIds.has(e.target)) continue;
		const cost = sizeOf(e) + newDocs(e.documentIds);
		if (used + cost > room) break;
		used += cost;
		take(e.documentIds);
		keptEdges.push({ ...e, edgeId: `e${keptEdges.length + 1}` });
	}
	return { nodes: keptNodes, edges: keptEdges };
}

/**
 * The stored summary of the cluster when it was made for exactly the node's mentions and the
 * node is the whole cluster (a mention outside the scope would make the cluster larger, so
 * nothing about it shows and no summary is returned).
 */
function summaryOf(db: Tx, c: Component): string | null {
	if (c.members.length < 2 || c.members.length > MAX_SUMMARY_MEMBERS) {
		return null;
	}
	const ids = c.members.map((m) => m.entityId);
	const stored = readSummaryInSnapshot(db, c.anchor, clusterDigest(ids));
	if (!stored) return null;
	// Summaries are made for clusters of stored links; a node a key join made larger has none.
	const whole = readSameClusterInTransaction(
		db,
		c.anchor,
		MAX_SUMMARY_MEMBERS + 1,
		undefined,
		{ keys: false },
	);
	if (whole.truncated || whole.members.length !== ids.length) return null;
	return stored.summary;
}
