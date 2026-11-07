// P2 scenarios (p2.md §7): fragments, extraction, vectors, evidence, publication and invalidation,
// on the real package with the example host. The inference answers are scripted by call order:
// the script is written from the fixture (the same chunking), never from the prompt (plan §7.1).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	KNOWLEDGE_JOB_KINDS,
	embeddingSpaceKey,
	type EmbeddingPort,
	type Fragment,
} from "../../src/contracts/index.js";
import { chunkMarkdown, normalizeForSearch } from "../../src/core/index.js";
import {
	getPublishedVersionInSnapshot,
	retireDocumentInTransaction,
	searchFragmentsInSnapshot,
} from "../../src/sqlite/index.js";
// Version-id reads are internal (not exported from ./sqlite); the scenarios inspect with them.
import {
	getRetainedVersionInSnapshot,
	getVersionInSnapshot,
	listEntityMentionsInSnapshot,
	listEvidenceInSnapshot,
	listExtractionsInSnapshot,
	listFragmentsInSnapshot,
	listRelationMentionsInSnapshot,
	readVersionVectorsInSnapshot,
} from "../../src/sqlite/reads.js";
import { readFixtureBytes, readFixtureMarkdown } from "../fixtures/index.js";
import { removeExampleTempDir } from "../host/store.js";
import { createMeaninglessHashEmbedding } from "../mocks/embedding.js";
import type { ScriptedScenario, ScriptedStep } from "../mocks/inference.js";
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
const keptDirs = new Set<string>();
async function open(options: ScenarioOptions) {
	const scenario = await createScenario(options);
	opened.push(scenario);
	if (options.keep) keptDirs.add(scenario.host.dir);
	return scenario;
}
afterEach(async () => {
	for (const scenario of opened.splice(0).reverse())
		await scenario.close().catch(() => {});
	for (const dir of keptDirs) removeExampleTempDir(dir);
	keptDirs.clear();
});

const sha = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");
const KEY = (documentId: string) => ({
	sourceNamespace: "docling",
	documentId,
});

/** A single synthetic document (namespace `work`, visible to both principals). */
function single(markdown: string, path = "p2/doc.md") {
	return [{ namespace: "work", path, title: "P2 の合成文書", markdown }];
}

function fragmentsOf(markdown: string, maxBytes?: number): Fragment[] {
	return chunkMarkdown(
		Buffer.from(markdown, "utf8"),
		markdown,
		maxBytes ? { maxBytes } : {},
	);
}

