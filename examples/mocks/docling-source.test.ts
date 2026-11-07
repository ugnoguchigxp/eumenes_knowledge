import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	SourceError,
	documentInputSchema,
	documentListPageSchema,
	type SourceErrorCode,
} from "../../src/contracts/index.js";
import {
	createDoclingMock,
	mockDocumentId,
	type MockDocumentInput,
} from "./docling.js";
import { createDoclingSource } from "./docling-source.js";

const credential = "test-credential";
const baseUrl = "http://docling.mock";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const signal = () => new AbortController().signal;

function setup(
	options: {
		docs?: MockDocumentInput[];
		pageSize?: number;
		maxResponseBytes?: number;
	} = {},
) {
	const mock = createDoclingMock({
		documents: options.docs ?? [
			{
				namespace: "notes",
				path: "a.md",
				title: "A",
				markdown: "# A\n",
				recovery: "RECOVERY-MARKER-a",
			},
			{
				namespace: "notes",
				path: "b.md",
				title: "B",
				markdown: "# B\n",
				recovery: "RECOVERY-MARKER-b",
			},
		],
		credential,
		pageSize: options.pageSize,
	});
	const source = createDoclingSource({
		fetch: (input, init) => mock.app.request(input, init),
		baseUrl,
		credential,
		maxResponseBytes: options.maxResponseBytes,
	});
	return { ...mock, source };
}

async function codeOf(promise: Promise<unknown>): Promise<SourceErrorCode> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof SourceError) return error.code;
		throw error;
	}
	throw new Error("expected a SourceError");
}

const idA = mockDocumentId("notes", "a.md");

describe("docling source: success paths", () => {
	test("list maps to the package contract and drops the recovery digest", async () => {
		const { source } = setup();
		const page = await source.list(null, signal());
		expect(() => documentListPageSchema.parse(page)).not.toThrow();
		expect(page.namespaces).toEqual(["notes"]);
		expect(page.nextCursor).toBeNull();
		expect(page.documents.map((d) => d.documentId)).toEqual([
			idA,
			mockDocumentId("notes", "b.md"),
		]);
		expect(page.documents[0]).not.toHaveProperty("recoverySha256");
		expect(page.documents[0]?.sourceNamespace).toBe("docling");
	});

	test("paging through the cursor reads everything", async () => {
		const docs = Array.from({ length: 5 }, (_, i) => ({
			namespace: "notes",
			path: `d${i}.md`,
			title: "T",
			markdown: `# ${i}`,
		}));
		const { source, control } = setup({ docs, pageSize: 2 });
		const ids: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await source.list(cursor, signal());
			ids.push(...page.documents.map((d) => d.documentId));
			cursor = page.nextCursor;
		} while (cursor);
		expect(ids).toHaveLength(5);
		expect(new Set(ids).size).toBe(5);
		// capabilities precede every list and read
		const paths = control.requests().map((r) => r.path);
		expect(paths.slice(0, 2)).toEqual([
			"/v1/docling/capabilities",
			"/v1/docling/documents",
		]);
	});

	test("read returns the body without the recovery, matching the listing", async () => {
		const { source, control } = setup();
		const listed = (await source.list(null, signal())).documents[0];
		const doc = await source.read(idA, signal());
		expect(() => documentInputSchema.parse(doc)).not.toThrow();
		expect(JSON.stringify(doc)).not.toContain("RECOVERY-MARKER");
		expect(doc).not.toHaveProperty("recovery");
		expect(doc).not.toHaveProperty("recoverySha256");
		expect(doc.markdown).toBe("# A\n");
		const { markdown: _m, ...summary } = doc;
		expect(summary).toEqual(listed as NonNullable<typeof listed>);
		expect(control.snapshot(idA)?.etag).toBe(doc.etag);
	});

	test("a BOM and CRLF body keeps its bytes and markdownSha256", async () => {
		const markdown = "﻿---\r\ntitle: 試験\r\n---\r\n\r\n# 見出し\r\n本文\r\n";
		const { source, control } = setup({ docs: [] });
		// the allowed area must include the new document's namespace
		control.setAllowedNamespaces(["notes"]);
		const id = control.addDocument({
			namespace: "notes",
			path: "bom.md",
			title: "BOM",
			markdown,
		});
		const doc = await source.read(id, signal());
		expect(doc.markdown).toBe(markdown);
		expect(doc.markdownSha256).toBe(
			createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex"),
		);
		expect(doc.markdownSha256).not.toBe(sha(markdown.slice(1)));
	});

	test("a recovery-only change changes etag and contentDigest, not markdownSha256", async () => {
		const { source, control } = setup();
		const before = await source.read(idA, signal());
		control.setRecovery(idA, "RECOVERY-MARKER-new");
		const after = await source.read(idA, signal());
		expect(after.markdownSha256).toBe(before.markdownSha256);
		expect(after.etag).not.toBe(before.etag);
		expect(after.contentDigest).not.toBe(before.contentDigest);
	});

	test("binding is the sha256 of base URL and credential", () => {
		const { source } = setup();
		expect(source.binding()).toBe(sha(JSON.stringify([baseUrl, credential])));
		const other = createDoclingSource({
			fetch: () => new Response(),
			baseUrl,
			credential: "",
		});
		expect(other.binding()).toBeNull();
	});
});

