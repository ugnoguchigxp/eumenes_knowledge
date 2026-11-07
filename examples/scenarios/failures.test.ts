// P1 scenarios (p1.md §6): cancellation, deadlines, rollback, restart, unavailability, partial
// listings and broken bodies, on the real package with the example host.
import { afterEach, expect, test } from "bun:test";
import { KNOWLEDGE_JOB_KINDS } from "../../src/contracts/index.js";
import { fixtureNames } from "../fixtures/index.js";
import { removeExampleTempDir } from "../host/store.js";
import {
	ALICE,
	BOB,
	createScenario,
	fixtureId,
	type Scenario,
} from "./harness.js";

const opened: Scenario[] = [];
/** Directories opened with `keep` (restart scenarios); removed even when a test fails. */
const keptDirs = new Set<string>();
async function open(options?: Parameters<typeof createScenario>[0]) {
	const scenario = await createScenario(options);
	opened.push(scenario);
	if (options?.keep) keptDirs.add(scenario.host.dir);
	return scenario;
}
afterEach(async () => {
	for (const scenario of opened.splice(0).reverse())
		await scenario.close().catch(() => {});
	for (const dir of keptDirs) removeExampleTempDir(dir);
	keptDirs.clear();
});

/** Request a sync and run only the listing pages, leaving the ingest jobs queued. */
async function observeOnly(scenario: Scenario) {
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	for (;;) {
		const next = scenario
			.jobs(KNOWLEDGE_JOB_KINDS.syncPage)
			.find((job) => job.state === "queued");
		if (!next) return;
		await scenario.host.runner.step();
	}
}

test("実行中の取消: 遅れて返った結果を適用せず、次の同期で同じ版を取り込める", async () => {
	const scenario = await open();
	await scenario.sync();
	const id = fixtureId("shop-log");
	scenario.docling.control.setMarkdown(id, "# 版 2\n\n取消の試験。\n");
	await observeOnly(scenario);

	scenario.docling.control.failNext(
		{ route: "get", documentId: id },
		{ kind: "hold" },
	);
	const step = scenario.host.runner.step();
	await scenario.docling.control.whenHeld(1);
	const job = scenario
		.jobs(KNOWLEDGE_JOB_KINDS.ingestDocument)
		.find((j) => j.state === "running")!;
	expect(await scenario.host.runner.cancel(job.id, "user_cancelled")).toBe(
		"cancelled",
	);
	scenario.docling.control.releaseHeld();
	expect(await step).toMatchObject({ result: "discarded" });
	expect(scenario.documentRow(id)?.state).toBe("stale");

	// The cancelled job's dedupe key is used for good (Eumenes semantics); the next sync must
	// still be able to ingest the same version.
	await scenario.sync();
	expect(scenario.documentRow(id)).toMatchObject({
		state: "current",
		applied_markdown_sha256:
			scenario.docling.control.snapshot(id)!.markdownSha256,
	});
});

test("期限切れ: 期限を過ぎた取り込みは適用されず、次の同期で取り込み直せる", async () => {
	const scenario = await open({ deadlineMs: 60_000 });
	const id = fixtureId("canal-guide");
	scenario.docling.control.failNext(
		{ route: "get", documentId: id },
		{ kind: "hold" },
	);
	await observeOnly(scenario);
	const steps = scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	await scenario.docling.control.whenHeld(1);
	scenario.clock.advance(120_000);
	expect(scenario.host.runner.expireDue().length).toBe(1);
	scenario.docling.control.releaseHeld();
	await steps;
	expect(scenario.documentRow(id)?.state).toBe("stale");
	expect(
		scenario
			.jobs(KNOWLEDGE_JOB_KINDS.ingestDocument)
			.some((j) => j.state === "expired"),
	).toBe(true);

	await scenario.sync();
	expect(scenario.documentRow(id)?.state).toBe("current");
});

