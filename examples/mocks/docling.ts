import { Hono } from "hono";
import { documentDigests, sha256Hex } from "./docling-digest.js";
import { createGate, isAbortError } from "./gate.js";

/**
 * An in-process imitation of LARM's resident Docling file API (`larm.docling-files.v1`), as
 * Eumenes' docling domain consumes it. It is a Hono app only: nothing listens on a port, and a
 * test calls `app.request` / `app.fetch` directly. State changes go through `control`, never
 * through HTTP.
 */

export const DOCLING_BASE_PATH = "/v1/docling/documents";
export const DOCLING_CAPABILITIES_PATH = "/v1/docling/capabilities";
export const DOCLING_CONTRACT_VERSION = "larm.docling-files.v1";
export const DOCLING_CONTENT_DIGEST_RULE =
	"sha256(ascii(markdownSha256 + LF + recoverySha256))";

const DOCUMENT_ID = /^wiki-[a-f0-9]{32}$/;
const STRONG_ETAG = /^"[a-f0-9]{64}"$/;

/** Limits Eumenes saw from the real service (spec: 8 MiB / 8 MiB / 20 MiB, page 100). */
export type DoclingLimits = {
	maxRequestBytes: number;
	maxMarkdownBytes: number;
	maxRecoveryBytes: number;
};
const defaultLimits: DoclingLimits = {
	maxRequestBytes: 20 * 1024 * 1024,
	maxMarkdownBytes: 8 * 1024 * 1024,
	maxRecoveryBytes: 8 * 1024 * 1024,
};

export type MockDocumentInput = {
	/** `wiki-` + 32 hex. Derived from namespace and path when omitted. */
	id?: string;
	namespace: string;
	path: string;
	title: string;
	markdown: string;
	/** Opaque editor state that is not Markdown. Defaults to a synthetic string. */
	recovery?: string;
};

export type MockDocumentSnapshot = {
	id: string;
	namespace: string;
	path: string;
	title: string;
	markdown: string;
	recovery: string;
	etag: string;
	markdownSha256: string;
	recoverySha256: string;
	contentDigest: string;
};

/** Stable synthetic document id for a (namespace, path) pair. */
export function mockDocumentId(namespace: string, path: string): string {
	return `wiki-${sha256Hex(JSON.stringify(["docling-mock-id-v1", namespace, path])).slice(0, 32)}`;
}

/**
 * The mock's ETag rule: a strong ETag `"<sha256 hex>"` over id, namespace, path, title,
 * markdownSha256 and recoverySha256. A change of the body or of the recovery always changes it
 * (it hashes both digests); so does a move or a retitle. This is the mock's own choice: the real
 * service only promises a strong ETag that changes when the document changes.
 */
export function mockEtag(doc: {
	id: string;
	namespace: string;
	path: string;
	title: string;
	markdownSha256: string;
	recoverySha256: string;
}): string {
	return `"${sha256Hex(
		JSON.stringify([
			"docling-mock-etag-v1",
			doc.id,
			doc.namespace,
			doc.path,
			doc.title,
			doc.markdownSha256,
			doc.recoverySha256,
		]),
	)}"`;
}

export type DoclingRoute = "capabilities" | "list" | "get" | "delete";

/** What the next matching request suffers instead of (or after) its normal handling. */
export type DoclingFault =
	/** An error response `{error:{code}}` with this status. The request has no effect. */
	| { kind: "status"; status: number; code?: string }
	/** A response with a hand-made body (for broken-contract responses). The request has no effect. */
	| {
			kind: "raw";
			status?: number;
			headers?: Record<string, string>;
			body: string;
	  }
	/**
	 * The connection drops: the fetch rejects with a TypeError. With `afterProcessing` the request
	 * has taken effect first (a lost response).
	 */
	| { kind: "disconnect"; afterProcessing?: boolean }
	/** The request takes effect, but the response is held until `control.releaseHeld()`. */
	| { kind: "hold" };

export type DoclingFaultMatch = { route: DoclingRoute; documentId?: string };

/** A recorded request: method and path only. Never a query, a header, a body or a credential. */
export type DoclingRequestRecord = { method: string; path: string };

