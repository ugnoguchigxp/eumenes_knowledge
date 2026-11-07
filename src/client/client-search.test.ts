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
const DOC = `wiki-${"a".repeat(32)}`;
const SHA = "b".repeat(64);

const searchAnswer = {
	contractVersion: CONTRACT_VERSION,
	results: [
		{
			rank: 1,
			sourceNamespace: "docling",
			documentId: DOC,
			namespace: "notes",
			path: "a.md",
			title: "A",
			markdownSha256: SHA,
			state: "current",
			fragment: { ordinal: 0, byteStart: 0, byteEnd: 5, headingPath: ["A"] },
			quote: "hello",
			quoteSha256: SHA,
			matchedBy: [{ route: "text", rank: 1 }],
			mentions: [],
		},
	],
	lexicalMode: "trigram",
	routes: [{ route: "text", status: "ok", reason: null, candidates: 1 }],
	coverage: {
		documents: 1,
		searchable: 1,
		stale: 0,
		unavailable: 0,
		failed: 0,
		extractionIncomplete: 0,
	},
	complete: true,
	partialReasons: [],
};
const evidenceRequest = {
	documentId: DOC,
	markdownSha256: SHA,
	byteStart: 0,
	byteEnd: 5,
	quoteSha256: SHA,
};

type Call = { url: string; init: RequestInit };
const recorder = (answer: Response | Error) => {
	const calls: Call[] = [];
	const fetch: KnowledgeFetch = async (url, init) => {
		calls.push({ url, init });
		if (answer instanceof Error) throw answer;
		return answer.clone() as unknown as Response;
	};
	return { calls, fetch };
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const client = (fetch: KnowledgeFetch, extra: Record<string, unknown> = {}) =>
	createKnowledgeClient({ baseUrl: BASE, token: TOKEN, fetch, ...extra });
const failure = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(KnowledgeClientError);
		return error as KnowledgeClientError;
	}
	throw new Error("expected a KnowledgeClientError");
};

