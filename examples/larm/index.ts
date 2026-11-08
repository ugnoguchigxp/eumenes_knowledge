import { randomUUID } from "node:crypto";
import {
	MAX_EMBED_BATCH,
	type EmbeddingKind,
	type EmbeddingPort,
	type EmbeddingSpace,
	type InferencePort,
	type InferenceRequest,
	type InferenceResult,
	type InferenceUsage,
} from "../../src/contracts/index.js";

/**
 * An examples-only LARM connection that gives the package's `InferencePort` and `EmbeddingPort`
 * over a real LARM gateway. It follows how Eumenes connects
 * (`api/domains/larm/service/{provider-connection,playground-provider,chat-request,guards}.ts`):
 *
 * 1. catalog `GET /v3/agent-profiles?profile=<p>` picks the `llm` and the embedding provider;
 * 2. `POST /v1/agent-connections` (Idempotency-Key, `Prefer: wait=1`), then `GET` until the
 *    connection is `ready` and the provider is claimable;
 * 3. `POST .../claim`; the provider URL must be on the LARM host (or an explicit extra host);
 * 4. one call to the provider with the claimed bearer credential;
 * 5. `DELETE` the connection, whatever happened.
 *
 * The control token and the claimed credential are never logged, returned or put in an error:
 * every failure is a safe code (`/^[a-z][a-z0-9_]*$/`).
 */

export type LarmConfig = {
	/** LARM control origin, e.g. `http://127.0.0.1:8080`. */
	baseUrl: string;
	/** Bearer token for the control API. */
	token: string;
	/** Profile selector. */
	profile: string;
	audience: string;
	/** Extra hosts that may receive a provider credential (the LARM host always may). */
	providerHosts?: readonly string[];
	fetch?: typeof fetch;
	/** Milliseconds between two reads of a pending connection. Default 1000. */
	pollMs?: number;
	/** Milliseconds a connection may take to become ready. Default 90_000. */
	readyMs?: number;
	/**
	 * Default 4096. Capped by the provider's `contextWindow.outputReserveTokens` unless its
	 * `outputLimit` is `remaining-context`.
	 */
	maxOutputTokens?: number;
	/** `off` (default) sends `enable_thinking: false` and `reasoning_effort: "none"`. */
	reasoning?: "off" | "default";
	/** Default `eumenes-knowledge-examples`; each connection is `${clientName}-${randomUUID()}`. */
	clientName?: string;
};

export type LarmBinding = {
	profile: string;
	catalogRevision: string;
	llm: {
		name: string;
		model: string;
		contextWindow: {
			maxTokens: number;
			outputReserveTokens: number;
			outputLimit?: string;
		} | null;
	};
	embedding: { name: string; model: string; space: EmbeddingSpace } | null;
};

export type LarmStats = {
	/** Port calls (inference and embedding). */
	calls: number;
	ok: number;
	/** Failure code to count. Also counts `release_unconfirmed` (a DELETE that was not confirmed). */
	failures: Record<string, number>;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalMs: number;
};

// ---------------------------------------------------------------------------
// Errors, small parsers
// ---------------------------------------------------------------------------

const SAFE_CODE = /^[a-z][a-z0-9_]*$/;
const CATALOG_TTL_MS = 600_000;
const RELEASE_MS = 10_000;
const CREATE_MS = 15_000;
const JSON_LIMIT = 1_000_000;

/** The only error this module throws. The message is a safe code and nothing else. */
class LarmError extends Error {
	override readonly name = "LarmError";
	constructor(readonly code: string) {
		super(code);
	}
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

const invalid = () => new LarmError("invalid_response");

function obj(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw invalid();
	return value as Record<string, unknown>;
}
function str(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 8192)
		throw invalid();
	return value;
}
function list(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value) || value.length > 512) throw invalid();
	return value.map(obj);
}

async function readText(response: Response, limit: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw invalid();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			throw new LarmError("response_too_large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function json(response: Response): Promise<Record<string, unknown>> {
	const text = await readText(response, JSON_LIMIT);
	try {
		return obj(JSON.parse(text));
	} catch {
		throw invalid();
	}
}

/** Loopback / private-LAN URLs only; a `.local` name only when it is listed in `allowLocal`. */
function localUrl(value: string, allowLocal: readonly string[]): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new LarmError("invalid_larm_url");
	}
	const host = url.hostname.toLowerCase();
	const local =
		host === "localhost" ||
		(host.endsWith(".local") && allowLocal.includes(host)) ||
		(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) &&
			host.split(".").every((part) => Number(part) <= 255) &&
			/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!local
	)
		throw new LarmError("invalid_larm_url");
	return url;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

