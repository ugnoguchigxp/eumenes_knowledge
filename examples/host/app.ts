// examples ホストの HTTP 入口。経路・入出力は `src/contracts/api.ts` が正本。TCP の待受はしない
// （試験は `app.request()` で呼ぶ）。トークンも文書本文もログ・応答に出さない。
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
	API_BASE_PATH,
	API_ERROR_STATUS,
	accessContextSchema,
	apiPaths,
	evidenceRequestSchema,
	evidenceResponseSchema,
	graphRequestSchema,
	graphResponseSchema,
	KnowledgeError,
	knowledgeStatusSchema,
	relatedRequestSchema,
	relatedResponseSchema,
	searchResponseSchema,
	syncRequestInputSchema,
	syncRequestSchema,
	type AccessContext,
	type ApiErrorCode,
	type EvidenceRequest,
	type EvidenceResponse,
	type GraphRequest,
	type GraphResponse,
	type KnowledgeStatus,
	type RelatedRequest,
	type RelatedResponse,
	type SearchRequest,
	type SearchResponse,
	type SyncRequest,
} from "../../src/contracts/index.js";
import type { RequestSyncResult } from "./sync-requests.js";

export const MAX_BODY_BYTES = 64 * 1024;

/** Error codes that mean "busy, try again": the job queue limit and the writer queue limit. */
const OVERLOADED: ReadonlySet<string> = new Set([
	"queue_full",
	"database_writer_queue_full",
]);

export type ExampleAppOptions = {
	/** `Authorization: Bearer <token>` の token から権限を引く。 */
	principals: Readonly<Record<string, AccessContext>>;
	/** 真の間は knowledge の全経路に 503 `server_starting`。 */
	isStarting: () => boolean;
	readStatus(access: AccessContext): KnowledgeStatus;
	requestSync(
		access: AccessContext,
		requestId: string,
	): Promise<RequestSyncResult>;
	getSyncRequest(access: AccessContext, requestId: string): SyncRequest | null;
	/**
	 * 検索。省略すると経路を持たない。request は検証前の JSON で、検証は実装（package）が行い、
	 * 違反は `KnowledgeError("invalid_input")` で返す。signal は client の切断で中断する。
	 */
	search?(
		access: AccessContext,
		request: SearchRequest,
		signal: AbortSignal,
	): Promise<SearchResponse>;
	/** 根拠の確認。省略すると経路を持たない。`not_available` も応答の本文（200）。 */
	readEvidence?(
		access: AccessContext,
		request: EvidenceRequest,
	): EvidenceResponse;
	/** 関連文書。省略すると経路を持たない。`not_available`・`stale` も応答の本文（200）。 */
	readRelated?(access: AccessContext, request: RelatedRequest): RelatedResponse;
	/** 知識グラフ（kg.md §2）。省略すると経路を持たない。 */
	readGraph?(access: AccessContext, request: GraphRequest): GraphResponse;
};

type Env = { Variables: { access: AccessContext } };

const BEARER = /^Bearer ([^\s]+)$/;

function fail(c: Context, code: ApiErrorCode): Response {
	return c.json({ error: code }, API_ERROR_STATUS[code]);
}

async function readJson(c: Context): Promise<unknown> {
	try {
		return JSON.parse(await c.req.text());
	} catch {
		return null;
	}
}

const bodyLimited = bodyLimit({
	maxSize: MAX_BODY_BYTES,
	onError: (c) => fail(c, "payload_too_large"),
});

/** package の入力違反だけを 400 に写す。それ以外は投げ直し、`onError` が 500 にする。 */
const isInvalidInput = (error: unknown) =>
	error instanceof KnowledgeError && error.code === "invalid_input";

