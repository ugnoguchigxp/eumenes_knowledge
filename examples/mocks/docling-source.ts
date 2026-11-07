import { z } from "zod";
import {
	SOURCE_NAMESPACE_DOCLING,
	SourceError,
	doclingDocumentIdSchema,
	doclingEtagSchema,
	documentInputSchema,
	documentListPageSchema,
	sha256HexSchema,
	type DocumentInput,
	type DocumentListPage,
	type DocumentSourcePort,
} from "../../src/contracts/index.js";
import { documentDigests, sha256Hex } from "./docling-digest.js";

/**
 * The host adapter that turns the Docling file API into a `DocumentSourcePort`. In production
 * Eumenes' docling domain does this conversion (P6); this file reproduces it for examples. The
 * fetch is injected, so a test passes the mock app's `request` and no network is used.
 */

export type DoclingFetch = (
	input: string,
	init?: RequestInit,
) => Response | Promise<Response>;

export type DoclingSourceOptions = {
	fetch: DoclingFetch;
	baseUrl: string;
	credential: string;
	/** Upper bound for any single response body. Defaults to Eumenes' bound for one document. */
	maxResponseBytes?: number;
};

export type DoclingSource = DocumentSourcePort & {
	/** Changes the connection. A read that was in flight fails with `connection_changed`. */
	reconfigure(next: { baseUrl?: string; credential?: string }): void;
};

const CONTRACT_VERSION = "larm.docling-files.v1";
const BASE_PATH = "/v1/docling/documents";
const CAPABILITIES_PATH = "/v1/docling/capabilities";
const DIGEST_RULE = "sha256(ascii(markdownSha256 + LF + recoverySha256))";
const CAPABILITIES_LIMIT = 32 * 1024;
const LIST_LIMIT = 4 * 1024 * 1024;

const capabilitiesSchema = z.object({
	contractVersion: z.literal(CONTRACT_VERSION),
	basePath: z.literal(BASE_PATH),
	requiresDocling: z.literal(false),
	methods: z.array(z.string()).refine((v) => v.includes("GET")),
	maxMarkdownBytes: z.number().int().positive().safe(),
	maxRecoveryBytes: z.number().int().positive().safe(),
	maxPageSize: z.number().int().positive().max(100),
	contentDigest: z.literal(DIGEST_RULE),
});
type Capabilities = z.infer<typeof capabilitiesSchema>;

const summarySchema = z.object({
	id: doclingDocumentIdSchema,
	namespace: z.string().min(1),
	path: z.string().min(1),
	title: z.string().min(1),
	etag: doclingEtagSchema,
	markdownSha256: sha256HexSchema,
	recoverySha256: sha256HexSchema,
	contentDigest: sha256HexSchema,
});
const listSchema = z.object({
	documents: z.array(summarySchema),
	namespaces: z.array(z.string().min(1)),
	nextCursor: z.string().min(1).nullable(),
});
const savedSchema = summarySchema.extend({
	markdown: z.string(),
	recovery: z.string(),
});

type Context = "capabilities" | "list" | "read";

/** Maps an HTTP status to the source error. A body is never read for this. */
function errorForStatus(status: number, context: Context): SourceError {
	if (status === 401) return new SourceError("unauthorized");
	// `forbidden` and `not_found` describe one document, so only the document GET may use them.
	// A 403 from capabilities or the list is a credential permission problem, not a document state.
	if (status === 403)
		return new SourceError(context === "read" ? "forbidden" : "unauthorized");
	if (status === 404)
		return new SourceError(
			context === "read" ? "not_found" : "invalid_response",
		);
	if (status === 408 || status === 504) return new SourceError("timeout");
	if (status >= 500) return new SourceError("unavailable");
	return new SourceError("invalid_response");
}

