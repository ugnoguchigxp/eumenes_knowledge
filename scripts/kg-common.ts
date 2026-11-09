// Shared by the live run (kg-live.ts) and the deterministic key graph (kg-keys.ts): the copy of an
// earlier run's database, the evaluation against the corpus' expected.json, the graph statistics
// and the check of every returned quotation with the evidence API.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
	type KnowledgeClient,
	KnowledgeClientError,
} from "../src/client/index.js";
import type {
	EvidenceResponse,
	GraphResponse,
	InferencePort,
} from "../src/contracts/index.js";
import { constrainedComponents } from "../src/core/link/components.js";
import { normalizeForSearch } from "../src/core/text/normalize.js";
import type { MockDocumentInput } from "../examples/mocks/docling.js";

export const ROOT = resolve(import.meta.dir, "..");
export const CORPUS = join(ROOT, "examples/corpus/ai-memory");
/** examples/corpus/<name> (ai-memory is the corpus of kg.md). */
export const corpusDir = (name: string): string =>
	name === "ai-memory" ? CORPUS : join(ROOT, "examples/corpus", name);

/** A path for the report: relative to the repository when inside it, else its file name only. */
export function reportPath(path: string): string {
	const inside = relative(ROOT, path);
	return inside.startsWith("..") ? basename(path) : inside;
}

export const largest = (values: Iterable<number>): number => {
	let max = 0;
	for (const v of values) if (v > max) max = v;
	return max;
};

/**
 * Copy an earlier run's database into a new directory, drop its identity links, comparison marks
 * and summaries (the identity chain starts over), and return the documents as they were ingested
 * (rebuilt from the stored fragments, checked against the stored version digest).
 */
export async function prepareRelink(
	file: string,
	option = "--relink",
): Promise<{ dir: string; documents: MockDocumentInput[] }> {
	if (!existsSync(file)) throw new Error(`${option}: no such database file`);
	const dir = await mkdtemp(join(tmpdir(), "kg-relink-"));
	const copy = join(dir, "knowledge.db");
	const source = new Database(file, { readonly: true });
	try {
		source.run("VACUUM INTO ?", [copy]);
	} finally {
		source.close();
	}
	const db = new Database(copy);
	try {
		db.transaction(() => {
			db.run("DELETE FROM knowledge_entity_links");
			db.run("DELETE FROM knowledge_link_versions");
			db.run("DELETE FROM knowledge_entity_summaries");
			// The earlier run's jobs (and sync requests) are not this run's: none is left to run or count.
			db.run("DELETE FROM host_jobs");
			db.run("DELETE FROM host_sync_requests");
			db.run(`UPDATE knowledge_link_chain SET open_sweep = NULL, opened_at = NULL,
 advanced_at = NULL, active_kind = NULL, active_id = NULL, active_digest = NULL,
 link_generation = link_generation + 1, summary_checked_key = NULL, summary_recheck_at = NULL`);
		})();
		const { documents } = readCorpusFromDb(db, option);
		return { dir, documents };
	} finally {
		db.close();
	}
}

/**
 * How the identity decisions relate to the two names (equal, one contains the other, neither),
 * and the largest set of current mentions joined by `same` links alone (no conflict rule): a
 * large one means wrong links chained many mentions together.
 */
export function linkingStats(db: Database) {
	const names = new Map(
		(
			db
				.query(
					`SELECT m.entity_id AS id, m.name_norm AS n FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id AND d.state = 'current'`,
				)
				.all() as { id: number; n: string }[]
		).map((r) => [r.id, r.n]),
	);
	const links = db
		.query(
			"SELECT entity_a AS a, entity_b AS b, decision FROM knowledge_entity_links",
		)
		.all() as { a: number; b: number; decision: string }[];
	const byNames: Record<string, Record<string, number>> = {};
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		let root = x;
		while (parent.has(root) && parent.get(root) !== root)
			root = parent.get(root)!;
		parent.set(x, root);
		return root;
	};
	for (const l of links) {
		const a = names.get(l.a);
		const b = names.get(l.b);
		if (a === undefined || b === undefined) continue;
		const kind =
			a === b ? "equal" : a.includes(b) || b.includes(a) ? "contains" : "other";
		byNames[kind] ??= {};
		byNames[kind][l.decision] = (byNames[kind][l.decision] ?? 0) + 1;
		if (l.decision === "same") {
			const ra = find(l.a);
			const rb = find(l.b);
			if (ra !== rb) parent.set(ra, rb);
		}
	}
	const size = new Map<number, number>();
	for (const id of names.keys())
		size.set(find(id), (size.get(find(id)) ?? 0) + 1);
	return {
		decisionsByNames: byNames,
		largestSameComponent: largest(size.values()),
	};
}

