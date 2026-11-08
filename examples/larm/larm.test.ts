import { describe, expect, test } from "bun:test";
import {
	MAX_EMBED_BATCH,
	type InferenceRequest,
} from "../../src/contracts/index.js";
import { createLarm, type LarmConfig } from "./index.js";

const TOKEN = "control-token-SECRET";
const CREDENTIAL = "provider-credential-SECRET";
const BASE = "http://127.0.0.1:9000";
const PROVIDER = "http://127.0.0.1:9100/llm";
const EMBED_PROVIDER = "http://127.0.0.1:9100/embedding";

type Seen = {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: unknown;
};

type FakeOptions = {
	/** GETs that answer `pending` before the connection becomes ready. */
	pendingPolls?: number;
	/** Base URL the claim reports for providers. */
	claimBase?: string;
	createStatus?: number;
	/** Called per create; a number answers that status instead of the default. */
	createFor?: (n: number) => number | undefined;
	/** Catalog revision the fake reports. */
	revision?: () => string;
	createBody?: unknown;
	chat?: (body: any) => Response | Promise<Response>;
	embed?: (body: any) => Response | Promise<Response>;
	onGet?: () => void;
	catalogProviders?: unknown[];
	deleteStatus?: number;
};

const reply = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const embeddingSpace = {
	model: { id: "emb-model-id", revision: "r7", artifactDigest: "f".repeat(64) },
	dimension: 3,
	prefixes: { query: "query: ", passage: "passage: " },
};

const llmProvider = {
	name: "llm",
	model: "chat-model",
	protocol: "openai.chat-completions.v1",
	capability: "chat",
	endpoint: "/v1/chat/completions",
	contextWindow: { maxTokens: 32768, outputReserveTokens: 2048 },
};
const embeddingProvider = {
	name: "embedding",
	model: "emb-model",
	protocol: "larm.embedding.v1",
	capability: "embedding",
	endpoint: "/v1/embed",
	embeddingSpace,
};

function createFakeLarm(options: FakeOptions = {}) {
	const seen: Seen[] = [];
	const deleted: string[] = [];
	const connections = new Map<string, { name: string; polls: number }>();
	let next = 0;
	let createCalls = 0;
	const providers = options.catalogProviders ?? [
		llmProvider,
		embeddingProvider,
	];

	function state(id: string) {
		const c = connections.get(id)!;
		const info = c.name === "llm" ? llmProvider : embeddingProvider;
		const ready = c.polls <= 0;
		return {
			id,
			status: ready ? "ready" : "pending",
			agentProfile: "prof",
			catalogRevision: options.revision?.() ?? "rev1",
			providers: [
				{
					name: c.name,
					model: info.model,
					protocol: info.protocol,
					claimable: ready,
					readiness: ready ? "ready" : "starting",
				},
			],
		};
	}

	async function handler(input: URL | string, init: RequestInit = {}) {
		const url = new URL(input.toString());
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		const body = init.body ? JSON.parse(String(init.body)) : undefined;
		seen.push({ method: init.method ?? "GET", url, headers, body });
		const method = init.method ?? "GET";
		const path = url.pathname;
		const provider = url.port === "9100";
		if (provider) {
			if (headers.authorization !== `Bearer ${CREDENTIAL}`)
				return reply({ error: "unauthorized" }, 401);
			if (path === "/llm/chat/completions")
				return (
					options.chat?.(body) ??
					reply({
						model: "served-model",
						choices: [{ message: { content: '{"a":1}' } }],
						usage: {
							prompt_tokens: 10,
							prompt_tokens_details: { cached_tokens: 4 },
							completion_tokens: 5,
							completion_tokens_details: { reasoning_tokens: 2 },
						},
					})
				);
			if (path === "/embedding/embed")
				return (
					options.embed?.(body) ??
					reply({
						dimension: 3,
						embeddings: body.texts.map(() => [0.1, 0.2, 0.3]),
					})
				);
			return reply({}, 404);
		}
		if (headers.authorization !== `Bearer ${TOKEN}`)
			return reply({ error: "unauthorized" }, 401);
		if (method === "GET" && path === "/v3/agent-profiles")
			return reply({
				contractVersion: "agent-connection.v3",
				requestedProfile: url.searchParams.get("profile"),
				catalogRevision: options.revision?.() ?? "rev1",
				profiles: [
					{ id: "other", providers: [] },
					{ id: "prof", providers },
				],
			});
		if (method === "POST" && path === "/v1/agent-connections") {
			createCalls += 1;
			const status = options.createFor?.(createCalls) ?? options.createStatus;
			if (status && status !== 201)
				return reply(options.createBody ?? {}, status);
			if (body.expectedCatalogRevision !== (options.revision?.() ?? "rev1"))
				return reply({ error: "catalog_revision_mismatch" }, 409);
			const id = `conn-${++next}`;
			connections.set(id, {
				name: body.providers[0],
				polls: options.pendingPolls ?? 0,
			});
			return reply(state(id), 201);
		}
		const m = /^\/v1\/agent-connections\/([^/]+)(\/claim)?$/.exec(path);
		if (m) {
			const id = decodeURIComponent(m[1]!);
			const c = connections.get(id);
			if (!c) return reply({}, 404);
			if (method === "GET") {
				options.onGet?.();
				c.polls -= 1;
				return reply(state(id));
			}
			if (method === "DELETE") {
				deleted.push(id);
				return new Response(null, { status: options.deleteStatus ?? 204 });
			}
			if (method === "POST" && m[2]) {
				const isLlm = c.name === "llm";
				const base = options.claimBase ?? (isLlm ? PROVIDER : EMBED_PROVIDER);
				const info = isLlm ? llmProvider : embeddingProvider;
				return reply({
					id,
					status: "ready",
					expiresAt: new Date(Date.now() + 300_000).toISOString(),
					providers: [
						{
							name: c.name,
							model: info.model,
							protocol: info.protocol,
							baseUrl: base,
							configuration: {
								fields: {
									model: info.model,
									...(isLlm ? { baseURL: base } : { daemonURL: base }),
								},
							},
							credential: {
								type: "bearer",
								token: CREDENTIAL,
								expiresAt: new Date(Date.now() + 300_000).toISOString(),
							},
						},
					],
				});
			}
		}
		return reply({}, 404);
	}

	return { fetch: handler as unknown as typeof fetch, seen, deleted };
}