export type DoclingMockOptions = {
	documents?: readonly MockDocumentInput[];
	/** The allowed areas the credential may read. Defaults to the namespaces of the initial `documents` (documents added later do not widen it). */
	namespaces?: readonly string[];
	/** Documents per page, 1..100. Default 100. */
	pageSize?: number;
	/** The test credential. Any other Bearer value is answered 401. */
	credential?: string;
	/** Adds `DELETE` (If-Match required) and its capabilities entries, as in the delete proposal. */
	libraryExtension?: boolean;
	limits?: Partial<DoclingLimits>;
};

export type DoclingMockControl = {
	/** Adds a document and returns its id. */
	addDocument(input: MockDocumentInput): string;
	/** Changes the Markdown only; the recovery stays. */
	setMarkdown(id: string, markdown: string): void;
	/** Changes the recovery only; markdownSha256 stays, etag and contentDigest change. */
	setRecovery(id: string, recovery: string): void;
	setMeta(
		id: string,
		meta: { namespace?: string; path?: string; title?: string },
	): void;
	removeDocument(id: string): void;
	/** Makes GET and DELETE of this document answer 403 (it stays in the listing). */
	forbid(id: string, forbidden?: boolean): void;
	/** Replaces the allowed areas. Documents outside them leave the listing and answer 403. */
	setAllowedNamespaces(namespaces: readonly string[]): void;
	setCredential(credential: string): void;
	/** Queues a one-shot fault for the next request that matches. */
	failNext(match: DoclingFaultMatch, fault: DoclingFault): void;
	clearFaults(): void;
	pendingFaults(): number;
	/** Releases every held response. */
	releaseHeld(): number;
	heldCount(): number;
	whenHeld(n?: number): Promise<void>;
	requests(): readonly DoclingRequestRecord[];
	clearRequests(): void;
	/** The current state of a document with its digests (test inspection only). */
	snapshot(id: string): MockDocumentSnapshot | undefined;
};

type Stored = {
	id: string;
	namespace: string;
	path: string;
	title: string;
	markdown: string;
	recovery: string;
};

/** Thrown into Hono and rethrown by `onError`, so that `app.request` rejects like a dropped socket. */
class MockConnectionDropped extends TypeError {
	constructor() {
		super("mock connection dropped");
	}
}

const statusCodes: Record<number, string> = {
	400: "invalid_request",
	401: "unauthorized",
	403: "forbidden",
	404: "not_found",
	412: "etag_mismatch",
	413: "payload_too_large",
	428: "precondition_required",
};

function errorBody(code: string): string {
	return JSON.stringify({ error: { code } });
}

function jsonResponse(
	body: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	});
}

function errorResponse(
	status: number,
	code?: string,
	headers?: Record<string, string>,
): Response {
	const resolved =
		code ?? statusCodes[status] ?? (status >= 500 ? "unavailable" : "error");
	return jsonResponse(errorBody(resolved), status, headers);
}

function routeOf(
	method: string,
	pathname: string,
): { route: DoclingRoute; documentId?: string } | null {
	if (method === "GET" && pathname === DOCLING_CAPABILITIES_PATH)
		return { route: "capabilities" };
	if (method === "GET" && pathname === DOCLING_BASE_PATH)
		return { route: "list" };
	if (pathname.startsWith(`${DOCLING_BASE_PATH}/`)) {
		const raw = pathname.slice(DOCLING_BASE_PATH.length + 1);
		if (raw === "" || raw.includes("/")) return null;
		let documentId = raw;
		try {
			documentId = decodeURIComponent(raw);
		} catch {
			// keep the raw segment; the handler answers 400 for it
		}
		if (method === "GET") return { route: "get", documentId };
		if (method === "DELETE") return { route: "delete", documentId };
	}
	return null;
}

type SortKey = [string, string, string];
function compareKeys(a: SortKey, b: SortKey): number {
	for (let i = 0; i < 3; i++) {
		const x = a[i] as string;
		const y = b[i] as string;
		if (x < y) return -1;
		if (x > y) return 1;
	}
	return 0;
}
function encodeCursor(key: SortKey): string {
	return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}
function decodeCursor(cursor: string): SortKey | null {
	try {
		const value: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			Array.isArray(value) &&
			value.length === 3 &&
			value.every((v) => typeof v === "string")
		)
			return value as SortKey;
	} catch {
		// fall through
	}
	return null;
}

