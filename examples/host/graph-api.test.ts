import { afterEach, describe, expect, test } from "bun:test";
import {
	apiPaths,
	CONTRACT_VERSION,
	GRAPH_LIMITS,
	KnowledgeError,
	type GraphRequest,
	type GraphResponse,
	type ReadGraph,
	type SearchDeps,
} from "../../src/contracts/index.js";
import { MAX_BODY_BYTES } from "./app.js";
import {
	ALICE,
	BOB,
	cleanupHosts,
	makeHost,
	type TestHost,
} from "./test-support.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

const DOC = `wiki-${"a".repeat(32)}`;
const SHA = "b".repeat(64);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const REQUEST = { maxNodes: 10, maxEdges: 20, namespaces: ["notes"] };
const point = {
	documentId: DOC,
	markdownSha256: SHA,
	fragmentOrdinal: 0,
	byteStart: 0,
	byteEnd: 5,
	quoteSha256: SHA,
};

const OK: GraphResponse = {
	contractVersion: CONTRACT_VERSION,
	status: "ok",
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
		{
			nodeId: "n2",
			label: "Beta",
			names: ["Beta"],
			types: ["company"],
			mentionCount: 1,
			documentCount: 1,
			documentIds: [DOC],
			evidence: [point],
			decidedBy: [],
			summary: null,
		},
	],
	edges: [
		{
			edgeId: "e1",
			source: "n1",
			target: "n2",
			directed: false,
			relation: "partner",
			keywords: [],
			negated: false,
			certainty: "stated",
			conditions: [],
			mentionCount: 1,
			documentCount: 1,
			documentIds: [DOC],
			evidence: [point],
		},
	],
	complete: false,
	partialReasons: ["linking_pending"],
};

type Call = { deps: unknown; access: unknown; request: GraphRequest };

function wiring(answer: (request: GraphRequest) => GraphResponse = () => OK) {
	const calls: Call[] = [];
	const readGraph: ReadGraph = (deps, access, request) => {
		calls.push({ deps, access, request });
		return answer(request);
	};
	return {
		calls,
		overrides: { readGraph, searchOptions: { verifiedWithinMs: 12_345 } },
	};
}

async function ready(w = wiring()): Promise<TestHost> {
	const t = makeHost(w.overrides);
	await t.host.ready;
	return t;
}

const postTo = (t: TestHost, token: string | null, body: string) =>
	t.host.app.request(apiPaths.graph, {
		method: "POST",
		headers: {
			...(token === null ? {} : auth(token)),
			"content-type": "application/json",
		},
		body,
	});