describe("docling source: error mapping", () => {
	test("read statuses map to source codes", async () => {
		const { source, control } = setup();
		const cases: [number, SourceErrorCode][] = [
			[404, "not_found"],
			[403, "forbidden"],
			[401, "unauthorized"],
			[500, "unavailable"],
			[503, "unavailable"],
			[408, "timeout"],
			[400, "invalid_response"],
			[412, "invalid_response"],
		];
		for (const [status, code] of cases) {
			control.failNext({ route: "get" }, { kind: "status", status });
			expect(await codeOf(source.read(idA, signal()))).toBe(code);
		}
	});

	test("real 404 and 403 from the mock state", async () => {
		const { source, control } = setup();
		expect(await codeOf(source.read(`wiki-${"0".repeat(32)}`, signal()))).toBe(
			"not_found",
		);
		control.forbid(idA);
		expect(await codeOf(source.read(idA, signal()))).toBe("forbidden");
		control.forbid(idA, false);
		control.setCredential("rotated");
		expect(await codeOf(source.list(null, signal()))).toBe("unauthorized");
		expect(await codeOf(source.read("bad-id", signal()))).toBe("not_found");
	});

	test("list and capabilities statuses map; a 404 there is a broken contract", async () => {
		const { source, control } = setup();
		control.failNext({ route: "list" }, { kind: "status", status: 502 });
		expect(await codeOf(source.list(null, signal()))).toBe("unavailable");
		control.failNext(
			{ route: "capabilities" },
			{ kind: "status", status: 404 },
		);
		expect(await codeOf(source.list(null, signal()))).toBe("invalid_response");
		control.failNext(
			{ route: "capabilities" },
			{ kind: "status", status: 401 },
		);
		expect(await codeOf(source.read(idA, signal()))).toBe("unauthorized");
	});

	test("a 403 from capabilities or the list is unauthorized, never a document state", async () => {
		const { source, control } = setup();
		// read() fetches capabilities before the document GET.
		control.failNext(
			{ route: "capabilities" },
			{ kind: "status", status: 403 },
		);
		expect(await codeOf(source.read(idA, signal()))).toBe("unauthorized");
		control.failNext(
			{ route: "capabilities" },
			{ kind: "status", status: 403 },
		);
		expect(await codeOf(source.list(null, signal()))).toBe("unauthorized");
		control.failNext({ route: "list" }, { kind: "status", status: 403 });
		expect(await codeOf(source.list(null, signal()))).toBe("unauthorized");
		// Only the document GET keeps forbidden.
		control.failNext({ route: "get" }, { kind: "status", status: 403 });
		expect(await codeOf(source.read(idA, signal()))).toBe("forbidden");
	});

	test("a dropped connection is unavailable", async () => {
		const { source, control } = setup();
		control.failNext({ route: "get" }, { kind: "disconnect" });
		expect(await codeOf(source.read(idA, signal()))).toBe("unavailable");
		control.failNext({ route: "capabilities" }, { kind: "disconnect" });
		expect(await codeOf(source.list(null, signal()))).toBe("unavailable");
	});

	test("an aborted signal is cancelled, before and during a held response", async () => {
		const { source, control } = setup();
		const done = new AbortController();
		done.abort();
		expect(await codeOf(source.read(idA, done.signal))).toBe("cancelled");

		control.failNext({ route: "get" }, { kind: "hold" });
		const controller = new AbortController();
		const pending = codeOf(source.read(idA, controller.signal));
		await control.whenHeld();
		controller.abort();
		expect(await pending).toBe("cancelled");
		expect(control.heldCount()).toBe(0);
	});

	test("a held response that is released late still arrives", async () => {
		const { source, control } = setup();
		control.failNext({ route: "get" }, { kind: "hold" });
		const pending = source.read(idA, signal());
		await control.whenHeld();
		control.setMarkdown(idA, "# newer\n");
		control.releaseHeld();
		expect((await pending).markdown).toBe("# A\n");
	});

	test("contract violations are invalid_response", async () => {
		const { source, control } = setup();
		const good = control.snapshot(idA);
		if (!good) throw new Error("fixture");
		const body = (patch: Record<string, unknown>) =>
			JSON.stringify({ ...good, ...patch });
		const headers = { etag: good.etag, "content-type": "application/json" };
		const broken: Record<
			string,
			{ body: string; headers?: Record<string, string> }
		> = {
			"not json": { body: "{", headers },
			"id mismatch": {
				body: body({ id: mockDocumentId("notes", "b.md") }),
				headers,
			},
			"etag header differs": {
				body: body({}),
				headers: { etag: `"${"b".repeat(64)}"` },
			},
			"etag header missing": { body: body({}), headers: {} },
			"markdown digest": { body: body({ markdown: "# tampered\n" }), headers },
			"recovery digest": { body: body({ recovery: "tampered" }), headers },
			"content digest": {
				body: body({ contentDigest: "c".repeat(64) }),
				headers,
			},
			"bad etag format": { body: body({ etag: "W/abc" }), headers },
			"missing field": {
				body: JSON.stringify({ id: good.id, markdown: "" }),
				headers,
			},
		};
		for (const [name, { body: raw, headers: h }] of Object.entries(broken)) {
			control.failNext(
				{ route: "get" },
				{ kind: "raw", status: 200, headers: h, body: raw },
			);
			expect([name, await codeOf(source.read(idA, signal()))]).toEqual([
				name,
				"invalid_response",
			]);
		}
		// a non-200 success status is also a violation
		control.failNext(
			{ route: "get" },
			{ kind: "raw", status: 201, headers, body: body({}) },
		);
		expect(await codeOf(source.read(idA, signal()))).toBe("invalid_response");
	});

	test("list violations: namespace outside the areas, bad schema, bad capabilities", async () => {
		const { source, control } = setup();
		const entry = control.snapshot(idA);
		if (!entry) throw new Error("fixture");
		const { markdown: _m, recovery: _r, ...summary } = entry;
		control.failNext(
			{ route: "list" },
			{
				kind: "raw",
				body: JSON.stringify({
					documents: [{ ...summary, namespace: "elsewhere" }],
					namespaces: ["notes"],
					nextCursor: null,
				}),
			},
		);
		expect(await codeOf(source.list(null, signal()))).toBe("invalid_response");
		control.failNext(
			{ route: "list" },
			{ kind: "raw", body: JSON.stringify({ documents: [{ id: "x" }] }) },
		);
		expect(await codeOf(source.list(null, signal()))).toBe("invalid_response");
		control.failNext(
			{ route: "capabilities" },
			{ kind: "raw", body: JSON.stringify({ contractVersion: "other" }) },
		);
		expect(await codeOf(source.list(null, signal()))).toBe("invalid_response");
	});

	test("a response over the size bound is invalid_response", async () => {
		const big = "あ".repeat(2000);
		const { source } = setup({
			docs: [
				{ namespace: "notes", path: "big.md", title: "Big", markdown: big },
			],
			maxResponseBytes: 4000,
		});
		const id = mockDocumentId("notes", "big.md");
		expect(await codeOf(source.read(id, signal()))).toBe("invalid_response");
	});

	test("a markdown over the advertised limit is invalid_response", async () => {
		const mock = createDoclingMock({
			documents: [
				{
					namespace: "notes",
					path: "big.md",
					title: "Big",
					markdown: "x".repeat(200),
				},
			],
			credential,
			limits: { maxMarkdownBytes: 100 },
		});
		const source = createDoclingSource({
			fetch: (input, init) => mock.app.request(input, init),
			baseUrl,
			credential,
		});
		expect(
			await codeOf(source.read(mockDocumentId("notes", "big.md"), signal())),
		).toBe("invalid_response");
	});

	test("a connection change during a read is connection_changed", async () => {
		const mock = createDoclingMock({
			documents: [
				{ namespace: "notes", path: "a.md", title: "A", markdown: "# A" },
			],
			credential,
		});
		const source = createDoclingSource({
			fetch: (input, init) => mock.app.request(input, init),
			baseUrl,
			credential,
		});
		mock.control.failNext({ route: "get" }, { kind: "hold" });
		const before = source.binding();
		const pending = codeOf(source.read(idA, signal()));
		await mock.control.whenHeld();
		source.reconfigure({ baseUrl: "http://other.mock" });
		mock.control.releaseHeld();
		expect(await pending).toBe("connection_changed");
		expect(source.binding()).not.toBe(before);
	});

	test("errors carry the code only: no body, no credential", async () => {
		const { source, control } = setup();
		control.failNext(
			{ route: "get" },
			{ kind: "status", status: 500, code: "BODY-SECRET-MARKER" },
		);
		try {
			await source.read(idA, signal());
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(SourceError);
			const text =
				JSON.stringify(error) + String(error) + (error as Error).message;
			expect(text).not.toContain("BODY-SECRET-MARKER");
			expect(text).not.toContain(credential);
			expect((error as Error).message).toBe("unavailable");
		}
	});
});
