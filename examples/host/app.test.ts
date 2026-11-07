import { afterEach, describe, expect, test } from "bun:test";
import {
	API_ERROR_STATUS,
	apiPaths,
	knowledgeStatusSchema,
	syncRequestSchema,
} from "../../src/contracts/index.js";
import { createExampleApp, MAX_BODY_BYTES } from "./app.js";
import {
	ALICE,
	cleanupHosts,
	count,
	makeHost,
	readFakeStatus,
	START_MS,
	TOKENS,
	type TestHost,
} from "./test-support.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (t: TestHost, token: string | null, body: string) =>
	t.host.app.request(apiPaths.syncRequests, {
		method: "POST",
		headers: {
			...(token === null ? {} : auth(token)),
			"content-type": "application/json",
		},
		body,
	});

async function ready(overrides = {}) {
	const t = makeHost(overrides);
	await t.host.ready;
	return t;
}

describe("認証と起動", () => {
	test("Authorization が無い・不明・形が違うと 401 unauthorized。token は応答に出ない", async () => {
		const t = await ready();
		for (const headers of [
			{},
			auth("unknown-token"),
			{ authorization: "Basic token-alice" },
			{ authorization: "Bearer" },
			{ authorization: "token-alice" },
		]) {
			const res = await t.host.app.request(apiPaths.status, { headers });
			expect(res.status).toBe(401);
			const text = await res.text();
			expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
			expect(text).not.toContain("token");
		}
		const post401 = await post(t, null, "{}");
		expect(post401.status).toBe(401);
	});

	test("認証の無い巨大な本文も 401（本文は読まない）", async () => {
		const t = await ready();
		const res = await post(t, null, "x".repeat(MAX_BODY_BYTES + 1));
		expect(res.status).toBe(401);
	});

	test("isStarting の間はすべての knowledge 経路が 503 server_starting（認証より先）", async () => {
		let starting = true;
		const app = createExampleApp({
			principals: TOKENS,
			isStarting: () => starting,
			readStatus: (access) =>
				readFakeStatus(undefined as never, access, 0, { verifiedWithinMs: 1 }),
			requestSync: () => Promise.reject(new Error("must not be called")),
			getSyncRequest: () => null,
		});
		const id = crypto.randomUUID();
		for (const [method, path] of [
			["GET", apiPaths.status],
			["POST", apiPaths.syncRequests],
			["GET", apiPaths.syncRequest(id)],
		] as const) {
			for (const headers of [{}, auth("token-alice")]) {
				const res = await app.request(path, { method, headers });
				expect(res.status).toBe(API_ERROR_STATUS.server_starting);
				expect(await res.json()).toEqual({ error: "server_starting" });
			}
		}
		starting = false;
		expect(
			(
				await app.request(apiPaths.syncRequest(id), {
					headers: auth("token-alice"),
				})
			).status,
		).toBe(404);
	});

	test("起動時の回復が終わるまで host の API は 503、終わると通る", async () => {
		const t = makeHost();
		const early = await t.host.app.request(apiPaths.status, {
			headers: auth("token-alice"),
		});
		expect(early.status).toBe(503);
		await t.host.ready;
		const late = await t.host.app.request(apiPaths.status, {
			headers: auth("token-alice"),
		});
		expect(late.status).toBe(200);
	});

	test("不正な principal の設定は組み立て時に拒否する", () => {
		expect(() =>
			createExampleApp({
				principals: { t: { principal: "", namespaces: [] } },
				isStarting: () => false,
				readStatus: () => {
					throw new Error("unused");
				},
				requestSync: () => Promise.reject(new Error("unused")),
				getSyncRequest: () => null,
			}),
		).toThrow();
	});
});

