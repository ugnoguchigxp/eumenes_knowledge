import { afterEach, describe, expect, test } from "bun:test";
import {
	apiPaths,
	CONTRACT_VERSION,
	KnowledgeError,
	type EvidenceRequest,
	type EvidenceResponse,
	type ReadEvidence,
	type Search,
	type SearchDeps,
	type SearchResponse,
	type VectorIndex,
} from "../../src/contracts/index.js";
import { MAX_BODY_BYTES } from "./app.js";
import { createExampleHost } from "./index.js";
import {
	ALICE,
	cleanupHosts,
	deferred,
	makeHost,
	TOKENS,
	type TestHost,
} from "./test-support.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

const DOC = `wiki-${"a".repeat(32)}`;
const SHA = "b".repeat(64);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const EVIDENCE_REQUEST: EvidenceRequest = {
	documentId: DOC,
	markdownSha256: SHA,
	byteStart: 0,
	byteEnd: 5,
	quoteSha256: SHA,
};

const SEARCH_RESPONSE: SearchResponse = {
	contractVersion: CONTRACT_VERSION,
	results: [],
	lexicalMode: "trigram",
	routes: [{ route: "text", status: "ok", reason: null, candidates: 0 }],
	coverage: {
		documents: 0,
		searchable: 0,
		stale: 0,
		unavailable: 0,
		failed: 0,
		extractionIncomplete: 0,
	},
	complete: true,
	partialReasons: [],
};

type SearchCall = {
	deps: SearchDeps;
	access: unknown;
	request: unknown;
	signal: AbortSignal;
};
const VECTORS: VectorIndex = { kind: "knowledge.vector-index" };

function wiring(
	answer: (call: SearchCall) => Promise<SearchResponse> = async () =>
		SEARCH_RESPONSE,
	evidenceAnswer: (request: EvidenceRequest) => EvidenceResponse = () => ({
		status: "mismatch",
	}),
) {
	const searchCalls: SearchCall[] = [];
	const evidenceCalls: { access: unknown; request: EvidenceRequest }[] = [];
	let created = 0;
	const search: Search = (deps, access, request, signal) => {
		const call = { deps, access, request, signal };
		searchCalls.push(call);
		return answer(call);
	};
	const readEvidence: ReadEvidence = (_deps, access, request) => {
		evidenceCalls.push({ access, request });
		return evidenceAnswer(request);
	};
	return {
		searchCalls,
		evidenceCalls,
		created: () => created,
		overrides: {
			search,
			readEvidence,
			createVectorIndex: () => {
				created += 1;
				return VECTORS;
			},
			searchOptions: { verifiedWithinMs: 12_345 },
		},
	};
}

async function ready(w = wiring()): Promise<TestHost> {
	const t = makeHost(w.overrides);
	await t.host.ready;
	return t;
}

const postTo = (
	t: TestHost,
	path: string,
	token: string | null,
	body: string,
	extra: RequestInit = {},
) =>
	t.host.app.request(path, {
		method: "POST",
		headers: {
			...(token === null ? {} : auth(token)),
			"content-type": "application/json",
		},
		body,
		...extra,
	});

