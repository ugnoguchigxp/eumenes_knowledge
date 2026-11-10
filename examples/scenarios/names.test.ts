// KG2 scenarios (kg2.md G3・G4): the model-free extractor through the example host and its API.
// No model is asked: names come from the package's tokenizer and rules, mentions of one namespace
// with the same identity key are one entity when read, and every quotation checks out.
import { afterEach, expect, test } from "bun:test";
import { ALICE, BOB, createScenario, type Scenario } from "./harness.js";

const opened: Scenario[] = [];
async function open() {
	const scenario = await createScenario({
		documents: [
			{
				namespace: "notes",
				path: "names/a.md",
				title: "点検",
				markdown: "# 水門の点検\n\n北水門の点検は Lantern で記録する。\n",
			},
			{
				namespace: "notes",
				path: "names/b.md",
				title: "週報",
				markdown: "# 週報\n\nＬａｎｔｅｒｎ の画面で北水門の記録を見た。\n",
			},
			{
				namespace: "work",
				path: "names/c.md",
				title: "別の部署",
				markdown: "# 別の部署\n\nLantern という同じ名前の別の道具。\n",
			},
		],
		ingestOptions: { extractor: "names" },
	});
	opened.push(scenario);
	return scenario;
}
afterEach(async () => {
	for (const scenario of opened.splice(0).reverse())
		await scenario.close().catch(() => {});
});

const idOf = (scenario: Scenario, path: string): string =>
	(
		scenario.host.store.read((db) =>
			db
				.query("SELECT document_id FROM knowledge_documents WHERE path = ?")
				.get(path),
		) as { document_id: string }
	).document_id;

const KEY = { model: null, instructionId: "name_key", instructionVersion: 1 };

test("名前の抽出器: モデルを呼ばずに取り込み、同じ namespace で同じキーの言及が 1 つの実体になる", async () => {
	const scenario = await open();
	await scenario.sync();
	expect(scenario.inference.calls()).toHaveLength(0);
	const [a, b, c] = ["names/a.md", "names/b.md", "names/c.md"].map((p) =>
		idOf(scenario, p),
	) as [string, string, string];

	const graph = await scenario.client(ALICE).graph({});
	expect(graph).toMatchObject({ status: "ok", complete: true });
	const lanterns = graph.nodes.filter((n) => n.names.includes("Lantern"));
	// One node per namespace: notes (a, b) and work (c).
	expect(lanterns.map((n) => [...n.documentIds].sort())).toEqual([
		[a, b].sort(),
		[c],
	]);
	expect(lanterns[0]?.names).toContain("Ｌａｎｔｅｒｎ");
	expect(lanterns[0]?.decidedBy).toEqual([KEY]);
	const sluice = graph.nodes.find((n) => n.names.includes("北水門"));
	expect(sluice?.documentIds.length).toBe(2);
	// No edge: the model-free extractor makes no relation (kg2.md §7.14).
	expect(graph.edges).toEqual([]);

	// Every quotation of the graph checks out with the evidence API.
	for (const point of graph.nodes.flatMap((n) => n.evidence)) {
		const answer = await scenario.client(ALICE).evidence({
			documentId: point.documentId,
			markdownSha256: point.markdownSha256,
			byteStart: point.byteStart,
			byteEnd: point.byteEnd,
			quoteSha256: point.quoteSha256,
		});
		expect(answer.status).toBe("valid");
	}
});

test("名前の抽出器: キーを共有する文書が関連文書になり、別の namespace の文書は入らない", async () => {
	const scenario = await open();
	await scenario.sync();
	const [a, b, c] = ["names/a.md", "names/b.md", "names/c.md"].map((p) =>
		idOf(scenario, p),
	) as [string, string, string];
	const related = await scenario
		.client(ALICE)
		.related({ documentId: a, routes: ["entities"] });
	expect(related).toMatchObject({ status: "ok", complete: true });
	expect(related.results.map((r) => r.documentId)).toEqual([b]);
	const labels = related.results[0]?.shared.map((s) => s.label).sort();
	expect(labels).toEqual(["Lantern", "北水門", "記録"].sort());
	for (const s of related.results[0]?.shared ?? [])
		expect(s.decidedBy).toEqual(KEY);
	// Bob reads `work` alone: its Lantern shares a key with nothing he may read.
	const bob = await scenario
		.client(BOB)
		.related({ documentId: c, routes: ["entities"] });
	expect(bob.results).toEqual([]);
});

test("関連文書の 2 つの経路: 名前と埋め込みで見つけた文書が先、埋め込みだけの文書は共有する実体なし、断片の組は根拠として確かめられる", async () => {
	const scenario = await open();
	await scenario.sync();
	const [a, b, c] = ["names/a.md", "names/b.md", "names/c.md"].map((p) =>
		idOf(scenario, p),
	) as [string, string, string];
	const related = await scenario.client(ALICE).related({ documentId: a });
	expect(related).toMatchObject({ status: "ok", complete: true });
	expect(related.results.map((r) => [r.documentId, r.routes])).toEqual([
		[b, ["entities", "embedding"]],
		[c, ["embedding"]],
	]);
	expect(related.results[1]?.shared).toEqual([]);
	const bodies = new Map<string, string>();
	for (const r of related.results) {
		expect(r.passages.length).toBeGreaterThan(0);
		for (const pair of r.passages)
			for (const [documentId, markdownSha256, point] of [
				[a, related.document?.markdownSha256 as string, pair.document],
				[r.documentId, r.markdownSha256, pair.related],
			] as const) {
				const answer = await scenario.client(ALICE).evidence({
					documentId,
					markdownSha256,
					byteStart: point.byteStart,
					byteEnd: point.byteEnd,
					quoteSha256: point.quoteSha256,
				});
				expect(answer.status).toBe("valid");
				if (answer.status === "valid") bodies.set(documentId, answer.quote);
			}
	}
	// The whole fragment is the quotation.
	expect(bodies.get(c)).toContain("Lantern という同じ名前の別の道具。");
	// Bob reads `work` alone: nothing else is near c for him.
	const bob = await scenario.client(BOB).related({ documentId: c });
	expect(bob.results).toEqual([]);
});