describe("GET status", () => {
	test("権限ごとの status を schema を満たして返す", async () => {
		const t = await ready();
		const a = await t.host.app.request(apiPaths.status, {
			headers: auth("token-alice"),
		});
		expect(a.status).toBe(200);
		const aliceStatus = knowledgeStatusSchema.parse(await a.json());
		const b = await t.host.app.request(apiPaths.status, {
			headers: auth("token-bob"),
		});
		const bobStatus = knowledgeStatusSchema.parse(await b.json());
		expect(aliceStatus.documents.total).toBe(ALICE.namespaces.length);
		expect(bobStatus.documents.total).toBe(1);
	});

	test("readStatus が schema を満たさない値を返したら 500 internal_error（内容は出さない）", async () => {
		const app = createExampleApp({
			principals: TOKENS,
			isStarting: () => false,
			readStatus: () => ({ secret: "do-not-leak" }) as never,
			requestSync: () => Promise.reject(new Error("unused")),
			getSyncRequest: () => null,
		});
		const res = await app.request(apiPaths.status, {
			headers: auth("token-alice"),
		});
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ error: "internal_error" });
		expect(text).not.toContain("do-not-leak");
	});
});

describe("POST sync-requests", () => {
	test("202 で syncRequest の形を返し、最初の sync-page ジョブが 1 件入る", async () => {
		const t = await ready();
		const requestId = crypto.randomUUID();
		const res = await post(t, "token-alice", JSON.stringify({ requestId }));
		expect(res.status).toBe(202);
		const body = syncRequestSchema.parse(await res.json());
		expect(body).toEqual({
			requestId,
			state: "accepted",
			acceptedAt: new Date(START_MS).toISOString(),
			finishedAt: null,
			complete: false,
			errorCode: null,
		});
		expect(count(t.host, "host_jobs")).toBe(1);
		const job = t.host.runner.listJobs()[0];
		expect(job).toMatchObject({ kind: "knowledge.sync-page", state: "queued" });
		expect(job?.payload).toMatchObject({ cursor: null, page: 0 });
	});

	test("同じ requestId の再送は同じ記録を返し、ジョブも増えない", async () => {
		const t = await ready();
		const requestId = crypto.randomUUID();
		const first = await post(t, "token-alice", JSON.stringify({ requestId }));
		t.clock.advance(5_000);
		const second = await post(t, "token-alice", JSON.stringify({ requestId }));
		expect(second.status).toBe(202);
		expect(await second.json()).toEqual(await first.json());
		expect(count(t.host, "host_jobs")).toBe(1);
		expect(count(t.host, "host_sync_requests")).toBe(1);
	});

	test("別 principal の同じ requestId は別の要求になり、409 にならず、互いに見えない", async () => {
		const t = await ready();
		const requestId = crypto.randomUUID();
		const alice = await post(t, "token-alice", JSON.stringify({ requestId }));
		t.clock.advance(3_000);
		const bob = await post(t, "token-bob", JSON.stringify({ requestId }));
		expect(alice.status).toBe(202);
		expect(bob.status).toBe(202);
		expect(syncRequestSchema.parse(await bob.json()).acceptedAt).toBe(
			new Date(START_MS + 3_000).toISOString(),
		);
		expect(count(t.host, "host_sync_requests")).toBe(2);
		// 走査は未完了の最初の走査に相乗りするので、ジョブは 1 件のまま。
		expect(count(t.host, "host_jobs")).toBe(1);
		for (const token of ["token-alice", "token-bob"]) {
			const got = await t.host.app.request(apiPaths.syncRequest(requestId), {
				headers: auth(token),
			});
			expect(got.status).toBe(200);
		}
		// 同じ principal の再送は従来どおり同じ記録。
		const again = await post(t, "token-bob", JSON.stringify({ requestId }));
		expect(await again.json()).toEqual(
			syncRequestSchema.parse(
				await (
					await t.host.app.request(apiPaths.syncRequest(requestId), {
						headers: auth("token-bob"),
					})
				).json(),
			),
		);
		expect(count(t.host, "host_sync_requests")).toBe(2);
	});

	test("壊れた JSON・schema 違反・principal を持ち込む本文は 400 invalid_input", async () => {
		const t = await ready();
		const cases = [
			"",
			"{not json",
			"null",
			"[]",
			"{}",
			JSON.stringify({ requestId: "not-a-uuid" }),
			JSON.stringify({ requestId: crypto.randomUUID(), principal: "bob" }),
			JSON.stringify({ requestId: crypto.randomUUID(), namespaces: ["x"] }),
		];
		for (const body of cases) {
			const res = await post(t, "token-alice", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_input" });
		}
		expect(count(t.host, "host_jobs")).toBe(0);
	});

	test("本文 64 KiB 超は 413 payload_too_large（content-length が無くても）", async () => {
		const t = await ready();
		const big = JSON.stringify({
			requestId: crypto.randomUUID(),
			pad: "x".repeat(MAX_BODY_BYTES),
		});
		const res = await post(t, "token-alice", big);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "payload_too_large" });
		// ちょうど上限以下は schema で 400
		const edge = await post(t, "token-alice", " ".repeat(MAX_BODY_BYTES));
		expect(edge.status).toBe(400);
		// ストリームで送る（content-length 無し）
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const chunk = new TextEncoder().encode("x".repeat(MAX_BODY_BYTES));
				controller.enqueue(chunk);
				controller.enqueue(chunk);
				controller.close();
			},
		});
		const streamed = await t.host.app.request(apiPaths.syncRequests, {
			method: "POST",
			headers: auth("token-alice"),
			body: stream,
			duplex: "half",
		} as RequestInit);
		expect(streamed.status).toBe(413);
		expect(count(t.host, "host_jobs")).toBe(0);
	});

	test("下流が例外なら 500 internal_error で内容を出さない", async () => {
		const app = createExampleApp({
			principals: TOKENS,
			isStarting: () => false,
			readStatus: () => {
				throw new Error("unused");
			},
			requestSync: () => Promise.reject(new Error("db path /secret/place")),
			getSyncRequest: () => null,
		});
		const res = await app.request(apiPaths.syncRequests, {
			method: "POST",
			headers: auth("token-alice"),
			body: JSON.stringify({ requestId: crypto.randomUUID() }),
		});
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ error: "internal_error" });
		expect(text).not.toContain("secret");
	});

	test("ジョブ queue・writer の上限は 503 knowledge_unavailable（同じ requestId で再送できる）", async () => {
		for (const code of ["queue_full", "database_writer_queue_full"]) {
			const app = createExampleApp({
				principals: TOKENS,
				isStarting: () => false,
				readStatus: () => {
					throw new Error("unused");
				},
				requestSync: () => Promise.reject(new Error(code)),
				getSyncRequest: () => null,
			});
			const res = await app.request(apiPaths.syncRequests, {
				method: "POST",
				headers: auth("token-alice"),
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			});
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ error: "knowledge_unavailable" });
		}
	});
});