const noUsage = (): InferenceUsage => ({
	inputTokens: null,
	cachedTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	calls: null,
});

/** A count the provider reported; anything else is null (never 0 in its place). */
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

function readUsage(raw: unknown): InferenceUsage {
	const usage = raw && typeof raw === "object" ? (raw as any) : {};
	const details = (key: string) =>
		usage[key] && typeof usage[key] === "object" ? usage[key] : {};
	return {
		inputTokens: count(usage.prompt_tokens),
		cachedTokens: count(details("prompt_tokens_details").cached_tokens),
		outputTokens: count(usage.completion_tokens),
		reasoningTokens: count(
			details("completion_tokens_details").reasoning_tokens,
		),
		calls: 1,
	};
}

/**
 * A safe failure code for an error. A caller's abort is rethrown (the same AbortError the mock
 * ports throw); a passed deadline is `deadline_exceeded`.
 */
function failureCode(
	error: unknown,
	caller: AbortSignal,
	deadline?: AbortSignal,
): string {
	if (caller.aborted) throw abortError();
	if (deadline?.aborted) return "deadline_exceeded";
	if (error instanceof LarmError && SAFE_CODE.test(error.code))
		return error.code;
	// A refused connection, a redirect (`redirect: "error"`) or a broken body.
	if (error instanceof TypeError) return "larm_unreachable";
	if (
		error instanceof DOMException &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	)
		return "larm_timeout";
	return "larm_error";
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

type ContextWindow = NonNullable<LarmBinding["llm"]["contextWindow"]>;

type Target = {
	name: string;
	model: string;
	protocol: string;
	capability: string;
	/** Path from the catalog, e.g. `/v1/chat/completions`. */
	endpoint: string;
	kind: "llm" | "embedding";
	/** The profile id the connection is checked against. */
	profile: string;
	revision: string;
};

type LlmTarget = Target & { contextWindow: ContextWindow | null };
type EmbeddingTarget = Target & { space: EmbeddingSpace };

type Catalog = {
	profile: string;
	revision: string;
	llm: LlmTarget | null;
	embedding: EmbeddingTarget | null;
	/** Why the embedding provider is unusable, when the catalog declares one that is. */
	embeddingProblem: string | null;
};

const LLM_PROTOCOL = "openai.chat-completions.v1";
const LLM_ENDPOINT = "/v1/chat/completions";
const EMBEDDING_PROTOCOL = "larm.embedding.v1";
const EMBEDDING_ENDPOINT = "/v1/embed";

function readContextWindow(raw: unknown): ContextWindow | null {
	if (!raw || typeof raw !== "object") return null;
	const w = raw as Record<string, unknown>;
	const max = w.maxTokens;
	const reserve = w.outputReserveTokens;
	if (
		typeof max !== "number" ||
		!Number.isInteger(max) ||
		max < 1 ||
		typeof reserve !== "number" ||
		!Number.isInteger(reserve) ||
		reserve < 1
	)
		return null;
	return {
		maxTokens: max,
		outputReserveTokens: reserve,
		...(typeof w.outputLimit === "string"
			? { outputLimit: w.outputLimit }
			: {}),
	};
}

function readEmbeddingSpace(item: Record<string, unknown>): EmbeddingSpace {
	const space = obj(item.embeddingSpace);
	const model = obj(space.model);
	const prefixes = space.prefixes === undefined ? {} : obj(space.prefixes);
	const dimension = Number(space.dimension);
	if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192)
		throw new LarmError("invalid_embedding_space");
	return {
		modelId: str(model.id),
		revision: str(model.revision),
		artifactDigest: str(model.artifactDigest),
		dimension,
		queryPrefix: str(prefixes.query ?? ""),
		passagePrefix: str(prefixes.passage ?? ""),
	};
}

