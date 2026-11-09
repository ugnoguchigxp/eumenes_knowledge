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
const point = {
	documentId: DOC,
	markdownSha256: SHA,
	fragmentOrdinal: 0,
	byteStart: 0,
	byteEnd: 5,
	quoteSha256: SHA,
};

const request = { maxNodes: 5, maxEdges: 5, namespaces: ["notes"] };
const empty = {
	contractVersion: CONTRACT_VERSION,
	status: "ok",
	documents: [],
	nodes: [],
	edges: [],
	complete: true,
	partialReasons: [],
};
const okAnswer = {
	...empty,
	documents: [
		{
			documentId: DOC,
			namespace: "notes",
			path: "a.md",
			title: "A",
			markdownSha256: SHA,
			state: "current",
		},
	],
	nodes: [
		{
			nodeId: "n1",
			label: "Acme",
			names: ["Acme"],
			types: ["company"],
			mentionCount: 1,
			documentCount: 1,
			documentIds: [DOC],
			evidence: [point],
			decidedBy: [],
			summary: null,
		},
	],
	complete: false,
	partialReasons: ["nodes_truncated"],
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
const client = (fetch: KnowledgeFetch) =>
	createKnowledgeClient({ baseUrl: BASE, token: TOKEN, fetch });
const failure = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(KnowledgeClientError);
		return error as KnowledgeClientError;
	}
	throw new Error("expected a KnowledgeClientError");
};

describe("graph()", () => {
	test("posts the request and returns the validated answer", async () => {
		for (const answer of [okAnswer, empty]) {
			const { calls, fetch } = recorder(json(answer));
			const result = await client(fetch).graph(request);
			expect(result).toEqual(answer as never);
			expect(calls[0]?.url).toBe(`${BASE}${apiPaths.graph}`);
			expect(calls[0]?.init.method).toBe("POST");
			expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
				...request,
				minDocuments: 1,
				minEdgeDocuments: 1,
			});
		}
		// An empty request is valid: the host applies the defaults.
		const { calls, fetch } = recorder(json(empty));
		await client(fetch).graph({});
		expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
			maxNodes: 200,
			maxEdges: 500,
		});
	});

	test("an invalid request is refused before any call", async () => {
		const { calls, fetch } = recorder(json(empty));
		const c = client(fetch);
		for (const bad of [
			{ maxNodes: 0 },
			{ maxNodes: 1001 },
			{ maxEdges: -1 },
			{ maxEdges: 1.5 },
			{ namespaces: [""] },
			{ principal: "root" },
		]) {
			const error = await failure(c.graph(bad as never));
			expect(error.code).toBe("knowledge_invalid_input");
		}
		expect(calls).toHaveLength(0);
	});

	test("an answer that fails the schema is a contract mismatch", async () => {
		for (const body of [
			{ ...empty, status: "stale" },
			{ ...empty, extra: 1 },
			{ ...empty, partialReasons: ["nope"] },
			{ ...okAnswer, nodes: [{ ...okAnswer.nodes[0], mentionCount: 0 }] },
			{ status: "ok" },
			null,
		]) {
			const { fetch } = recorder(json(body));
			const error = await failure(client(fetch).graph(request));
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
		["timeout", new DOMException("t", "TimeoutError"), "knowledge_timeout"],
	];
	for (const [label, answer, code] of cases) {
		test(`${label} -> ${code}`, async () => {
			const { fetch } = recorder(answer);
			const error = await failure(client(fetch).graph(request));
			expect(error.code).toBe(code);
		});
	}
});
