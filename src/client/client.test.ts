import { describe, expect, test } from "bun:test";
import { apiPaths } from "../contracts/api.js";
import { CONTRACT_VERSION } from "../contracts/version.js";
import {
	createKnowledgeClient,
	KnowledgeClientError,
	type KnowledgeClientErrorCode,
	type KnowledgeFetch,
} from "./index.js";

const TOKEN = "dummy-token-0123456789-abcdefghij";
const BASE = "http://127.0.0.1:8787";
const REQUEST_ID = "6f0a9c0e-5b1e-4f3e-9d57-3f2d5f0a1b2c";

const status = {
	contractVersion: CONTRACT_VERSION,
	documents: {
		total: 3,
		current: 2,
		unverified: 0,
		stale: 1,
		unavailable: 0,
		excluded: 0,
		removed: 0,
	},
	lastScanAt: "2026-11-07T10:00:00Z",
	lastCompleteScanAt: null,
	complete: false,
	partialReasons: ["no_complete_scan", "stale_documents"],
};
const sync = {
	requestId: REQUEST_ID,
	state: "accepted",
	acceptedAt: "2026-11-07T10:00:00Z",
	finishedAt: null,
	complete: false,
	errorCode: null,
};

type Call = { url: string; init: RequestInit };
const headersOf = (call: Call | undefined): Record<string, string> =>
	(call?.init.headers ?? {}) as Record<string, string>;
const recorder = (
	...answers: (Response | Error | ((init: RequestInit) => Promise<Response>))[]
) => {
	const calls: Call[] = [];
	const fetch: KnowledgeFetch = async (url, init) => {
		calls.push({ url, init });
		const next = answers[Math.min(calls.length - 1, answers.length - 1)];
		if (next instanceof Error) throw next;
		if (typeof next === "function") return next(init);
		// clone() is typed with undici's Response in this toolchain; it is the same runtime object.
		return (next as Response).clone() as unknown as Response;
	};
	return { calls, fetch };
};
const json = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const failure = async (
	promise: Promise<unknown>,
): Promise<KnowledgeClientError> => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(KnowledgeClientError);
		return error as KnowledgeClientError;
	}
	throw new Error("expected a KnowledgeClientError");
};

const client = (fetch: KnowledgeFetch, extra: Record<string, unknown> = {}) =>
	createKnowledgeClient({ baseUrl: BASE, token: TOKEN, fetch, ...extra });