function parseCatalog(
	data: Record<string, unknown>,
	selector: string,
): Catalog {
	if (
		data.contractVersion !== "agent-connection.v3" ||
		data.requestedProfile !== selector
	)
		throw new LarmError("invalid_catalog");
	const revision = str(data.catalogRevision);
	const profiles = list(data.profiles);
	const chosen = profiles.find((p) => p.id === selector) ?? profiles[0];
	if (!chosen) throw new LarmError("profile_unavailable");
	const profile = str(chosen.id);
	const providers = list(chosen.providers ?? []);
	const target = (
		item: Record<string, unknown>,
		kind: Target["kind"],
	): Target => ({
		name: str(item.name),
		model: str(item.model),
		protocol: str(item.protocol),
		capability: str(item.capability),
		endpoint: str(item.endpoint),
		kind,
		profile,
		revision,
	});

	const llmItem = providers.find(
		(p) => p.name === "llm" && p.protocol === LLM_PROTOCOL,
	);
	let llm: LlmTarget | null = null;
	if (llmItem && llmItem.endpoint === LLM_ENDPOINT)
		llm = {
			...target(llmItem, "llm"),
			contextWindow: readContextWindow(llmItem.contextWindow),
		};

	const embeddingItem =
		providers.find(
			(p) => p.name === "embedding" && p.protocol === EMBEDDING_PROTOCOL,
		) ?? providers.find((p) => p.protocol === EMBEDDING_PROTOCOL);
	let embedding: EmbeddingTarget | null = null;
	let embeddingProblem: string | null = null;
	if (embeddingItem) {
		try {
			if (embeddingItem.endpoint !== EMBEDDING_ENDPOINT)
				throw new LarmError("invalid_embedding_space");
			embedding = {
				...target(embeddingItem, "embedding"),
				space: readEmbeddingSpace(embeddingItem),
			};
		} catch (error) {
			embeddingProblem =
				error instanceof LarmError ? error.code : "invalid_embedding_space";
		}
	}
	return { profile, revision, llm, embedding, embeddingProblem };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function createLarm(config: LarmConfig): {
	describe(signal: AbortSignal): Promise<LarmBinding>;
	inference: InferencePort;
	embedding: EmbeddingPort;
	stats(): LarmStats;
} {
	const doFetch = config.fetch ?? fetch;
	const providerHosts = (config.providerHosts ?? []).map((h) =>
		h.toLowerCase(),
	);
	const pollMs = config.pollMs ?? 1000;
	const readyMs = config.readyMs ?? 90_000;
	const reasoning = config.reasoning ?? "off";
	const clientName = config.clientName ?? "eumenes-knowledge-examples";

	let base: URL | undefined;
	const larmBase = (): URL => {
		base ??= localUrl(config.baseUrl.trim(), [
			new URL(config.baseUrl.trim()).hostname.toLowerCase(),
		]);
		return base;
	};

	/** A provider may receive the credential only at the LARM host or an explicit extra host. */
	function providerUrl(value: string): URL {
		const url = localUrl(value, [new URL(value).hostname.toLowerCase()]);
		const host = url.hostname.toLowerCase();
		if (
			host !== larmBase().hostname.toLowerCase() &&
			!providerHosts.includes(host)
		)
			throw new LarmError("provider_host_mismatch");
		return url;
	}

	/** A control call: bearer token, no redirects, same origin only. */
	async function control(
		path: string,
		signal: AbortSignal,
		init: RequestInit = {},
		accepted: readonly number[] = [200],
	): Promise<Response> {
		const origin = larmBase();
		if (!config.token) throw new LarmError("larm_unconfigured");
		signal.throwIfAborted();
		const url = new URL(path, origin);
		if (
			url.origin !== origin.origin ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new LarmError("invalid_larm_url");
		const response = await doFetch(url, {
			...init,
			redirect: "error",
			signal,
			headers: { Authorization: `Bearer ${config.token}`, ...init.headers },
		});
		if (accepted.includes(response.status)) return response;
		if (response.status === 503 && (await capacityRefused(response)))
			throw new LarmError("capacity_busy");
		await response.body?.cancel().catch(() => {});
		throw new LarmError(`larm_http_${response.status}`);
	}

	/** LARM's single "no free memory now" refusal: 503 `resource_exhausted` on `memory`. */
	async function capacityRefused(response: Response): Promise<boolean> {
		try {
			const body = JSON.parse(await readText(response, 16 * 1024)) as Record<
				string,
				unknown
			>;
			const error = body.error as Record<string, unknown> | string | undefined;
			const inner = error && typeof error === "object" ? error : {};
			const code =
				typeof error === "string" ? error : (inner.code ?? body.code);
			const resource = inner.resource ?? body.resource;
			return code === "resource_exhausted" && resource === "memory";
		} catch {
			return false;
		}
	}

	const post = (
		body: unknown,
		headers: Record<string, string> = {},
	): RequestInit => ({
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

	let cached: { at: number; catalog: Catalog } | undefined;
	async function catalog(signal: AbortSignal): Promise<Catalog> {
		if (cached && Date.now() - cached.at < CATALOG_TTL_MS)
			return cached.catalog;
		if (!config.profile) throw new LarmError("larm_profile_missing");
		const data = await json(
			await control(
				`/v3/agent-profiles?profile=${encodeURIComponent(config.profile)}`,
				signal,
			),
		);
		const parsed = parseCatalog(data, config.profile);
		cached = { at: Date.now(), catalog: parsed };
		return parsed;
	}

	/**
	 * A refusal that says the catalog we hold is out of date (the connection contract, the
	 * provider binding, or a 409/412/422 refusal of the expected catalog revision) drops the
	 * cached catalog, so the next call reads it again instead of failing until the TTL.
	 */
	const STALE = new Set([
		"invalid_connection_contract",
		"invalid_provider_binding",
		"larm_http_409",
		"larm_http_412",
		"larm_http_422",
	]);
	function forgetStale(error: unknown): void {
		if (error instanceof LarmError && STALE.has(error.code)) cached = undefined;
	}

	// -- statistics -----------------------------------------------------------

	const totals: LarmStats = {
		calls: 0,
		ok: 0,
		failures: {},
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalMs: 0,
	};
	function record(
		ok: boolean,
		code: string | null,
		durationMs: number,
		usage?: InferenceUsage,
	): void {
		totals.calls += 1;
		totals.totalMs += durationMs;
		if (ok) totals.ok += 1;
		else if (code) totals.failures[code] = (totals.failures[code] ?? 0) + 1;
		if (usage) {
			totals.inputTokens += usage.inputTokens ?? 0;
			totals.outputTokens += usage.outputTokens ?? 0;
			totals.reasoningTokens += usage.reasoningTokens ?? 0;
		}
	}

	// -- connection -----------------------------------------------------------

	/**
	 * Opens a connection for one provider, waits until it is ready, runs `action`, and releases
	 * the connection whatever happened. A release that is not confirmed is counted, never thrown:
	 * the connection expires by itself (`ttlSeconds`).
	 */
	async function withConnection<T>(
		target: Target,
		signal: AbortSignal,
		action: (id: string) => Promise<T>,
	): Promise<T> {
		let id: string | undefined;
		const started = Date.now();
		try {
			signal.throwIfAborted();
			const idempotencyKey = randomUUID();
			const client = `${clientName}-${randomUUID()}`;
			// The create call is bound by its own timeout, not by `signal`: a cancellation must still
			// let us read a late connection id and release it.
			const create = async () =>
				json(
					await control(
						"/v1/agent-connections",
						AbortSignal.timeout(CREATE_MS),
						post(
							{
								profile: config.profile,
								audience: config.audience,
								client,
								providers: [target.name],
								ttlSeconds: 300,
								allowFallback: false,
								deploymentPolicy: "existing-only",
								expectedCatalogRevision: target.revision,
							},
							{ "Idempotency-Key": idempotencyKey, Prefer: "wait=1" },
						),
						[201, 202],
					),
				);
			let state: Record<string, unknown>;
			try {
				state = await create();
			} catch (error) {
				// No answer arrived: send the same Idempotency-Key once more.
				const lost =
					error instanceof TypeError ||
					(error instanceof DOMException && error.name === "TimeoutError");
				if (!lost || signal.aborted) throw error;
				state = await create();
			}
			id = str(state.id);
			if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
				throw new LarmError("invalid_connection_id");
			signal.throwIfAborted();
			for (;;) {
				if (
					state.id !== id ||
					state.agentProfile !== target.profile ||
					state.catalogRevision !== target.revision
				)
					throw new LarmError("invalid_connection_contract");
				const p = list(state.providers).find((x) => x.name === target.name);
				if (!p || p.model !== target.model || p.protocol !== target.protocol)
					throw new LarmError("invalid_provider_binding");
				if (["failed", "expired", "released"].includes(String(state.status)))
					throw new LarmError("provider_not_ready");
				if (
					state.status === "ready" &&
					p.claimable === true &&
					p.readiness === "ready"
				)
					return await action(id);
				if (Date.now() - started >= readyMs)
					throw new LarmError("provider_not_ready");
				await pause(pollMs, signal);
				state = await json(
					await control(
						`/v1/agent-connections/${encodeURIComponent(id)}`,
						signal,
					),
				);
			}
		} finally {
			if (id)
				await control(
					`/v1/agent-connections/${encodeURIComponent(id)}`,
					AbortSignal.timeout(RELEASE_MS),
					{ method: "DELETE" },
					[200, 204, 404],
				).catch(() => {
					totals.failures.release_unconfirmed =
						(totals.failures.release_unconfirmed ?? 0) + 1;
				});
		}
	}

	/**
	 * Claims one provider of a ready connection and returns a function that calls it. The
	 * credential stays inside this closure, and is sent only to a validated provider URL.
	 */
	async function claim(target: Target, id: string, signal: AbortSignal) {
		const claimed = await json(
			await control(
				`/v1/agent-connections/${encodeURIComponent(id)}/claim`,
				signal,
				post({
					format:
						target.kind === "embedding"
							? "larm-embedding-provider-v1"
							: "openai-provider-v1",
				}),
			),
		);
		let token: string;
		let endpoint: URL;
		try {
			if (
				claimed.id !== id ||
				claimed.status !== "ready" ||
				!(Date.parse(str(claimed.expiresAt)) >= Date.now() + 10_000)
			)
				throw new LarmError("invalid_claim");
			const p = list(claimed.providers).find((x) => x.name === target.name);
			if (!p || p.model !== target.model || p.protocol !== target.protocol)
				throw new LarmError("invalid_claim");
			const fields = obj(obj(p.configuration).fields);
			const credential = obj(p.credential);
			if (
				fields.model !== target.model ||
				credential.type !== "bearer" ||
				!(Date.parse(str(credential.expiresAt)) > Date.now() + 10_000)
			)
				throw new LarmError("invalid_claim");
			const providerBase = providerUrl(str(fields.baseURL ?? fields.daemonURL));
			if (providerBase.href !== providerUrl(str(p.baseUrl)).href)
				throw new LarmError("invalid_claim");
			endpoint = new URL(
				target.endpoint.replace(/^\/v1\//, ""),
				`${providerBase.href.replace(/\/$/, "")}/`,
			);
			if (
				p.endpoint !== undefined &&
				providerUrl(str(p.endpoint)).href !== endpoint.href
			)
				throw new LarmError("invalid_claim");
			token = str(credential.token);
		} catch (error) {
			// A structure that does not parse is an invalid claim; a host refusal keeps its code.
			if (error instanceof LarmError && error.code !== "invalid_response")
				throw error;
			throw new LarmError("invalid_claim");
		}
		return async (body: unknown): Promise<Record<string, unknown>> => {
			signal.throwIfAborted();
			const response = await doFetch(endpoint, {
				...post(body, { Authorization: `Bearer ${token}` }),
				redirect: "error",
				signal,
			});
			if (!response.ok) {
				const busy =
					response.status === 503 && (await capacityRefused(response));
				await response.body?.cancel().catch(() => {});
				throw new LarmError(
					busy ? "capacity_busy" : `larm_http_${response.status}`,
				);
			}
			return json(response);
		};
	}

	// -- ports ----------------------------------------------------------------

	function chatBody(
		llm: LlmTarget,
		request: InferenceRequest,
	): Record<string, unknown> {
		const requested = config.maxOutputTokens ?? 4096;
		const window = llm.contextWindow;
		const maxTokens =
			!window || window.outputLimit === "remaining-context"
				? requested
				: Math.min(window.outputReserveTokens, requested);
		return {
			model: llm.model,
			messages: [
				...(request.system === undefined
					? []
					: [{ role: "system", content: request.system }]),
				{ role: "user", content: request.prompt },
			],
			temperature: 0,
			...(request.outputSchema
				? {
						response_format: {
							type: "json_schema",
							json_schema: {
								name: "answer",
								strict: true,
								schema: request.outputSchema,
							},
						},
					}
				: {}),
			...(reasoning === "off"
				? {
						chat_template_kwargs: { enable_thinking: false },
						reasoning_effort: "none",
					}
				: {}),
			stream: false,
			max_tokens: maxTokens,
		};
	}

	const inference: InferencePort = {
		async complete(request, signal): Promise<InferenceResult> {
			const started = Date.now();
			const elapsed = () => Date.now() - started;
			let model: string | null = null;
			let usage = noUsage();
			const fail = (code: string): InferenceResult => {
				record(false, code, elapsed(), usage);
				return { ok: false, error: code, model, usage, durationMs: elapsed() };
			};
			if (signal.aborted) throw abortError();
			if (started > request.deadlineAtMs) return fail("deadline_exceeded");
			const deadline = AbortSignal.timeout(request.deadlineAtMs - started);
			const combined = AbortSignal.any([signal, deadline]);
			try {
				const cat = await catalog(combined);
				const llm = cat.llm;
				if (!llm) throw new LarmError("llm_unavailable");
				model = llm.model;
				const text = await withConnection(llm, combined, async (id) => {
					const call = await claim(llm, id, combined);
					const answer = await call(chatBody(llm, request));
					if (typeof answer.model === "string" && answer.model)
						model = answer.model;
					usage = readUsage(answer.usage);
					const choices = answer.choices;
					// The model hit max_tokens: the text is cut off (broken JSON), never a valid answer.
					if (
						Array.isArray(choices) &&
						choices[0] &&
						typeof choices[0] === "object" &&
						(choices[0] as { finish_reason?: unknown }).finish_reason ===
							"length"
					)
						throw new LarmError("output_truncated");
					const message =
						Array.isArray(choices) &&
						choices[0] &&
						typeof choices[0] === "object"
							? (choices[0] as { message?: { content?: unknown } }).message
							: undefined;
					const content = message?.content;
					if (typeof content !== "string" || !content.trim()) throw invalid();
					return content;
				});
				const durationMs = elapsed();
				record(true, null, durationMs, usage);
				return { ok: true, text, model, usage, durationMs };
			} catch (error) {
				forgetStale(error);
				return fail(failureCode(error, signal, deadline));
			}
		},
	};

	const embedding: EmbeddingPort = {
		async embed(texts, kind: EmbeddingKind, signal) {
			if (signal.aborted) throw abortError();
			if (
				texts.length === 0 ||
				texts.length > MAX_EMBED_BATCH ||
				texts.some((t) => typeof t !== "string" || !t.trim())
			)
				throw new Error("invalid_embedding_input");
			const started = Date.now();
			try {
				const cat = await catalog(signal);
				const target = cat.embedding;
				if (!target)
					throw new LarmError(cat.embeddingProblem ?? "embedding_unavailable");
				const result = await withConnection(target, signal, async (id) => {
					const call = await claim(target, id, signal);
					const data = await call({
						texts,
						type: kind,
						normalize: true,
						// LARM requires a priority: passages are background work, a query is interactive.
						priority: kind === "passage" ? "low" : "normal",
					});
					const vectors = data.embeddings;
					const { dimension } = target.space;
					if (
						data.dimension !== dimension ||
						!Array.isArray(vectors) ||
						vectors.length !== texts.length ||
						!vectors.every(
							(v) =>
								Array.isArray(v) &&
								v.length === dimension &&
								v.every((n) => typeof n === "number" && Number.isFinite(n)),
						)
					)
						throw new LarmError("invalid_embedding_result");
					return vectors as number[][];
				});
				record(true, null, Date.now() - started);
				return { vectors: result, space: { ...target.space } };
			} catch (error) {
				forgetStale(error);
				const code = failureCode(error, signal);
				record(false, code, Date.now() - started);
				throw new Error(code);
			}
		},
	};

	return {
		async describe(signal) {
			try {
				const cat = await catalog(signal);
				if (!cat.llm) throw new LarmError("llm_unavailable");
				return {
					profile: cat.profile,
					catalogRevision: cat.revision,
					llm: {
						name: cat.llm.name,
						model: cat.llm.model,
						contextWindow: cat.llm.contextWindow
							? { ...cat.llm.contextWindow }
							: null,
					},
					embedding: cat.embedding
						? {
								name: cat.embedding.name,
								model: cat.embedding.model,
								space: { ...cat.embedding.space },
							}
						: null,
				};
			} catch (error) {
				forgetStale(error);
				throw new Error(failureCode(error, signal));
			}
		},
		inference,
		embedding,
		stats: () => ({ ...totals, failures: { ...totals.failures } }),
	};
}