describe("POST /search", () => {
	test("calls search with the host's deps and the bearer's access, and returns the validated answer", async () => {
		const w = wiring();
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			JSON.stringify({ query: "hello", limit: 5 }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(SEARCH_RESPONSE);
		expect(w.searchCalls).toHaveLength(1);
		const call = w.searchCalls[0] as SearchCall;
		expect(call.access).toEqual(ALICE);
		expect(call.request).toEqual({ query: "hello", limit: 5 });
		expect(call.signal.aborted).toBe(false);
		expect(call.deps.vectors).toBe(VECTORS);
		expect(call.deps.options).toEqual({ verifiedWithinMs: 12_345 });
		expect(call.deps.clock).toBe(t.host.clock);
		expect(w.created()).toBe(1);
		// 検索のたびに VectorIndex を作り直さない。
		await postTo(t, apiPaths.search, "token-alice", '{"query":"again"}');
		expect(w.created()).toBe(1);
		expect(w.searchCalls[1]?.deps.vectors).toBe(VECTORS);
	});

	test("read runs on a committed snapshot of the host database", async () => {
		const seen: unknown[] = [];
		const w = wiring(async ({ deps }) => {
			seen.push(
				deps.read((db) => db.query<{ n: number }>("SELECT 1 AS n").get()),
			);
			return SEARCH_RESPONSE;
		});
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			'{"query":"x"}',
		);
		expect(res.status).toBe(200);
		expect(seen).toEqual([{ n: 1 }]);
	});

	test("principal and namespaces in the body never replace the host's access", async () => {
		const w = wiring();
		const t = await ready(w);
		const body = {
			query: "x",
			namespaces: ["other", "secret"],
			principal: "bob",
			access: { principal: "bob", namespaces: ["other"] },
		};
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			JSON.stringify(body),
		);
		expect(res.status).toBe(200);
		expect(w.searchCalls[0]?.access).toEqual(ALICE);
		const bob = await postTo(t, apiPaths.search, "token-bob", '{"query":"x"}');
		expect(bob.status).toBe(200);
		expect(w.searchCalls[1]?.access).toEqual(TOKENS["token-bob"]);
	});

	test("400 invalid_input for broken JSON, a non-object body, or a package schema error", async () => {
		const w = wiring(async ({ request }) => {
			if ((request as { query?: unknown }).query === "")
				throw new KnowledgeError("invalid_input");
			return SEARCH_RESPONSE;
		});
		const t = await ready(w);
		for (const body of ["{", "", "null", "[]", '"x"', '{"query":""}']) {
			const res = await postTo(t, apiPaths.search, "token-alice", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_input" });
		}
		// 壊れた JSON・非 object は search まで届かない。
		expect(w.searchCalls).toHaveLength(1);
	});

	test("413 payload_too_large above 64 KiB, and search is not called", async () => {
		const w = wiring();
		const t = await ready(w);
		const big = JSON.stringify({ query: "x".repeat(MAX_BODY_BYTES) });
		const res = await postTo(t, apiPaths.search, "token-alice", big);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "payload_too_large" });
		expect(w.searchCalls).toHaveLength(0);
	});

	test("401 without a valid token", async () => {
		const w = wiring();
		const t = await ready(w);
		for (const token of [null, "unknown"]) {
			const res = await postTo(t, apiPaths.search, token, '{"query":"x"}');
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "unauthorized" });
		}
		expect(w.searchCalls).toHaveLength(0);
	});

	test("503 server_starting until the host is ready", async () => {
		const w = wiring();
		const t = makeHost(w.overrides);
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			'{"query":"x"}',
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "server_starting" });
		expect(w.searchCalls).toHaveLength(0);
		await t.host.ready;
	});

	test("an answer that breaks the schema is a 500 internal_error that shows nothing of it", async () => {
		const w = wiring(
			async () =>
				({
					...SEARCH_RESPONSE,
					secret: "SECRET-BODY",
				}) as unknown as SearchResponse,
		);
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			'{"query":"x"}',
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ error: "internal_error" });
		expect(text).not.toContain("SECRET-BODY");
	});

	test("any other failure of search is a 500 internal_error without its message", async () => {
		const w = wiring(async () => {
			throw new Error("secret detail /tmp/x");
		});
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			'{"query":"x"}',
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ error: "internal_error" });
		expect(text).not.toContain("secret");
	});

	test("a disconnect of the client reaches search as an abort", async () => {
		const started = deferred<AbortSignal>();
		const w = wiring(
			({ signal }) =>
				new Promise<SearchResponse>((_, reject) => {
					started.resolve(signal);
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		);
		const t = await ready(w);
		const controller = new AbortController();
		const pending = Promise.resolve(
			postTo(t, apiPaths.search, "token-alice", '{"query":"x"}', {
				signal: controller.signal,
			}),
		).catch((error: unknown) => error);
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		controller.abort();
		await pending;
		expect(signal.aborted).toBe(true);
	});
});

