import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { knowledgeStatusSchema } from "../contracts/index.js";
import {
	docId,
	drain,
	makeDoc,
	makeEnv,
	runJob,
	syncAll,
	type Env,
} from "../core/harness.fixture.js";
import {
	migrations,
	readScanInSnapshot,
	readStatusInSnapshot,
	retireDocumentInTransaction,
} from "./index.js";

const HOUR = 3_600_000;
const status = (
	env: Env,
	namespaces: string[],
	within = HOUR,
	extra: { binding?: string | null } = {},
) => {
	const s = readStatusInSnapshot(
		env.db,
		{ principal: "p", namespaces },
		env.clock.t,
		{ verifiedWithinMs: within, ...extra },
	);
	expect(knowledgeStatusSchema.parse(s)).toEqual(s);
	return s;
};

test("migrations are plain SQL strings with the knowledge_ prefix", () => {
	expect(migrations.length).toBeGreaterThan(0);
	for (const sql of migrations) {
		for (const m of sql.matchAll(/CREATE (?:TABLE|INDEX) (\w+)/g)) {
			expect(m[1]!.startsWith("knowledge_")).toBe(true);
		}
	}
	expect(readScanInSnapshot(makeEnv().db, randomUUID())).toBeNull();
});

describe("status", () => {
	test("an empty registry is partial: no complete scan", () => {
		const env = makeEnv();
		const s = status(env, ["wiki"]);
		expect(s.documents.total).toBe(0);
		expect(s.lastScanAt).toBeNull();
		expect(s.lastCompleteScanAt).toBeNull();
		expect(s.complete).toBe(false);
		expect(s.partialReasons).toEqual(["no_complete_scan"]);
	});

	test("counts only the caller's namespaces", async () => {
		const env = makeEnv();
		env.source.namespaces = ["wiki", "team"];
		env.source.put(makeDoc(1, "a", { namespace: "wiki" }));
		env.source.put(makeDoc(2, "b", { namespace: "team" }));
		env.source.put(makeDoc(3, "c", { namespace: "team" }));
		await syncAll(env);
		expect(status(env, ["wiki"]).documents).toMatchObject({
			total: 1,
			current: 1,
		});
		expect(status(env, ["team"]).documents).toMatchObject({
			total: 2,
			current: 2,
		});
		expect(status(env, ["wiki", "team"]).documents.total).toBe(3);
		expect(status(env, []).documents.total).toBe(0);
		expect(status(env, ["other"]).documents.total).toBe(0);
	});

	test("a fully verified registry after a complete scan is complete", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "a"));
		await syncAll(env);
		const s = status(env, ["wiki"]);
		expect(s.complete).toBe(true);
		expect(s.partialReasons).toEqual([]);
		expect(s.lastScanAt).toBe(new Date(env.clock.t).toISOString());
		expect(s.lastCompleteScanAt).toBe(new Date(env.clock.t).toISOString());
		expect(s.lastScanAt).toMatch(/Z$|[+-]\d\d:\d\d$/);
	});

	test("unverified is derived from the last verification and excluded from current", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		await syncAll(env);
		env.clock.t += 2 * HOUR;
		let s = status(env, ["wiki"]);
		expect(s.documents).toMatchObject({ total: 2, current: 0, unverified: 2 });
		expect(s.partialReasons).toEqual(["unverified_documents"]);
		expect(s.complete).toBe(false);
		// Exactly at the limit is still verified.
		env.clock.t -= HOUR;
		s = status(env, ["wiki"]);
		expect(s.documents).toMatchObject({ current: 2, unverified: 0 });
		// A later scan re-verifies.
		env.clock.t += HOUR;
		await syncAll(env);
		s = status(env, ["wiki"]);
		expect(s.documents).toMatchObject({ current: 2, unverified: 0 });
		expect(s.complete).toBe(true);
	});

	test("stale and unavailable documents are reported", async () => {
		const env = makeEnv();
		env.source.namespaces = ["wiki", "gone"];
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b", { namespace: "gone" }));
		await syncAll(env);
		env.source.put(makeDoc(1, "a changed"));
		env.source.namespaces = ["wiki"];
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const s = status(env, ["wiki", "gone"]);
		expect(s.documents).toMatchObject({ stale: 1, unavailable: 1, current: 0 });
		expect(s.partialReasons).toEqual([
			"stale_documents",
			"unavailable_documents",
		]);
		await drain(env);
		expect(status(env, ["wiki", "gone"]).partialReasons).toEqual([
			"unavailable_documents",
		]);
	});

	test("excluded and removed are counted but do not make the status partial", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		await syncAll(env);
		const k = (n: number) => ({
			sourceNamespace: "docling",
			documentId: docId(n),
		});
		retireDocumentInTransaction(env.db, k(1), "excluded", env.clock.t);
		retireDocumentInTransaction(env.db, k(2), "removed", env.clock.t);
		const s = status(env, ["wiki"]);
		expect(s.documents).toMatchObject({
			total: 2,
			excluded: 1,
			removed: 1,
			current: 0,
		});
		expect(s.complete).toBe(true);
	});

	test("current documents of two extractors are mixed; a version of no recorded extractor is not counted", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		env.source.put(makeDoc(3, "c", { namespace: "team" }));
		env.source.namespaces = ["wiki", "team"];
		await syncAll(env);
		expect(status(env, ["wiki", "team"]).partialReasons).toEqual([]);
		const setExtractor = (n: number, extractor: string) =>
			env.db.run(
				`UPDATE knowledge_versions SET extractor = ? WHERE version_id =
 (SELECT published_version_id FROM knowledge_documents WHERE document_id = ?)`,
				[extractor, docId(n)],
			);
		setExtractor(3, "names:other@rules1");
		expect(status(env, ["wiki", "team"]).partialReasons).toEqual([
			"extractor_mixed",
		]);
		// Only the caller's namespaces count.
		expect(status(env, ["wiki"]).partialReasons).toEqual([]);
		expect(status(env, ["team"]).partialReasons).toEqual([]);
		setExtractor(3, "");
		expect(status(env, ["wiki", "team"]).partialReasons).toEqual([]);
	});

	test("a running scan is in progress", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const s = status(env, ["wiki"]);
		expect(s.partialReasons).toContain("scan_in_progress");
		expect(s.partialReasons).toContain("no_complete_scan");
		expect(s.lastCompleteScanAt).toBeNull();
	});

	test("a scan that failed midway makes a once-complete registry partial without touching documents", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		await syncAll(env);
		const complete = status(env, ["wiki"]);
		expect(complete.complete).toBe(true);

		env.clock.t += 1000;
		env.source.listFailsAt = "1";
		await syncAll(env);
		const s = status(env, ["wiki"]);
		expect(s.documents.current).toBe(2);
		expect(s.complete).toBe(false);
		expect(s.partialReasons).toEqual(["no_complete_scan"]);
		expect(s.lastCompleteScanAt).toBe(complete.lastCompleteScanAt);
		expect(s.lastScanAt).not.toBe(complete.lastScanAt);

		// The next complete scan clears it.
		env.clock.t += 1000;
		env.source.listFailsAt = null;
		await syncAll(env);
		expect(status(env, ["wiki"]).complete).toBe(true);
	});
});