/** A contiguous quotation of a fragment: its first non-blank code points, never splitting one. */
function quoteOf(fragment: Fragment, length = 12): string {
	const chars = Array.from(fragment.text.replace(/^[\s﻿#>*\-|]+/, ""));
	return chars
		.slice(0, length)
		.join("")
		.replace(/[\r\n].*$/s, "")
		.trim();
}

function answer(value: unknown): ScriptedStep {
	return { expect: EXTRACT_CALL, answer: { text: JSON.stringify(value) } };
}
const empty: ScriptedStep = {
	expect: EXTRACT_CALL,
	answer: { text: EMPTY_EXTRACTION },
};
const script = (step: (index: number) => ScriptedStep): ScriptedScenario => ({
	steps: (index) => step(index),
});

/** One entity per fragment, quoting it; the first fragment also states a relation. */
function entitiesFor(fragments: readonly Fragment[]) {
	return (index: number): ScriptedStep => {
		const fragment = fragments[index];
		if (!fragment) return empty;
		const q = quoteOf(fragment);
		if (!q) return empty;
		const entities = [
			{
				id: "e1",
				name: q,
				type: "合成の対象",
				description: "試験用の言及",
				evidence: [q],
			},
		];
		const second = Array.from(q).slice(0, 4).join("");
		const relations =
			index === 0 && second
				? [
						{
							id: "r1",
							source: "e1",
							target: "e2",
							directed: false,
							relation: "含む",
							description: "試験用の関係",
							keywords: ["試験"],
							qualifiers: {
								negated: false,
								condition: null,
								certainty: "stated",
							},
							evidence: [q],
						},
					]
				: [];
		if (relations.length)
			entities.push({
				id: "e2",
				name: second,
				type: "合成の対象",
				description: "試験用の言及",
				evidence: [second],
			});
		return answer({ entities, relations });
	};
}

function onlyDocumentId(scenario: Scenario): string {
	const ids = scenario.host.store.read(
		(db) =>
			db.query("SELECT document_id FROM knowledge_documents").all() as {
				document_id: string;
			}[],
	);
	expect(ids).toHaveLength(1);
	return ids[0]!.document_id;
}

/** The published version of a current document (null for any other state). */
function published(scenario: Scenario, id: string) {
	return scenario.host.store.readSnapshot((db) =>
		getPublishedVersionInSnapshot(db, KEY(id)),
	);
}
/** The published version whatever the document's state (maintenance view). */
function retained(scenario: Scenario, id: string) {
	return scenario.host.store.readSnapshot((db) =>
		getRetainedVersionInSnapshot(db, KEY(id)),
	);
}
/** The default base delay before a temporarily failed document is picked again. */
const TRANSIENT_DELAY_MS = 5 * 60 * 1000;

test("取り込み→索引: 断片が本文を覆い、言及・関係・根拠の byte 範囲から原文と digest が戻る（BOM・CRLF・日本語）", async () => {
	const markdown = await readFixtureMarkdown("canal-guide-bom-crlf");
	const bytes = await readFixtureBytes("canal-guide-bom-crlf");
	const fragments = fragmentsOf(markdown);
	expect(fragments.length).toBeGreaterThan(0);
	const scenario = await open({
		documents: single(markdown),
		inference: script(entitiesFor(fragments)),
	});
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const version = published(scenario, id)!;
	expect(version).toMatchObject({
		state: "published",
		extractionPartial: false,
		expectedFragments: fragments.length,
	});

	const stored = scenario.host.store.readSnapshot((db) =>
		listFragmentsInSnapshot(db, version.versionId),
	);
	expect(stored.map((f) => f.text).join("")).toBe(markdown);
	for (const f of stored) {
		const slice = bytes.subarray(f.byteStart, f.byteEnd);
		expect(Buffer.from(slice).toString("utf8")).toBe(f.text);
		expect(f.textSha256).toBe(sha(slice));
	}

	const evidence = scenario.host.store.readSnapshot((db) =>
		listEvidenceInSnapshot(db, version.versionId),
	);
	expect(evidence.length).toBeGreaterThan(0);
	for (const e of evidence) {
		const slice = bytes.subarray(e.byteStart, e.byteEnd);
		expect(e.quoteSha256).toBe(sha(slice));
		const fragment = stored.find((f) => f.ordinal === e.fragmentOrdinal)!;
		expect(e.byteStart).toBeGreaterThanOrEqual(fragment.byteStart);
		expect(e.byteEnd).toBeLessThanOrEqual(fragment.byteEnd);
		expect(fragment.text).toContain(Buffer.from(slice).toString("utf8"));
	}
	const entities = scenario.host.store.readSnapshot((db) =>
		listEntityMentionsInSnapshot(db, version.versionId),
	);
	expect(entities.every((m) => m.versionId === version.versionId)).toBe(true);
	const relations = scenario.host.store.readSnapshot((db) =>
		listRelationMentionsInSnapshot(db, version.versionId),
	);
	expect(relations).toHaveLength(1);
	expect(relations[0]).toMatchObject({
		directed: false,
		fragmentOrdinal: 0,
	});
	const vectors = scenario.host.store.readSnapshot((db) =>
		readVersionVectorsInSnapshot(
			db,
			version.versionId,
			embeddingSpaceKey(TEST_SPACE),
		),
	);
	expect(vectors).toHaveLength(fragments.length);
	const status = await scenario.client(BOB).status();
	expect(status.complete).toBe(true);
});

test("新版の公開: 旧版の断片・全文索引・ベクトルは片付けられ、新版だけが引ける", async () => {
	const v1 = "# 手引き\n\n旧版だけにある水門点検の語句。\n";
	const v2 = "# 手引き\n\n新版だけにある堤防巡回の語句。\n";
	const scenario = await open({ documents: single(v1) });
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const first = published(scenario, id)!;
	scenario.docling.control.setMarkdown(id, v2);
	await scenario.sync();
	const second = published(scenario, id)!;
	expect(second.versionId).not.toBe(first.versionId);
	expect(second.markdownSha256).toBe(sha(v2));
	scenario.host.store.readSnapshot((db) => {
		expect(getVersionInSnapshot(db, first.versionId)).toBeNull();
		expect(listFragmentsInSnapshot(db, first.versionId)).toEqual([]);
		expect(
			searchFragmentsInSnapshot(db, normalizeForSearch("水門点検"), 10, [
				"work",
			]),
		).toEqual([]);
		expect(
			searchFragmentsInSnapshot(db, normalizeForSearch("堤防巡回"), 10, [
				"work",
			]).map((h) => h.versionId),
		).toEqual([second.versionId]);
	});
	expect(scenario.count("knowledge_versions")).toBe(1);
});

test("抽出中の取消: staging は公開されず、旧版が公開されたまま。次の同期で新版を取り込み、残りは片付く", async () => {
	const v1 = "# 手引き\n\n版 1 の本文。\n";
	const v2 = "# 手引き\n\n版 2 の本文。\n";
	const n1 = fragmentsOf(v1).length;
	const scenario = await open({
		documents: single(v1),
		inference: script((i) => (i === n1 ? { ...empty, hold: true } : empty)),
	});
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const first = published(scenario, id)!;
	scenario.docling.control.setMarkdown(id, v2);
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	const steps = scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	await scenario.inference.whenHeld(1);
	const running = scenario
		.jobs(KNOWLEDGE_JOB_KINDS.ingestNext)
		.find((j) => j.state === "running")!;
	expect(await scenario.host.runner.cancel(running.id, "user_cancelled")).toBe(
		"cancelled",
	);
	scenario.inference.releaseHeld();
	await steps;
	expect(retained(scenario, id)!.versionId).toBe(first.versionId);
	// A cancellation is a temporary end: not counted, the document waits before it is picked again.
	expect(scenario.documentRow(id)).toMatchObject({
		state: "stale",
		ingest_retry: 0,
	});
	const staging = scenario.host.store.read(
		(db) =>
			db
				.query(
					"SELECT state FROM knowledge_versions WHERE version_id <> ? ORDER BY version_id",
				)
				.all(first.versionId) as { state: string }[],
	);
	expect(staging.map((v) => v.state)).toEqual(["abandoned"]);

	scenario.clock.advance(TRANSIENT_DELAY_MS);
	await scenario.sync();
	expect(published(scenario, id)!.markdownSha256).toBe(sha(v2));
	expect(scenario.count("knowledge_versions")).toBe(1);
});

test("書込み途中のクラッシュ: 再起動後に同じ版を取り込み直し、版は 1 つだけ公開される", async () => {
	const markdown = "# 手引き\n\nクラッシュの試験。\n";
	const first = await open({
		documents: single(markdown),
		keep: true,
		maxAttempts: 2,
		inference: script((i) => (i === 0 ? { ...empty, hold: true } : empty)),
	});
	await first.client(ALICE).requestSync(crypto.randomUUID());
	const steps = first.host.runner.runUntilIdle({ maxSteps: 100 });
	await first.inference.whenHeld(1);
	const dir = first.host.dir;
	// The fragments are staged; the database goes away under the running job.
	await first.host.store.close();
	first.inference.releaseHeld();
	await steps.catch(() => {});
	opened.splice(opened.indexOf(first), 1);

	const second = await open({ dir, docling: first.docling, maxAttempts: 2 });
	await second.host.runner.runUntilIdle({ maxSteps: 100 });
	const id = onlyDocumentId(second);
	expect(second.documentRow(id)?.state).toBe("current");
	expect(published(second, id)!.markdownSha256).toBe(sha(markdown));
	expect(second.count("knowledge_versions")).toBe(1);
	await first.close().catch(() => {});
});

test("不正 JSON・schema 違反・範囲外の引用: 該当する断片か要素だけが捨てられ、版は partial で公開される", async () => {
	const markdown = [
		"# 一",
		"",
		"一つ目の断片の本文です。",
		"",
		"# 二",
		"",
		"二つ目の断片の本文です。",
		"",
		"# 三",
		"",
		"三つ目の断片の本文です。",
		"",
	].join("\n");
	const fragments = fragmentsOf(markdown, 64);
	expect(fragments.length).toBeGreaterThanOrEqual(3);
	const third = quoteOf(fragments[2]!);
	const scenario = await open({
		documents: single(markdown),
		ingestOptions: { maxFragmentBytes: 64 },
		inference: script((i) => {
			if (i === 0)
				return {
					expect: EXTRACT_CALL,
					answer: { text: "これは JSON ではない" },
				};
			if (i === 1) return answer({ entities: [{ id: "e1" }], relations: [] });
			if (i === 2)
				return answer({
					entities: [
						{
							id: "e1",
							name: "本文にない対象",
							type: "合成",
							description: "引用が本文にない",
							evidence: ["どこにも書かれていない引用"],
						},
						{
							id: "e2",
							name: third,
							type: "合成",
							description: "引用が本文にある",
							evidence: [third],
						},
					],
					relations: [],
				});
			return empty;
		}),
	});
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const version = published(scenario, id)!;
	expect(version.extractionPartial).toBe(true);
	const extractions = scenario.host.store.readSnapshot((db) =>
		listExtractionsInSnapshot(db, version.versionId),
	);
	expect(extractions[0]).toMatchObject({
		status: "failed",
		errorCode: "invalid_json",
	});
	expect(extractions[1]).toMatchObject({
		status: "failed",
		errorCode: "schema_violation",
	});
	expect(extractions[2]!.status).toBe("ok");
	expect(extractions[2]!.dropped).toContainEqual({
		reason: "no_evidence",
		count: 1,
	});
	const names = scenario.host.store
		.readSnapshot((db) => listEntityMentionsInSnapshot(db, version.versionId))
		.map((m) => m.name);
	expect(names).toEqual([third]);
	const status = await scenario.client(BOB).status();
	expect(status.documents.current).toBe(1);
	expect(status.partialReasons).toContain("extraction_incomplete");
});

test("埋め込みの次元不一致: 新版を公開せず旧版を壊さない。上限回数で failed_documents になり、版が変わるまで選ばない", async () => {
	const hash = createMeaninglessHashEmbedding({ space: TEST_SPACE });
	let wrong = false;
	const embedding: EmbeddingPort = {
		async embed(texts, kind, signal) {
			const r = await hash.port.embed(texts, kind, signal);
			return wrong ? { ...r, vectors: r.vectors.map((v) => v.slice(1)) } : r;
		},
	};
	const scenario = await open({
		documents: single("# 手引き\n\n版 1。\n"),
		embedding,
	});
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const first = published(scenario, id)!;
	wrong = true;
	scenario.docling.control.setMarkdown(id, "# 手引き\n\n版 2。\n");
	await scenario.sync();
	expect(retained(scenario, id)!.versionId).toBe(first.versionId);
	expect(published(scenario, id)).toBeNull(); // stale: the old version is not current evidence
	expect(scenario.documentRow(id)).toMatchObject({
		state: "stale",
		ingest_retry: 3,
	});
	const status = await scenario.client(BOB).status();
	expect(status.partialReasons).toContain("failed_documents");

	// Fixed provider, same version: still skipped until the version changes (p2.md §3).
	wrong = false;
	await scenario.sync();
	expect(retained(scenario, id)!.versionId).toBe(first.versionId);
	scenario.docling.control.setMarkdown(id, "# 手引き\n\n版 3。\n");
	await scenario.sync();
	expect(published(scenario, id)!.markdownSha256).toBe(
		sha("# 手引き\n\n版 3。\n"),
	);
});

test("space の変更: 新しい版のベクトルは新しい space にだけあり、旧 space の行は片付く", async () => {
	const hash = createMeaninglessHashEmbedding({ space: TEST_SPACE });
	const scenario = await open({
		documents: single("# 手引き\n\n版 1。\n"),
		embedding: hash.port,
	});
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const next = { ...TEST_SPACE, revision: "test-2" };
	hash.control.setSpace(next);
	scenario.docling.control.setMarkdown(id, "# 手引き\n\n版 2。\n");
	await scenario.sync();
	const version = published(scenario, id)!;
	expect(version.spaceKey).toBe(embeddingSpaceKey(next));
	scenario.host.store.readSnapshot((db) => {
		expect(
			readVersionVectorsInSnapshot(
				db,
				version.versionId,
				embeddingSpaceKey(next),
			),
		).toHaveLength(version.expectedFragments);
		expect(
			readVersionVectorsInSnapshot(
				db,
				version.versionId,
				embeddingSpaceKey(TEST_SPACE),
			),
		).toEqual([]);
	});
	expect(scenario.count("knowledge_vectors")).toBe(version.expectedFragments);
});

test("removed と unavailable: removed は公開版が退役して片付き、unavailable は公開版を残すが検索に出ない", async () => {
	const scenario = await open({
		documents: [
			...single("# 削除\n\n削除される文書の本文。\n", "p2/removed.md"),
			...single("# 取得不能\n\n読めなくなる文書の本文。\n", "p2/gone.md"),
		],
	});
	await scenario.sync();
	const ids = scenario.host.store.read(
		(db) =>
			db
				.query(
					"SELECT document_id, path FROM knowledge_documents ORDER BY path",
				)
				.all() as { document_id: string; path: string }[],
	);
	const gone = ids.find((r) => r.path === "p2/gone.md")!.document_id;
	const removed = ids.find((r) => r.path === "p2/removed.md")!.document_id;

	await scenario.host.store.write((db) =>
		retireDocumentInTransaction(
			db,
			KEY(removed),
			"removed",
			scenario.clock.now(),
		),
	);
	scenario.docling.control.setMarkdown(gone, "# 取得不能\n\n新版。\n");
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	await scenario.host.runner.step(); // the listing observes the new version of `gone`
	scenario.docling.control.removeDocument(gone);
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });

	expect(scenario.documentRow(removed)?.state).toBe("removed");
	expect(retained(scenario, removed)).toBeNull();
	expect(scenario.documentRow(gone)?.state).toBe("unavailable");
	expect(published(scenario, gone)).toBeNull();
	const kept = retained(scenario, gone)!;
	expect(kept.state).toBe("published");
	scenario.host.store.readSnapshot((db) => {
		expect(listFragmentsInSnapshot(db, kept.versionId).length).toBeGreaterThan(
			0,
		);
		expect(
			searchFragmentsInSnapshot(
				db,
				normalizeForSearch("読めなくなる文書"),
				10,
				["work"],
			),
		).toEqual([]);
	});
	// Only the unavailable document's version is left after the cleanup.
	expect(scenario.count("knowledge_versions")).toBe(1);
	const status = await scenario.client(BOB).status();
	expect(status.documents).toMatchObject({ removed: 1, unavailable: 1 });
});

test("namespace だけの移動: 読取りで先に新しい場所が見えても数えず空回りせず、次の走査で取り込む", async () => {
	const scenario = await open({ documents: single("# 移動\n\n版 1。\n") });
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	scenario.docling.control.setMarkdown(id, "# 移動\n\n版 2。\n");
	await scenario.client(ALICE).requestSync(crypto.randomUUID());
	await scenario.host.runner.step(); // the listing observes version 2 in `work`
	// Before the read, the document moves to another allowed namespace (same body).
	scenario.docling.control.setMeta(id, { namespace: "notes" });
	scenario.docling.control.clearRequests();
	await scenario.host.runner.runUntilIdle({ maxSteps: 100 });
	const reads = scenario.docling.control
		.requests()
		.filter((r) => r.method === "GET" && r.path.endsWith(id)).length;
	expect(reads).toBe(1); // superseded once, then not picked again before the next listing
	expect(scenario.documentRow(id)).toMatchObject({
		state: "stale",
		ingest_retry: 0,
	});
	await scenario.sync();
	expect(scenario.documentRow(id)).toMatchObject({
		state: "current",
		namespace: "notes",
		ingest_retry: 0,
	});
});

test("埋め込み先の一時的な停止: どの文書も failed_documents にならず、待ち時間の後に取り込める", async () => {
	const hash = createMeaninglessHashEmbedding({ space: TEST_SPACE });
	let down = false;
	const embedding: EmbeddingPort = {
		async embed(texts, kind, signal) {
			if (down) throw new Error("embedding_unavailable");
			return hash.port.embed(texts, kind, signal);
		},
	};
	const scenario = await open({
		documents: [
			...single("# 一\n\n版 1。\n", "p2/one.md"),
			...single("# 二\n\n版 1。\n", "p2/two.md"),
		],
		embedding,
	});
	await scenario.sync();
	down = true;
	const ids = scenario.host.store.read(
		(db) =>
			db.query("SELECT document_id FROM knowledge_documents").all() as {
				document_id: string;
			}[],
	);
	for (const { document_id } of ids)
		scenario.docling.control.setMarkdown(document_id, "# 新版\n\n版 2。\n");
	for (let i = 0; i < 3; i++) {
		await scenario.sync();
		scenario.clock.advance(60_000);
	}
	for (const { document_id } of ids)
		expect(scenario.documentRow(document_id)).toMatchObject({
			state: "stale",
			ingest_retry: 0,
		});
	const during = await scenario.client(BOB).status();
	expect(during.partialReasons).not.toContain("failed_documents");
	expect(during.partialReasons).toContain("stale_documents");

	down = false;
	scenario.clock.advance(60 * 60 * 1000);
	await scenario.sync();
	for (const { document_id } of ids)
		expect(scenario.documentRow(document_id)?.state).toBe("current");
	expect((await scenario.client(BOB).status()).complete).toBe(true);
});

test("推論基盤の停止: 空の版を公開せず、旧版を残す。回復後に新版を取り込む", async () => {
	const v1 = "# 手引き\n\n版 1 の本文。\n";
	const v2 = "# 手引き\n\n版 2 の本文。\n";
	const n1 = fragmentsOf(v1).length;
	const scenario = await open({
		documents: single(v1),
		inference: script((i) =>
			i === n1
				? { expect: EXTRACT_CALL, answer: { error: "provider_unavailable" } }
				: empty,
		),
	});
	await scenario.sync();
	const id = onlyDocumentId(scenario);
	const first = retained(scenario, id)!;
	scenario.docling.control.setMarkdown(id, v2);
	await scenario.sync();
	// Not published: the old version stays, nothing partial was published in its place.
	expect(retained(scenario, id)!.versionId).toBe(first.versionId);
	expect(scenario.documentRow(id)).toMatchObject({
		state: "stale",
		ingest_retry: 0,
	});
	expect(
		scenario.host.store.read(
			(db) =>
				db
					.query(
						"SELECT COUNT(*) AS n FROM knowledge_versions WHERE state = 'published'",
					)
					.get() as { n: number },
		).n,
	).toBe(1);

	scenario.clock.advance(TRANSIENT_DELAY_MS);
	await scenario.sync();
	const second = published(scenario, id)!;
	expect(second.markdownSha256).toBe(sha(v2));
	expect(second.extractionPartial).toBe(false);
});
