import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	evidenceResponseSchema,
	type EvidenceRequest,
} from "../../contracts/index.js";
import { retireDocumentInTransaction } from "../../sqlite/index.js";
import { docId, makeDoc, runJob, syncAll } from "../harness.fixture.js";
import { readEvidence } from "./index.js";
import { ACCESS, HOUR, ingestAll, makeSearchEnv } from "./search.fixture.js";

const sha = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");

const JP =
	"# 見出し\r\n\r\n日本語の本文です。😀 絵文字と CRLF を含みます。\r\n";
const BOM = `﻿${JP}`;

async function setup(markdown = BOM) {
	const env = makeSearchEnv();
	await ingestAll(env, [{ n: 1, markdown }]);
	const bytes = Buffer.from(markdown, "utf8");
	const read = (
		request: EvidenceRequest,
		access = ACCESS,
		verifiedWithinMs = HOUR,
	) => {
		const out = readEvidence(
			{ ...env.deps, options: { verifiedWithinMs } },
			access,
			request,
		);
		expect(evidenceResponseSchema.parse(out)).toEqual(out);
		return out;
	};
	/** A request for the bytes [start, end) of the body, with the correct digests. */
	const cite = (start: number, end: number): EvidenceRequest => ({
		documentId: docId(1),
		markdownSha256: sha(bytes),
		byteStart: start,
		byteEnd: end,
		quoteSha256: sha(bytes.subarray(start, end)),
	});
	return { env, bytes, read, cite };
}

/** Byte range of `needle` in the body. */
const rangeOf = (bytes: Buffer, needle: string) => {
	const start = bytes.indexOf(Buffer.from(needle, "utf8"));
	expect(start).toBeGreaterThanOrEqual(0);
	return [start, start + Buffer.byteLength(needle)] as const;
};

describe("valid", () => {
	test("BOM, CRLF, Japanese and emoji ranges return the exact text", async () => {
		const { bytes, read, cite } = await setup();
		for (const needle of [
			"﻿# 見出し",
			"\r\n\r\n",
			"日本語の本文です。",
			"😀",
			"絵文字と CRLF",
			BOM,
		]) {
			const [s, e] = rangeOf(bytes, needle);
			expect(read(cite(s, e))).toEqual({
				status: "valid",
				quote: needle,
				state: "current",
			});
		}
	});

	test("a range may span fragments", async () => {
		const para = (c: string) => `${c.repeat(900)}\n`;
		const markdown = `# T\n\n${para("あ")}\n${para("い")}\n${para("う")}`;
		const { env, bytes, read, cite } = await setup(markdown);
		const frags = env.db
			.query<{ byte_start: number; byte_end: number }, []>(
				"SELECT byte_start, byte_end FROM knowledge_fragments ORDER BY ordinal",
			)
			.all();
		expect(frags.length).toBeGreaterThanOrEqual(3);
		// from inside the first paragraph into the last one, on character boundaries
		const start = bytes.indexOf("あ") + 3 * 100;
		const end = bytes.indexOf("う") + 9;
		expect(
			frags.filter((f) => f.byte_end > start && f.byte_start < end).length,
		).toBeGreaterThanOrEqual(3);
		const out = read(cite(start, end));
		expect(out.status).toBe("valid");
		if (out.status === "valid") {
			expect(out.quote).toBe(bytes.subarray(start, end).toString("utf8"));
			expect(out.quote.length).toBeGreaterThan(1000);
		}
		// the whole body
		const all = read(cite(0, bytes.length));
		expect(all.status === "valid" && all.quote === markdown).toBe(true);
	});

	test("a document not verified lately is valid but unverified", async () => {
		const { bytes, read, cite, env } = await setup();
		env.clock.t += 2 * HOUR;
		expect(read(cite(0, 5))).toMatchObject({
			status: "valid",
			state: "unverified",
		});
		expect(bytes.length).toBeGreaterThan(5);
	});
});

