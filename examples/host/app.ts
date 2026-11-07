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
	knowledgeStatusSchema,
	syncRequestInputSchema,
	syncRequestSchema,
	type AccessContext,
	type ApiErrorCode,
	type KnowledgeStatus,
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
};

type Env = { Variables: { access: AccessContext } };

const BEARER = /^Bearer ([^\s]+)$/;

function fail(c: Context, code: ApiErrorCode): Response {
	return c.json({ error: code }, API_ERROR_STATUS[code]);
}

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

	app.post(
		apiPaths.syncRequests,
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => fail(c, "payload_too_large"),
		}),
		async (c) => {
			let raw: unknown = null;
			try {
				raw = JSON.parse(await c.req.text());
			} catch {
				raw = null;
			}
			const input = syncRequestInputSchema.safeParse(raw);
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
		},
	);

	app.get(`${API_BASE_PATH}/sync-requests/:requestId`, (c) => {
		const requestId = z.uuid().safeParse(c.req.param("requestId"));
		if (!requestId.success) return fail(c, "invalid_input");
		const request = options.getSyncRequest(c.get("access"), requestId.data);
		if (!request) return fail(c, "not_available");
		return c.json(syncRequestSchema.parse(request), 200);
	});

	app.notFound((c) => fail(c, "not_available"));
	// 内容（token・本文を含み得る）は出さず、ログにも残さない。
	app.onError((_error, c) => fail(c, "internal_error"));
	return app;
}