describe("POST /evidence", () => {
	test("calls readEvidence with the bearer's access and returns each status as 200", async () => {
		const answers: EvidenceResponse[] = [
			{ status: "valid", quote: "hello", state: "current" },
			{ status: "stale", currentMarkdownSha256: SHA },
			{ status: "unavailable" },
			{ status: "mismatch" },
			{ status: "not_available" },
		];
		let i = 0;
		const w = wiring(undefined, () => answers[i++] as EvidenceResponse);
		const t = await ready(w);
		for (const answer of answers) {
			const res = await postTo(
				t,
				apiPaths.evidence,
				"token-alice",
				JSON.stringify(EVIDENCE_REQUEST),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual(answer);
		}
		expect(w.evidenceCalls.map((c) => c.access)).toEqual(
			answers.map(() => ALICE),
		);
		expect(w.evidenceCalls[0]?.request).toEqual(EVIDENCE_REQUEST);
	});

	test("body fields other than the request never become the access", async () => {
		const w = wiring();
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.evidence,
			"token-alice",
			JSON.stringify({ ...EVIDENCE_REQUEST, principal: "bob" }),
		);
		// strict な schema は未知の key を 400 にする。access は呼ばれない。
		expect(res.status).toBe(400);
		expect(w.evidenceCalls).toHaveLength(0);
	});

	test("400 for broken JSON and schema violations; readEvidence is not called", async () => {
		const w = wiring();
		const t = await ready(w);
		const bad = [
			"{",
			"null",
			"{}",
			JSON.stringify({ ...EVIDENCE_REQUEST, documentId: "x" }),
			JSON.stringify({ ...EVIDENCE_REQUEST, markdownSha256: "ZZ" }),
			JSON.stringify({ ...EVIDENCE_REQUEST, byteStart: 5, byteEnd: 5 }),
			JSON.stringify({ ...EVIDENCE_REQUEST, byteStart: -1 }),
		];
		for (const body of bad) {
			const res = await postTo(t, apiPaths.evidence, "token-alice", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_input" });
		}
		expect(w.evidenceCalls).toHaveLength(0);
	});

	test("a KnowledgeError invalid_input from readEvidence is a 400", async () => {
		const w = wiring(undefined, () => {
			throw new KnowledgeError("invalid_input");
		});
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.evidence,
			"token-alice",
			JSON.stringify(EVIDENCE_REQUEST),
		);
		expect(res.status).toBe(400);
	});

	test("413, 401 and 503 as for every route", async () => {
		const w = wiring();
		const t = makeHost(w.overrides);
		const body = JSON.stringify(EVIDENCE_REQUEST);
		expect(
			(await postTo(t, apiPaths.evidence, "token-alice", body)).status,
		).toBe(503);
		await t.host.ready;
		expect((await postTo(t, apiPaths.evidence, null, body)).status).toBe(401);
		const big = JSON.stringify({
			...EVIDENCE_REQUEST,
			pad: "x".repeat(MAX_BODY_BYTES),
		});
		const res = await postTo(t, apiPaths.evidence, "token-alice", big);
		expect(res.status).toBe(413);
		expect(w.evidenceCalls).toHaveLength(0);
	});

	test("an answer that breaks the schema is a 500 internal_error", async () => {
		const w = wiring(
			undefined,
			() =>
				({ status: "valid", quote: "SECRET" }) as unknown as EvidenceResponse,
		);
		const t = await ready(w);
		const res = await postTo(
			t,
			apiPaths.evidence,
			"token-alice",
			JSON.stringify(EVIDENCE_REQUEST),
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ error: "internal_error" });
		expect(text).not.toContain("SECRET");
	});
});

describe("assembly", () => {
	test("without search and readEvidence the routes do not exist (404 after auth)", async () => {
		const t = makeHost();
		await t.host.ready;
		const res = await postTo(
			t,
			apiPaths.search,
			"token-alice",
			'{"query":"x"}',
		);
		expect(res.status).toBe(404);
		expect((await postTo(t, apiPaths.search, null, "{}")).status).toBe(401);
	});

	test("search or readEvidence without its wiring is refused at creation, before anything is made", () => {
		const w = wiring();
		const base = { ...w.overrides };
		expect(() => makeHost({ ...base, searchOptions: undefined })).toThrow(
			"search_wiring_required",
		);
		expect(() => makeHost({ ...base, createVectorIndex: undefined })).toThrow(
			"search_wiring_required",
		);
		expect(typeof createExampleHost).toBe("function");
	});

	test("readEvidence alone needs only searchOptions and creates no VectorIndex", async () => {
		const w = wiring();
		const t = makeHost({
			readEvidence: w.overrides.readEvidence,
			searchOptions: w.overrides.searchOptions,
		});
		await t.host.ready;
		const res = await postTo(
			t,
			apiPaths.evidence,
			"token-alice",
			JSON.stringify(EVIDENCE_REQUEST),
		);
		expect(res.status).toBe(200);
		expect(w.created()).toBe(0);
		expect((await postTo(t, apiPaths.search, "token-alice", "{}")).status).toBe(
			404,
		);
	});
});