describe("mismatch", () => {
	test("a wrong quote digest, a range outside the body, a cut character", async () => {
		const { bytes, read, cite } = await setup();
		const [s, e] = rangeOf(bytes, "日本語");
		expect(read({ ...cite(s, e), quoteSha256: sha("other") })).toEqual({
			status: "mismatch",
		});
		expect(read(cite(0, 5))).toMatchObject({ status: "valid" });
		// past the end of the body
		const past = { ...cite(0, bytes.length), byteEnd: bytes.length + 1 };
		expect(read(past)).toEqual({ status: "mismatch" });
		expect(
			read({
				...cite(0, 1),
				byteStart: bytes.length + 5,
				byteEnd: bytes.length + 9,
			}),
		).toEqual({ status: "mismatch" });
		// a range that cuts a three-byte character is no quotation, even with its own digest
		expect(read(cite(s + 1, e))).toEqual({ status: "mismatch" });
		expect(read(cite(s, e - 1))).toEqual({ status: "mismatch" });
		// one byte more or less than the cited text
		expect(read({ ...cite(s, e), byteEnd: e + 1 })).toEqual({
			status: "mismatch",
		});
	});
});

describe("stale", () => {
	test("another version than the published one", async () => {
		const { bytes, read, cite } = await setup();
		const old = cite(0, 5);
		expect(read({ ...old, markdownSha256: sha("not the body") })).toEqual({
			status: "stale",
			currentMarkdownSha256: sha(bytes),
		});
	});

	test("a newer version observed but not ingested yet", async () => {
		const { env, bytes, read, cite } = await setup();
		env.source.put(makeDoc(1, "changed body"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		// the old citation is no longer adoptable, and the answer names the published version
		expect(read(cite(0, 5))).toEqual({
			status: "stale",
			currentMarkdownSha256: sha(bytes),
		});
		// after the new version is published, the old sha is stale against the new one
		await syncAll(env);
		expect(read(cite(0, 5))).toEqual({
			status: "stale",
			currentMarkdownSha256: sha("changed body"),
		});
		expect(
			read({
				documentId: docId(1),
				markdownSha256: sha("changed body"),
				byteStart: 0,
				byteEnd: 7,
				quoteSha256: sha("changed"),
			}),
		).toEqual({ status: "valid", quote: "changed", state: "current" });
	});

	test("a stale document without a published version has no current sha", async () => {
		const env = makeSearchEnv();
		env.source.put(makeDoc(1, "new doc"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const out = readEvidence({ ...env.deps }, ACCESS, {
			documentId: docId(1),
			markdownSha256: sha("new doc"),
			byteStart: 0,
			byteEnd: 3,
			quoteSha256: sha("new"),
		});
		expect(out).toEqual({ status: "stale", currentMarkdownSha256: null });
	});
});

describe("unavailable and not available", () => {
	test("unavailable, excluded and removed documents", async () => {
		for (const how of ["unavailable", "excluded", "removed"] as const) {
			const { env, read, cite } = await setup();
			expect(read(cite(0, 5)).status).toBe("valid");
			if (how === "unavailable") {
				env.db
					.query("UPDATE knowledge_documents SET state = 'unavailable'")
					.run();
			} else {
				env.db.transaction(() =>
					retireDocumentInTransaction(
						env.db,
						{ sourceNamespace: "docling", documentId: docId(1) },
						how,
						env.clock.t,
					),
				)();
			}
			expect(read(cite(0, 5))).toEqual({ status: "unavailable" });
		}
	});

	test("unknown and out-of-scope documents are not told apart", async () => {
		const { env, read, cite } = await setup();
		const unknown = read({ ...cite(0, 5), documentId: docId(99) });
		const outside = read(cite(0, 5), { principal: "q", namespaces: ["other"] });
		const nobody = read(cite(0, 5), { principal: "q", namespaces: [] });
		expect(unknown).toEqual({ status: "not_available" });
		expect(outside).toEqual(unknown);
		expect(nobody).toEqual(unknown);
		expect(env.db).toBeDefined();
	});
});

describe("input", () => {
	test("a malformed request is invalid_input", async () => {
		const { read, cite } = await setup();
		const ok = cite(0, 5);
		for (const bad of [
			{ ...ok, byteEnd: ok.byteStart },
			{ ...ok, byteStart: -1 },
			{ ...ok, documentId: "x" },
			{ ...ok, quoteSha256: "abc" },
			{ ...ok, extra: true },
		]) {
			expect(() => read(bad as never)).toThrow();
			try {
				read(bad as never);
			} catch (e) {
				expect((e as { code: string }).code).toBe("invalid_input");
			}
		}
	});
});
