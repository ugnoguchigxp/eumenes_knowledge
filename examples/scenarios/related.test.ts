// P3 scenarios (p3.md §8): identity across documents is a model judgment kept as a link with its
// provenance; related documents and summaries are read through the API within the caller's scope,
// and follow the current versions. The scripts answer by call order and purpose only.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

const NAME = "北水門";
const A = `# 水門の点検\n\n${NAME}の点検は毎週火曜日に行う。\n`;
const B = `# 架空商店の週報\n\n${NAME}の近くで搬入路の工事があった。\n`;

/** Every fragment of these short documents is one fragment that names the entity once. */
const extraction = {
	steps: (_index: number, info: ScriptedCallInfo) =>
		answering(
			info,
			JSON.stringify({
				entities: [
					{
						id: "e1",
						name: NAME,
						type: "合成の施設",
						description: "試験用の言及",
						evidence: [NAME],
					},
				],
				relations: [],
			}),
		),
};

/** One candidate per identity call in these scenarios: answer it with `decision`. */
function linking(decision: "same" | "different" | "unsure") {
	return {
		steps: (_index: number, info: ScriptedCallInfo) =>
			answering(
				info,
				info.instructionId === "summarize"
					? JSON.stringify({ summary: `${NAME}は合成の施設である。` })
					: JSON.stringify({ decisions: [{ candidate: "c1", decision }] }),
			),
	};
}

function documents(
	extra: { namespace: string; path: string; markdown: string }[] = [],
) {
	return [
		{ namespace: "notes", path: "rel/a.md", title: "点検", markdown: A },
		{ namespace: "work", path: "rel/b.md", title: "週報", markdown: B },
		...extra.map((d) => ({ ...d, title: d.path })),
	];
}

function idOf(scenario: Scenario, path: string): string {
	return (
		scenario.host.store.read((db) =>
			db
				.query("SELECT document_id FROM knowledge_documents WHERE path = ?")
				.get(path),
		) as { document_id: string }
	).document_id;
}

test("同じ実体: LLM が same と判断した言及で文書がつながり、両方の根拠と判断の由来を返す", async () => {
	const scenario = await open({
		documents: documents(),
		inference: extraction,
		linking: linking("same"),
	});
	await scenario.sync();
	const a = idOf(scenario, "rel/a.md");
	const b = idOf(scenario, "rel/b.md");

	const related = await scenario.client(ALICE).related({ documentId: a });
	expect(related).toMatchObject({ status: "ok", complete: true });
	expect(related.document).toEqual({ documentId: a, markdownSha256: sha(A) });
	expect(related.results).toHaveLength(1);
	const hit = related.results[0]!;
	expect(hit).toMatchObject({ rank: 1, documentId: b, markdownSha256: sha(B) });
	const shared = hit.shared[0]!;
	expect(shared).toMatchObject({ label: NAME, relatedLabel: NAME });
	expect(shared.decidedBy).toMatchObject({
		instructionId: "link",
		instructionVersion: 3,
	});
	// Both quotations lead back to the documents, and the evidence check confirms them.
	for (const [id, body, points] of [
		[a, A, shared.evidence.document],
		[b, B, shared.evidence.related],
	] as const) {
		const point = points[0]!;
		expect(
			Buffer.from(
				Buffer.from(body, "utf8").subarray(point.byteStart, point.byteEnd),
			).toString("utf8"),
		).toBe(NAME);
		expect(
			await scenario.client(ALICE).evidence({
				documentId: id,
				markdownSha256: sha(body),
				byteStart: point.byteStart,
				byteEnd: point.byteEnd,
				quoteSha256: point.quoteSha256,
			}),
		).toMatchObject({ status: "valid", quote: NAME });
	}
	// The other direction gives the same pair.
	const back = await scenario.client(ALICE).related({ documentId: b });
	expect(back.results.map((r) => r.documentId)).toEqual([a]);
});

test("different と unsure: 同じ実体として数えず、unsure は partial の理由になる", async () => {
	for (const decision of ["different", "unsure"] as const) {
		const scenario = await open({
			documents: documents(),
			inference: extraction,
			linking: linking(decision),
		});
		await scenario.sync();
		const related = await scenario
			.client(ALICE)
			.related({ documentId: idOf(scenario, "rel/a.md") });
		expect(related.results).toEqual([]);
		if (decision === "unsure") {
			expect(related.complete).toBe(false);
			expect(related.partialReasons).toContain("linking_unsure");
		} else expect(related.complete).toBe(true);
	}
});

test("範囲外: bob には notes の文書の関連が見えず、範囲外の言及を含むまとまりの要約も返らない", async () => {
	// (Without a direct b–c link, Bob would see nothing: an out-of-scope mention never bridges two
	// documents.)
	const scenario = await open({
		documents: documents([
			{
				namespace: "work",
				path: "rel/c.md",
				markdown: `# 搬入\n\n${NAME}の脇に資材を置いた。\n`,
			},
		]),
		inference: extraction,
		// By the order of the identity calls: the second document has one candidate, the third has
		// two (both earlier mentions); every pair is judged the same, so b and c are linked directly.
		linking: {
			steps: (index: number, info: ScriptedCallInfo) =>
				answering(
					info,
					info.instructionId === "summarize"
						? JSON.stringify({ summary: `${NAME}は合成の施設である。` })
						: JSON.stringify({
								decisions: (index === 0 ? ["c1"] : ["c1", "c2"]).map(
									(candidate) => ({ candidate, decision: "same" }),
								),
							}),
				),
		},
		linkOptions: { summaryMinMentions: 2 },
	});
	await scenario.sync();
	const a = idOf(scenario, "rel/a.md");
	const b = idOf(scenario, "rel/b.md");
	const c = idOf(scenario, "rel/c.md");

	expect(await scenario.client(BOB).related({ documentId: a })).toMatchObject({
		status: "not_available",
		results: [],
		document: null,
	});
	const fromB = await scenario.client(BOB).related({ documentId: b });
	expect(fromB.results.map((r) => r.documentId)).toEqual([c]);
	// The entity also has a mention in `notes` (outside Bob's scope): no summary for Bob.
	expect(fromB.results[0]!.shared[0]!.summary).toBeNull();
	// Alice sees every mention of the entity: the summary is returned.
	const forAlice = await scenario.client(ALICE).related({ documentId: b });
	expect(forAlice.results.map((r) => r.documentId).sort()).toEqual(
		[a, c].sort(),
	);
	expect(forAlice.results[0]!.shared[0]!.summary).toBe(
		`${NAME}は合成の施設である。`,
	);
});