function make(options: FakeOptions = {}, config: Partial<LarmConfig> = {}) {
	const fake = createFakeLarm(options);
	const larm = createLarm({
		baseUrl: BASE,
		token: TOKEN,
		profile: "prof",
		audience: "tests",
		fetch: fake.fetch,
		pollMs: 1,
		readyMs: 2_000,
		...config,
	});
	return { fake, larm };
}

const signal = () => new AbortController().signal;
const request = (patch: Partial<InferenceRequest> = {}): InferenceRequest => ({
	purpose: "extract",
	instructionId: "i",
	instructionVersion: 1,
	prompt: "hello",
	deadlineAtMs: Date.now() + 60_000,
	...patch,
});
const providerCalls = (seen: Seen[]) =>
	seen.filter((s) => s.url.port === "9100");

describe("catalog", () => {
	test("describe picks the llm and the embedding provider of the selected profile", async () => {
		const { larm, fake } = make();
		const binding = await larm.describe(signal());
		expect(binding).toEqual({
			profile: "prof",
			catalogRevision: "rev1",
			llm: {
				name: "llm",
				model: "chat-model",
				contextWindow: { maxTokens: 32768, outputReserveTokens: 2048 },
			},
			embedding: {
				name: "embedding",
				model: "emb-model",
				space: {
					modelId: "emb-model-id",
					revision: "r7",
					artifactDigest: "f".repeat(64),
					dimension: 3,
					queryPrefix: "query: ",
					passagePrefix: "passage: ",
				},
			},
		});
		// Cached: a second describe does not ask again.
		await larm.describe(signal());
		expect(
			fake.seen.filter((s) => s.url.pathname === "/v3/agent-profiles"),
		).toHaveLength(1);
		expect(fake.seen[0]!.url.search).toBe("?profile=prof");
	});

	test("a catalog without an embedding provider has embedding null; embed fails", async () => {
		const { larm } = make({ catalogProviders: [llmProvider] });
		expect((await larm.describe(signal())).embedding).toBeNull();
		await expect(
			larm.embedding.embed(["x"], "passage", signal()),
		).rejects.toThrow("embedding_unavailable");
	});

	test("a catalog without an llm fails describe and complete", async () => {
		const { larm } = make({ catalogProviders: [embeddingProvider] });
		await expect(larm.describe(signal())).rejects.toThrow("llm_unavailable");
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "llm_unavailable" });
	});
});