const clockText = () => new Date().toISOString().slice(11, 19);
export const log = (line: string) => console.log(`[${clockText()}] ${line}`);
export const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/**
 * Whether the normalized text names the alias: an ASCII word character next to the match ends it
 * (`mem0` is not found inside `mem0g`); other scripts have no word boundary to check.
 */
export function mentions(normalizedText: string, alias: string): boolean {
	const a = norm(alias);
	const word = /[a-z0-9_]/;
	for (
		let i = normalizedText.indexOf(a);
		i >= 0;
		i = normalizedText.indexOf(a, i + 1)
	) {
		const before = normalizedText[i - 1] ?? "";
		const after = normalizedText[i + a.length] ?? "";
		const edgeOk = (c: string, inner: string | undefined) =>
			!(inner && word.test(inner) && word.test(c));
		if (edgeOk(before, a[0]) && edgeOk(after, a[a.length - 1])) return true;
	}
	return false;
}

export type CorpusDocument = { file: string; path: string; markdown: string };

export type Expected = {
	entities: { id: string; aliases: string[] }[];
	relations: { a: string[]; b: string[]; about: string }[];
	distinct: [string, string][];
};

// ---------------------------------------------------------------------------
// Evaluation against expected.json
// ---------------------------------------------------------------------------

export type Node = GraphResponse["nodes"][number];

/** What `evaluate` reads of a graph: the API answer, or `fullGraph` of a database. */
export type EvaluatedGraph = {
	nodes: Pick<
		Node,
		"nodeId" | "label" | "names" | "documentIds" | "mentionCount"
	>[];
	edges: Pick<
		GraphResponse["edges"][number],
		"source" | "target" | "relation"
	>[];
};

export function evaluate(
	graph: EvaluatedGraph,
	expected: Expected,
	corpus: readonly CorpusDocument[],
	docIdByPath: ReadonlyMap<string, string>,
) {
	const aliasSets = new Map(
		expected.entities.map((e) => [e.id, new Set(e.aliases.map(norm))]),
	);
	const nodesFor = (id: string): EvaluatedGraph["nodes"] =>
		graph.nodes.filter((n) =>
			n.names.some((name) => aliasSets.get(id)?.has(norm(name))),
		);
	// A corpus document the store does not know (never listed) still counts: no node covers it.
	const idOf = (path: string) => docIdByPath.get(path) ?? `missing:${path}`;
	const normalizedText = new Map(corpus.map((d) => [d.path, norm(d.markdown)]));
	const entities = expected.entities.map((e) => {
		const expectedDocs = corpus
			.filter((d) =>
				e.aliases.some((a) => mentions(normalizedText.get(d.path) ?? "", a)),
			)
			.map((d) => idOf(d.path));
		const nodes = nodesFor(e.id);
		const covered = (docs: readonly string[]) =>
			expectedDocs.filter((d) => docs.includes(d)).length;
		const best = nodes.reduce((m, n) => Math.max(m, covered(n.documentIds)), 0);
		const union = covered([...new Set(nodes.flatMap((n) => n.documentIds))]);
		return {
			id: e.id,
			expectedDocuments: expectedDocs.length,
			found: nodes.length > 0,
			nodes: nodes.length,
			bestNodeCoverage: expectedDocs.length ? best / expectedDocs.length : null,
			unionCoverage: expectedDocs.length ? union / expectedDocs.length : null,
			labels: nodes.map((n) => n.label),
		};
	});
	// A node whose names are aliases of two or more expected entities mixes them.
	const impureNodes = graph.nodes
		.map((n) => ({
			label: n.label,
			mentions: n.mentionCount,
			entities: expected.entities
				.filter((e) =>
					n.names.some((name) => aliasSets.get(e.id)?.has(norm(name))),
				)
				.map((e) => e.id),
		}))
		.filter((n) => n.entities.length >= 2);
	const present = entities.filter((e) => e.expectedDocuments > 0);
	const crossDoc = present.filter((e) => e.expectedDocuments >= 2);
	const relations = expected.relations.map((r) => {
		const a = new Set(r.a.flatMap((id) => nodesFor(id).map((n) => n.nodeId)));
		const b = new Set(r.b.flatMap((id) => nodesFor(id).map((n) => n.nodeId)));
		const edges = graph.edges.filter(
			(e) =>
				(a.has(e.source) && b.has(e.target)) ||
				(a.has(e.target) && b.has(e.source)),
		);
		return {
			about: r.about,
			endpointsFound: a.size > 0 && b.size > 0,
			hit: edges.length > 0,
			relations: [...new Set(edges.map((e) => e.relation))],
		};
	});
	const distinct = expected.distinct.map(([x, y]) => {
		const xs = new Set(nodesFor(x).map((n) => n.nodeId));
		const merged = nodesFor(y).filter((n) => xs.has(n.nodeId));
		return { pair: [x, y], merged: merged.map((n) => n.label) };
	});
	const ratio = (n: number, d: number) => (d ? n / d : null);
	return {
		summary: {
			entitiesInCorpus: present.length,
			entityRecall: ratio(
				present.filter((e) => e.found).length,
				present.length,
			),
			crossDocumentEntities: crossDoc.length,
			mergedIntoOneNode: crossDoc.filter((e) => e.bestNodeCoverage === 1)
				.length,
			meanBestNodeCoverage: ratio(
				crossDoc.reduce((s, e) => s + (e.bestNodeCoverage ?? 0), 0),
				crossDoc.length,
			),
			meanNodesPerFoundEntity: ratio(
				present.filter((e) => e.found).reduce((s, e) => s + e.nodes, 0),
				present.filter((e) => e.found).length,
			),
			relationRecall: ratio(
				relations.filter((r) => r.hit).length,
				relations.length,
			),
			relationEndpointsFound: relations.filter((r) => r.endpointsFound).length,
			distinctViolations: distinct.filter((d) => d.merged.length > 0).length,
			impureNodes: impureNodes.length,
		},
		entities,
		relations,
		distinct,
		impureNodes,
	};
}

