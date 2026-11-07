import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { KnowledgeError, SourceError } from "../contracts/index.js";
import { getDocumentInTransaction } from "../sqlite/index.js";
import { sha256Hex, utf8Bytes } from "./index.js";
import {
	docId,
	drain,
	makeDoc,
	makeEnv,
	rows,
	runJob,
	sha,
	syncAll,
} from "./harness.fixture.js";

const key = (n: number) => ({
	sourceNamespace: "docling",
	documentId: docId(n),
});

/** Queue the ingest of whatever the listing says, with the source serving `served` on read. */
async function ingestServing(
	env: ReturnType<typeof makeEnv>,
	listed: ReturnType<typeof makeDoc>,
	served: ReturnType<typeof makeDoc>,
) {
	env.source.put(listed);
	env.source.readOverride.set(listed.documentId, served);
	await runJob(env.db, env.sync, {
		scanId: randomUUID(),
		cursor: null,
		page: 0,
	});
	return drain(env);
}

describe("refusing a body", () => {
	test("a digest mismatch is refused and a current document is not damaged", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await syncAll(env);
		const before = getDocumentInTransaction(env.db, key(1))!;

		const listed = makeDoc(1, "v2 listed");
		const served = {
			...makeDoc(1, "tampered body"),
			markdownSha256: listed.markdownSha256,
		};
		const { logs } = await ingestServing(env, listed, served);
		expect(logs[0]!.error).toMatchObject({ code: "digest_mismatch" });
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.appliedMarkdownSha256).toBe(before.appliedMarkdownSha256);
		expect(row.appliedByteLength).toBe(before.appliedByteLength);
		expect(row.state).toBe("stale");
	});

	test("a lone surrogate is invalid_input", async () => {
		const env = makeEnv();
		const body = "ok \ud800 broken";
		const listed = makeDoc(1, body);
		const { logs } = await ingestServing(env, listed, listed);
		expect(logs[0]!.error).toMatchObject({ code: "invalid_input" });
		expect(
			getDocumentInTransaction(env.db, key(1))!.appliedMarkdownSha256,
		).toBeNull();
	});

	test("a body over the limit is document_too_large (limit is an option)", async () => {
		const env = makeEnv({ maxDocumentBytes: 10 });
		const listed = makeDoc(1, "0123456789ab");
		const { logs } = await ingestServing(env, listed, listed);
		expect(logs[0]!.error).toMatchObject({ code: "document_too_large" });
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("stale");

		const ok = makeEnv({ maxDocumentBytes: 12 });
		const again = await ingestServing(ok, listed, listed);
		expect(again.logs[0]!.settled).toBe("applied");
		expect(getDocumentInTransaction(ok.db, key(1))!.state).toBe("current");
	});

	test("the default limit is 8 MiB", async () => {
		const env = makeEnv();
		const exact = makeDoc(1, "a".repeat(8 * 1024 * 1024));
		const ok = await ingestServing(env, exact, exact);
		expect(ok.logs[0]!.settled).toBe("applied");
		const over = makeDoc(2, "a".repeat(8 * 1024 * 1024 + 1));
		const bad = await ingestServing(env, over, over);
		expect(bad.logs[0]!.error).toMatchObject({ code: "document_too_large" });
	});

	test("a document with another id or namespace is document_mismatch", async () => {
		const env = makeEnv();
		const listed = makeDoc(1, "one");
		const { logs } = await ingestServing(env, listed, makeDoc(2, "one"));
		expect(logs[0]!.error).toMatchObject({ code: "document_mismatch" });
	});

	test("a malformed port answer is contract_mismatch", async () => {
		const env = makeEnv();
		const listed = makeDoc(1, "one");
		const { logs } = await ingestServing(env, listed, {
			...listed,
			etag: "weak",
		});
		expect(logs[0]!.error).toMatchObject({ code: "contract_mismatch" });
	});

	test("other source errors are thrown and classified", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "one"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		env.source.readErrors.set(docId(1), "unauthorized");
		const { logs } = await drain(env);
		expect(logs[0]!.error).toBeInstanceOf(SourceError);
		expect(env.ingest.classify(new SourceError("unavailable"))).toBe("retry");
		expect(env.ingest.classify(new SourceError("timeout"))).toBe("retry");
		expect(env.ingest.classify(new SourceError("unauthorized"))).toBe("fail");
		expect(env.ingest.classify(new SourceError("not_found"))).toBe("fail");
		expect(env.ingest.classify(new KnowledgeError("digest_mismatch"))).toBe(
			"fail",
		);
		expect(env.ingest.classify(new Error("boom"))).toBe("fail");
		expect(env.sync.classify(new SourceError("timeout"))).toBe("retry");
	});

	test("a retried list keeps the scan running", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "one"));
		env.source.listFailsAt = "0";
		env.source.listFailCode = "unavailable";
		const scanId = randomUUID();
		// cursor "0" fails; use it as the first-page cursor of a page-0 job.
		const log = await runJob(env.db, env.sync, {
			scanId,
			cursor: "0",
			page: 0,
		});
		expect(log.error).toBeInstanceOf(SourceError);
		expect(rows(env.db, "SELECT state FROM knowledge_scans")).toEqual([
			{ state: "running" },
		]);
	});
});

describe("bytes", () => {
	const cases: Record<string, string> = {
		bom: "\ufeff# Title\n",
		crlf: "line1\r\nline2\r\n",
		japanese: "# 見出し\n\n日本語の本文です。\n",
		emoji: "emoji 😀👨‍👩‍👧 end\n",
		frontmatter: "---\ntitle: あ\n---\n\nbody\r\n",
	};
	for (const [name, body] of Object.entries(cases)) {
		test(`${name}: sha256 covers the exact UTF-8 bytes and ingest applies`, async () => {
			const bytes = utf8Bytes(body);
			expect(Buffer.from(bytes).equals(Buffer.from(body, "utf8"))).toBe(true);
			expect(sha256Hex(bytes)).toBe(sha(Buffer.from(body, "utf8")));
			if (name === "bom") {
				expect(bytes.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
				const stripped = body.slice(1);
				expect(sha256Hex(bytes)).not.toBe(sha(Buffer.from(stripped, "utf8")));
			}
			const env = makeEnv();
			const doc = makeDoc(1, body);
			env.source.put(doc);
			await syncAll(env);
			const row = getDocumentInTransaction(env.db, key(1))!;
			expect(row.state).toBe("current");
			expect(row.appliedMarkdownSha256).toBe(doc.markdownSha256);
			expect(row.appliedByteLength).toBe(bytes.byteLength);
		});
	}

	test("a digest computed without the BOM is refused", async () => {
		const env = makeEnv();
		const body = "\ufeff# Title\n";
		const wrongSha = sha(Buffer.from(body.slice(1), "utf8"));
		const listed = makeDoc(1, body, { markdownSha256: wrongSha });
		const { logs } = await ingestServing(env, listed, listed);
		expect(logs[0]!.error).toMatchObject({ code: "digest_mismatch" });
	});

	test("events never carry the body", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "SECRET-BODY-TEXT"));
		await syncAll(env);
		expect(env.events.length).toBeGreaterThan(0);
		expect(JSON.stringify(env.events)).not.toContain("SECRET-BODY-TEXT");
	});
});