export function createDoclingMock(options: DoclingMockOptions = {}): {
	app: Hono;
	control: DoclingMockControl;
} {
	const pageSize = options.pageSize ?? 100;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
		throw new Error("invalid_page_size");
	const limits: DoclingLimits = { ...defaultLimits, ...options.limits };
	const libraryExtension = options.libraryExtension === true;
	let credential = options.credential ?? "docling-mock-test-credential";

	const documents = new Map<string, Stored>();
	const forbidden = new Set<string>();
	const requests: DoclingRequestRecord[] = [];
	const faults: { match: DoclingFaultMatch; fault: DoclingFault }[] = [];
	const gate = createGate();

	function snapshotOf(doc: Stored): MockDocumentSnapshot {
		const digests = documentDigests(doc.markdown, doc.recovery);
		return {
			...doc,
			...digests,
			etag: mockEtag({ ...doc, ...digests }),
		};
	}
	function pathTaken(namespace: string, path: string, exceptId?: string) {
		for (const doc of documents.values())
			if (
				doc.id !== exceptId &&
				doc.namespace === namespace &&
				doc.path === path
			)
				return true;
		return false;
	}
	function addDocument(input: MockDocumentInput): string {
		if (!input.namespace || !input.path || !input.title)
			throw new Error("invalid_document");
		const id = input.id ?? mockDocumentId(input.namespace, input.path);
		if (!DOCUMENT_ID.test(id)) throw new Error("invalid_document_id");
		if (documents.has(id)) throw new Error("document_exists");
		if (pathTaken(input.namespace, input.path)) throw new Error("path_exists");
		documents.set(id, {
			id,
			namespace: input.namespace,
			path: input.path,
			title: input.title,
			markdown: input.markdown,
			recovery: input.recovery ?? `synthetic-recovery:${id}`,
		});
		return id;
	}
	function must(id: string): Stored {
		const doc = documents.get(id);
		if (!doc) throw new Error("unknown_document");
		return doc;
	}

	for (const input of options.documents ?? []) addDocument(input);
	let allowed = new Set(
		options.namespaces ?? [
			...new Set([...documents.values()].map((d) => d.namespace)),
		],
	);
	const allowedList = () => [...allowed].sort();
	const accessible = (doc: Stored) =>
		allowed.has(doc.namespace) && !forbidden.has(doc.id);

	const app = new Hono();

	app.onError((error) => {
		// A dropped connection or an abort must surface as a rejection of the fetch itself.
		if (error instanceof MockConnectionDropped || isAbortError(error))
			throw error;
		return errorResponse(500, "unavailable");
	});
	app.notFound(() => errorResponse(404, "not_found"));

	app.use("*", async (c, next) => {
		const url = new URL(c.req.url);
		requests.push({ method: c.req.method, path: url.pathname });
		if (c.req.header("authorization") !== `Bearer ${credential}`)
			return errorResponse(401, "unauthorized", {
				"www-authenticate": "Bearer",
			});
		const target = routeOf(c.req.method, url.pathname);
		const index = target
			? faults.findIndex(
					(f) =>
						f.match.route === target.route &&
						(f.match.documentId === undefined ||
							f.match.documentId === target.documentId),
				)
			: -1;
		const fault = index >= 0 ? faults.splice(index, 1)[0]?.fault : undefined;
		if (!fault) return next();
		switch (fault.kind) {
			case "status":
				return errorResponse(fault.status, fault.code);
			case "raw":
				return new Response(fault.body, {
					status: fault.status ?? 200,
					headers: {
						"content-type": "application/json; charset=utf-8",
						...fault.headers,
					},
				});
			case "disconnect":
				if (fault.afterProcessing) await next();
				throw new MockConnectionDropped();
			case "hold":
				await next();
				await gate.hold(c.req.raw.signal);
				return;
		}
	});

	app.get(DOCLING_CAPABILITIES_PATH, () => {
		const body: Record<string, unknown> = {
			contractVersion: DOCLING_CONTRACT_VERSION,
			basePath: DOCLING_BASE_PATH,
			requiresDocling: false,
			methods: libraryExtension ? ["GET", "PUT", "DELETE"] : ["GET", "PUT"],
			maxRequestBytes: limits.maxRequestBytes,
			maxMarkdownBytes: limits.maxMarkdownBytes,
			maxRecoveryBytes: limits.maxRecoveryBytes,
			maxPageSize: pageSize,
			contentDigest: DOCLING_CONTENT_DIGEST_RULE,
		};
		if (libraryExtension) body.delete = `${DOCLING_BASE_PATH}/{id}`;
		return jsonResponse(JSON.stringify(body), 200);
	});

	app.get(DOCLING_BASE_PATH, (c) => {
		const rawLimit = c.req.query("limit");
		let limit = pageSize;
		if (rawLimit !== undefined) {
			if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1)
				return errorResponse(400);
			limit = Math.min(Number(rawLimit), pageSize);
		}
		const rawCursor = c.req.query("cursor");
		let after: SortKey | null = null;
		if (rawCursor !== undefined) {
			after = decodeCursor(rawCursor);
			if (!after) return errorResponse(400);
		}
		const ordered = [...documents.values()]
			.filter((d) => allowed.has(d.namespace))
			.map((d) => ({ doc: d, key: [d.namespace, d.path, d.id] as SortKey }))
			.sort((a, b) => compareKeys(a.key, b.key))
			.filter((e) => after === null || compareKeys(e.key, after) > 0);
		const page = ordered.slice(0, limit);
		const last = page.at(-1);
		const nextCursor =
			last && ordered.length > page.length ? encodeCursor(last.key) : null;
		return jsonResponse(
			JSON.stringify({
				documents: page.map((e) => {
					const { markdown: _m, recovery: _r, ...summary } = snapshotOf(e.doc);
					return summary;
				}),
				namespaces: allowedList(),
				nextCursor,
			}),
			200,
		);
	});

	app.get(`${DOCLING_BASE_PATH}/:id`, (c) => {
		const id = c.req.param("id");
		if (!DOCUMENT_ID.test(id)) return errorResponse(400);
		const doc = documents.get(id);
		if (!doc) return errorResponse(404);
		if (!accessible(doc)) return errorResponse(403);
		const snap = snapshotOf(doc);
		return jsonResponse(JSON.stringify(snap), 200, { etag: snap.etag });
	});

	app.delete(`${DOCLING_BASE_PATH}/:id`, (c) => {
		if (!libraryExtension) return errorResponse(405, "invalid_request");
		const id = c.req.param("id");
		if (!DOCUMENT_ID.test(id)) return errorResponse(400);
		const ifMatch = c.req.header("if-match");
		if (ifMatch === undefined) return errorResponse(428);
		if (!STRONG_ETAG.test(ifMatch)) return errorResponse(400);
		const doc = documents.get(id);
		if (!doc) return errorResponse(404);
		if (!accessible(doc)) return errorResponse(403);
		if (snapshotOf(doc).etag !== ifMatch) return errorResponse(412);
		documents.delete(id);
		return jsonResponse(JSON.stringify({ id, deleted: true }), 200);
	});

	app.on(["PUT", "POST", "PATCH"], `${DOCLING_BASE_PATH}/:id`, () =>
		errorResponse(405, "invalid_request"),
	);

	const control: DoclingMockControl = {
		addDocument,
		setMarkdown(id, markdown) {
			must(id).markdown = markdown;
		},
		setRecovery(id, recovery) {
			must(id).recovery = recovery;
		},
		setMeta(id, meta) {
			const doc = must(id);
			const namespace = meta.namespace ?? doc.namespace;
			const path = meta.path ?? doc.path;
			const title = meta.title ?? doc.title;
			if (!namespace || !path || !title) throw new Error("invalid_document");
			if (pathTaken(namespace, path, id)) throw new Error("path_exists");
			doc.namespace = namespace;
			doc.path = path;
			doc.title = title;
		},
		removeDocument(id) {
			must(id);
			documents.delete(id);
			forbidden.delete(id);
		},
		forbid(id, on = true) {
			must(id);
			if (on) forbidden.add(id);
			else forbidden.delete(id);
		},
		setAllowedNamespaces(namespaces) {
			allowed = new Set(namespaces);
		},
		setCredential(next) {
			credential = next;
		},
		failNext(match, fault) {
			faults.push({ match, fault });
		},
		clearFaults() {
			faults.length = 0;
		},
		pendingFaults: () => faults.length,
		releaseHeld: () => gate.release(),
		heldCount: () => gate.count(),
		whenHeld: (n) => gate.whenHeld(n),
		requests: () => requests,
		clearRequests() {
			requests.length = 0;
		},
		snapshot(id) {
			const doc = documents.get(id);
			return doc ? snapshotOf(doc) : undefined;
		},
	};

	return { app, control };
}