describe("connection lifecycle", () => {
	test("create, poll pending to ready, claim, chat call, DELETE", async () => {
		const { larm, fake } = make({ pendingPolls: 2 });
		const result = await larm.inference.complete(request(), signal());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe('{"a":1}');
		expect(result.model).toBe("served-model");
		const trail = fake.seen.map((s) => `${s.method} ${s.url.pathname}`);
		expect(trail).toEqual([
			"GET /v3/agent-profiles",
			"POST /v1/agent-connections",
			"GET /v1/agent-connections/conn-1",
			"GET /v1/agent-connections/conn-1",
			"POST /v1/agent-connections/conn-1/claim",
			"POST /llm/chat/completions",
			"DELETE /v1/agent-connections/conn-1",
		]);
		const create = fake.seen[1]!;
		expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(create.headers.prefer).toBe("wait=1");
		expect(create.body).toMatchObject({
			profile: "prof",
			audience: "tests",
			providers: ["llm"],
			ttlSeconds: 300,
			allowFallback: false,
			deploymentPolicy: "existing-only",
			expectedCatalogRevision: "rev1",
		});
		expect((create.body as any).client).toMatch(
			/^eumenes-knowledge-examples-[0-9a-f-]{36}$/,
		);
		expect((fake.seen[4]!.body as any).format).toBe("openai-provider-v1");
		expect(fake.deleted).toEqual(["conn-1"]);
	});

	test("each call uses its own connection and client name", async () => {
		const { larm, fake } = make({}, { clientName: "kg-test" });
		await larm.inference.complete(request(), signal());
		await larm.inference.complete(request(), signal());
		const clients = fake.seen
			.filter(
				(s) =>
					s.method === "POST" && s.url.pathname === "/v1/agent-connections",
			)
			.map((s) => (s.body as any).client as string);
		expect(clients).toHaveLength(2);
		expect(clients[0]).toStartWith("kg-test-");
		expect(clients[0]).not.toBe(clients[1]);
		expect(fake.deleted).toEqual(["conn-1", "conn-2"]);
	});

	test("DELETE also runs when the provider call fails", async () => {
		const { larm, fake } = make({ chat: () => reply({ error: "boom" }, 500) });
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "larm_http_500" });
		expect(fake.deleted).toEqual(["conn-1"]);
	});

	test("a connection that never becomes ready fails with provider_not_ready and is released", async () => {
		const { larm, fake } = make({ pendingPolls: 1_000_000 }, { readyMs: 30 });
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "provider_not_ready" });
		expect(fake.deleted).toEqual(["conn-1"]);
	});

	test("a failed DELETE does not hide the answer; it is counted", async () => {
		const { larm } = make({ deleteStatus: 500 });
		const result = await larm.inference.complete(request(), signal());
		expect(result.ok).toBe(true);
		expect(larm.stats().failures).toEqual({ release_unconfirmed: 1 });
	});

	test("abort mid-poll rethrows an AbortError and still DELETEs", async () => {
		const controller = new AbortController();
		const { larm, fake } = make({
			pendingPolls: 1_000_000,
			onGet: () => controller.abort(),
		});
		const error = await larm.inference
			.complete(request(), controller.signal)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("AbortError");
		expect(fake.deleted).toEqual(["conn-1"]);
		expect(providerCalls(fake.seen)).toHaveLength(0);
	});

	test("an already aborted signal rethrows without any HTTP", async () => {
		const { larm, fake } = make();
		const controller = new AbortController();
		controller.abort();
		await expect(
			larm.inference.complete(request(), controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(
			larm.embedding.embed(["x"], "query", controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fake.seen).toHaveLength(0);
	});

	test("abort during the provider call rethrows and DELETEs", async () => {
		const controller = new AbortController();
		const { larm, fake } = make({
			chat: () => {
				controller.abort();
				throw new DOMException("aborted", "AbortError");
			},
		});
		await expect(
			larm.inference.complete(request(), controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fake.deleted).toEqual(["conn-1"]);
	});

	test("a deadline already past fails fast without any HTTP", async () => {
		const { larm, fake } = make();
		const result = await larm.inference.complete(
			request({ deadlineAtMs: Date.now() - 1 }),
			signal(),
		);
		expect(result).toMatchObject({ ok: false, error: "deadline_exceeded" });
		expect(fake.seen).toHaveLength(0);
	});

	test("a deadline that passes while waiting is deadline_exceeded, and the connection is released", async () => {
		const { larm, fake } = make({ pendingPolls: 1_000_000 }, { pollMs: 5 });
		const result = await larm.inference.complete(
			request({ deadlineAtMs: Date.now() + 40 }),
			signal(),
		);
		expect(result).toMatchObject({ ok: false, error: "deadline_exceeded" });
		expect(fake.deleted).toEqual(["conn-1"]);
	});

	test("a 503 capacity refusal is ok:false capacity_busy", async () => {
		const { larm, fake } = make({
			createStatus: 503,
			createBody: { error: { code: "resource_exhausted", resource: "memory" } },
		});
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "capacity_busy" });
		expect(fake.deleted).toEqual([]);
	});

	test("another 503 is larm_http_503", async () => {
		const { larm } = make({ createStatus: 503, createBody: { error: "down" } });
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "larm_http_503" });
	});

	test("an unreachable gateway is larm_unreachable", async () => {
		const larm = createLarm({
			baseUrl: BASE,
			token: TOKEN,
			profile: "prof",
			audience: "tests",
			fetch: (async () => {
				throw new TypeError(`connect failed with ${TOKEN}`);
			}) as unknown as typeof fetch,
		});
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "larm_unreachable" });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});
});