describe("search()", () => {
	test("posts the request as JSON (defaults applied) and returns the validated answer", async () => {
		const { calls, fetch } = recorder(json(searchAnswer));
		const result = await client(fetch).search({ query: "hello" });
		expect(result.results[0]?.quote).toBe("hello");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}${apiPaths.search}`);
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
			query: "hello",
			limit: 10,
		});
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	test("an invalid request is refused before any call", async () => {
		const { calls, fetch } = recorder(json(searchAnswer));
		const c = client(fetch);
		for (const bad of [
			{ query: "" },
			{ query: "x".repeat(1001) },
			{ query: "x", limit: 51 },
			{ query: "x", routes: [] },
			{ query: "x", routes: ["nope"] },
			{ query: "x", principal: "root" },
			{},
			null,
		]) {
			const error = await failure(c.search(bad as never));
			expect(error.code).toBe("knowledge_invalid_input");
		}
		expect(calls).toHaveLength(0);
	});

	test("an answer that fails the schema is a contract mismatch", async () => {
		for (const body of [
			{ ...searchAnswer, extra: 1 },
			{ ...searchAnswer, results: [{ rank: 0 }] },
			{ ...searchAnswer, contractVersion: "other" },
			"text",
			null,
		]) {
			const { fetch } = recorder(json(body));
			const error = await failure(client(fetch).search({ query: "x" }));
			expect(error.code).toBe("knowledge_contract_mismatch");
		}
	});

	const cases: [string, Response | Error, KnowledgeClientErrorCode][] = [
		[
			"connection refused",
			new TypeError("fetch failed"),
			"knowledge_unavailable",
		],
		["400", json({ error: "invalid_input" }, 400), "knowledge_invalid_input"],
		["401", json({ error: "unauthorized" }, 401), "knowledge_auth_failed"],
		["413", json({ error: "payload_too_large" }, 413), "knowledge_http_error"],
		["500", json({ error: "internal_error" }, 500), "knowledge_http_error"],
		[
			"503 knowledge_unavailable",
			json({ error: "knowledge_unavailable" }, 503),
			"knowledge_unavailable",
		],
		[
			"503 server_starting",
			json({ error: "server_starting" }, 503),
			"knowledge_server_starting",
		],
		["timeout", new DOMException("t", "TimeoutError"), "knowledge_timeout"],
	];
	for (const [label, answer, code] of cases) {
		test(`${label} -> ${code}`, async () => {
			const { fetch } = recorder(answer);
			const error = await failure(client(fetch).search({ query: "x" }));
			expect(error.code).toBe(code);
			expect(error.message).toBe(code);
			expect(error.message).not.toContain(TOKEN);
		});
	}

	test("a fetch that never answers is cut at timeoutMs", async () => {
		const fetch: KnowledgeFetch = (_url, init) =>
			new Promise<Response>((_, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		const error = await failure(
			client(fetch, { timeoutMs: 20 }).search({ query: "x" }),
		);
		expect(error.code).toBe("knowledge_timeout");
	});
});

describe("evidence()", () => {
	test("posts the request and returns each status as an answer", async () => {
		const answers = [
			{ status: "valid", quote: "hello", state: "current" },
			{ status: "stale", currentMarkdownSha256: SHA },
			{ status: "stale", currentMarkdownSha256: null },
			{ status: "unavailable" },
			{ status: "mismatch" },
			{ status: "not_available" },
		];
		for (const answer of answers) {
			const { calls, fetch } = recorder(json(answer));
			const result = await client(fetch).evidence(evidenceRequest);
			expect(result).toEqual(answer as never);
			expect(calls[0]?.url).toBe(`${BASE}${apiPaths.evidence}`);
			expect(calls[0]?.init.method).toBe("POST");
			expect(JSON.parse(calls[0]?.init.body as string)).toEqual(
				evidenceRequest,
			);
		}
	});

	test("an invalid request is refused before any call", async () => {
		const { calls, fetch } = recorder(json({ status: "mismatch" }));
		const c = client(fetch);
		for (const bad of [
			{ ...evidenceRequest, documentId: "x" },
			{ ...evidenceRequest, markdownSha256: "ZZ" },
			{ ...evidenceRequest, byteStart: 5, byteEnd: 5 },
			{ ...evidenceRequest, byteStart: -1 },
			{ ...evidenceRequest, principal: "root" },
			{ documentId: DOC },
		]) {
			const error = await failure(c.evidence(bad as never));
			expect(error.code).toBe("knowledge_invalid_input");
		}
		expect(calls).toHaveLength(0);
	});

	test("an answer that fails the schema is a contract mismatch", async () => {
		for (const body of [
			{ status: "valid" },
			{ status: "valid", quote: "x", state: "other" },
			{ status: "stale" },
			{ status: "mismatch", extra: 1 },
			{ status: "unknown" },
			null,
		]) {
			const { fetch } = recorder(json(body));
			const error = await failure(client(fetch).evidence(evidenceRequest));
			expect(error.code).toBe("knowledge_contract_mismatch");
		}
	});

	const cases: [string, Response | Error, KnowledgeClientErrorCode][] = [
		[
			"connection refused",
			new TypeError("fetch failed"),
			"knowledge_unavailable",
		],
		["400", json({ error: "invalid_input" }, 400), "knowledge_invalid_input"],
		["401", json({ error: "unauthorized" }, 401), "knowledge_auth_failed"],
		["500", json({ error: "internal_error" }, 500), "knowledge_http_error"],
		[
			"503 server_starting",
			json({ error: "server_starting" }, 503),
			"knowledge_server_starting",
		],
		["timeout", new DOMException("t", "TimeoutError"), "knowledge_timeout"],
	];
	for (const [label, answer, code] of cases) {
		test(`${label} -> ${code}`, async () => {
			const { fetch } = recorder(answer);
			const error = await failure(client(fetch).evidence(evidenceRequest));
			expect(error.code).toBe(code);
		});
	}
});
