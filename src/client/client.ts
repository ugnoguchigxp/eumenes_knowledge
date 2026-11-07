import type { ZodType, output } from "zod";
import {
	apiErrorSchema,
	apiPaths,
	evidenceRequestSchema,
	evidenceResponseSchema,
	knowledgeStatusSchema,
	relatedRequestSchema,
	relatedResponseSchema,
	searchRequestSchema,
	searchResponseSchema,
	syncRequestInputSchema,
	syncRequestSchema,
	type EvidenceRequest,
	type EvidenceResponse,
	type KnowledgeStatus,
	type RelatedRequest,
	type RelatedResponse,
	type SearchRequest,
	type SearchResponse,
	type SyncRequest,
} from "../contracts/api.js";

/**
 * Codes the client fails with. Safe to show: they never carry a token, a URL, a path or text
 * from a document.
 */
export const knowledgeClientErrorCodes = [
	/** No answer: the host is down, refused the connection or answered `knowledge_unavailable`. */
	"knowledge_unavailable",
	/** 401. */
	"knowledge_auth_failed",
	/** 503 `server_starting`, still so after the one allowed wait. */
	"knowledge_server_starting",
	"knowledge_timeout",
	/** The answer does not match the published schema. */
	"knowledge_contract_mismatch",
	/** 404. */
	"knowledge_not_available",
	/** 400, or the caller's own input/options were refused before sending. */
	"knowledge_invalid_input",
	/** 409. */
	"knowledge_request_conflict",
	"knowledge_http_error",
] as const;
export type KnowledgeClientErrorCode =
	(typeof knowledgeClientErrorCodes)[number];

export type KnowledgeClientErrorDetail = {
	/** HTTP status of the answer, when there was one. */
	status?: number | undefined;
	/** The `error` code of the API's error body, when it had the published shape. */
	apiCode?: string | undefined;
	/** The host's `X-Request-Id`, when present and plain. */
	requestId?: string | undefined;
};

/** The only error the client throws. The message is the code; no credential is ever attached. */
export class KnowledgeClientError extends Error {
	override readonly name = "KnowledgeClientError";
	readonly status: number | undefined;
	readonly apiCode: string | undefined;
	readonly requestId: string | undefined;
	constructor(
		readonly code: KnowledgeClientErrorCode,
		detail: KnowledgeClientErrorDetail = {},
	) {
		super(code);
		this.status = detail.status;
		this.apiCode = detail.apiCode;
		this.requestId = detail.requestId;
	}
}

/** Any fetch-shaped function (the global `fetch`, a Hono `app.request` wrapper, a test double). */
export type KnowledgeFetch = (
	input: string,
	init: RequestInit,
) => Promise<Response>;

export type KnowledgeClientOptions = {
	/** Origin of the host, e.g. `http://127.0.0.1:8787`. Required: there is no default. */
	baseUrl: string;
	/** Bearer token. Sent only in the Authorization header; never logged or put in an error. */
	token: string;
	fetch?: KnowledgeFetch;
	/** Limit for each HTTP attempt, including reading the answer. Default 30 seconds. */
	timeoutMs?: number;
	/**
	 * How long to wait, once, when the host answers 503 `server_starting`; the same request is
	 * then sent once more. 0 (default) means do not wait or resend.
	 */
	startingWaitMs?: number;
	/** Replaces the real timer, so tests do not wait. */
	sleep?: (ms: number) => Promise<void>;
};

