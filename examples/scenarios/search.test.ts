// P3 scenarios (p3.md §1, §3, §4): a search result leads back to the document id, version, byte
// range and quote digest; the evidence check confirms or refuses it after invalidation. Everything
// goes through the HTTP API and the package client, on the real package with the example host.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	EmbeddingPort,
	EvidenceRequest,
	SearchHit,
} from "../../src/contracts/index.js";
import { chunkMarkdown } from "../../src/core/index.js";
import { createMeaninglessHashEmbedding } from "../mocks/embedding.js";
import type { ScriptedStep } from "../mocks/inference.js";
import {
	ALICE,
	BOB,
	EMPTY_EXTRACTION,
	EXTRACT_CALL,
	TEST_SPACE,
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

const BODY_NOTES =
	"# 星見町の水門\n\n北水門の点検は毎週火曜日に行う。点検記録は管理棟に保管する。\n";
const BODY_WORK =
	"# 架空商店の週報\n\n今週は棚卸しを実施した。在庫の差異は三件だった。\n";

function docs() {
	return [
		{
			namespace: "notes",
			path: "search/notes.md",
			title: "水門",
			markdown: BODY_NOTES,
		},
		{
			namespace: "work",
			path: "search/work.md",
			title: "週報",
			markdown: BODY_WORK,
		},
	];
}

/** Scripted extraction by call order: one entity per fragment of the documents, in order. */
function extractionFor(bodies: readonly string[], names: readonly string[]) {
	const answers: ScriptedStep[] = [];
	bodies.forEach((body, d) => {
		for (const fragment of chunkMarkdown(Buffer.from(body), body)) {
			const name = names[d]!;
			answers.push(
				fragment.text.includes(name)
					? {
							expect: EXTRACT_CALL,
							answer: {
								text: JSON.stringify({
									entities: [
										{
											id: "e1",
											name,
											type: "合成の対象",
											description: "試験用の言及",
											evidence: [name],
										},
									],
									relations: [],
								}),
							},
						}
					: { expect: EXTRACT_CALL, answer: { text: EMPTY_EXTRACTION } },
			);
		}
	});
	return {
		steps: (index: number) =>
			answers[index] ?? {
				expect: EXTRACT_CALL,
				answer: { text: EMPTY_EXTRACTION },
			},
	};
}

function evidenceOf(hit: SearchHit): EvidenceRequest {
	return {
		documentId: hit.documentId,
		markdownSha256: hit.markdownSha256,
		byteStart: hit.fragment.byteStart,
		byteEnd: hit.fragment.byteEnd,
		quoteSha256: hit.quoteSha256,
	};
}

test("検索→根拠: 結果から文書 ID・版・byte 範囲・引用 digest に戻り、根拠取得で原文が一致する", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const result = await scenario.client(ALICE).search({ query: "点検記録" });
	expect(result.results.length).toBeGreaterThan(0);
	const hit = result.results[0]!;
	expect(hit.path).toBe("search/notes.md");
	expect(hit.markdownSha256).toBe(sha(BODY_NOTES));
	const bytes = Buffer.from(BODY_NOTES, "utf8");
	expect(
		Buffer.from(
			bytes.subarray(hit.fragment.byteStart, hit.fragment.byteEnd),
		).toString("utf8"),
	).toBe(hit.quote);
	expect(hit.quoteSha256).toBe(sha(hit.quote));
	expect(hit.matchedBy.map((m) => m.route)).toContain("text");

	const checked = await scenario.client(ALICE).evidence(evidenceOf(hit));
	expect(checked).toEqual({
		status: "valid",
		quote: hit.quote,
		state: "current",
	});
	expect(result.complete).toBe(true);
});

test("新版の後: 古い参照は stale で現在の版を示し、検索は新版の原文だけを返す", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const before = (await scenario.client(ALICE).search({ query: "点検記録" }))
		.results[0]!;
	const id = before.documentId;
	const v2 = "# 星見町の水門\n\n南水門の点検は毎週木曜日に移った。\n";
	scenario.docling.control.setMarkdown(id, v2);
	await scenario.sync();

	expect(await scenario.client(ALICE).evidence(evidenceOf(before))).toEqual({
		status: "stale",
		currentMarkdownSha256: sha(v2),
	});
	const old = await scenario.client(ALICE).search({ query: "点検記録" });
	// No hit of the document carries the old version (the vector route may still return the
	// document, with its new version).
	for (const h of old.results.filter((h) => h.documentId === id)) {
		expect(h.markdownSha256).toBe(sha(v2));
		expect(h.quote).not.toContain("点検記録");
	}
	const now = await scenario.client(ALICE).search({ query: "南水門" });
	expect(now.results[0]).toMatchObject({
		documentId: id,
		markdownSha256: sha(v2),
	});
});

test("取り込み待ちの間: 旧版を現在の根拠として返さず、検索は partial を返す", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const before = (await scenario.client(ALICE).search({ query: "点検記録" }))
		.results[0]!;
	scenario.docling.control.setMarkdown(before.documentId, "# 水門\n\n新版。\n");
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	await scenario.host.runner.step(); // only the listing: the new version is not applied yet
	const result = await scenario.client(ALICE).search({ query: "点検記録" });
	expect(
		result.results.filter((h) => h.documentId === before.documentId),
	).toEqual([]);
	expect(result.complete).toBe(false);
	expect(result.partialReasons).toContain("stale_documents");
	expect(result.coverage.stale).toBe(1);
	expect(
		(await scenario.client(ALICE).evidence(evidenceOf(before))).status,
	).toBe("stale");
});