describe("POST /graph", () => {
	test("calls readGraph with the host's deps and the bearer's access", async () => {
		const w = wiring();
		const t = await ready(w);
		const res = await postTo(t, "token-alice", JSON.stringify(REQUEST));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(OK);
		expect(w.calls.map((c) => c.access)).toEqual([ALICE]);
		expect(w.calls[0]?.request).toEqual({
			...REQUEST,
			minDocuments: 1,
			minEdgeDocuments: 1,
		});
		const deps = w.calls[0]?.deps as Pick<
			SearchDeps,
			"read" | "clock" | "options"
		>;
		expect(deps.clock).toBe(t.host.clock);
		expect(deps.options).toEqual({ verifiedWithinMs: 12_345 });
		expect(typeof deps.read).toBe("function");
	});

	test("the defaults are filled in by the schema", async () => {
		const w = wiring();
		const t = await ready(w);
		const res = await postTo(t, "token-alice", "{}");
		expect(res.status).toBe(200);
		expect(w.calls[0]?.request).toEqual({
			maxNodes: GRAPH_LIMITS.defaultNodes,
			maxEdges: GRAPH_LIMITS.defaultEdges,
			minDocuments: 1,
			minEdgeDocuments: 1,
		});
	});

	test("namespaces in the body are passed as a request to narrow; the access stays the bearer's", async () => {
		const w = wiring();
		const t = await ready(w);
		// Bob asks for Alice's namespaces: the access handed over is still Bob's.
		const res = await postTo(
			t,
			"token-bob",
			JSON.stringify({ namespaces: [...ALICE.namespaces, ...BOB.namespaces] }),
		);
		expect(res.status).toBe(200);
		expect(w.calls[0]?.access).toEqual(BOB);
		expect(w.calls[0]?.request.namespaces).toEqual([
			...ALICE.namespaces,
			...BOB.namespaces,
		]);
	});

	test("body fields other than the request never become the access", async () => {
		const w = wiring();
		const t = await ready(w);
		for (const extra of [{ principal: "bob" }, { access: BOB }]) {
			const res = await postTo(
				t,
				"token-alice",
				JSON.stringify({ ...REQUEST, ...extra }),
			);
			expect(res.status).toBe(400);
		}
		expect(w.calls).toHaveLength(0);
	});

	test("400 for broken JSON and schema violations; readGraph is not called", async () => {
		const w = wiring();
		const t = await ready(w);
		const bad = [
			"{",
			"null",
			"[]",
			JSON.stringify({ ...REQUEST, maxNodes: 0 }),
			JSON.stringify({ ...REQUEST, maxNodes: GRAPH_LIMITS.maxNodes + 1 }),
			JSON.stringify({ ...REQUEST, maxEdges: -1 }),
			JSON.stringify({ ...REQUEST, maxEdges: GRAPH_LIMITS.maxEdges + 1 }),
			JSON.stringify({ ...REQUEST, maxNodes: 1.5 }),
			JSON.stringify({ ...REQUEST, namespaces: [""] }),
		];
		for (const body of bad) {
			const res = await postTo(t, "token-alice", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_input" });
		}
		expect(w.calls).toHaveLength(0);
	});

	test("a KnowledgeError invalid_input from readGraph is a 400", async () => {
		const w = wiring(() => {
			throw new KnowledgeError("invalid_input");
		});
		const t = await ready(w);
		const res = await postTo(t, "token-alice", JSON.stringify(REQUEST));
		expect(res.status).toBe(400);
	});

	test("413, 401 and 503 as for every route", async () => {
		const w = wiring();
		const t = makeHost(w.overrides);
		const body = JSON.stringify(REQUEST);
		expect((await postTo(t, "token-alice", body)).status).toBe(503);
		await t.host.ready;
		expect((await postTo(t, null, body)).status).toBe(401);
		expect((await postTo(t, "unknown-token", body)).status).toBe(401);
		const big = JSON.stringify({ ...REQUEST, pad: "x".repeat(MAX_BODY_BYTES) });
		expect((await postTo(t, "token-alice", big)).status).toBe(413);
		expect(w.calls).toHaveLength(0);
	});

	test("an answer that breaks the schema is a 500 internal_error", async () => {
		const w = wiring(
			() => ({ ...OK, secret: "SECRET" }) as unknown as GraphResponse,
		);
		const t = await ready(w);
		const res = await postTo(t, "token-alice", JSON.stringify(REQUEST));
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ error: "internal_error" });
		expect(text).not.toContain("SECRET");
	});
});

describe("assembly", () => {
	test("without readGraph the route does not exist (404 after auth)", async () => {
		const t = makeHost();
		await t.host.ready;
		expect(
			(await postTo(t, "token-alice", JSON.stringify(REQUEST))).status,
		).toBe(404);
		expect((await postTo(t, null, "{}")).status).toBe(401);
	});

	test("readGraph without searchOptions is refused at creation", () => {
		const w = wiring();
		expect(() => makeHost({ readGraph: w.overrides.readGraph })).toThrow(
			"search_wiring_required",
		);
	});

	test("readGraph alone needs only searchOptions; the other routes stay absent", async () => {
		const w = wiring();
		const t = await ready(w);
		expect(
			(await postTo(t, "token-alice", JSON.stringify(REQUEST))).status,
		).toBe(200);
		for (const path of [apiPaths.search, apiPaths.evidence, apiPaths.related]) {
			const res = await t.host.app.request(path, {
				method: "POST",
				headers: auth("token-alice"),
				body: "{}",
			});
			expect(res.status).toBe(404);
		}
	});
});