describe("GET sync-requests/:requestId", () => {
	test("本人の記録は 200 で schema を満たす", async () => {
		const t = await ready();
		const requestId = crypto.randomUUID();
		await post(t, "token-alice", JSON.stringify({ requestId }));
		const res = await t.host.app.request(apiPaths.syncRequest(requestId), {
			headers: auth("token-alice"),
		});
		expect(res.status).toBe(200);
		expect(syncRequestSchema.parse(await res.json()).requestId).toBe(requestId);
	});

	test("別 principal・未知の id は 404 not_available（存在を区別させない）", async () => {
		const t = await ready();
		const requestId = crypto.randomUUID();
		await post(t, "token-alice", JSON.stringify({ requestId }));
		const other = await t.host.app.request(apiPaths.syncRequest(requestId), {
			headers: auth("token-bob"),
		});
		const unknown = await t.host.app.request(
			apiPaths.syncRequest(crypto.randomUUID()),
			{ headers: auth("token-alice") },
		);
		expect(other.status).toBe(404);
		expect(unknown.status).toBe(404);
		expect(await other.json()).toEqual({ error: "not_available" });
		expect(await unknown.json()).toEqual({ error: "not_available" });
	});

	test("uuid でない id は 400 invalid_input。知らない経路は 404 not_available", async () => {
		const t = await ready();
		const bad = await t.host.app.request(apiPaths.syncRequest("nope"), {
			headers: auth("token-alice"),
		});
		expect(bad.status).toBe(400);
		const none = await t.host.app.request("/api/knowledge/other", {
			headers: auth("token-alice"),
		});
		expect(none.status).toBe(404);
		expect(await none.json()).toEqual({ error: "not_available" });
	});
});
