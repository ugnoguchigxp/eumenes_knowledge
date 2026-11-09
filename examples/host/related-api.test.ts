import { afterEach, describe, expect, test } from "bun:test";
import {
	apiPaths,
	CONTRACT_VERSION,
	KnowledgeError,
	type ReadRelated,
	type RelatedRequest,
	type RelatedResponse,
	type SearchDeps,
} from "../../src/contracts/index.js";
import { MAX_BODY_BYTES } from "./app.js";
import {
	ALICE,
	cleanupHosts,
	makeHost,
	type TestHost,
} from "./test-support.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

const DOC = `wiki-${"a".repeat(32)}`;
const OTHER = `wiki-${"c".repeat(32)}`;
const SHA = "b".repeat(64);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const REQUEST = { documentId: DOC, limit: 5, namespaces: ["notes"] };
const point = {
	fragmentOrdinal: 0,
	byteStart: 0,
	byteEnd: 5,
	quoteSha256: SHA,
};

const OK: RelatedResponse = {
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
			passages: [{ document: point, related: point, routes: ["entities"] }],
			shared: [
				{
					label: "Acme",
					relatedLabel: "Acme Inc.",
					evidence: { document: [point], related: [point] },
					decidedBy: {
						model: "m",
						instructionId: "link",
						instructionVersion: 1,
					},
					summary: null,
				},
			],
		},
	],
	complete: true,
	partialReasons: [],
};
const NOT_AVAILABLE: RelatedResponse = {
	contractVersion: CONTRACT_VERSION,
	status: "not_available",
	document: null,
	results: [],
	complete: true,
	partialReasons: [],
};
const STALE: RelatedResponse = { ...NOT_AVAILABLE, status: "stale" };

type Call = { deps: unknown; access: unknown; request: RelatedRequest };

function wiring(
	answer: (request: RelatedRequest) => RelatedResponse = () => OK,
) {
	const calls: Call[] = [];
	const readRelated: ReadRelated = (deps, access, request) => {
		calls.push({ deps, access, request });
		return answer(request);
	};
	return {
		calls,
		overrides: { readRelated, searchOptions: { verifiedWithinMs: 12_345 } },
	};
}

async function ready(w = wiring()): Promise<TestHost> {
	const t = makeHost(w.overrides);
	await t.host.ready;
	return t;
}

const postTo = (t: TestHost, token: string | null, body: string) =>
	t.host.app.request(apiPaths.related, {
		method: "POST",
		headers: {
			...(token === null ? {} : auth(token)),
			"content-type": "application/json",
		},
		body,
	});

describe("POST /related", () => {
	test("calls readRelated with the host's deps and the bearer's access; each status is a 200", async () => {
		const answers = [OK, NOT_AVAILABLE, STALE];
		let i = 0;
		const w = wiring(() => answers[i++] as RelatedResponse);
		const t = await ready(w);
		for (const answer of answers) {
			const res = await postTo(t, "token-alice", JSON.stringify(REQUEST));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual(answer);
		}
		expect(w.calls.map((c) => c.access)).toEqual(answers.map(() => ALICE));
		expect(w.calls[0]?.request).toEqual(REQUEST);
		const deps = w.calls[0]?.deps as Pick<
			SearchDeps,
			"read" | "clock" | "options"
		>;
		expect(deps.clock).toBe(t.host.clock);
		expect(deps.options).toEqual({ verifiedWithinMs: 12_345 });
		expect(typeof deps.read).toBe("function");
	});

	test("the default limit is filled in by the schema", async () => {
		const w = wiring();
		const t = await ready(w);
		const res = await postTo(
			t,
			"token-alice",
			JSON.stringify({ documentId: DOC }),
		);
		expect(res.status).toBe(200);
		expect(w.calls[0]?.request.documentId).toBe(DOC);
		expect(typeof w.calls[0]?.request.limit).toBe("number");
	});

	test("body fields other than the request never become the access", async () => {
		const w = wiring();
		const t = await ready(w);
		const res = await postTo(
			t,
			"token-alice",
			JSON.stringify({ ...REQUEST, principal: "bob" }),
		);
		expect(res.status).toBe(400);
		expect(w.calls).toHaveLength(0);
	});

	test("400 for broken JSON and schema violations; readRelated is not called", async () => {
		const w = wiring();
		const t = await ready(w);
		const bad = [
			"{",
			"null",
			"{}",
			JSON.stringify({ ...REQUEST, documentId: "x" }),
			JSON.stringify({ ...REQUEST, limit: 0 }),
			JSON.stringify({ ...REQUEST, limit: 1.5 }),
			JSON.stringify({ ...REQUEST, namespaces: [""] }),
		];
		for (const body of bad) {
			const res = await postTo(t, "token-alice", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_input" });
		}
		expect(w.calls).toHaveLength(0);
	});

	test("a KnowledgeError invalid_input from readRelated is a 400", async () => {
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
			() =>
				({
					...OK,
					status: "ok",
					secret: "SECRET",
				}) as unknown as RelatedResponse,
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
	test("without readRelated the route does not exist (404 after auth)", async () => {
		const t = makeHost();
		await t.host.ready;
		expect(
			(await postTo(t, "token-alice", JSON.stringify(REQUEST))).status,
		).toBe(404);
		expect((await postTo(t, null, "{}")).status).toBe(401);
	});

	test("readRelated without searchOptions is refused at creation", () => {
		const w = wiring();
		expect(() => makeHost({ readRelated: w.overrides.readRelated })).toThrow(
			"search_wiring_required",
		);
	});

	test("readRelated alone needs only searchOptions; the other routes stay absent", async () => {
		const w = wiring();
		const t = await ready(w);
		expect(
			(await postTo(t, "token-alice", JSON.stringify(REQUEST))).status,
		).toBe(200);
		for (const path of [apiPaths.search, apiPaths.evidence]) {
			const res = await t.host.app.request(path, {
				method: "POST",
				headers: auth("token-alice"),
				body: "{}",
			});
			expect(res.status).toBe(404);
		}
	});
});