export function graphStats(graph: GraphResponse) {
	const multiDoc = graph.nodes.filter((n) => n.documentIds.length >= 2);
	return {
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		singletonNodes: graph.nodes.filter((n) => n.mentionCount === 1).length,
		multiDocumentNodes: multiDoc.length,
		nodesWithSummary: graph.nodes.filter((n) => n.summary !== null).length,
		multiMentionEdges: graph.edges.filter((e) => e.mentionCount >= 2).length,
		crossDocumentEdges: graph.edges.filter((e) => e.documentIds.length >= 2)
			.length,
		maxNamesPerNode: largest(graph.nodes.map((n) => n.names.length)),
		nodesWithFiveNamesOrMore: graph.nodes.filter((n) => n.names.length >= 5)
			.length,
		topNodes: graph.nodes.slice(0, 25).map((n) => ({
			label: n.label,
			mentions: n.mentionCount,
			documents: n.documentIds.length,
			types: n.types.slice(0, 3),
		})),
	};
}

/** Every quotation the graph returns (nodes and edges), checked with the evidence API. */
/**
 * The graph at the API's largest limits, or at half of them while the answer is larger than the
 * client reads (1 MiB: without identity links every mention is a node, kg2.md §7.4). The limits
 * used go into the report.
 */
export async function readGraphFitting(client: KnowledgeClient): Promise<{
	graph: GraphResponse;
	request: { maxNodes: number; maxEdges: number };
}> {
	let request = { maxNodes: 1000, maxEdges: 2000 };
	for (;;) {
		try {
			return { graph: await client.graph(request), request };
		} catch (error) {
			if (
				!(error instanceof KnowledgeClientError) ||
				error.code !== "knowledge_contract_mismatch" ||
				request.maxNodes <= 125
			)
				throw error;
			request = {
				maxNodes: request.maxNodes / 2,
				maxEdges: request.maxEdges / 2,
			};
			log(
				`graph answer too large for the client: reading ${JSON.stringify(request)}`,
			);
		}
	}
}

export async function checkEvidence(
	client: KnowledgeClient,
	graph: GraphResponse,
): Promise<Record<EvidenceResponse["status"], number>> {
	const evidence: Record<EvidenceResponse["status"], number> = {
		valid: 0,
		stale: 0,
		unavailable: 0,
		mismatch: 0,
		not_available: 0,
	};
	for (const point of [
		...graph.nodes.flatMap((n) => n.evidence),
		...graph.edges.flatMap((e) => e.evidence),
	]) {
		const answer = await client.evidence({
			documentId: point.documentId,
			markdownSha256: point.markdownSha256,
			byteStart: point.byteStart,
			byteEnd: point.byteEnd,
			quoteSha256: point.quoteSha256,
		});
		evidence[answer.status]++;
	}
	return evidence;
}