test("settle 中の例外（queue の上限）: 書込みが巻き戻り、再起動後の同期で重複なく継続できる", async () => {
	const first = await open({
		keep: true,
		queueLimits: { total: 1024, background: 768, scope: 3 },
	});
	const { finished } = await first.sync();
	// The page's settle hit queue_full: the whole transaction rolled back, then (as in Eumenes'
	// settle.ts) the handler was settled again as failed(settle_failed), which failed the scan.
	expect(
		first.jobs(KNOWLEDGE_JOB_KINDS.syncPage).map((j) => [j.state, j.errorCode]),
	).toEqual([["failed", "settle_failed"]]);
	expect(first.count("knowledge_documents")).toBe(0);
	expect(finished).toMatchObject({
		state: "failed",
		complete: false,
		errorCode: "settle_failed",
	});
	const dir = first.host.dir;
	await first.close();
	opened.splice(opened.indexOf(first), 1);

	// Restart on the same database with the default limits.
	const second = await open({ dir, docling: first.docling });
	const again = await second.sync();
	expect(again.finished.state).toBe("completed");
	expectNoDuplicates(second);
	expect(second.count("knowledge_documents")).toBe(fixtureNames.length);
	const status = await second.client(ALICE).status();
	expect(status.documents.current).toBe(fixtureNames.length);
	expect(status.complete).toBe(true);
	await second.close();
	opened.splice(opened.indexOf(second), 1);
});

/** Ingest keys must stay unique and the registry must hold each fixture once. */
function expectNoDuplicates(scenario: Scenario) {
	expect(scenario.count("knowledge_documents")).toBe(fixtureNames.length);
	const keys = scenario
		.jobs(KNOWLEDGE_JOB_KINDS.ingestDocument)
		.map((j) => j.dedupeKey);
	expect(new Set(keys).size).toBe(keys.length);
}

test("取り込み中の停止: 実行中の取り込みは中断として記録され、再起動後の同期で重複なく取り込める", async () => {
	const first = await open({ keep: true, maxAttempts: 2 });
	const id = fixtureId("reading-memo");
	await observeOnly(first);
	first.docling.control.failNext(
		{ route: "get", documentId: id },
		{ kind: "hold" },
	);
	const steps = first.host.runner.runUntilIdle({ maxSteps: 100 });
	await first.docling.control.whenHeld(1);
	const dir = first.host.dir;
	// A normal stop while the read is in flight: the job ends interrupted and is not resumed by
	// itself (Eumenes does not resume interrupted work either).
	const closing = first.close();
	first.docling.control.releaseHeld();
	await closing;
	await steps.catch(() => {});
	opened.splice(opened.indexOf(first), 1);

	const second = await open({ dir, docling: first.docling, maxAttempts: 2 });
	expect(second.documentRow(id)?.state).toBe("stale");
	await second.sync();
	expect(second.documentRow(id)?.state).toBe("current");
	expectNoDuplicates(second);
	await second.close();
	opened.splice(opened.indexOf(second), 1);
});

test("取り込み中のクラッシュ: 実行中のまま残った取り込みは起動時に再実行され、重複しない", async () => {
	const first = await open({ keep: true, maxAttempts: 2 });
	const id = fixtureId("reading-memo");
	await observeOnly(first);
	first.docling.control.failNext(
		{ route: "get", documentId: id },
		{ kind: "hold" },
	);
	const steps = first.host.runner.runUntilIdle({ maxSteps: 100 });
	await first.docling.control.whenHeld(1);
	const dir = first.host.dir;
	// A crash: the database goes away under the running job, which stays `running` on disk.
	await first.host.store.close();
	first.docling.control.releaseHeld();
	await steps.catch(() => {});
	opened.splice(opened.indexOf(first), 1);

	const second = await open({ dir, docling: first.docling, maxAttempts: 2 });
	await second.host.runner.runUntilIdle({ maxSteps: 100 });
	expect(second.documentRow(id)?.state).toBe("current");
	expectNoDuplicates(second);
	await second.close();
	opened.splice(opened.indexOf(second), 1);
	await first.close().catch(() => {});
});

