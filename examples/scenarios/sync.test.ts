// P1 scenarios (p1.md §6): synthetic documents through the same public contract, end to end.
import { afterEach, expect, test } from "bun:test";
import { KNOWLEDGE_JOB_KINDS } from "../../src/contracts/index.js";
import { fixtureNames, readFixtureBytes } from "../fixtures/index.js";
import {
	ALICE,
	BOB,
	createScenario,
	fixtureId,
	fixtureSha256,
	type Scenario,
} from "./harness.js";

let scenario: Scenario | undefined;
afterEach(async () => {
	await scenario?.close();
	scenario = undefined;
});

test("合成文書の同期: mock Docling → 2 つのジョブ → 登録簿 current → API → client の status が一致する", async () => {
	scenario = await createScenario({ pageSize: 4 });
	const { accepted, finished } = await scenario.sync();

	expect(accepted.state).toBe("accepted");
	expect(finished).toMatchObject({
		state: "completed",
		complete: true,
		errorCode: null,
	});
	// Counts are not part of the answer (they would cover other principals' namespaces).
	expect(finished).not.toHaveProperty("documentsQueued");
	expect(scenario.jobs(KNOWLEDGE_JOB_KINDS.syncPage)).toHaveLength(2);
	expect(scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext)).toHaveLength(
		fixtureNames.length,
	);
	const status = await scenario.client(ALICE).status();
	expect(status.documents).toEqual({
		total: fixtureNames.length,
		current: fixtureNames.length,
		unverified: 0,
		stale: 0,
		unavailable: 0,
		excluded: 0,
		removed: 0,
	});
	expect(status.complete).toBe(true);
	expect(status.partialReasons).toEqual([]);
	// Docling only received reads: the source of truth is never written.
	expect(
		scenario.docling.control.requests().every((r) => r.method === "GET"),
	).toBe(true);
});

test("日本語・BOM・CRLF・frontmatter: 適用した版と byte 長が、fixture ファイルの bytes と一致する", async () => {
	scenario = await createScenario();
	await scenario.sync();
	for (const name of fixtureNames) {
		const row = scenario.documentRow(fixtureId(name));
		const bytes = await readFixtureBytes(name);
		expect(row?.state).toBe("current");
		expect(row?.applied_markdown_sha256).toBe(await fixtureSha256(name));
		expect(row?.applied_byte_length).toBe(bytes.byteLength);
		// The mock (Docling's rule) agrees on the same digest: the body was not altered on the way.
		expect(
			scenario.docling.control.snapshot(fixtureId(name))?.markdownSha256,
		).toBe(row?.applied_markdown_sha256 ?? "");
	}
	// The BOM variant really starts with EF BB BF, and its digest differs from the plain file.
	const bom = await readFixtureBytes("canal-guide-bom");
	expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	expect(await fixtureSha256("canal-guide-bom")).not.toBe(
		await fixtureSha256("canal-guide"),
	);
});

test("同じ版の再同期: 取り込みジョブ・登録簿の行・世代が増えない", async () => {
	scenario = await createScenario();
	await scenario.sync();
	const ingestJobs = scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext).length;
	const rows = scenario.count("knowledge_documents");
	const generation = scenario.documentRow(fixtureId("shop-log"))?.generation;

	const again = await scenario.sync();
	expect(again.finished.state).toBe("completed");
	expect(scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext).length).toBe(ingestJobs);
	expect(scenario.count("knowledge_documents")).toBe(rows);
	expect(scenario.documentRow(fixtureId("shop-log"))?.generation).toBe(
		generation,
	);
});

test("新版の検知: 一覧の markdownSha256 が変わると stale になり、取り込み後に current へ戻る", async () => {
	scenario = await createScenario();
	await scenario.sync();
	const id = fixtureId("shop-log");
	const before = scenario.documentRow(id)!;
	scenario.docling.control.setMarkdown(id, "# 架空商店\n\n新しい版の本文。\n");

	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	// Run only the listing page: the new version is observed but not applied yet.
	const first = await scenario.host.runner.step();
	expect(first).toMatchObject({ kind: KNOWLEDGE_JOB_KINDS.syncPage });
	expect(scenario.documentRow(id)).toMatchObject({
		state: "stale",
		generation: before.generation + 1,
		applied_markdown_sha256: before.applied_markdown_sha256,
	});
	const bob = await scenario.client(BOB).status();
	expect(bob.documents.stale).toBe(1);
	expect(bob.complete).toBe(false);
	expect(bob.partialReasons).toContain("stale_documents");

	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	const after = scenario.documentRow(id)!;
	expect(after.state).toBe("current");
	expect(after.applied_markdown_sha256).toBe(
		scenario.docling.control.snapshot(id)!.markdownSha256,
	);
	expect(after.applied_markdown_sha256).not.toBe(
		before.applied_markdown_sha256,
	);
});

test("recovery だけの変更: ETag・contentDigest が変わっても再取り込みしない", async () => {
	scenario = await createScenario();
	await scenario.sync();
	const id = fixtureId("canal-guide");
	const before = scenario.documentRow(id)!;
	const etagBefore = scenario.docling.control.snapshot(id)!.etag;
	scenario.docling.control.setRecovery(id, '{"editor":"changed-only"}');
	expect(scenario.docling.control.snapshot(id)!.etag).not.toBe(etagBefore);
	const ingestJobs = scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext).length;

	await scenario.sync();
	expect(scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext).length).toBe(ingestJobs);
	const after = scenario.documentRow(id)!;
	expect(after.state).toBe("current");
	expect(after.generation).toBe(before.generation);
	expect(after.applied_markdown_sha256).toBe(before.applied_markdown_sha256);
	// The new ETag is recorded as an observation only.
	expect(after.observed_etag).toBe(scenario.docling.control.snapshot(id)!.etag);
});

test("path・title だけの変更: 本文を取り込み直さず、メタ情報だけ更新する", async () => {
	scenario = await createScenario();
	await scenario.sync();
	const id = fixtureId("reading-memo");
	const before = scenario.documentRow(id)!;
	scenario.docling.control.setMeta(id, {
		path: "memo/renamed.md",
		title: "改題した読書メモ",
	});
	const ingestJobs = scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext).length;

	await scenario.sync();
	expect(scenario.jobs(KNOWLEDGE_JOB_KINDS.ingestNext).length).toBe(ingestJobs);
	expect(scenario.documentRow(id)).toMatchObject({
		state: "current",
		path: "memo/renamed.md",
		title: "改題した読書メモ",
		generation: before.generation,
		applied_markdown_sha256: before.applied_markdown_sha256,
	});
});
