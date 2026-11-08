// KG scenarios (kg.md §2): the graph is read through the API within the caller's scope. Nodes
// are entities joined by the model's `same` judgments, edges are the relations between them, and
// every quotation leads back to the original text. The scripts answer by call order and purpose
// only, so the extraction is the same for every fragment and the identity script answers the
// candidate ids it knows (one candidate per mention, or two for the third document).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { GraphResponse } from "../../src/contracts/index.js";
import type { ScriptedCallInfo } from "../mocks/inference.js";
import {
	ALICE,
	BOB,
	answering,
	createScenario,
	type Scenario,
	type ScenarioOptions,
} from "./harness.js";

const opened: Scenario[] = [];
async function open(options: ScenarioOptions) {
	const scenario = await createScenario(options);
	opened.push(scenario);
	return scenario;
}
afterEach(async () => {
	for (const scenario of opened.splice(0).reverse())
		await scenario.close().catch(() => {});
});

const sha = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

const GATE = "北水門";
const ROAD = "搬入路";
const SUMMARY = "合成の実体の要約。";
const A = `# 水門の点検\n\n${GATE}の点検の日に${ROAD}を確認した。\n`;
const B = `# 架空商店の週報\n\n${GATE}の近くの${ROAD}で工事があった。\n`;
const C = `# 搬入の記録\n\n${GATE}の脇の${ROAD}に資材を置いた。\n`;

const entities = [
	{
		id: "e1",
		name: GATE,
		type: "合成の施設",
		description: "試験用の言及",
		evidence: [GATE],
	},
	{
		id: "e2",
		name: ROAD,
		type: "合成の設備",
		description: "試験用の通路",
		evidence: [ROAD],
	},
];
const relation = {
	id: "r1",
	source: "e1",
	target: "e2",
	directed: false,
	relation: "隣接",
	description: "試験用の関係",
	keywords: ["隣"],
	qualifiers: { negated: false, condition: null, certainty: "stated" },
	evidence: [GATE],
};
const extractionAnswer = JSON.stringify({ entities, relations: [relation] });

/** Every fragment names both entities and one relation between them. */
const extraction = {
	steps: (_index: number, info: ScriptedCallInfo) =>
		answering(info, extractionAnswer),
};

const decisionsOf = (candidates: string[], decision: string) =>
	JSON.stringify({
		decisions: candidates.map((candidate) => ({ candidate, decision })),
	});

/** Two documents: the one compared has one candidate per mention. */
function linking(decision: "same" | "different" | "unsure") {
	return {
		steps: (_index: number, info: ScriptedCallInfo) =>
			answering(
				info,
				info.instructionId === "summarize"
					? JSON.stringify({ summary: SUMMARY })
					: decisionsOf(["c1"], decision),
			),
	};
}

const doc = (namespace: string, path: string, markdown: string) => ({
	namespace,
	path,
	title: path,
	markdown,
});

function idOf(scenario: Scenario, path: string): string {
	return (
		scenario.host.store.read((db) =>
			db
				.query("SELECT document_id FROM knowledge_documents WHERE path = ?")
				.get(path),
		) as { document_id: string }
	).document_id;
}

const labels = (g: GraphResponse) =>
	g.nodes.map((n) => [n.label, n.mentionCount, n.documentIds.length]);

