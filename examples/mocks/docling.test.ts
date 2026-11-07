import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createDoclingMock, mockDocumentId } from "./docling.js";

const credential = "test-credential";
const auth = { authorization: `Bearer ${credential}` };
const base = "http://docling.mock";

// The shapes Eumenes' docling domain parses (api/domains/docling/contracts/documents.ts).
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const summary = z.object({
	id: z.string().regex(/^wiki-[a-f0-9]{32}$/),
	namespace: z.string().min(1),
	path: z.string().min(1),
	title: z.string().min(1),
	etag: z.string().regex(/^"[a-f0-9]{64}"$/),
	markdownSha256: digest,
	recoverySha256: digest,
	contentDigest: digest,
});
const saved = summary.extend({ markdown: z.string(), recovery: z.string() });
const list = z.object({
	documents: z.array(summary),
	namespaces: z.array(z.string().min(1)),
	nextCursor: z.string().min(1).nullable(),
});
const capabilities = z.object({
	contractVersion: z.literal("larm.docling-files.v1"),
	basePath: z.literal("/v1/docling/documents"),
	requiresDocling: z.literal(false),
	methods: z
		.array(z.string())
		.refine((v) => v.includes("GET") && v.includes("PUT")),
	maxRequestBytes: z.number().int().positive().safe(),
	maxMarkdownBytes: z.number().int().positive().safe(),
	maxRecoveryBytes: z.number().int().positive().safe(),
	maxPageSize: z.number().int().positive().max(100),
	contentDigest: z.literal(
		"sha256(ascii(markdownSha256 + LF + recoverySha256))",
	),
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function setup(
	extra: Parameters<typeof createDoclingMock>[0] = {},
	docs = [
		{ namespace: "notes", path: "a.md", title: "A", markdown: "# A\n" },
		{ namespace: "notes", path: "b.md", title: "B", markdown: "# B\n" },
		{ namespace: "work", path: "c.md", title: "C", markdown: "# C\n" },
	],
) {
	const mock = createDoclingMock({
		documents: docs,
		credential,
		...extra,
	});
	const get = async (path: string, headers: Record<string, string> = auth) =>
		mock.app.request(`${base}${path}`, { headers });
	return { ...mock, get };
}

describe("docling mock responses", () => {
	test("capabilities has the contract fields and no DELETE by default", async () => {
		const { get } = setup();
		const res = await get("/v1/docling/capabilities");
		expect(res.status).toBe(200);
		const caps = capabilities.parse(await res.json());
		expect(caps.methods).not.toContain("DELETE");
		const withLibrary = setup({ libraryExtension: true });
		const body = (await (
			await withLibrary.get("/v1/docling/capabilities")
		).json()) as Record<string, unknown>;
		expect(capabilities.parse(body).methods).toContain("DELETE");
		expect(body.delete).toBe("/v1/docling/documents/{id}");
	});

	test("list and get match the Eumenes schema; ids, etags and digests follow the rules", async () => {
		const { get } = setup();
		const page = list.parse(await (await get("/v1/docling/documents")).json());
		expect(page.namespaces).toEqual(["notes", "work"]);
		expect(page.nextCursor).toBeNull();
		expect(page.documents.map((d) => d.path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(page.documents[0]?.id).toBe(mockDocumentId("notes", "a.md"));
		for (const d of page.documents) {
			const res = await get(`/v1/docling/documents/${d.id}`);
			expect(res.status).toBe(200);
			const doc = saved.parse(await res.json());
			expect(res.headers.get("etag")).toBe(doc.etag);
			expect(doc.etag).toBe(d.etag);
			expect(doc.markdownSha256).toBe(sha(doc.markdown));
			expect(doc.recoverySha256).toBe(sha(doc.recovery));
			expect(doc.contentDigest).toBe(
				sha(`${doc.markdownSha256}\n${doc.recoverySha256}`),
			);
			expect(res.headers.get("cache-control")).toBe("no-store");
		}
	});

	test("markdownSha256 covers the BOM character", async () => {
		const markdown = "﻿# 見出し\r\n本文\r\n";
		const { get, control } = setup({ namespaces: ["notes"] }, []);
		const id = control.addDocument({
			namespace: "notes",
			path: "bom.md",
			title: "BOM",
			markdown,
		});
		const doc = saved.parse(
			await (await get(`/v1/docling/documents/${id}`)).json(),
		);
		expect(doc.markdown).toBe(markdown);
		expect(doc.markdownSha256).toBe(
			createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex"),
		);
		expect(Buffer.from(markdown, "utf8").subarray(0, 3)).toEqual(
			Buffer.from([0xef, 0xbb, 0xbf]),
		);
	});

	test("a recovery-only change moves etag and contentDigest but not markdownSha256", async () => {
		const { get, control } = setup();
		const id = mockDocumentId("notes", "a.md");
		const before = saved.parse(
			await (await get(`/v1/docling/documents/${id}`)).json(),
		);
		control.setRecovery(id, "other recovery");
		const after = saved.parse(
			await (await get(`/v1/docling/documents/${id}`)).json(),
		);
		expect(after.markdownSha256).toBe(before.markdownSha256);
		expect(after.recoverySha256).not.toBe(before.recoverySha256);
		expect(after.contentDigest).not.toBe(before.contentDigest);
		expect(after.etag).not.toBe(before.etag);
		control.setMarkdown(id, "# A2\n");
		const edited = saved.parse(
			await (await get(`/v1/docling/documents/${id}`)).json(),
		);
		expect(edited.markdownSha256).not.toBe(after.markdownSha256);
		expect(edited.etag).not.toBe(after.etag);
		expect(edited.recoverySha256).toBe(after.recoverySha256);
	});

	test("metadata changes keep the id; a move leaves the old namespace listing", async () => {
		const { get, control } = setup();
		const id = mockDocumentId("notes", "a.md");
		control.setMeta(id, {
			namespace: "work",
			path: "moved.md",
			title: "Moved",
		});
		const page = list.parse(await (await get("/v1/docling/documents")).json());
		const moved = page.documents.find((d) => d.id === id);
		expect(moved).toMatchObject({
			namespace: "work",
			path: "moved.md",
			title: "Moved",
		});
		expect(() => control.setMeta(id, { path: "c.md" })).toThrow("path_exists");
	});

	test("invalid ids answer 400 and unknown ids 404, with error bodies {error:{code}}", async () => {
		const { get } = setup();
		const bad = await get("/v1/docling/documents/not-an-id");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: { code: "invalid_request" } });
		const missing = await get(`/v1/docling/documents/wiki-${"0".repeat(32)}`);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: { code: "not_found" } });
	});
});

