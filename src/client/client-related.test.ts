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
const OTHER = `wiki-${"c".repeat(32)}`;
const SHA = "b".repeat(64);
const point = {
	fragmentOrdinal: 0,
	byteStart: 0,
	byteEnd: 5,
	quoteSha256: SHA,
};

const request = { documentId: DOC, limit: 5, namespaces: ["notes"] };
const okAnswer = {
	contractVersion: CONTRACT_VERSION,
	status: "ok",
	document: { documentId: DOC, markdownSha256: SHA },
	results: [
		{
			rank: 1,
			documentId: OTHER,
			namespace: "notes",
			path: "b.md",
			title: "B",
			markdownSha256: SHA,
			state: "current",
			routes: ["entities"],
			links: [],
			passages: [{ document: point, related: point, routes: ["entities"] }],
			shared: [
				{
					label: "Acme",
					relatedLabel: "Acme Inc.",
					evidence: { document: [point], related: [point] },
					decidedBy: {
						model: null,
						instructionId: "link",
						instructionVersion: 1,
					},
					summary: "s",
				},
			],
		},
	],
	complete: true,
	partialReasons: ["linking_pending"],
};
const empty = {
	contractVersion: CONTRACT_VERSION,
	document: null,
	results: [],
	complete: true,
	partialReasons: [],
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

describe("related()", () => {
	test("posts the request and returns each status as an answer", async () => {
		const answers = [
			okAnswer,
			{ ...empty, status: "not_available" },
			{ ...empty, status: "stale" },
		];
		for (const answer of answers) {
			const { calls, fetch } = recorder(json(answer));
			const result = await client(fetch).related(request);
			expect(result).toEqual(answer as never);
			expect(calls[0]?.url).toBe(`${BASE}${apiPaths.related}`);
			expect(calls[0]?.init.method).toBe("POST");
			expect(JSON.parse(calls[0]?.init.body as string)).toEqual(request);
		}
	});

	test("an invalid request is refused before any call", async () => {
		const { calls, fetch } = recorder(json({ ...empty, status: "stale" }));
		const c = client(fetch);
		for (const bad of [
			{ ...request, documentId: "x" },
			{ ...request, limit: 0 },
			{ ...request, limit: 1.5 },
			{ ...request, namespaces: [""] },
			{ ...request, principal: "root" },
			{},
		]) {
			const error = await failure(c.related(bad as never));
			expect(error.code).toBe("knowledge_invalid_input");
		}
		expect(calls).toHaveLength(0);
	});

	test("an answer that fails the schema is a contract mismatch", async () => {
		for (const body of [
			{ ...empty, status: "unknown" },
			{ ...empty, status: "ok", extra: 1 },
			{ ...empty, status: "ok", partialReasons: ["nope"] },
			{ ...okAnswer, results: [{ ...okAnswer.results[0], rank: 0 }] },
			{ status: "ok" },
			null,
		]) {
			const { fetch } = recorder(json(body));
			const error = await failure(client(fetch).related(request));
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
			const error = await failure(client(fetch).related(request));
			expect(error.code).toBe(code);
		});
	}
});