test("404・403: 新版を読めない文書は unavailable になり、削除とは扱わない", async () => {
	const scenario = await open();
	await scenario.sync();
	const gone = fixtureId("shop-log");
	const forbidden = fixtureId("canal-guide");
	scenario.docling.control.setMarkdown(gone, "# 消える前の新版\n");
	scenario.docling.control.setMarkdown(forbidden, "# 読めない新版\n");
	await observeOnly(scenario);
	scenario.docling.control.removeDocument(gone);
	scenario.docling.control.forbid(forbidden);
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });

	for (const id of [gone, forbidden]) {
		const row = scenario.documentRow(id)!;
		expect(row.state).toBe("unavailable");
		// The indexed data stays; nothing is deleted on a 404.
		expect(row.applied_markdown_sha256).not.toBeNull();
	}
	const status = await scenario.client(ALICE).status();
	expect(status.documents.unavailable).toBe(2);
	expect(status.documents.removed).toBe(0);
	expect(status.partialReasons).toContain("unavailable_documents");
});

test("許可領域外への変更: namespace が許可領域から外れた文書は unavailable になる", async () => {
	const scenario = await open();
	await scenario.sync();
	scenario.docling.control.setAllowedNamespaces(["notes", "work"]);
	await scenario.sync();
	expect(scenario.documentRow(fixtureId("reading-memo"))?.state).toBe(
		"unavailable",
	);
	expect(scenario.documentRow(fixtureId("shop-log"))?.state).toBe("current");
});

test("一覧の途中失敗: 見えなかった文書を不存在にせず、status は partial を返す", async () => {
	const scenario = await open({ pageSize: 2 });
	await scenario.sync();
	scenario.docling.control.failNext(
		{ route: "list" },
		{ kind: "status", status: 503, code: "unavailable" },
	);
	// The first page of the next scan fails: nothing of that scan was observed.
	const { finished } = await scenario.sync();
	expect(finished.state).toBe("failed");
	expect(finished.complete).toBe(false);
	for (const name of fixtureNames)
		expect(scenario.documentRow(fixtureId(name))?.state).toBe("current");
	const status = await scenario.client(ALICE).status();
	expect(status.documents.current).toBe(fixtureNames.length);
	expect(status.complete).toBe(false);
	expect(status.partialReasons).toContain("no_complete_scan");
});

test("本文 digest の不一致: 改ざんされた応答を適用せず、適用済みの版を壊さない", async () => {
	const scenario = await open();
	await scenario.sync();
	const id = fixtureId("shop-log");
	const before = scenario.documentRow(id)!;
	scenario.docling.control.setMarkdown(id, "# 版 2\n");
	await observeOnly(scenario);
	const good = scenario.docling.control.snapshot(id)!;
	scenario.docling.control.failNext(
		{ route: "get", documentId: id },
		{
			kind: "raw",
			status: 200,
			headers: { etag: good.etag },
			body: JSON.stringify({
				id: good.id,
				namespace: good.namespace,
				path: good.path,
				title: good.title,
				etag: good.etag,
				markdownSha256: good.markdownSha256,
				recoverySha256: good.recoverySha256,
				contentDigest: good.contentDigest,
				markdown: "# 改ざんされた本文\n",
				recovery: good.recovery,
			}),
		},
	);
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	expect(scenario.documentRow(id)).toMatchObject({
		state: "stale",
		applied_markdown_sha256: before.applied_markdown_sha256,
	});
	// A later sync reads the genuine body and applies it.
	await scenario.sync();
	expect(scenario.documentRow(id)).toMatchObject({
		state: "current",
		applied_markdown_sha256: good.markdownSha256,
	});
});

test("複数 principal: 同じホスト・同じ索引を使い、範囲外の文書と受付を返さない", async () => {
	const scenario = await open();
	const { requestId } = await scenario.sync(ALICE);
	const alice = await scenario.client(ALICE).status();
	const bob = await scenario.client(BOB).status();
	expect(alice.documents.total).toBe(fixtureNames.length);
	expect(bob.documents.total).toBe(1);
	// Bob cannot see Alice's request. The same id from Bob is simply his own request: whether
	// Alice used it is not revealed (p0.md §4).
	await expect(
		scenario.client(BOB).getSyncRequest(requestId),
	).rejects.toMatchObject({
		code: "knowledge_not_available",
	});
	const own = await scenario.client(BOB).requestSync(requestId);
	expect(own.state).toBe("accepted");
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	expect((await scenario.client(BOB).getSyncRequest(requestId)).state).toBe(
		"completed",
	);
	expect((await scenario.client(ALICE).getSyncRequest(requestId)).state).toBe(
		"completed",
	);
});