describe("docling mock auth, access and paging", () => {
	test("anything but the test credential is 401", async () => {
		const { get, control } = setup();
		for (const headers of [
			{} as Record<string, string>,
			{ authorization: "Bearer wrong" },
			{ authorization: credential },
		]) {
			const res = await get("/v1/docling/documents", headers);
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
		}
		control.setCredential("rotated");
		expect((await get("/v1/docling/capabilities")).status).toBe(401);
	});

	test("forbid answers 403 for GET but keeps the listing; allowed areas filter the listing", async () => {
		const { get, control } = setup();
		const id = mockDocumentId("notes", "a.md");
		control.forbid(id);
		expect((await get(`/v1/docling/documents/${id}`)).status).toBe(403);
		expect(
			list.parse(await (await get("/v1/docling/documents")).json()).documents,
		).toHaveLength(3);
		control.forbid(id, false);
		expect((await get(`/v1/docling/documents/${id}`)).status).toBe(200);

		control.setAllowedNamespaces(["work"]);
		const page = list.parse(await (await get("/v1/docling/documents")).json());
		expect(page.namespaces).toEqual(["work"]);
		expect(page.documents.map((d) => d.namespace)).toEqual(["work"]);
		expect((await get(`/v1/docling/documents/${id}`)).status).toBe(403);
	});

	test("paging walks every document once, in order, even with a changing set", async () => {
		const docs = Array.from({ length: 5 }, (_, i) => ({
			namespace: "notes",
			path: `d${i}.md`,
			title: `D${i}`,
			markdown: `# ${i}\n`,
		}));
		const { get, control } = setup({ pageSize: 2 }, docs);
		const caps = capabilities.parse(
			await (await get("/v1/docling/capabilities")).json(),
		);
		expect(caps.maxPageSize).toBe(2);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const query: string = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
			const page = list.parse(
				await (await get(`/v1/docling/documents?${query}`)).json(),
			);
			seen.push(...page.documents.map((d) => d.path));
			cursor = page.nextCursor;
			pages += 1;
			if (pages === 1) control.removeDocument(mockDocumentId("notes", "d0.md"));
		} while (cursor);
		expect(pages).toBe(3);
		expect(seen).toEqual(["d0.md", "d1.md", "d2.md", "d3.md", "d4.md"]);
		// limit above the page size is clamped; a bad limit or cursor is a 400
		const clamped = list.parse(
			await (await get("/v1/docling/documents?limit=100")).json(),
		);
		expect(clamped.documents).toHaveLength(2);
		expect((await get("/v1/docling/documents?limit=0")).status).toBe(400);
		expect((await get("/v1/docling/documents?cursor=%25%25")).status).toBe(400);
	});

	test("an exact multiple of the page size ends with a null cursor", async () => {
		const docs = Array.from({ length: 4 }, (_, i) => ({
			namespace: "notes",
			path: `d${i}.md`,
			title: "T",
			markdown: "x",
		}));
		const { get } = setup({ pageSize: 2 }, docs);
		const first = list.parse(await (await get("/v1/docling/documents")).json());
		expect(first.nextCursor).not.toBeNull();
		const second = list.parse(
			await (
				await get(
					`/v1/docling/documents?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
				)
			).json(),
		);
		expect(second.documents).toHaveLength(2);
		expect(second.nextCursor).toBeNull();
	});
});

describe("docling mock DELETE (library extension)", () => {
	const id = mockDocumentId("notes", "a.md");

	test("is refused without the extension", async () => {
		const { app } = setup();
		const res = await app.request(`${base}/v1/docling/documents/${id}`, {
			method: "DELETE",
			headers: { ...auth, "if-match": `"${"a".repeat(64)}"` },
		});
		expect(res.status).toBe(405);
	});

	test("requires If-Match, rejects a stale one with 412, and deletes with the exact one", async () => {
		const { app, get, control } = setup({ libraryExtension: true });
		const del = (headers: Record<string, string>) =>
			app.request(`${base}/v1/docling/documents/${id}`, {
				method: "DELETE",
				headers: { ...auth, ...headers },
			});
		expect((await del({})).status).toBe(428);
		expect((await del({ "if-match": "*" })).status).toBe(400);
		expect((await del({ "if-match": `W/"${"a".repeat(64)}"` })).status).toBe(
			400,
		);
		const stale = await del({ "if-match": `"${"a".repeat(64)}"` });
		expect(stale.status).toBe(412);
		expect(await stale.json()).toEqual({ error: { code: "etag_mismatch" } });
		expect(control.snapshot(id)).toBeDefined();

		const etag = control.snapshot(id)?.etag ?? "";
		control.setRecovery(id, "changed after listing");
		expect((await del({ "if-match": etag })).status).toBe(412);

		const current = control.snapshot(id)?.etag ?? "";
		const ok = await del({ "if-match": current });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ id, deleted: true });
		expect((await get(`/v1/docling/documents/${id}`)).status).toBe(404);
		expect((await del({ "if-match": current })).status).toBe(404);
	});
});

describe("docling mock failure injection", () => {
	test("failNext is one-shot, matches a route and optionally a document", async () => {
		const { get, control } = setup();
		const a = mockDocumentId("notes", "a.md");
		const b = mockDocumentId("notes", "b.md");
		control.failNext(
			{ route: "get", documentId: b },
			{ kind: "status", status: 503 },
		);
		expect((await get(`/v1/docling/documents/${a}`)).status).toBe(200);
		expect(control.pendingFaults()).toBe(1);
		const failed = await get(`/v1/docling/documents/${b}`);
		expect(failed.status).toBe(503);
		expect(await failed.json()).toEqual({ error: { code: "unavailable" } });
		expect((await get(`/v1/docling/documents/${b}`)).status).toBe(200);
		expect(control.pendingFaults()).toBe(0);

		control.failNext(
			{ route: "list" },
			{ kind: "status", status: 429, code: "rate" },
		);
		expect((await get("/v1/docling/documents")).status).toBe(429);
		expect((await get("/v1/docling/documents")).status).toBe(200);
	});

	test("a fault does not fire before authentication", async () => {
		const { get, control } = setup();
		control.failNext({ route: "list" }, { kind: "status", status: 503 });
		expect((await get("/v1/docling/documents", {})).status).toBe(401);
		expect(control.pendingFaults()).toBe(1);
		control.clearFaults();
		expect(control.pendingFaults()).toBe(0);
	});

	test("disconnect rejects the fetch; afterProcessing applies the DELETE first", async () => {
		const { app, get, control } = setup({ libraryExtension: true });
		control.failNext({ route: "capabilities" }, { kind: "disconnect" });
		await expect(get("/v1/docling/capabilities")).rejects.toBeInstanceOf(
			TypeError,
		);

		const id = mockDocumentId("notes", "a.md");
		control.failNext(
			{ route: "delete" },
			{ kind: "disconnect", afterProcessing: true },
		);
		await expect(
			app.request(`${base}/v1/docling/documents/${id}`, {
				method: "DELETE",
				headers: { ...auth, "if-match": control.snapshot(id)?.etag ?? "" },
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(control.snapshot(id)).toBeUndefined();
	});

	test("raw serves a hand-made body", async () => {
		const { get, control } = setup();
		control.failNext({ route: "list" }, { kind: "raw", body: "not json" });
		const res = await get("/v1/docling/documents");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("not json");
	});

	test("hold computes the answer now and delivers it after release", async () => {
		const { get, control } = setup();
		const id = mockDocumentId("notes", "a.md");
		control.failNext({ route: "get" }, { kind: "hold" });
		let settled = false;
		const pending = get(`/v1/docling/documents/${id}`).then((r) => {
			settled = true;
			return r;
		});
		await control.whenHeld();
		expect(control.heldCount()).toBe(1);
		expect(settled).toBe(false);
		control.setMarkdown(id, "# changed while held\n");
		expect(control.releaseHeld()).toBe(1);
		const doc = saved.parse(await (await pending).json());
		expect(doc.markdown).toBe("# A\n");
		expect(control.heldCount()).toBe(0);
	});

	test("an aborted request rejects a held response", async () => {
		const { app, control } = setup();
		control.failNext({ route: "list" }, { kind: "hold" });
		const controller = new AbortController();
		const pending = app.request(`${base}/v1/docling/documents`, {
			headers: auth,
			signal: controller.signal,
		});
		await control.whenHeld();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(control.heldCount()).toBe(0);
	});

	test("requests are recorded as method and path only", async () => {
		const { get, control } = setup();
		await get("/v1/docling/documents?limit=2&cursor=abc");
		await get("/v1/docling/capabilities", {});
		expect(control.requests()).toEqual([
			{ method: "GET", path: "/v1/docling/documents" },
			{ method: "GET", path: "/v1/docling/capabilities" },
		]);
		control.clearRequests();
		expect(control.requests()).toEqual([]);
	});
});