test("同じ実体: same と判断された言及が 1 つのノードになり、関係は 1 本の辺にまとまり、根拠は原文に戻る", async () => {
	const scenario = await open({
		documents: [doc("notes", "g/a.md", A), doc("work", "g/b.md", B)],
		inference: extraction,
		linking: linking("same"),
		linkOptions: { summaryMinMentions: 2 },
	});
	await scenario.sync();
	const a = idOf(scenario, "g/a.md");
	const b = idOf(scenario, "g/b.md");

	const g = await scenario.client(ALICE).graph({});
	expect(g).toMatchObject({ status: "ok", complete: true, partialReasons: [] });
	expect(labels(g)).toEqual([
		[GATE, 2, 2],
		[ROAD, 2, 2],
	]);
	const [gate, road] = g.nodes;
	expect(g.nodes.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
	expect(g.edges.map((e) => e.edgeId)).toEqual(["e1"]);
	expect(gate!.documentIds.sort()).toEqual([a, b].sort());
	expect(gate!.types).toEqual(["合成の施設"]);
	expect(gate!.decidedBy).toHaveLength(1);
	expect(gate!.decidedBy[0]).toMatchObject({ instructionId: "link" });
	expect(gate!.decidedBy[0]!.instructionVersion).toBeGreaterThanOrEqual(1);
	// The summary was made for exactly these two mentions.
	expect(gate!.summary).toBe(SUMMARY);
	expect(road!.summary).toBe(SUMMARY);
	expect(g.documents.map((d) => d.documentId).sort()).toEqual([a, b].sort());
	expect(g.documents.every((d) => d.state === "current")).toBe(true);

	expect(g.edges).toHaveLength(1);
	const edge = g.edges[0]!;
	expect(edge).toMatchObject({
		source: gate!.nodeId,
		target: road!.nodeId,
		directed: false,
		relation: "隣接",
		keywords: ["隣"],
		negated: false,
		certainty: "stated",
		conditions: [],
		mentionCount: 2,
	});
	expect([...edge.documentIds].sort()).toEqual([a, b].sort());

	// Every quotation is confirmed by the evidence API against its own document.
	const bodies = new Map([
		[a, A],
		[b, B],
	]);
	let confirmed = 0;
	for (const item of [...g.nodes, ...g.edges]) {
		expect(item.evidence.length).toBeGreaterThan(0);
		for (const point of item.evidence) {
			const body = bodies.get(point.documentId)!;
			expect(point.markdownSha256).toBe(sha(body));
			expect(
				await scenario.client(ALICE).evidence({
					documentId: point.documentId,
					markdownSha256: point.markdownSha256,
					byteStart: point.byteStart,
					byteEnd: point.byteEnd,
					quoteSha256: point.quoteSha256,
				}),
			).toMatchObject({ status: "valid" });
			confirmed++;
		}
	}
	expect(confirmed).toBeGreaterThanOrEqual(6);
	// A node quotes each of its documents once.
	expect(gate!.evidence.map((p) => p.documentId).sort()).toEqual([a, b].sort());
});

test("different と unsure: ノードは分かれ、辺は文書ごと。unsure は partial の理由になる", async () => {
	for (const decision of ["different", "unsure"] as const) {
		const scenario = await open({
			documents: [doc("notes", "g/a.md", A), doc("work", "g/b.md", B)],
			inference: extraction,
			linking: linking(decision),
		});
		await scenario.sync();
		const g = await scenario.client(ALICE).graph({});
		expect(g.nodes).toHaveLength(4);
		expect(
			g.nodes.every((n) => n.mentionCount === 1 && n.summary === null),
		).toBe(true);
		expect(g.nodes.every((n) => n.decidedBy.length === 0)).toBe(true);
		expect(g.edges).toHaveLength(2);
		expect(g.edges.every((e) => e.mentionCount === 1)).toBe(true);
		if (decision === "unsure") {
			expect(g.complete).toBe(false);
			expect(g.partialReasons).toEqual(["linking_unsure"]);
		} else {
			expect(g.complete).toBe(true);
		}
	}
});

/**
 * Three documents (a in notes, b and c in work). The mock lists and ingests them in the order
 * of their ids: c, a, b. The second is compared with the first (one candidate per mention), the
 * third with both (two, the first one's mention first). The answers: a is the same as c, b is the
 * same as a and unsure against c, so c and b are joined only through a.
 */
const bridged = {
	steps: (index: number, info: ScriptedCallInfo) =>
		answering(
			info,
			info.instructionId === "summarize"
				? JSON.stringify({ summary: SUMMARY })
				: JSON.stringify({
						decisions:
							index < 2
								? [{ candidate: "c1", decision: "same" }]
								: [
										{ candidate: "c1", decision: "unsure" },
										{ candidate: "c2", decision: "same" },
									],
					}),
		),
};

test("範囲外: bob には notes の文書のノード・辺・根拠・要約が見えず、範囲外の言及は bob のノードを橋渡ししない", async () => {
	const scenario = await open({
		documents: [
			doc("notes", "g/a.md", A),
			doc("work", "g/b.md", B),
			doc("work", "g/c.md", C),
		],
		inference: extraction,
		linking: bridged,
		linkOptions: { summaryMinMentions: 2 },
	});
	await scenario.sync();
	const a = idOf(scenario, "g/a.md");
	const b = idOf(scenario, "g/b.md");
	const c = idOf(scenario, "g/c.md");
	// The scripts above rely on this order (the first mention belongs to c, the last to b).
	expect([c, a, b]).toEqual([c, a, b].sort());

	const forAlice = await scenario.client(ALICE).graph({});
	expect(labels(forAlice)).toEqual([
		[GATE, 3, 3],
		[ROAD, 3, 3],
	]);
	expect(forAlice.nodes[0]!.summary).toBe(SUMMARY);
	expect(forAlice.documents.map((d) => d.documentId).sort()).toEqual(
		[a, b, c].sort(),
	);
	expect(forAlice.edges).toHaveLength(1);
	expect(forAlice.edges[0]!.mentionCount).toBe(3);

	const forBob = await scenario.client(BOB).graph({});
	// b and c are joined only through a's mentions: two nodes for each name, one mention each.
	expect(labels(forBob).sort()).toEqual(
		[
			[GATE, 1, 1],
			[GATE, 1, 1],
			[ROAD, 1, 1],
			[ROAD, 1, 1],
		].sort(),
	);
	expect(forBob.edges).toHaveLength(2);
	expect(forBob.edges.every((e) => e.mentionCount === 1)).toBe(true);
	expect(forBob.documents.map((d) => d.documentId).sort()).toEqual(
		[b, c].sort(),
	);
	expect(forBob.nodes.every((n) => n.summary === null)).toBe(true);
	expect(forBob.nodes.every((n) => n.decidedBy.length === 0)).toBe(true);
	expect(forBob.partialReasons).toEqual(["linking_unsure"]);
	const text = JSON.stringify(forBob);
	expect(text).not.toContain(a);
	expect(text).not.toContain("g/a.md");
	expect(text).not.toContain(sha(A));
	expect(text).not.toContain(SUMMARY);
	for (const item of [...forBob.nodes, ...forBob.edges]) {
		expect(item.evidence.every((p) => p.documentId !== a)).toBe(true);
	}

	// A request narrows and never widens.
	const narrowed = await scenario.client(ALICE).graph({ namespaces: ["work"] });
	expect(labels(narrowed).sort()).toEqual(labels(forBob).sort());
	expect(JSON.stringify(narrowed)).not.toContain(a);
	const widened = await scenario
		.client(BOB)
		.graph({ namespaces: ["notes", "work", "personal"] });
	expect(labels(widened).sort()).toEqual(labels(forBob).sort());
	const outside = await scenario.client(BOB).graph({ namespaces: ["notes"] });
	expect(outside.nodes).toEqual([]);
	expect(outside.edges).toEqual([]);
	expect(outside.documents).toEqual([]);
	const aliceNotesOnly = await scenario
		.client(ALICE)
		.graph({ namespaces: ["notes"] });
	expect(labels(aliceNotesOnly)).toEqual([
		[GATE, 1, 1],
		[ROAD, 1, 1],
	]);
	expect(aliceNotesOnly.nodes.every((n) => n.summary === null)).toBe(true);
});

test("切り詰め: maxNodes と maxEdges を超えたら、返す分だけにして理由を返す", async () => {
	const scenario = await open({
		documents: [doc("notes", "g/a.md", A), doc("work", "g/b.md", B)],
		inference: extraction,
		linking: linking("same"),
	});
	await scenario.sync();
	const one = await scenario.client(ALICE).graph({ maxNodes: 1 });
	expect(one.nodes).toHaveLength(1);
	// An edge needs both of its nodes.
	expect(one.edges).toEqual([]);
	expect(one.partialReasons).toEqual(["nodes_truncated"]);
	expect(one.complete).toBe(false);

	const none = await scenario.client(ALICE).graph({ maxEdges: 0 });
	expect(none.nodes).toHaveLength(2);
	expect(none.edges).toEqual([]);
	expect(none.partialReasons).toEqual(["edges_truncated"]);

	const all = await scenario.client(ALICE).graph({ maxNodes: 2, maxEdges: 1 });
	expect(all.complete).toBe(true);
	expect(all.edges).toHaveLength(1);
});

test("新版で言及が消える: ノードも辺も現在の版に従い、古いリンクや要約は返らない", async () => {
	let aWithoutEntities = false;
	const scenario = await open({
		documents: [doc("notes", "g/a.md", A), doc("work", "g/b.md", B)],
		inference: {
			steps: (_index: number, info: ScriptedCallInfo) =>
				answering(
					info,
					aWithoutEntities
						? JSON.stringify({ entities: [], relations: [] })
						: extractionAnswer,
				),
		},
		linking: linking("same"),
		linkOptions: { summaryMinMentions: 2 },
	});
	await scenario.sync();
	const a = idOf(scenario, "g/a.md");
	const b = idOf(scenario, "g/b.md");
	const before = await scenario.client(ALICE).graph({});
	expect(labels(before)).toEqual([
		[GATE, 2, 2],
		[ROAD, 2, 2],
	]);

	aWithoutEntities = true;
	scenario.docling.control.setMarkdown(
		a,
		"# 水門の点検\n\n点検は毎週火曜日に行う。\n",
	);
	await scenario.sync();
	const after = await scenario.client(ALICE).graph({});
	expect(after.complete).toBe(true);
	expect(labels(after)).toEqual([
		[GATE, 1, 1],
		[ROAD, 1, 1],
	]);
	expect(after.edges).toHaveLength(1);
	expect(after.edges[0]!.mentionCount).toBe(1);
	expect(after.documents.map((d) => d.documentId)).toEqual([b]);
	expect(JSON.stringify(after)).not.toContain(a);
	expect(after.nodes.every((n) => n.summary === null)).toBe(true);
	expect(scenario.count("knowledge_entity_links")).toBe(0);
});