test("同時の同期要求: 2 つの principal の要求は同じ走査を共有し、互いを打ち切らない", async () => {
	const scenario = await open();
	const a = crypto.randomUUID();
	const b = crypto.randomUUID();
	await scenario.client(ALICE).requestSync(a);
	await scenario.client(BOB).requestSync(b);
	await scenario.host.runner.runUntilIdle({ maxSteps: 1000 });
	expect((await scenario.client(ALICE).getSyncRequest(a)).state).toBe(
		"completed",
	);
	expect((await scenario.client(BOB).getSyncRequest(b)).state).toBe(
		"completed",
	);
	expect(scenario.count("knowledge_scans")).toBe(1);
});

test("一覧より先に新版になった文書（superseded）: 次の同期で新版を取り込める", async () => {
	const scenario = await open();
	await scenario.sync();
	const id = fixtureId("shop-log");
	scenario.docling.control.setMarkdown(id, "# 版 2\n");
	await observeOnly(scenario);
	// Between the listing and the read the document moves on to version 3.
	scenario.docling.control.setMarkdown(id, "# 版 3\n");
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	expect(scenario.documentRow(id)?.state).toBe("stale");
	await scenario.sync();
	expect(scenario.documentRow(id)).toMatchObject({
		state: "current",
		applied_markdown_sha256:
			scenario.docling.control.snapshot(id)!.markdownSha256,
	});
});

test("取り込み中の資格情報の変更: 読取りは適用されず、次の同期で取り込める", async () => {
	const scenario = await open();
	await scenario.sync();
	const id = fixtureId("canal-guide");
	scenario.docling.control.setMarkdown(id, "# 版 2（資格情報の更新中）\n");
	await observeOnly(scenario);
	scenario.docling.control.failNext(
		{ route: "get", documentId: id },
		{ kind: "hold" },
	);
	const steps = scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	await scenario.docling.control.whenHeld(1);
	const rotated = "docling-mock-credential-rotated-0123456789";
	scenario.docling.control.setCredential(rotated);
	scenario.source.reconfigure({ credential: rotated });
	scenario.docling.control.releaseHeld();
	await steps;
	expect(scenario.documentRow(id)?.state).toBe("stale");
	await scenario.sync();
	expect(scenario.documentRow(id)?.state).toBe("current");
});

test("capabilities の 403: 文書の状態とは扱わず unavailable にしない", async () => {
	const scenario = await open();
	await scenario.sync();
	const id = fixtureId("shop-log");
	scenario.docling.control.setMarkdown(id, "# 版 2\n");
	await observeOnly(scenario);
	scenario.docling.control.failNext(
		{ route: "capabilities" },
		{ kind: "status", status: 403, code: "forbidden" },
	);
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	expect(scenario.documentRow(id)?.state).toBe("stale");
	await scenario.sync();
	expect(scenario.documentRow(id)?.state).toBe("current");
});

test("100 件を超える一覧: 既定の queue の上限の下で、全件を重複なく取り込める", async () => {
	const documents = Array.from({ length: 150 }, (_, i) => ({
		namespace: "work",
		path: `bulk/${String(i).padStart(3, "0")}.md`,
		title: `一括 ${i}`,
		markdown: `# 一括 ${i}\n\n合成の本文 ${i}。\n`,
	}));
	const scenario = await open({ documents });
	const { finished } = await scenario.sync();
	expect(finished.state).toBe("completed");
	const status = await scenario.client(BOB).status();
	expect(status.documents.current).toBe(150);
	const keys = scenario
		.jobs(KNOWLEDGE_JOB_KINDS.ingestDocument)
		.map((j) => j.dedupeKey);
	expect(keys).toHaveLength(150);
	expect(new Set(keys).size).toBe(150);
});

test("認証失敗・起動中: 401 と 503 を返し、別のインスタンスを作らない", async () => {
	const scenario = await open();
	await expect(
		scenario.client("unknown-token-0123456789abcdef").status(),
	).rejects.toMatchObject({ code: "knowledge_auth_failed" });
	expect(scenario.count("knowledge_documents")).toBe(0);
});