export function createExampleApp(options: ExampleAppOptions): Hono<Env> {
	const tokens = new Map<string, AccessContext>();
	for (const [token, access] of Object.entries(options.principals)) {
		if (token.length === 0) throw new Error("invalid_principal_token");
		tokens.set(token, accessContextSchema.parse(access));
	}
	const app = new Hono<Env>();

	app.use(`${API_BASE_PATH}/*`, async (c, next) => {
		if (options.isStarting()) return fail(c, "server_starting");
		const match = BEARER.exec(c.req.header("authorization") ?? "");
		const access = match?.[1] === undefined ? undefined : tokens.get(match[1]);
		if (!access) return fail(c, "unauthorized");
		c.set("access", access);
		await next();
	});

	app.get(apiPaths.status, (c) => {
		const status = knowledgeStatusSchema.parse(
			options.readStatus(c.get("access")),
		);
		return c.json(status, 200);
	});

	app.post(apiPaths.syncRequests, bodyLimited, async (c) => {
		const input = syncRequestInputSchema.safeParse(await readJson(c));
		if (!input.success) return fail(c, "invalid_input");
		const access = c.get("access");
		let result: Awaited<ReturnType<typeof options.requestSync>>;
		try {
			result = await options.requestSync(access, input.data.requestId);
		} catch (error) {
			// A full job queue or writer is temporary: the client may resend the same requestId.
			if (error instanceof Error && OVERLOADED.has(error.message))
				return fail(c, "knowledge_unavailable");
			throw error;
		}
		if (!result.ok) return fail(c, result.error);
		const request = options.getSyncRequest(access, input.data.requestId);
		if (!request) return fail(c, "internal_error");
		return c.json(syncRequestSchema.parse(request), 202);
	});

	app.get(`${API_BASE_PATH}/sync-requests/:requestId`, (c) => {
		const requestId = z.uuid().safeParse(c.req.param("requestId"));
		if (!requestId.success) return fail(c, "invalid_input");
		const request = options.getSyncRequest(c.get("access"), requestId.data);
		if (!request) return fail(c, "not_available");
		return c.json(syncRequestSchema.parse(request), 200);
	});

	const { search, readEvidence, readRelated, readGraph } = options;
	if (search) {
		app.post(apiPaths.search, bodyLimited, async (c) => {
			const raw = await readJson(c);
			if (typeof raw !== "object" || raw === null || Array.isArray(raw))
				return fail(c, "invalid_input");
			let result: SearchResponse;
			try {
				// access は Bearer から引いたものだけ。本文の principal や namespace は権限にならない。
				result = await search(
					c.get("access"),
					raw as SearchRequest,
					c.req.raw.signal,
				);
			} catch (error) {
				if (isInvalidInput(error)) return fail(c, "invalid_input");
				throw error;
			}
			return c.json(searchResponseSchema.parse(result), 200);
		});
	}

	if (readEvidence) {
		app.post(apiPaths.evidence, bodyLimited, async (c) => {
			const input = evidenceRequestSchema.safeParse(await readJson(c));
			if (!input.success) return fail(c, "invalid_input");
			let result: EvidenceResponse;
			try {
				result = readEvidence(c.get("access"), input.data);
			} catch (error) {
				if (isInvalidInput(error)) return fail(c, "invalid_input");
				throw error;
			}
			return c.json(evidenceResponseSchema.parse(result), 200);
		});
	}

	if (readRelated) {
		app.post(apiPaths.related, bodyLimited, async (c) => {
			const input = relatedRequestSchema.safeParse(await readJson(c));
			if (!input.success) return fail(c, "invalid_input");
			let result: RelatedResponse;
			try {
				// access は Bearer から引いたものだけ。本文の principal は strict な schema が 400 にする。
				result = readRelated(c.get("access"), input.data);
			} catch (error) {
				if (isInvalidInput(error)) return fail(c, "invalid_input");
				throw error;
			}
			return c.json(relatedResponseSchema.parse(result), 200);
		});
	}

	if (readGraph) {
		app.post(apiPaths.graph, bodyLimited, async (c) => {
			const input = graphRequestSchema.safeParse(await readJson(c));
			if (!input.success) return fail(c, "invalid_input");
			let result: GraphResponse;
			try {
				// access は Bearer から引いたものだけ。本文の namespaces は狭めるだけで、広げない。
				result = readGraph(c.get("access"), input.data);
			} catch (error) {
				if (isInvalidInput(error)) return fail(c, "invalid_input");
				throw error;
			}
			return c.json(graphResponseSchema.parse(result), 200);
		});
	}

	app.notFound((c) => fail(c, "not_available"));
	// 内容（token・本文を含み得る）は出さず、ログにも残さない。
	app.onError((_error, c) => fail(c, "internal_error"));
	return app;
}