test("比べる前: 取り込んだばかりで同一視の連鎖がまだなら linking_pending で partial", async () => {
	const scenario = await open({
		documents: documents(),
		inference: extraction,
		linking: linking("same"),
	});
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	// Run the listing and the ingest chain only, not the identity chain.
	for (let i = 0; i < 100; i++) {
		const next = scenario
			.jobs()
			.find(
				(j) =>
					j.state === "queued" &&
					(j.kind === "knowledge.sync-page" ||
						j.kind === "knowledge.ingest-next"),
			);
		if (!next) break;
		const pendingLinks = scenario
			.jobs("knowledge.link-next")
			.filter((j) => j.state === "queued");
		// Steps run oldest first: stop before a queued identity link would run.
		if (
			pendingLinks.some(
				(l) => l.availableAtMs <= next.availableAtMs && l.id < next.id,
			)
		)
			break;
		await scenario.host.runner.step();
	}
	const related = await scenario
		.client(ALICE)
		.related({ documentId: idOf(scenario, "rel/a.md") });
	expect(related.complete).toBe(false);
	expect(related.partialReasons).toContain("linking_pending");

	await scenario.host.runner.runUntilIdle({ maxSteps: 1000 });
	const after = await scenario
		.client(ALICE)
		.related({ documentId: idOf(scenario, "rel/a.md") });
	expect(after.complete).toBe(true);
	expect(after.results).toHaveLength(1);
});

test("新版で言及が消える: リンクとまとまりが現在の版に従い、関連文書から外れる", async () => {
	const scenario = await open({
		documents: documents(),
		inference: {
			// The new version of A no longer names the entity: its extraction is empty.
			steps: (_index: number, info: ScriptedCallInfo) => answerFor(info),
		},
		linking: linking("same"),
	});
	let aWithoutEntity = false;
	function answerFor(info: ScriptedCallInfo) {
		return aWithoutEntity
			? answering(info, JSON.stringify({ entities: [], relations: [] }))
			: extraction.steps(0, info);
	}
	await scenario.sync();
	const a = idOf(scenario, "rel/a.md");
	const b = idOf(scenario, "rel/b.md");
	expect(
		(await scenario.client(ALICE).related({ documentId: b })).results,
	).toHaveLength(1);

	aWithoutEntity = true;
	scenario.docling.control.setMarkdown(
		a,
		"# 水門の点検\n\n点検は毎週火曜日に行う。\n",
	);
	await scenario.sync();
	const after = await scenario.client(ALICE).related({ documentId: b });
	expect(after.results).toEqual([]);
	expect(after.complete).toBe(true);
	// The old version's mention and its link were cleaned up with the retired version.
	expect(scenario.count("knowledge_entity_links")).toBe(0);
});

test("取り込み待ちの文書: 関連文書の起点にすると stale を返す", async () => {
	const scenario = await open({
		documents: documents(),
		inference: extraction,
		linking: linking("same"),
	});
	await scenario.sync();
	const a = idOf(scenario, "rel/a.md");
	scenario.docling.control.setMarkdown(a, `# 水門\n\n${NAME}の新版。\n`);
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	await scenario.host.runner.step(); // the listing only
	const related = await scenario.client(ALICE).related({ documentId: a });
	expect(related).toMatchObject({
		status: "stale",
		document: null,
		results: [],
	});
});

test("範囲外の言及を橋にしない: b と c が notes の a を通してだけつながるとき、bob には関連が出ない", async () => {
	const scenario = await open({
		documents: documents([
			{
				namespace: "work",
				path: "rel/c.md",
				markdown: `# 搬入\n\n${NAME}の脇に資材を置いた。\n`,
			},
		]),
		inference: extraction,
		// By the order of the identity calls: the second document has one candidate (same); the
		// third has two, answered "same" for the first and explicitly "unsure" for the second, so b
		// and c are linked only through a. (Every candidate must be answered: an answer that leaves
		// one out fails the mention.)
		linking: {
			steps: (index: number, info: ScriptedCallInfo) =>
				answering(
					info,
					info.instructionId === "summarize"
						? JSON.stringify({ summary: `${NAME}は合成の施設である。` })
						: JSON.stringify({
								decisions:
									index === 0
										? [{ candidate: "c1", decision: "same" }]
										: [
												{ candidate: "c1", decision: "same" },
												{ candidate: "c2", decision: "unsure" },
											],
							}),
				),
		},
	});
	await scenario.sync();
	const b = idOf(scenario, "rel/b.md");
	const forBob = await scenario.client(BOB).related({ documentId: b });
	expect(forBob.results).toEqual([]);
	expect(forBob.partialReasons).toContain("linking_unsure");
	const forAlice = await scenario.client(ALICE).related({ documentId: b });
	expect(forAlice.results).toHaveLength(2);
});