/** A required environment variable (its value is never printed). */
export function env(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

// ---------------------------------------------------------------------------
// Inference with per-call accounting (no prompt or answer is kept)
// ---------------------------------------------------------------------------

export type PurposeStats = {
	calls: number;
	ok: number;
	errors: Record<string, number>;
	ms: number;
	inputTokens: number;
	outputTokens: number;
};

export function accounted(port: InferencePort) {
	const byPurpose = new Map<string, PurposeStats>();
	const wrapped: InferencePort = {
		async complete(request, signal) {
			const s = byPurpose.get(request.purpose) ?? {
				calls: 0,
				ok: 0,
				errors: {},
				ms: 0,
				inputTokens: 0,
				outputTokens: 0,
			};
			byPurpose.set(request.purpose, s);
			s.calls++;
			const started = Date.now();
			try {
				const result = await port.complete(request, signal);
				const ms = Date.now() - started;
				s.ms += ms;
				s.inputTokens += result.usage.inputTokens ?? 0;
				s.outputTokens += result.usage.outputTokens ?? 0;
				if (result.ok) s.ok++;
				else s.errors[result.error] = (s.errors[result.error] ?? 0) + 1;
				log(
					`${request.purpose} #${s.calls} ${result.ok ? "ok" : result.error} ${(ms / 1000).toFixed(1)}s in=${result.usage.inputTokens ?? "-"} out=${result.usage.outputTokens ?? "-"}`,
				);
				return result;
			} catch (error) {
				s.ms += Date.now() - started;
				s.errors.thrown = (s.errors.thrown ?? 0) + 1;
				log(`${request.purpose} #${s.calls} thrown`);
				throw error;
			}
		},
	};
	return { port: wrapped, stats: () => Object.fromEntries(byPurpose) };
}

// ---------------------------------------------------------------------------
// Mentions, links and nodes of a database (the graph read's rule, kg.md §2 and §8)
// ---------------------------------------------------------------------------

export type Mention = {
	id: number;
	name: string;
	nameNorm: string;
	type: string;
	description: string;
	namespace: string;
	versionId: number;
	fragment: number;
	localId: string;
	documentId: string;
	path: string;
};

/** The mentions of the published versions of current documents, in entity id order. */
export function readMentions(db: Database): Mention[] {
	return db
		.query(
			`SELECT m.entity_id AS id, m.name, m.name_norm AS nameNorm, m.type, m.description,
 d.namespace, m.version_id AS versionId, m.fragment_ordinal AS fragment, m.local_id AS localId,
 d.document_id AS documentId, d.path
FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id AND d.state = 'current'
ORDER BY m.entity_id`,
		)
		.all() as Mention[];
}

export type Decision = "same" | "different" | "unsure";
export type Link = {
	a: number;
	b: number;
	decision: Decision;
	version: number;
	instruction: string;
};

/** Links between two current mentions, of the versions those mentions are in now. */
export function readCurrentLinks(
	db: Database,
	mentions: readonly Mention[],
): Link[] {
	const versionOf = new Map(mentions.map((m) => [m.id, m.versionId]));
	return (
		db
			.query(
				`SELECT entity_a AS a, entity_b AS b, decision, version_a AS va, version_b AS vb,
 instruction_version AS version, instruction_id AS instruction
FROM knowledge_entity_links ORDER BY entity_a, entity_b`,
			)
			.all() as (Link & { va: number; vb: number })[]
	)
		.filter((l) => versionOf.get(l.a) === l.va && versionOf.get(l.b) === l.vb)
		.map(({ a, b, decision, version, instruction }) => ({
			a,
			b,
			decision,
			version,
			instruction,
		}));
}

export const pairKey = (x: number, y: number) =>
	x < y ? `${x}-${y}` : `${y}-${x}`;

/**
 * Nodes as the graph read makes them for a reader of every namespace: `same` links under the
 * `different` judgments (`constrainedComponents`). `of[i]` is the node of `ms[i]`.
 */
export function nodesOf(db: Database): { ms: Mention[]; of: number[] } {
	const ms = readMentions(db);
	const index = new Map(ms.map((m, i) => [m.id, i]));
	const same: [number, number][] = [];
	const different: [number, number][] = [];
	for (const l of readCurrentLinks(db, ms)) {
		const a = index.get(l.a) as number;
		const b = index.get(l.b) as number;
		if (l.decision === "different") different.push([a, b]);
		else if (l.decision === "same") same.push([a, b]);
	}
	const { of } = constrainedComponents(
		ms.map((m) =>
			m.nameNorm !== "" ? m.nameNorm : normalizeForSearch(m.name),
		),
		same,
		different,
	);
	return { ms, of };
}

/** Whether two mentions are in one node (by entity id). */
export function sameNode(db: Database): (a: number, b: number) => boolean {
	const { ms, of } = nodesOf(db);
	const node = new Map(ms.map((m, i) => [m.id, of[i]]));
	return (a, b) => node.get(a) !== undefined && node.get(a) === node.get(b);
}

/**
 * The nodes and relation edges of a database for `evaluate`, with every name of every mention.
 * The graph API returns at most `namesPerNode` names, so an evaluation on its answer can miss an
 * alias in a large node (kg.md §8.8).
 */
export function fullGraph(db: Database): EvaluatedGraph {
	const { ms, of } = nodesOf(db);
	const byNode = new Map<number, Mention[]>();
	ms.forEach((m, i) => {
		const node = of[i] as number;
		const list = byNode.get(node);
		if (list) list.push(m);
		else byNode.set(node, [m]);
	});
	const nodeIdOf = new Map<number, string>();
	const nodes = [...byNode].map(([node, members]) => {
		const count = new Map<string, number>();
		for (const m of members) count.set(m.name, (count.get(m.name) ?? 0) + 1);
		const names = [...count].sort((x, y) => y[1] - x[1]).map(([n]) => n);
		const nodeId = `n${node}`;
		nodeIdOf.set(node, nodeId);
		return {
			nodeId,
			label: names[0] as string,
			names,
			documentIds: [...new Set(members.map((m) => m.documentId))],
			mentionCount: members.length,
		};
	});
	const byLocal = new Map(
		ms.map((m, i) => [`${m.versionId}:${m.fragment}:${m.localId}`, i]),
	);
	const edges = (
		db
			.query(
				`SELECT r.version_id AS v, r.fragment_ordinal AS f, r.source_local_id AS s,
 r.target_local_id AS t, r.relation
FROM knowledge_relation_mentions r
JOIN knowledge_documents d ON d.published_version_id = r.version_id AND d.state = 'current'`,
			)
			.all() as {
			v: number;
			f: number;
			s: string;
			t: string;
			relation: string;
		}[]
	).flatMap((r) => {
		const a = byLocal.get(`${r.v}:${r.f}:${r.s}`);
		const b = byLocal.get(`${r.v}:${r.f}:${r.t}`);
		if (a === undefined || b === undefined) return [];
		return [
			{
				source: nodeIdOf.get(of[a] as number) as string,
				target: nodeIdOf.get(of[b] as number) as string,
				relation: r.relation,
			},
		];
	});
	return { nodes, edges };
}

/**
 * The current documents of a database as they were ingested (rebuilt from the stored fragments,
 * checked against the stored version digest), and their ids by path.
 */
export function readCorpusFromDb(
	db: Database,
	option: string,
): {
	documents: MockDocumentInput[];
	corpus: CorpusDocument[];
	docIdByPath: Map<string, string>;
} {
	const docs = db
		.query(
			`SELECT d.document_id, d.namespace, d.path, d.title, v.version_id, v.markdown_sha256
FROM knowledge_documents d JOIN knowledge_versions v ON v.version_id = d.published_version_id
WHERE d.state = 'current' ORDER BY d.path`,
		)
		.all() as {
		document_id: string;
		namespace: string;
		path: string;
		title: string;
		version_id: number;
		markdown_sha256: string;
	}[];
	const documents = docs.map((d) => {
		const markdown = (
			db
				.query(
					"SELECT text FROM knowledge_fragments WHERE version_id = ? ORDER BY ordinal",
				)
				.all(d.version_id) as { text: string }[]
		)
			.map((f) => f.text)
			.join("");
		const digest = createHash("sha256").update(markdown, "utf8").digest("hex");
		if (digest !== d.markdown_sha256)
			throw new Error(`${option}: fragments do not rebuild ${d.path}`);
		return { namespace: d.namespace, path: d.path, title: d.title, markdown };
	});
	if (documents.length === 0) throw new Error(`${option}: no current document`);
	return {
		documents,
		corpus: documents.map((d) => ({
			file: basename(d.path),
			path: d.path,
			markdown: d.markdown,
		})),
		docIdByPath: new Map(docs.map((d) => [d.path, d.document_id])),
	};
}