export type KnowledgeClient = {
	status(): Promise<KnowledgeStatus>;
	/** Asks the host to run a sync. Resending the same `requestId` is the same request. */
	requestSync(requestId: string): Promise<SyncRequest>;
	getSyncRequest(requestId: string): Promise<SyncRequest>;
	/** Searches what the token's principal may read. The request is checked before it is sent. */
	search(request: SearchRequest): Promise<SearchResponse>;
	/** Checks a cited range. `not_available` is an answer (status), not an error. */
	evidence(request: EvidenceRequest): Promise<EvidenceResponse>;
	/** Documents sharing entities with one document. `not_available` and `stale` are answers (status). */
	related(request: RelatedRequest): Promise<RelatedResponse>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 1_048_576;
const tokenPattern = /^[\x21-\x7e]+$/;
const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const sleepFor = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

type Attempt = { status: number; body: unknown; requestId: string | undefined };

const abortLike = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"name" in error &&
	(error.name === "TimeoutError" || error.name === "AbortError");

export function createKnowledgeClient(
	options: KnowledgeClientOptions,
): KnowledgeClient {
	const origin = parseOrigin(options.baseUrl);
	if (typeof options.token !== "string" || !tokenPattern.test(options.token)) {
		throw new KnowledgeClientError("knowledge_invalid_input");
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startingWaitMs = options.startingWaitMs ?? 0;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new KnowledgeClientError("knowledge_invalid_input");
	}
	if (!Number.isFinite(startingWaitMs) || startingWaitMs < 0) {
		throw new KnowledgeClientError("knowledge_invalid_input");
	}
	const token = options.token;

	async function attempt(
		method: "GET" | "POST",
		path: string,
		payload: unknown,
	): Promise<Attempt> {
		const doFetch: KnowledgeFetch =
			options.fetch ?? ((input, init) => fetch(input, init));
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const response = await doFetch(`${origin}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					...(payload === undefined
						? {}
						: { "content-type": "application/json" }),
				},
				...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				signal,
				// A redirect would carry the request elsewhere; treat it as an error answer.
				redirect: "manual",
				cache: "no-store",
			});
			const text = await response.text();
			const requestId = response.headers.get("x-request-id") ?? undefined;
			return {
				status: response.status,
				body: parseJson(text),
				requestId:
					requestId !== undefined && requestIdPattern.test(requestId)
						? requestId
						: undefined,
			};
		} catch (error) {
			// Nothing from `error` is kept: its message could name the URL or echo a header.
			if (signal.aborted || abortLike(error)) {
				throw new KnowledgeClientError("knowledge_timeout");
			}
			throw new KnowledgeClientError("knowledge_unavailable");
		}
	}

	async function call<S extends ZodType>(
		schema: S,
		method: "GET" | "POST",
		path: string,
		payload?: unknown,
	): Promise<output<S>> {
		let answer = await attempt(method, path, payload);
		if (isStarting(answer)) {
			if (startingWaitMs > 0) {
				// A starting host processed nothing, so the same request is sent once more.
				await (options.sleep ?? sleepFor)(startingWaitMs);
				answer = await attempt(method, path, payload);
			}
			if (isStarting(answer)) {
				throw new KnowledgeClientError(
					"knowledge_server_starting",
					detailOf(answer),
				);
			}
		}
		if (answer.status < 200 || answer.status > 299) throw httpFailure(answer);
		const parsed = schema.safeParse(answer.body);
		if (!parsed.success) {
			throw new KnowledgeClientError(
				"knowledge_contract_mismatch",
				detailOf(answer),
			);
		}
		return parsed.data;
	}

	return {
		status: () => call(knowledgeStatusSchema, "GET", apiPaths.status),
		async requestSync(requestId) {
			const input = parseRequestId(requestId);
			const sync = await call(
				syncRequestSchema,
				"POST",
				apiPaths.syncRequests,
				input,
			);
			if (sync.requestId !== input.requestId) {
				throw new KnowledgeClientError("knowledge_contract_mismatch");
			}
			return sync;
		},
		async getSyncRequest(requestId) {
			const input = parseRequestId(requestId);
			const sync = await call(
				syncRequestSchema,
				"GET",
				apiPaths.syncRequest(input.requestId),
			);
			if (sync.requestId !== input.requestId) {
				throw new KnowledgeClientError("knowledge_contract_mismatch");
			}
			return sync;
		},
		search: async (request) =>
			call(
				searchResponseSchema,
				"POST",
				apiPaths.search,
				parseInput(searchRequestSchema, request),
			),
		evidence: async (request) =>
			call(
				evidenceResponseSchema,
				"POST",
				apiPaths.evidence,
				parseInput(evidenceRequestSchema, request),
			),
		related: async (request) =>
			call(
				relatedResponseSchema,
				"POST",
				apiPaths.related,
				parseInput(relatedRequestSchema, request),
			),
	};
}

/** Checks the caller's input against the published schema before anything is sent. */
function parseInput<S extends ZodType>(schema: S, input: unknown): output<S> {
	const parsed = schema.safeParse(input);
	if (!parsed.success)
		throw new KnowledgeClientError("knowledge_invalid_input");
	return parsed.data;
}

function parseOrigin(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new KnowledgeClientError("knowledge_invalid_input");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new KnowledgeClientError("knowledge_invalid_input");
	}
	return url.origin;
}

function parseRequestId(requestId: string) {
	const parsed = syncRequestInputSchema.safeParse({ requestId });
	if (!parsed.success)
		throw new KnowledgeClientError("knowledge_invalid_input");
	return parsed.data;
}

function parseJson(text: string): unknown {
	if (text.length === 0 || text.length > MAX_BODY_CHARS) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The published error code of an answer, when the body has the published shape. */
function apiCodeOf(answer: Attempt): string | undefined {
	const parsed = apiErrorSchema.safeParse(answer.body);
	return parsed.success ? parsed.data.error : undefined;
}

function detailOf(answer: Attempt): KnowledgeClientErrorDetail {
	return {
		status: answer.status,
		apiCode: apiCodeOf(answer),
		requestId: answer.requestId,
	};
}

const isStarting = (answer: Attempt) =>
	answer.status === 503 && apiCodeOf(answer) === "server_starting";

function httpFailure(answer: Attempt): KnowledgeClientError {
	const detail = detailOf(answer);
	switch (answer.status) {
		case 400:
			return new KnowledgeClientError("knowledge_invalid_input", detail);
		case 401:
			return new KnowledgeClientError("knowledge_auth_failed", detail);
		case 404:
			return new KnowledgeClientError("knowledge_not_available", detail);
		case 409:
			return new KnowledgeClientError("knowledge_request_conflict", detail);
		case 503:
			return new KnowledgeClientError(
				detail.apiCode === "knowledge_unavailable"
					? "knowledge_unavailable"
					: "knowledge_http_error",
				detail,
			);
		default:
			return new KnowledgeClientError("knowledge_http_error", detail);
	}
}