test("取得不能: unavailable の文書は検索に出ず、根拠は unavailable", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const before = (await scenario.client(ALICE).search({ query: "点検記録" }))
		.results[0]!;
	scenario.docling.control.setMarkdown(before.documentId, "# 水門\n\n新版。\n");
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	await scenario.host.runner.step();
	scenario.docling.control.removeDocument(before.documentId); // the read answers 404
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	expect(scenario.documentRow(before.documentId)?.state).toBe("unavailable");

	const result = await scenario.client(ALICE).search({ query: "点検記録" });
	expect(
		result.results.filter((h) => h.documentId === before.documentId),
	).toEqual([]);
	expect(result.partialReasons).toContain("unavailable_documents");
	expect(
		(await scenario.client(ALICE).evidence(evidenceOf(before))).status,
	).toBe("unavailable");
});

test("範囲外: bob には notes の文書が見えず、根拠取得は未知の文書と同じ not_available", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const hit = (await scenario.client(ALICE).search({ query: "点検記録" }))
		.results[0]!;
	const bob = await scenario.client(BOB).search({ query: "点検記録" });
	expect(bob.results.every((h) => h.namespace === "work")).toBe(true);
	expect(bob.coverage.documents).toBe(1); // only `work`
	expect(await scenario.client(BOB).evidence(evidenceOf(hit))).toEqual({
		status: "not_available",
	});
	const unknown = { ...evidenceOf(hit), documentId: `wiki-${"0".repeat(32)}` };
	expect(await scenario.client(ALICE).evidence(unknown)).toEqual({
		status: "not_available",
	});
	// A narrowing outside the caller's namespaces never widens them.
	const widened = await scenario
		.client(BOB)
		.search({ query: "点検記録", namespaces: ["notes"] });
	expect(widened.results).toEqual([]); // the intersection is empty: no route runs
	expect(widened.complete).toBe(false);
});

test("namespace の絞り込み: 要求の namespaces は呼出し側の範囲の中だけを絞る", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const all = await scenario
		.client(ALICE)
		.search({ query: "点検", routes: ["text"] });
	expect(all.results.some((h) => h.namespace === "notes")).toBe(true);
	const work = await scenario
		.client(ALICE)
		.search({ query: "点検", routes: ["text"], namespaces: ["work"] });
	expect(work.results.every((h) => h.namespace === "work")).toBe(true);
	expect(work.coverage.documents).toBe(1);
});

test("2 文字の query: 部分一致の走査に切り替え、そのことを結果に示す", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const result = await scenario
		.client(ALICE)
		.search({ query: "水門", routes: ["text"] });
	expect(result.lexicalMode).toBe("substring_scan");
	expect(result.results[0]?.path).toBe("search/notes.md");
});

test("言及の経路: 当たった言及の根拠の範囲を返し、その範囲も根拠取得で一致する", async () => {
	// One document: the chain picks documents in registry order, and the script is by call order.
	const scenario = await open({
		documents: [docs()[0]!],
		inference: extractionFor([BODY_NOTES], ["北水門"]),
	});
	await scenario.sync();
	const result = await scenario
		.client(ALICE)
		.search({ query: "北水門", routes: ["entity"] });
	const hit = result.results[0]!;
	expect(hit.matchedBy).toEqual([{ route: "entity", rank: 1 }]);
	const mention = hit.mentions[0]!;
	expect(mention).toMatchObject({ kind: "entity", label: "北水門" });
	const range = mention.evidence[0]!;
	const quote = Buffer.from(
		Buffer.from(BODY_NOTES, "utf8").subarray(range.byteStart, range.byteEnd),
	).toString("utf8");
	expect(quote).toBe("北水門");
	expect(
		await scenario.client(ALICE).evidence({
			documentId: hit.documentId,
			markdownSha256: hit.markdownSha256,
			...range,
		}),
	).toEqual({ status: "valid", quote: "北水門", state: "current" });
});

test("改ざん・範囲外の参照: 引用 digest か範囲が合わなければ mismatch", async () => {
	const scenario = await open({ documents: docs() });
	await scenario.sync();
	const hit = (await scenario.client(ALICE).search({ query: "点検記録" }))
		.results[0]!;
	const base = evidenceOf(hit);
	expect(
		(
			await scenario
				.client(ALICE)
				.evidence({ ...base, quoteSha256: sha("別の引用") })
		).status,
	).toBe("mismatch");
	const size = Buffer.byteLength(BODY_NOTES);
	expect(
		(
			await scenario
				.client(ALICE)
				.evidence({ ...base, byteStart: size, byteEnd: size + 10 })
		).status,
	).toBe("mismatch");
});

test("query の埋め込みの失敗: ベクトルの経路だけが failed になり、ほかの経路の結果を partial で返す", async () => {
	const hash = createMeaninglessHashEmbedding({ space: TEST_SPACE });
	const embedding: EmbeddingPort = {
		async embed(texts, kind, signal) {
			if (kind === "query") throw new Error("embedding_unavailable");
			return hash.port.embed(texts, kind, signal);
		},
	};
	const scenario = await open({ documents: docs(), embedding });
	await scenario.sync();
	const result = await scenario.client(ALICE).search({ query: "点検記録" });
	expect(result.results[0]?.path).toBe("search/notes.md");
	expect(result.routes.find((r) => r.route === "vector")?.status).toBe(
		"failed",
	);
	expect(result.complete).toBe(false);
	expect(result.partialReasons).toContain("vector_unavailable");
});