/** Rejects with `cancelled` as soon as the signal aborts, whatever the pending promise does. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.reject(new SourceError("cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new SourceError("cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function readBounded(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let step: Awaited<ReturnType<typeof reader.read>>;
			try {
				step = await withAbort(reader.read(), signal);
			} catch (error) {
				if (error instanceof SourceError) throw error;
				throw new SourceError("unavailable");
			}
			if (step.done) break;
			total += step.value.byteLength;
			if (total > limit) throw new SourceError("invalid_response");
			chunks.push(step.value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function createDoclingSource(
	options: DoclingSourceOptions,
): DoclingSource {
	let baseUrl = options.baseUrl;
	let credential = options.credential;

	const binding = (): string | null =>
		baseUrl && credential
			? sha256Hex(JSON.stringify([baseUrl, credential]))
			: null;

	function access(): { base: URL; credential: string; binding: string } {
		const key = binding();
		if (!key) throw new SourceError("unavailable");
		let base: URL;
		try {
			base = new URL(baseUrl);
		} catch {
			throw new SourceError("unavailable");
		}
		if (
			!["http:", "https:"].includes(base.protocol) ||
			base.username ||
			base.password
		)
			throw new SourceError("unavailable");
		return { base, credential, binding: key };
	}

	function unchanged(key: string): void {
		if (binding() !== key) throw new SourceError("connection_changed");
	}

	/** One GET. Returns the response and its parsed JSON; every failure is a `SourceError`. */
	async function get(
		endpoint: string,
		context: Context,
		bodyLimit: number,
		signal: AbortSignal,
	): Promise<{ response: Response; value: unknown }> {
		if (signal.aborted) throw new SourceError("cancelled");
		const conn = access();
		const limit = Math.min(bodyLimit, options.maxResponseBytes ?? bodyLimit);
		let response: Response;
		try {
			response = await withAbort(
				(async () =>
					options.fetch(new URL(endpoint, conn.base).toString(), {
						method: "GET",
						signal,
						redirect: "error",
						headers: {
							accept: "application/json",
							authorization: `Bearer ${conn.credential}`,
						},
					}))(),
				signal,
			);
		} catch (error) {
			if (error instanceof SourceError) throw error;
			throw new SourceError(signal.aborted ? "cancelled" : "unavailable");
		}
		try {
			unchanged(conn.binding);
		} catch (error) {
			await response.body?.cancel().catch(() => {});
			throw error;
		}
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw errorForStatus(response.status, context);
		}
		const bytes = await readBounded(response.body, limit, signal);
		unchanged(conn.binding);
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			return { response, value: JSON.parse(text) as unknown };
		} catch {
			throw new SourceError("invalid_response");
		}
	}

	async function capabilities(signal: AbortSignal): Promise<Capabilities> {
		const { value } = await get(
			CAPABILITIES_PATH,
			"capabilities",
			CAPABILITIES_LIMIT,
			signal,
		);
		const parsed = capabilitiesSchema.safeParse(value);
		if (!parsed.success) throw new SourceError("invalid_response");
		return parsed.data;
	}

	return {
		binding,
		reconfigure(next) {
			if (next.baseUrl !== undefined) baseUrl = next.baseUrl;
			if (next.credential !== undefined) credential = next.credential;
		},

		async list(cursor, signal): Promise<DocumentListPage> {
			const caps = await capabilities(signal);
			const query = new URLSearchParams({ limit: String(caps.maxPageSize) });
			if (cursor) query.set("cursor", cursor);
			const { value } = await get(
				`${caps.basePath}?${query}`,
				"list",
				LIST_LIMIT,
				signal,
			);
			const parsed = listSchema.safeParse(value);
			if (
				!parsed.success ||
				parsed.data.documents.length > caps.maxPageSize ||
				parsed.data.documents.some(
					(d) => !parsed.data.namespaces.includes(d.namespace),
				)
			)
				throw new SourceError("invalid_response");
			// The recovery digest is not part of the package's contract; drop it here.
			const page = documentListPageSchema.safeParse({
				documents: parsed.data.documents.map(
					({ id, recoverySha256: _recovery, ...rest }) => ({
						sourceNamespace: SOURCE_NAMESPACE_DOCLING,
						documentId: id,
						...rest,
					}),
				),
				namespaces: parsed.data.namespaces,
				nextCursor: parsed.data.nextCursor,
			});
			if (!page.success) throw new SourceError("invalid_response");
			return page.data;
		},

		async read(documentId, signal): Promise<DocumentInput> {
			if (!doclingDocumentIdSchema.safeParse(documentId).success)
				throw new SourceError("not_found");
			const caps = await capabilities(signal);
			const limit = Math.min(
				Number.MAX_SAFE_INTEGER,
				6 * (caps.maxMarkdownBytes + caps.maxRecoveryBytes) + 65536,
			);
			const { response, value } = await get(
				`${caps.basePath}/${encodeURIComponent(documentId)}`,
				"read",
				limit,
				signal,
			);
			const parsed = savedSchema.safeParse(value);
			if (
				!parsed.success ||
				parsed.data.id !== documentId ||
				response.headers.get("etag") !== parsed.data.etag ||
				Buffer.byteLength(parsed.data.markdown) > caps.maxMarkdownBytes ||
				Buffer.byteLength(parsed.data.recovery) > caps.maxRecoveryBytes
			)
				throw new SourceError("invalid_response");
			const doc = parsed.data;
			const digests = documentDigests(doc.markdown, doc.recovery);
			if (
				doc.markdownSha256 !== digests.markdownSha256 ||
				doc.recoverySha256 !== digests.recoverySha256 ||
				doc.contentDigest !== digests.contentDigest
			)
				throw new SourceError("invalid_response");
			// Strip the recovery: the package never receives it.
			const input = documentInputSchema.safeParse({
				sourceNamespace: SOURCE_NAMESPACE_DOCLING,
				documentId: doc.id,
				namespace: doc.namespace,
				path: doc.path,
				title: doc.title,
				etag: doc.etag,
				markdownSha256: doc.markdownSha256,
				contentDigest: doc.contentDigest,
				markdown: doc.markdown,
			});
			if (!input.success) throw new SourceError("invalid_response");
			return input.data;
		},
	};
}