describe("truncated output", () => {
	test("finish_reason length is output_truncated with usage kept", async () => {
		const { larm, fake } = make({
			chat: () =>
				reply({
					model: "served-model",
					choices: [{ finish_reason: "length", message: { content: '{"a":' } }],
					usage: { prompt_tokens: 10, completion_tokens: 4096 },
				}),
		});
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({
			ok: false,
			error: "output_truncated",
			model: "served-model",
			usage: { inputTokens: 10, outputTokens: 4096, calls: 1 },
		});
		expect(fake.deleted).toEqual(["conn-1"]);
		expect(larm.stats()).toMatchObject({
			ok: 0,
			failures: { output_truncated: 1 },
			outputTokens: 4096,
		});
	});

	test("finish_reason stop is an answer", async () => {
		const { larm } = make({
			chat: () =>
				reply({
					choices: [{ finish_reason: "stop", message: { content: "{}" } }],
				}),
		});
		expect((await larm.inference.complete(request(), signal())).ok).toBe(true);
	});
});

describe("stale catalog", () => {
	test("a refused catalog revision drops the cache; the next call reads the catalog again", async () => {
		let revision = "rev1";
		const { larm, fake } = make({ revision: () => revision });
		expect((await larm.inference.complete(request(), signal())).ok).toBe(true);
		revision = "rev2";
		// The cached catalog still says rev1: LARM refuses it with 409.
		expect(await larm.inference.complete(request(), signal())).toMatchObject({
			ok: false,
			error: "larm_http_409",
		});
		const catalogReads = () =>
			fake.seen.filter((s) => s.url.pathname === "/v3/agent-profiles").length;
		expect(catalogReads()).toBe(1);
		// Next call re-reads the catalog and succeeds under rev2.
		const again = await larm.inference.complete(request(), signal());
		expect(again.ok).toBe(true);
		expect(catalogReads()).toBe(2);
		const creates = fake.seen.filter(
			(s) => s.method === "POST" && s.url.pathname === "/v1/agent-connections",
		);
		expect((creates.at(-1)!.body as any).expectedCatalogRevision).toBe("rev2");
	});

	test("a catalog is kept after an unrelated failure", async () => {
		const { larm, fake } = make({
			createFor: (n) => (n === 1 ? 500 : undefined),
		});
		expect(await larm.inference.complete(request(), signal())).toMatchObject({
			error: "larm_http_500",
		});
		expect((await larm.inference.complete(request(), signal())).ok).toBe(true);
		expect(
			fake.seen.filter((s) => s.url.pathname === "/v3/agent-profiles"),
		).toHaveLength(1);
	});

	test("a 412 on create also drops the cache, for embedding too", async () => {
		const { larm, fake } = make({
			createFor: (n) => (n === 1 ? 412 : undefined),
		});
		await expect(
			larm.embedding.embed(["x"], "passage", signal()),
		).rejects.toThrow("larm_http_412");
		await larm.embedding.embed(["x"], "passage", signal());
		expect(
			fake.seen.filter((s) => s.url.pathname === "/v3/agent-profiles"),
		).toHaveLength(2);
	});
});