describe("requests", () => {
	test("status() is a GET with the bearer token and a validated answer", async () => {
		const { calls, fetch } = recorder(json(status));
		const result = await client(fetch).status();
		expect(result.documents.total).toBe(3);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}${apiPaths.status}`);
		expect(calls[0]?.init.method).toBe("GET");
		expect(headersOf(calls[0]).authorization).toBe(`Bearer ${TOKEN}`);
		expect(calls[0]?.init.redirect).toBe("manual");
	});

	test("requestSync() posts the chosen id as JSON", async () => {
		const { calls, fetch } = recorder(json(sync, 202));
		const result = await client(fetch).requestSync(REQUEST_ID);
		expect(result.state).toBe("accepted");
		expect(calls[0]?.url).toBe(`${BASE}${apiPaths.syncRequests}`);
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
			requestId: REQUEST_ID,
		});
		expect(headersOf(calls[0])["content-type"]).toBe("application/json");
	});

	test("getSyncRequest() gets the request by id", async () => {
		const { calls, fetch } = recorder(
			json({
				...sync,
				state: "completed",
				finishedAt: "2026-11-07T10:01:00Z",
				complete: true,
			}),
		);
		const result = await client(fetch).getSyncRequest(REQUEST_ID);
		expect(result.state).toBe("completed");
		expect(calls[0]?.url).toBe(`${BASE}${apiPaths.syncRequest(REQUEST_ID)}`);
		expect(calls[0]?.init.method).toBe("GET");
	});

	test("a request id that is not a uuid is refused before any call", async () => {
		const { calls, fetch } = recorder(json(sync));
		const error = await failure(client(fetch).requestSync("not-a-uuid"));
		expect(error.code).toBe("knowledge_invalid_input");
		expect((await failure(client(fetch).getSyncRequest("../x"))).code).toBe(
			"knowledge_invalid_input",
		);
		expect(calls).toHaveLength(0);
	});

	test("an answer for another request id is a contract mismatch", async () => {
		const { fetch } = recorder(
			json({ ...sync, requestId: "11111111-1111-4111-8111-111111111111" }),
		);
		expect((await failure(client(fetch).requestSync(REQUEST_ID))).code).toBe(
			"knowledge_contract_mismatch",
		);
	});
});

describe("error codes", () => {
	const cases: [string, Response | Error, KnowledgeClientErrorCode][] = [
		[
			"connection refused",
			new TypeError("fetch failed: connect ECONNREFUSED"),
			"knowledge_unavailable",
		],
		["401", json({ error: "unauthorized" }, 401), "knowledge_auth_failed"],
		["400", json({ error: "invalid_input" }, 400), "knowledge_invalid_input"],
		["404", json({ error: "not_available" }, 404), "knowledge_not_available"],
		[
			"409",
			json({ error: "request_conflict" }, 409),
			"knowledge_request_conflict",
		],
		["413", json({ error: "payload_too_large" }, 413), "knowledge_http_error"],
		["500", json({ error: "internal_error" }, 500), "knowledge_http_error"],
		[
			"500 with a non-JSON body",
			new Response("<html>oops</html>", { status: 500 }),
			"knowledge_http_error",
		],
		[
			"503 knowledge_unavailable",
			json({ error: "knowledge_unavailable" }, 503),
			"knowledge_unavailable",
		],
		[
			"503 from a proxy",
			new Response("gateway", { status: 503 }),
			"knowledge_http_error",
		],
		[
			"a redirect",
			new Response(null, {
				status: 302,
				headers: { location: "http://evil.example/" },
			}),
			"knowledge_http_error",
		],
		[
			"a timeout",
			new DOMException("timed out", "TimeoutError"),
			"knowledge_timeout",
		],
		[
			"an abort",
			new DOMException("aborted", "AbortError"),
			"knowledge_timeout",
		],
	];
	for (const [label, answer, code] of cases) {
		test(`${label} -> ${code}`, async () => {
			const { fetch } = recorder(answer);
			const error = await failure(client(fetch).status());
			expect(error.code).toBe(code);
			expect(error.message).toBe(code);
		});
	}

	test("the API's error code and request id are kept as safe diagnostics", async () => {
		const { fetch } = recorder(
			json({ error: "unauthorized" }, 401, { "x-request-id": "req-123" }),
		);
		const error = await failure(client(fetch).status());
		expect(error.status).toBe(401);
		expect(error.apiCode).toBe("unauthorized");
		expect(error.requestId).toBe("req-123");
	});

	test("a request id with unexpected characters is dropped", async () => {
		const { fetch } = recorder(
			json({ error: "unauthorized" }, 401, {
				"x-request-id": "bad id\twith space",
			}),
		);
		expect((await failure(client(fetch).status())).requestId).toBeUndefined();
	});

	test("an answer that fails the schema is a contract mismatch, whatever the shape", async () => {
		const bodies = [
			{ ...status, contractVersion: CONTRACT_VERSION + 1 },
			{ ...status, extra: true },
			{ ...status, documents: { ...status.documents, total: -1 } },
			{},
			[],
			"text",
			null,
		];
		for (const body of bodies) {
			const { fetch } = recorder(json(body));
			expect((await failure(client(fetch).status())).code).toBe(
				"knowledge_contract_mismatch",
			);
		}
		const { fetch } = recorder(new Response("not json", { status: 200 }));
		expect((await failure(client(fetch).status())).code).toBe(
			"knowledge_contract_mismatch",
		);
		const empty = recorder(new Response(null, { status: 204 }));
		expect((await failure(client(empty.fetch).status())).code).toBe(
			"knowledge_contract_mismatch",
		);
	});
});

describe("timeout", () => {
	test("a fetch that never answers is cut at timeoutMs", async () => {
		const hang = (init: RequestInit) =>
			new Promise<Response>((_, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		const { fetch } = recorder(hang);
		const started = performance.now();
		const error = await failure(client(fetch, { timeoutMs: 20 }).status());
		expect(error.code).toBe("knowledge_timeout");
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("a body that never finishes is also a timeout", async () => {
		const slowBody = async (init: RequestInit) => {
			const stream = new ReadableStream({
				start(controller) {
					init.signal?.addEventListener("abort", () =>
						controller.error(init.signal?.reason),
					);
				},
			});
			return new Response(stream, { status: 200 });
		};
		const { fetch } = recorder(slowBody);
		expect(
			(await failure(client(fetch, { timeoutMs: 20 }).status())).code,
		).toBe("knowledge_timeout");
	});
});

describe("a starting host", () => {
	const starting = () => json({ error: "server_starting" }, 503);

	test("waits startingWaitMs once, sends the same request again, and returns that answer", async () => {
		const { calls, fetch } = recorder(starting(), json(status));
		const sleeps: number[] = [];
		const result = await client(fetch, {
			startingWaitMs: 60_000,
			sleep: async (ms: number) => void sleeps.push(ms),
		}).status();
		expect(result.documents.total).toBe(3);
		expect(sleeps).toEqual([60_000]);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe(calls[0]?.url);
	});

	test("a POST is resent with the same body (same request id)", async () => {
		const { calls, fetch } = recorder(starting(), json(sync, 202));
		await client(fetch, {
			startingWaitMs: 1,
			sleep: async () => {},
		}).requestSync(REQUEST_ID);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
	});

	test("still starting after the one resend -> knowledge_server_starting, no third call", async () => {
		const { calls, fetch } = recorder(starting());
		const sleeps: number[] = [];
		const error = await failure(
			client(fetch, {
				startingWaitMs: 20_000,
				sleep: async (ms: number) => void sleeps.push(ms),
			}).status(),
		);
		expect(error.code).toBe("knowledge_server_starting");
		expect(error.apiCode).toBe("server_starting");
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([20_000]);
	});

	test("without startingWaitMs there is no wait and no resend", async () => {
		const { calls, fetch } = recorder(starting());
		const sleeps: number[] = [];
		const error = await failure(
			client(fetch, {
				sleep: async (ms: number) => void sleeps.push(ms),
			}).status(),
		);
		expect(error.code).toBe("knowledge_server_starting");
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("another 503, or any other error, is not waited for", async () => {
		const { calls, fetch } = recorder(
			json({ error: "knowledge_unavailable" }, 503),
		);
		const sleeps: number[] = [];
		const error = await failure(
			client(fetch, {
				startingWaitMs: 1000,
				sleep: async (ms: number) => void sleeps.push(ms),
			}).status(),
		);
		expect(error.code).toBe("knowledge_unavailable");
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("the resend can fail differently (host went down while waiting)", async () => {
		const { fetch } = recorder(
			starting(),
			new TypeError("connect ECONNREFUSED"),
		);
		const error = await failure(
			client(fetch, { startingWaitMs: 1, sleep: async () => {} }).status(),
		);
		expect(error.code).toBe("knowledge_unavailable");
	});
});

describe("the token", () => {
	const secretError = () =>
		new Error(`connect failed with Authorization: Bearer ${TOKEN} at ${BASE}`);

	test("never appears in an error, whatever failed", async () => {
		const answers: (Response | Error)[] = [
			secretError(),
			new TypeError(`bad header ${TOKEN}`),
			json(
				{ error: "unauthorized", token: TOKEN, message: `Bearer ${TOKEN}` },
				401,
			),
			json({ error: "internal_error", detail: TOKEN }, 500),
			json({ ...status, contractVersion: 99, echo: TOKEN }),
			new Response(`echo ${TOKEN}`, { status: 502 }),
		];
		for (const answer of answers) {
			const { fetch } = recorder(answer);
			const error = await failure(client(fetch).status());
			const dump =
				JSON.stringify(error, Object.getOwnPropertyNames(error)) +
				String(error) +
				(error.stack ?? "");
			expect(dump).not.toContain(TOKEN);
			expect(dump).not.toContain("Bearer");
			expect(error.cause).toBeUndefined();
		}
	});

	test("does not reach console output", async () => {
		const original = {
			log: console.log,
			error: console.error,
			warn: console.warn,
		};
		const lines: string[] = [];
		console.log =
			console.error =
			console.warn =
				(...args: unknown[]) => void lines.push(args.join(" "));
		try {
			const { fetch } = recorder(secretError());
			await failure(client(fetch).status());
		} finally {
			Object.assign(console, original);
		}
		expect(lines.join("\n")).not.toContain(TOKEN);
	});
});

describe("options", () => {
	const refused = (options: Record<string, unknown>) => {
		try {
			createKnowledgeClient({ baseUrl: BASE, token: TOKEN, ...options });
		} catch (error) {
			return (error as KnowledgeClientError).code;
		}
		return "accepted";
	};

	test("bad base URLs, tokens and limits are refused when the client is created", () => {
		for (const baseUrl of [
			"",
			"not a url",
			"ftp://127.0.0.1",
			"http://user:pw@127.0.0.1",
			"http://127.0.0.1/api",
			"http://127.0.0.1/?a=1",
		]) {
			expect(refused({ baseUrl })).toBe("knowledge_invalid_input");
		}
		for (const token of ["", "has space", "line\nbreak", "tab\t"]) {
			expect(refused({ token })).toBe("knowledge_invalid_input");
		}
		for (const timeoutMs of [0, -1, Number.NaN])
			expect(refused({ timeoutMs })).toBe("knowledge_invalid_input");
		for (const startingWaitMs of [-1, Number.NaN])
			expect(refused({ startingWaitMs })).toBe("knowledge_invalid_input");
	});

	test("an invalid option never echoes the offending value", () => {
		try {
			createKnowledgeClient({
				baseUrl: "http://user:secretpw@127.0.0.1",
				token: TOKEN,
			});
		} catch (error) {
			expect(String(error)).not.toContain("secretpw");
		}
	});

	test("https and a trailing slash are fine, and requests go to the origin", async () => {
		const { calls, fetch } = recorder(json(status));
		await createKnowledgeClient({
			baseUrl: "https://knowledge.example:8443/",
			token: TOKEN,
			fetch,
		}).status();
		expect(calls[0]?.url).toBe(
			`https://knowledge.example:8443${apiPaths.status}`,
		);
	});

	test("the global fetch is used when none is injected (resolved at call time)", async () => {
		const real = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (input: string) => {
			seen.push(String(input));
			return json(status);
		}) as unknown as typeof fetch;
		try {
			await createKnowledgeClient({ baseUrl: BASE, token: TOKEN }).status();
		} finally {
			globalThis.fetch = real;
		}
		expect(seen).toEqual([`${BASE}${apiPaths.status}`]);
	});
});