describe("status with a binding", () => {
	test("only scans completed under that binding count", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "a"));
		await syncAll(env);
		const done = status(env, ["wiki"]);
		expect(done.complete).toBe(true);

		// Omitted binding: unchanged behaviour. The matching binding: same answer.
		expect(status(env, ["wiki"], HOUR, { binding: "binding-1" })).toEqual(done);

		// Another binding: nothing completed under it.
		const other = status(env, ["wiki"], HOUR, { binding: "binding-2" });
		expect(other.complete).toBe(false);
		expect(other.partialReasons).toEqual(["no_complete_scan"]);
		expect(other.lastCompleteScanAt).toBeNull();
		expect(other.lastScanAt).toBe(done.lastScanAt);
		expect(other.documents).toEqual(done.documents);

		// Unconfigured source.
		const none = status(env, ["wiki"], HOUR, { binding: null });
		expect(none.complete).toBe(false);
		expect(none.partialReasons).toEqual(["no_complete_scan"]);
		expect(none.lastCompleteScanAt).toBeNull();

		// A complete scan under the new binding restores it.
		env.clock.t += 1000;
		env.source.currentBinding = "binding-2";
		await syncAll(env);
		expect(status(env, ["wiki"], HOUR, { binding: "binding-2" }).complete).toBe(
			true,
		);
		expect(
			status(env, ["wiki"], HOUR, { binding: "binding-1" }).lastCompleteScanAt,
		).toBe(done.lastCompleteScanAt);
	});
});