describe("chat request", () => {
	test("body with an output schema: json_schema strict, temperature 0, reasoning off", async () => {
		const { larm, fake } = make();
		const schema = { type: "object", properties: { a: { type: "number" } } };
		await larm.inference.complete(
			request({ system: "be brief", outputSchema: schema }),
			signal(),
		);
		const body = providerCalls(fake.seen)[0]!.body as any;
		expect(body).toEqual({
			model: "chat-model",
			messages: [
				{ role: "system", content: "be brief" },
				{ role: "user", content: "hello" },
			],
			temperature: 0,
			response_format: {
				type: "json_schema",
				json_schema: { name: "answer", strict: true, schema },
			},
			chat_template_kwargs: { enable_thinking: false },
			reasoning_effort: "none",
			stream: false,
			max_tokens: 2048,
		});
		const call = providerCalls(fake.seen)[0]!;
		expect(call.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		expect(call.url.href).toBe(`${PROVIDER}/chat/completions`);
	});

	test("without an output schema there is no response_format and no system message", async () => {
		const { larm, fake } = make();
		await larm.inference.complete(request(), signal());
		const body = providerCalls(fake.seen)[0]!.body as any;
		expect(body.response_format).toBeUndefined();
		expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
		expect(body.temperature).toBe(0);
	});

	test("reasoning default sends no reasoning fields", async () => {
		const { larm, fake } = make({}, { reasoning: "default" });
		await larm.inference.complete(request(), signal());
		const body = providerCalls(fake.seen)[0]!.body as any;
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	test("max_tokens: requested is capped by the output reserve", async () => {
		for (const [config, expected] of [
			[{}, 2048],
			[{ maxOutputTokens: 100 }, 100],
			[{ maxOutputTokens: 9000 }, 2048],
		] as const) {
			const { larm, fake } = make({}, config);
			await larm.inference.complete(request(), signal());
			expect((providerCalls(fake.seen)[0]!.body as any).max_tokens).toBe(
				expected,
			);
		}
	});

	test("max_tokens: remaining-context is not capped; no window uses the request", async () => {
		const remaining = {
			...llmProvider,
			contextWindow: {
				maxTokens: 32768,
				outputReserveTokens: 2048,
				outputLimit: "remaining-context",
			},
		};
		const a = make(
			{ catalogProviders: [remaining] },
			{ maxOutputTokens: 9000 },
		);
		await a.larm.inference.complete(request(), signal());
		expect((providerCalls(a.fake.seen)[0]!.body as any).max_tokens).toBe(9000);
		const { contextWindow: _unused, ...bare } = llmProvider;
		const b = make({ catalogProviders: [bare] });
		await b.larm.inference.complete(request(), signal());
		expect((providerCalls(b.fake.seen)[0]!.body as any).max_tokens).toBe(4096);
		expect((await b.larm.describe(signal())).llm.contextWindow).toBeNull();
	});
});

describe("results and usage", () => {
	test("usage is mapped, the served model is reported, stats add up", async () => {
		const { larm } = make();
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({
			ok: true,
			model: "served-model",
			usage: {
				inputTokens: 10,
				cachedTokens: 4,
				outputTokens: 5,
				reasoningTokens: 2,
				calls: 1,
			},
		});
		const stats = larm.stats();
		expect(stats).toMatchObject({
			calls: 1,
			ok: 1,
			failures: {},
			inputTokens: 10,
			outputTokens: 5,
			reasoningTokens: 2,
		});
	});

	test("a missing count is null, never 0; the model falls back to the provider model", async () => {
		const { larm } = make({
			chat: () =>
				reply({
					choices: [{ message: { content: "text" } }],
					usage: { prompt_tokens: 7 },
				}),
		});
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({
			ok: true,
			model: "chat-model",
			usage: {
				inputTokens: 7,
				cachedTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				calls: 1,
			},
		});
	});

	test("no usage object at all gives nulls", async () => {
		const { larm } = make({
			chat: () => reply({ choices: [{ message: { content: "text" } }] }),
		});
		const result = await larm.inference.complete(request(), signal());
		expect(result.ok && result.usage).toMatchObject({
			inputTokens: null,
			outputTokens: null,
		});
	});

	test("empty, missing or non-string content is invalid_response", async () => {
		for (const message of [
			{ content: "" },
			{ content: "  " },
			{ content: null },
			{ content: 5 },
			{},
		]) {
			const { larm, fake } = make({
				chat: () => reply({ choices: [{ message }] }),
			});
			const result = await larm.inference.complete(request(), signal());
			expect(result).toMatchObject({ ok: false, error: "invalid_response" });
			expect(fake.deleted).toEqual(["conn-1"]);
		}
		const { larm } = make({ chat: () => reply({ choices: [] }) });
		expect(await larm.inference.complete(request(), signal())).toMatchObject({
			ok: false,
			error: "invalid_response",
		});
	});

	test("every failure code is safe", async () => {
		const { larm } = make({ chat: () => reply({}, 429) });
		const result = await larm.inference.complete(request(), signal());
		expect(!result.ok && result.error).toMatch(/^[a-z][a-z0-9_]*$/);
		expect(larm.stats().failures).toEqual({ larm_http_429: 1 });
	});
});

describe("provider host", () => {
	test("a provider on a foreign host is refused and receives no credential", async () => {
		const { larm, fake } = make({ claimBase: "http://10.9.9.9:9100/llm" });
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({
			ok: false,
			error: "provider_host_mismatch",
		});
		expect(fake.seen.some((s) => s.url.hostname === "10.9.9.9")).toBe(false);
		expect(providerCalls(fake.seen)).toHaveLength(0);
		expect(fake.deleted).toEqual(["conn-1"]);
	});

	test("a non-local provider URL is refused", async () => {
		const { larm, fake } = make({ claimBase: "https://example.com/llm" });
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false });
		expect(fake.seen.some((s) => s.url.hostname === "example.com")).toBe(false);
	});

	test("an explicitly listed extra host is accepted", async () => {
		const { larm, fake } = make(
			{ claimBase: "http://10.9.9.9:9100/llm" },
			{ providerHosts: ["10.9.9.9"] },
		);
		const result = await larm.inference.complete(request(), signal());
		// The fake serves providers by port, so the call reaches it.
		expect(result.ok).toBe(true);
		expect(fake.seen.some((s) => s.url.hostname === "10.9.9.9")).toBe(true);
	});

	test("the control token is never sent to the provider", async () => {
		const { larm, fake } = make();
		await larm.inference.complete(request(), signal());
		await larm.embedding.embed(["a"], "passage", signal());
		for (const call of providerCalls(fake.seen))
			expect(call.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
	});
});

describe("embedding", () => {
	test("priority by kind, request body, space and vectors", async () => {
		const { larm, fake } = make();
		const passage = await larm.embedding.embed(["a", "b"], "passage", signal());
		const query = await larm.embedding.embed(["q"], "query", signal());
		const calls = providerCalls(fake.seen);
		expect(calls[0]!.url.href).toBe(`${EMBED_PROVIDER}/embed`);
		expect(calls[0]!.body).toEqual({
			texts: ["a", "b"],
			type: "passage",
			normalize: true,
			priority: "low",
		});
		expect(calls[1]!.body).toEqual({
			texts: ["q"],
			type: "query",
			normalize: true,
			priority: "normal",
		});
		expect(passage.vectors).toEqual([
			[0.1, 0.2, 0.3],
			[0.1, 0.2, 0.3],
		]);
		expect(query.space).toEqual({
			modelId: "emb-model-id",
			revision: "r7",
			artifactDigest: "f".repeat(64),
			dimension: 3,
			queryPrefix: "query: ",
			passagePrefix: "passage: ",
		});
		const claims = fake.seen.filter((s) => s.url.pathname.endsWith("/claim"));
		expect((claims[0]!.body as any).format).toBe("larm-embedding-provider-v1");
		expect(fake.deleted).toEqual(["conn-1", "conn-2"]);
	});

	test("batch limits: empty, blank and more than 64 throw without HTTP; 64 passes", async () => {
		const { larm, fake } = make();
		for (const texts of [
			[],
			["ok", ""],
			["ok", "  \n"],
			Array(MAX_EMBED_BATCH + 1).fill("t"),
		])
			await expect(
				larm.embedding.embed(texts, "passage", signal()),
			).rejects.toThrow("invalid_embedding_input");
		expect(fake.seen).toHaveLength(0);
		const ok = await larm.embedding.embed(
			Array(MAX_EMBED_BATCH).fill("t"),
			"passage",
			signal(),
		);
		expect(ok.vectors).toHaveLength(MAX_EMBED_BATCH);
	});

	test("a wrong dimension, vector count or non-finite number is invalid_embedding_result", async () => {
		const bad: unknown[] = [
			{ dimension: 4, embeddings: [[1, 2, 3]] },
			{ dimension: 3, embeddings: [[1, 2]] },
			{ dimension: 3, embeddings: [] },
			{ dimension: 3, embeddings: [[1, 2, null]] },
			{ dimension: 3, embeddings: [[1, 2, "3"]] },
			{ dimension: 3 },
		];
		for (const body of bad) {
			const { larm, fake } = make({ embed: () => reply(body) });
			await expect(
				larm.embedding.embed(["x"], "passage", signal()),
			).rejects.toThrow("invalid_embedding_result");
			expect(fake.deleted).toEqual(["conn-1"]);
		}
	});

	test("an invalid declared space is reported as invalid_embedding_space", async () => {
		const broken = {
			...embeddingProvider,
			embeddingSpace: { ...embeddingSpace, dimension: 0 },
		};
		const { larm } = make({ catalogProviders: [llmProvider, broken] });
		await expect(
			larm.embedding.embed(["x"], "passage", signal()),
		).rejects.toThrow("invalid_embedding_space");
		expect((await larm.describe(signal())).embedding).toBeNull();
	});

	test("a provider failure throws a safe code and releases", async () => {
		const { larm, fake } = make({ embed: () => reply({}, 503) });
		await expect(
			larm.embedding.embed(["x"], "passage", signal()),
		).rejects.toThrow("larm_http_503");
		expect(fake.deleted).toEqual(["conn-1"]);
		expect(larm.stats().failures).toEqual({ larm_http_503: 1 });
	});

	test("abort mid-poll rethrows an AbortError and DELETEs", async () => {
		const controller = new AbortController();
		const { larm, fake } = make({
			pendingPolls: 1_000_000,
			onGet: () => controller.abort(),
		});
		await expect(
			larm.embedding.embed(["x"], "query", controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fake.deleted).toEqual(["conn-1"]);
	});
});

describe("secrets", () => {
	test("neither the token nor the credential appears in results, errors or stats", async () => {
		const outputs: string[] = [];
		const cases: FakeOptions[] = [
			{},
			{ chat: () => reply({ error: `${CREDENTIAL} ${TOKEN}` }, 500) },
			{ chat: () => reply({ choices: [{ message: { content: "" } }] }) },
			{ claimBase: "http://10.9.9.9:9100/llm" },
			{ createStatus: 500, createBody: { error: TOKEN } },
		];
		for (const options of cases) {
			const { larm } = make(options);
			outputs.push(
				JSON.stringify(await larm.inference.complete(request(), signal())),
			);
			outputs.push(JSON.stringify(larm.stats()));
			await larm.embedding.embed(["x"], "passage", signal()).then(
				(r) => outputs.push(JSON.stringify(r)),
				(e: Error) => outputs.push(e.name, e.message, String(e.stack)),
			);
			await larm.describe(signal()).then(
				(r) => outputs.push(JSON.stringify(r)),
				(e: Error) => outputs.push(e.name, e.message),
			);
		}
		const bad = createLarm({
			baseUrl: BASE,
			token: TOKEN,
			profile: "prof",
			audience: "tests",
			fetch: (async () =>
				reply({ unexpected: TOKEN })) as unknown as typeof fetch,
		});
		outputs.push(
			JSON.stringify(await bad.inference.complete(request(), signal())),
		);
		const joined = outputs.join("\n");
		expect(joined).not.toContain(TOKEN);
		expect(joined).not.toContain(CREDENTIAL);
	});

	test("a non-local LARM base URL is refused before any request", async () => {
		let sent = 0;
		const larm = createLarm({
			baseUrl: "https://example.com",
			token: TOKEN,
			profile: "prof",
			audience: "tests",
			fetch: (async () => {
				sent += 1;
				return reply({});
			}) as unknown as typeof fetch,
		});
		const result = await larm.inference.complete(request(), signal());
		expect(result).toMatchObject({ ok: false, error: "invalid_larm_url" });
		expect(sent).toBe(0);
	});
});
