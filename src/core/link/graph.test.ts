import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	GRAPH_LIMITS,
	graphResponseSchema,
	type AccessContext,
	type GraphRequest,
	type GraphResponse,
} from "../../contracts/index.js";
import { docId, inferenceOk, rows, runJob } from "../harness.fixture.js";
import { readEvidence } from "../search/index.js";
import { recordLinkDecisionsInTransaction } from "../../sqlite/links.js";
import { sha256Hex } from "../bytes.js";
import { readGraph } from "./graph.js";
import {
	KNOWN_NAMES,
	inputOf,
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "./link.fixture.js";

const deps = (env: LinkEnv) => ({
	read: <T>(op: (db: LinkEnv["db"]) => T): T => op(env.db),
	clock: env.clock,
	options: { verifiedWithinMs: 10 ** 12 },
});
const access = (...namespaces: string[]): AccessContext => ({
	principal: "tester",
	namespaces,
});
const graph = (
	env: LinkEnv,
	namespaces: string[],
	request: GraphRequest = {},
): GraphResponse => readGraph(deps(env), access(...namespaces), request);

/**
 * Extraction: the known names a text holds, and one relation between the first two by the
 * wording of the text (a test double: the real code never does this).
 */
function installExtraction(env: LinkEnv): void {
	const base = env.inference.script;
	env.inference.script = (request, call, signal) => {
		if (request.purpose !== "extract") return base(request, call, signal);
		const text = (inputOf(request) as { text?: string }).text ?? "";
		const found = KNOWN_NAMES.filter((n) => text.includes(n));
		const entities = found.map((name, i) => ({
			id: `e${i + 1}`,
			name,
			type: "company",
			description: `${name} as described in: ${text.slice(0, 24)}`,
			evidence: [name],
		}));
		const rel = (
			relation: string,
			source: string,
			target: string,
			extra: { directed?: boolean; negated?: boolean } = {},
		) => ({
			id: "r1",
			source,
			target,
			directed: extra.directed ?? false,
			relation,
			description: "d",
			keywords: [relation.trim().toLowerCase()],
			qualifiers: {
				negated: extra.negated ?? false,
				condition: null,
				certainty: "stated",
			},
			evidence: [found[0]],
		});
		const relations =
			found.length < 2
				? []
				: text.includes("not partners")
					? [rel("partner", "e1", "e2", { negated: true })]
					: text.includes("partners with")
						? [rel("Partner", "e2", "e1")]
						: text.includes("are partners")
							? [rel("partner", "e1", "e2")]
							: text.includes("sign a deal")
								? [rel("ＰＡＲＴＮＥＲ ", "e1", "e2")]
								: text.includes("supplies")
									? [rel("supplies", "e2", "e1", { directed: true })]
									: [];
		return inferenceOk(JSON.stringify({ entities, relations }));
	};
}

async function ingestOnly(env: LinkEnv): Promise<void> {
	await runJob(env.db, env.sync, {
		scanId: randomUUID(),
		cursor: null,
		page: 0,
	});
	while (env.sink.open.length > 0) {
		const job = env.sink.open.shift()!;
		if (job.kind === "knowledge.link-next") continue;
		if (job.kind === "knowledge.sync-page") {
			await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
		} else {
			await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
		}
	}
}
const mentionId = (env: LinkEnv, doc: number, name: string): number =>
	(
		rows(
			env.db,
			`SELECT m.entity_id AS id FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE d.document_id = ? AND m.name = ?`,
			docId(doc),
			name,
		)[0] as { id: number }
	).id;
const decide = (
	env: LinkEnv,
	pairs: [number, number, "same" | "different" | "unsure"][],
) => {
	for (const [a, b, decision] of pairs) {
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: a, otherId: b, decision }],
			{ model: "m", instructionId: "link", instructionVersion: 1 },
			1,
		);
	}
};

const DOCS: [number, string, string][] = [
	[1, "Alpha Corp and Beta Ltd are partners.", "wiki"],
	[2, "Alpha Corp and Beta Ltd sign a deal.", "wiki"],
	[3, "Alpha Corp is mentioned abroad.", "other"],
	[4, "Gamma Inc stands alone.", "wiki"],
];

async function populated(extra: [number, string, string][] = []) {
	const env = makeLinkEnv({ summaryMinMentions: 3 });
	installExtraction(env);
	for (const [n, text, ns] of [...DOCS, ...extra]) putDoc(env, n, text, ns);
	await scanAndDrain(env);
	return env;
}

describe("readGraph", () => {
	test("nodes join the same entity across documents; one edge groups the equal relations", async () => {
		const env = await populated();
		const g = graph(env, ["wiki", "other"]);
		expect(graphResponseSchema.safeParse(g).success).toBe(true);
		expect(g.status).toBe("ok");
		expect(g.complete).toBe(true);
		expect(g.partialReasons).toEqual([]);
		expect(
			g.nodes.map((n) => [n.label, n.mentionCount, n.documentIds.length]),
		).toEqual([
			["Alpha Corp", 3, 3],
			["Beta Ltd", 2, 2],
			["Gamma Inc", 1, 1],
		]);
		const [alpha, beta, gamma] = g.nodes;
		// Ids are ordinals in the returned order, never an internal id.
		expect(g.nodes.map((n) => n.nodeId)).toEqual(["n1", "n2", "n3"]);
		expect(g.edges.map((e) => e.edgeId)).toEqual(["e1"]);
		expect(alpha!.names).toEqual(["Alpha Corp"]);
		expect(alpha!.types).toEqual(["company"]);
		expect(alpha!.decidedBy).toHaveLength(1);
		expect(alpha!.decidedBy[0]).toMatchObject({ instructionId: "link" });
		expect(alpha!.decidedBy[0]!.instructionVersion).toBeGreaterThanOrEqual(1);
		expect(gamma!.decidedBy).toEqual([]);
		expect(alpha!.summary).toBe("SUMMARY(Alpha Corp; 3)");
		expect(beta!.summary).toBeNull();
		expect(gamma!.summary).toBeNull();
		// The full-width, upper-case, padded wording is the same relation after normalizing.
		expect(g.edges).toHaveLength(1);
		const edge = g.edges[0]!;
		expect(edge).toMatchObject({
			source: alpha!.nodeId,
			target: beta!.nodeId,
			directed: false,
			relation: "partner",
			negated: false,
			certainty: "stated",
			mentionCount: 2,
			conditions: [],
		});
		expect(edge.keywords.sort()).toEqual(["partner", "ｐａｒｔｎｅｒ"].sort());
		expect(edge.documentIds).toEqual([docId(1), docId(2)]);
		expect(g.documents.map((d) => d.documentId)).toEqual([
			docId(1),
			docId(2),
			docId(3),
			docId(4),
		]);
		expect(g.documents[0]).toMatchObject({
			namespace: "wiki",
			path: "notes/1.md",
			state: "current",
		});
	});

	test("every evidence point leads back to the text and the evidence check accepts it", async () => {
		const env = await populated();
		const g = graph(env, ["wiki", "other"]);
		const body = (id: string) =>
			Buffer.from(DOCS.find((d) => docId(d[0]) === id)![1], "utf8");
		let checked = 0;
		for (const item of [...g.nodes, ...g.edges]) {
			expect(item.evidence.length).toBeGreaterThan(0);
			expect(item.evidence.length).toBeLessThanOrEqual(
				GRAPH_LIMITS.evidencePerItem,
			);
			for (const p of item.evidence) {
				const slice = body(p.documentId).subarray(p.byteStart, p.byteEnd);
				expect(sha256Hex(slice)).toBe(p.quoteSha256);
				expect(
					readEvidence(deps(env), access("wiki", "other"), {
						documentId: p.documentId,
						markdownSha256: p.markdownSha256,
						byteStart: p.byteStart,
						byteEnd: p.byteEnd,
						quoteSha256: p.quoteSha256,
					}).status,
				).toBe("valid");
				checked++;
			}
		}
		expect(checked).toBeGreaterThanOrEqual(6);
		// Alpha has one quotation per document (three), in entity id order.
		expect(g.nodes[0]!.evidence.map((p) => p.documentId)).toEqual([
			docId(1),
			docId(2),
			docId(3),
		]);
	});

	test("the caller's namespaces bound everything; a request only narrows", async () => {
		const env = await populated();
		const wiki = graph(env, ["wiki"]);
		expect(JSON.stringify(wiki)).not.toContain(docId(3));
		expect(JSON.stringify(wiki)).not.toContain("SUMMARY");
		expect(wiki.nodes.map((n) => [n.label, n.mentionCount])).toEqual([
			["Alpha Corp", 2],
			["Beta Ltd", 2],
			["Gamma Inc", 1],
		]);
		const narrowed = graph(env, ["wiki", "other"], { namespaces: ["wiki"] });
		expect(narrowed).toEqual(wiki);
		const widened = graph(env, ["wiki"], { namespaces: ["wiki", "other"] });
		expect(widened).toEqual(wiki);
		const none = graph(env, ["wiki"], { namespaces: ["other"] });
		expect(none.nodes).toEqual([]);
		expect(none.edges).toEqual([]);
		expect(none.documents).toEqual([]);
		const empty = graph(env, []);
		expect(empty.nodes).toEqual([]);
	});

	test("a mention outside the scope never joins two inside", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		putDoc(env, 1, "Alpha Corp and Beta Ltd are partners.", "wiki");
		putDoc(env, 2, "Alpha Corp and Beta Ltd sign a deal.", "wiki");
		putDoc(env, 3, "Alpha Corp is mentioned abroad.", "other");
		await ingestOnly(env);
		const a1 = mentionId(env, 1, "Alpha Corp");
		const a2 = mentionId(env, 2, "Alpha Corp");
		const a3 = mentionId(env, 3, "Alpha Corp");
		decide(env, [
			[a1, a3, "same"],
			[a2, a3, "same"],
			[a1, a2, "unsure"],
		]);
		const both = graph(env, ["wiki", "other"]);
		expect(both.nodes.filter((n) => n.label === "Alpha Corp")).toHaveLength(1);
		expect(both.nodes[0]).toMatchObject({
			label: "Alpha Corp",
			mentionCount: 3,
		});
		const wiki = graph(env, ["wiki"]);
		expect(wiki.nodes.filter((n) => n.label === "Alpha Corp")).toEqual([
			expect.objectContaining({ mentionCount: 1 }),
			expect.objectContaining({ mentionCount: 1 }),
		]);
		expect(
			wiki.nodes.filter((n) => n.label === "Alpha Corp")[0]!.decidedBy,
		).toEqual([]);
		// The relations of the two documents now run between different pairs of nodes.
		expect(wiki.edges).toHaveLength(2);
		expect(wiki.partialReasons).toContain("linking_pending");
	});

	test("a different judgment is a cannot-link constraint: a same link that would break it is not used", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		for (const n of [1, 2, 3]) putDoc(env, n, "Alpha Corp.", "wiki");
		await ingestOnly(env);
		const [a, b, c] = [1, 2, 3].map((n) => mentionId(env, n, "Alpha Corp"));
		decide(env, [
			[a!, b!, "same"],
			[b!, c!, "same"],
			[a!, c!, "different"],
		]);
		const g = graph(env, ["wiki"]);
		// The links are applied by (entity_a, entity_b): a-b joins, b-c would put a and c together.
		expect(g.nodes.map((n) => [n.nodeId, n.mentionCount])).toEqual([
			["n1", 2],
			["n2", 1],
		]);
		expect(g.nodes[0]!.documentIds).toEqual([docId(1), docId(2)]);
		expect(g.nodes[0]!.decidedBy).toHaveLength(1);
		expect(g.nodes[1]!.decidedBy).toEqual([]);
		expect(g.partialReasons).toContain("linking_conflict");
		expect(g.complete).toBe(false);
		// Without the constraint (unsure is no constraint) all three are one node.
		env.db.run(
			"UPDATE knowledge_entity_links SET decision = 'unsure' WHERE decision = 'different'",
		);
		const h = graph(env, ["wiki"]);
		expect(h.nodes.map((n) => n.mentionCount)).toEqual([3]);
		expect(h.partialReasons).not.toContain("linking_conflict");
	});

	test("links between mentions of the same name are applied first: one wrong cross-name same does not merge two large nodes", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		putDoc(env, 1, "Alpha Corp and Beta Ltd are partners.", "wiki");
		putDoc(env, 2, "Alpha Corp and Beta Ltd sign a deal.", "wiki");
		await ingestOnly(env);
		const a1 = mentionId(env, 1, "Alpha Corp");
		const b1 = mentionId(env, 1, "Beta Ltd");
		const a2 = mentionId(env, 2, "Alpha Corp");
		const b2 = mentionId(env, 2, "Beta Ltd");
		decide(env, [
			[a1, a2, "same"],
			[b1, b2, "same"],
			// The wrong judgment has the smallest ids: by (entity_a, entity_b) alone it would come first.
			[a1, b1, "same"],
			[a1, b2, "different"],
			[a2, b1, "different"],
			[a2, b2, "different"],
		]);
		expect(a1).toBeLessThan(b1);
		const g = graph(env, ["wiki"]);
		expect(g.nodes.map((n) => [n.label, n.mentionCount])).toEqual([
			["Alpha Corp", 2],
			["Beta Ltd", 2],
		]);
		expect(g.nodes.every((n) => n.decidedBy.length === 1)).toBe(true);
		expect(g.partialReasons).toContain("linking_conflict");
		// The relation of each document now runs between the same two nodes: one edge.
		expect(g.edges).toHaveLength(1);
		expect(g.edges[0]).toMatchObject({
			source: "n1",
			target: "n2",
			mentionCount: 2,
		});
	});

	test("a different judgment with an end outside the scope is ignored", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		putDoc(env, 1, "Alpha Corp.", "wiki");
		putDoc(env, 2, "Alpha Corp.", "wiki");
		putDoc(env, 3, "Alpha Corp.", "other");
		await ingestOnly(env);
		const [a, b, c] = [1, 2, 3].map((n) => mentionId(env, n, "Alpha Corp"));
		decide(env, [
			[a!, b!, "same"],
			[b!, c!, "same"],
			[a!, c!, "different"],
		]);
		// Inside wiki alone nothing contradicts a-b: no conflict, and nothing about "other" shows.
		const wiki = graph(env, ["wiki"]);
		expect(wiki.nodes.map((n) => n.mentionCount)).toEqual([2]);
		expect(wiki.partialReasons).not.toContain("linking_conflict");
		// With both namespaces the constraint holds.
		const both = graph(env, ["wiki", "other"]);
		expect(both.nodes.map((n) => n.mentionCount)).toEqual([2, 1]);
		expect(both.partialReasons).toContain("linking_conflict");
		// A request that narrows to wiki gives the first answer again.
		expect(graph(env, ["wiki", "other"], { namespaces: ["wiki"] })).toEqual(
			wiki,
		);
	});

	test("unsure and different do not merge; unsure is a partial reason in the scope", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		env.decide = (m, c) => (m.name === c.name ? "unsure" : "different");
		putDoc(env, 1, "Alpha Corp and Beta Ltd are partners.", "wiki");
		putDoc(env, 2, "Alpha Corp and Beta Ltd sign a deal.", "wiki");
		putDoc(env, 3, "Delta alone.", "other");
		await scanAndDrain(env);
		const g = graph(env, ["wiki"]);
		expect(g.nodes).toHaveLength(4);
		expect(g.nodes.every((n) => n.mentionCount === 1)).toBe(true);
		expect(g.partialReasons).toEqual(["linking_unsure"]);
		expect(g.complete).toBe(false);
		// Two edges (one per document); equal relations between different nodes are not grouped.
		expect(g.edges).toHaveLength(2);
		// The pair is outside the scope of a caller who reads only "other".
		expect(graph(env, ["other"]).partialReasons).toEqual([]);
	});

	test("edges differ by direction, negation and certainty; undirected ends are in canonical order", async () => {
		const env = await populated([
			[5, "Alpha Corp and Beta Ltd are not partners.", "wiki"],
			[6, "Beta Ltd partners with Alpha Corp.", "wiki"],
			[7, "Beta Ltd supplies Alpha Corp.", "wiki"],
		]);
		const g = graph(env, ["wiki", "other"]);
		const alpha = g.nodes.find((n) => n.label === "Alpha Corp")!;
		const beta = g.nodes.find((n) => n.label === "Beta Ltd")!;
		expect(g.edges).toHaveLength(3);
		const plain = g.edges.find((e) => !e.directed && !e.negated)!;
		// "Beta Ltd partners with Alpha Corp" is written the other way round and joins the group.
		expect(plain).toMatchObject({
			source: alpha.nodeId,
			target: beta.nodeId,
			mentionCount: 3,
			relation: "partner",
		});
		const negated = g.edges.find((e) => e.negated)!;
		expect(negated).toMatchObject({ mentionCount: 1, directed: false });
		const directed = g.edges.find((e) => e.directed)!;
		expect(directed).toMatchObject({
			source: beta.nodeId,
			target: alpha.nodeId,
			relation: "supplies",
		});
		// Most mentions first, then the edge id.
		expect(g.edges.map((e) => e.mentionCount)).toEqual([3, 1, 1]);
		expect(new Set(g.edges.map((e) => e.edgeId)).size).toBe(3);
	});

	test("a relation whose ends are joined into one node is no edge (no loop)", async () => {
		for (const decision of ["different", "same"] as const) {
			const env = makeLinkEnv();
			installExtraction(env);
			env.decide = () => decision;
			putDoc(env, 1, "Alpha Corp and Alpha Corp Japan are partners.", "wiki");
			putDoc(env, 2, "Alpha Corp Japan alone.", "wiki");
			putDoc(env, 3, "Alpha Corp alone.", "wiki");
			await scanAndDrain(env);
			const g = graph(env, ["wiki"]);
			if (decision === "different") {
				expect(g.nodes.length).toBeGreaterThan(1);
				expect(g.edges).toHaveLength(1);
			} else {
				expect(g.nodes).toHaveLength(1);
				expect(g.edges).toEqual([]);
			}
		}
	});

	test("minEdgeDocuments keeps the edges written in that many documents", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		putDoc(env, 1, "Alpha Corp and Beta Ltd are partners.", "wiki");
		putDoc(env, 2, "Alpha Corp and Beta Ltd sign a deal.", "wiki");
		putDoc(env, 3, "Alpha Corp and Gamma Inc are partners.", "wiki");
		await scanAndDrain(env);
		const label = (g: GraphResponse) =>
			new Map(g.nodes.map((n) => [n.nodeId, n.label]));
		const ends = (g: GraphResponse) =>
			g.edges.map((e) => [
				label(g).get(e.source),
				label(g).get(e.target),
				e.documentCount,
			]);
		expect(ends(graph(env, ["wiki"]))).toEqual([
			["Alpha Corp", "Beta Ltd", 2],
			["Alpha Corp", "Gamma Inc", 1],
		]);
		expect(ends(graph(env, ["wiki"], { minEdgeDocuments: 2 }))).toEqual([
			["Alpha Corp", "Beta Ltd", 2],
		]);
	});

	test("nodes and edges are cut by the request; the answer says so", async () => {
		const env = await populated();
		const one = graph(env, ["wiki", "other"], { maxNodes: 1 });
		expect(one.nodes.map((n) => n.label)).toEqual(["Alpha Corp"]);
		expect(one.edges).toEqual([]);
		expect(one.partialReasons).toEqual(["nodes_truncated"]);
		expect(one.complete).toBe(false);
		// Only the documents the returned items come from.
		expect(one.documents.map((d) => d.documentId)).toEqual([
			docId(1),
			docId(2),
			docId(3),
		]);
		const two = graph(env, ["wiki", "other"], { maxNodes: 2 });
		expect(two.edges).toHaveLength(1);
		expect(two.partialReasons).toEqual(["nodes_truncated"]);
		const noEdges = graph(env, ["wiki", "other"], { maxEdges: 0 });
		expect(noEdges.edges).toEqual([]);
		expect(noEdges.nodes).toHaveLength(3);
		expect(noEdges.partialReasons).toEqual(["edges_truncated"]);
		expect(
			graph(env, ["wiki", "other"], { maxNodes: 3, maxEdges: 1 }).complete,
		).toBe(true);
	});

	test("a new version without the entity removes its node and edges; the old summary is gone", async () => {
		const env = await populated();
		putDoc(env, 3, "Nothing here now.", "other");
		await scanAndDrain(env);
		const g = graph(env, ["wiki", "other"]);
		expect(g.nodes.find((n) => n.label === "Alpha Corp")!.mentionCount).toBe(2);
		expect(JSON.stringify(g)).not.toContain("SUMMARY");
		expect(g.complete).toBe(true);
		putDoc(env, 1, "Nothing here either.", "wiki");
		putDoc(env, 2, "Nor here.", "wiki");
		await scanAndDrain(env);
		const after = graph(env, ["wiki", "other"]);
		expect(after.nodes.map((n) => n.label)).toEqual(["Gamma Inc"]);
		expect(after.edges).toEqual([]);
		expect(after.documents.map((d) => d.documentId)).toEqual([docId(4)]);
	});

	test("an uncompared version in the scope is linking_pending; a document not verified lately is unverified", async () => {
		const env = await populated();
		putDoc(env, 5, "Alpha Corp new arrival.", "wiki");
		await ingestOnly(env);
		expect(graph(env, ["wiki"]).partialReasons).toEqual(["linking_pending"]);
		expect(graph(env, ["other"]).partialReasons).toEqual([]);
		const fresh = graph(env, ["wiki"]);
		expect(fresh.documents.every((d) => d.state === "current")).toBe(true);
		env.clock.t += 60_000;
		const strict = readGraph(
			{ ...deps(env), options: { verifiedWithinMs: 1000 } },
			access("wiki"),
			{},
		);
		expect(strict.documents.every((d) => d.state === "unverified")).toBe(true);
		expect(strict.partialReasons).toContain("unverified_documents");
	});

	test("names and types are by frequency, ties go to the smaller entity id", async () => {
		const env = makeLinkEnv();
		installExtraction(env);
		putDoc(env, 1, "Alpha Corp.", "wiki");
		putDoc(env, 2, "Alpha Corp.", "wiki");
		putDoc(env, 3, "Alpha Corp.", "wiki");
		await ingestOnly(env);
		const ids = [1, 2, 3].map((n) => mentionId(env, n, "Alpha Corp"));
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name = 'Alpha', type = 'org' WHERE entity_id = ?",
			[ids[0]!],
		);
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name = 'ALPHA', type = 'org' WHERE entity_id = ?",
			[ids[1]!],
		);
		decide(env, [
			[ids[0]!, ids[1]!, "same"],
			[ids[1]!, ids[2]!, "same"],
		]);
		const g = graph(env, ["wiki"]);
		expect(g.nodes).toHaveLength(1);
		// Three distinct names once each: the first one by entity id is the label.
		expect(g.nodes[0]!.names).toEqual(["Alpha", "ALPHA", "Alpha Corp"]);
		expect(g.nodes[0]!.label).toBe("Alpha");
		expect(g.nodes[0]!.types).toEqual(["org", "company"]);
		expect(g.nodes[0]!.nodeId).toBe("n1");
		// Another name given twice outweighs the first one.
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name = 'ALPHA' WHERE entity_id = ?",
			[ids[2]!],
		);
		const h = graph(env, ["wiki"]);
		expect(h.nodes[0]!.label).toBe("ALPHA");
		expect(h.nodes[0]!.names).toEqual(["ALPHA", "Alpha"]);
	});

	test("an invalid request or a missing option is invalid_input", async () => {
		const env = await populated();
		for (const bad of [
			{ maxNodes: 0 },
			{ maxNodes: GRAPH_LIMITS.maxNodes + 1 },
			{ maxEdges: -1 },
			{ namespaces: [""] },
			{ principal: "root" },
		]) {
			expect(() => graph(env, ["wiki"], bad as never)).toThrow();
		}
		expect(() =>
			readGraph({ ...deps(env), options: {} as never }, access("wiki"), {}),
		).toThrow();
	});
});
