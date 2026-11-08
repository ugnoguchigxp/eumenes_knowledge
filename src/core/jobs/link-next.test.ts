import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rows, runJob } from "../harness.fixture.js";
import { countUncomparedVersionsInSnapshot } from "../../sqlite/links.js";
import {
	drainAll,
	inputOf,
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
	type LinkInput,
} from "../link/link.fixture.js";

const links = (env: LinkEnv) =>
	rows(
		env.db,
		"SELECT entity_a, entity_b, decision, model, instruction_id, instruction_version FROM knowledge_entity_links ORDER BY entity_a, entity_b",
	);
const chain = (env: LinkEnv) =>
	rows(env.db, "SELECT * FROM knowledge_link_chain")[0] as Record<
		string,
		unknown
	>;
const marks = (env: LinkEnv) =>
	rows(
		env.db,
		"SELECT version_id, state, cursor_entity_id, failed_mentions, not_before, transient_failures FROM knowledge_link_versions ORDER BY version_id",
	);
const linkJobs = (env: LinkEnv) =>
	env.sink.open.filter((j) => j.kind === "knowledge.link-next");

/** Start a sync scan and run only the jobs of the other kinds (ingest and sync). */
async function ingestOnly(env: LinkEnv): Promise<void> {
	await runJob(env.db, env.sync, {
		scanId: randomUUID(),
		cursor: null,
		page: 0,
	});
	while (env.sink.open.some((j) => j.kind !== "knowledge.link-next")) {
		const index = env.sink.open.findIndex(
			(j) => j.kind !== "knowledge.link-next",
		);
		const [job] = env.sink.open.splice(index, 1);
		if (job?.kind === "knowledge.sync-page") {
			await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
		} else if (job) {
			await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
		}
	}
}

describe("the identity chain", () => {
	test("a published version opens the chain with one link-next job; the chain keeps one open job and closes", async () => {
		const env = makeLinkEnv();
		for (let n = 1; n <= 8; n++)
			putDoc(env, n, `Alpha Corp is in note ${n}. Delta too.`);
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const seenKeys: string[] = [];
		let guard = 0;
		while (env.sink.open.length > 0 && guard++ < 500) {
			const job = env.sink.open.shift()!;
			if (job.kind === "knowledge.link-next") {
				seenKeys.push(job.dedupeKey);
				// While a link runs, no other link job is open.
				expect(linkJobs(env)).toHaveLength(0);
				await runJob(env.db, env.link, env.link.schema.parse(job.payload));
				expect(linkJobs(env).length).toBeLessThanOrEqual(1);
			} else if (job.kind === "knowledge.sync-page") {
				await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
			} else {
				await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
			}
		}
		// Keys are used once, sweeps rise, and the chain ends closed with every version marked.
		expect(new Set(seenKeys).size).toBe(seenKeys.length);
		expect(seenKeys[0]).toBe("knowledge.link-next:1");
		expect(seenKeys.length).toBeGreaterThan(1);
		expect(chain(env).open_sweep).toBeNull();
		expect(marks(env).every((m) => m.state === "done")).toBe(true);
		expect(marks(env)).toHaveLength(8);
		// Every pair across documents was decided once: 8 docs x 2 names; same names are `same`.
		const sameCount = links(env).filter((l) => l.decision === "same").length;
		expect(sameCount).toBe(2 * ((8 * 7) / 2));
		expect(
			links(env).every((l) => (l.entity_a as number) < (l.entity_b as number)),
		).toBe(true);
	});

	test("the ingest chain's settle opens the link chain when it publishes, once while it is live", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(linkJobs(env)).toHaveLength(0);
		// First ingest link: one document published, one link-next job.
		const first = env.sink.open.shift()!;
		await runJob(env.db, env.ingest, env.ingest.schema.parse(first.payload));
		expect(linkJobs(env).map((j) => [j.dedupeKey, j.payload, j.lane])).toEqual([
			["knowledge.link-next:1", { sweep: 1 }, "background"],
		]);
		// Second publication while that link is still open and live: no second job.
		const second = env.sink.open.find(
			(j) => j.kind === "knowledge.ingest-next",
		)!;
		env.sink.open.splice(env.sink.open.indexOf(second), 1);
		await runJob(env.db, env.ingest, env.ingest.schema.parse(second.payload));
		expect(linkJobs(env)).toHaveLength(1);
		expect(chain(env)).toMatchObject({ open_sweep: 1, next_sweep: 2 });
		// The one link finds both versions.
		await drainAll(env);
		expect(marks(env).map((m) => m.state)).toEqual(["done", "done"]);
		expect(links(env)).toHaveLength(1);
	});

	test("a document that fails to publish opens no link chain", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		env.source.readErrors.set(
			`wiki-${(1).toString(16).padStart(32, "0")}`,
			"not_found",
		);
		await scanAndDrain(env);
		expect(env.sink.calls.some((j) => j.kind === "knowledge.link-next")).toBe(
			false,
		);
		expect(chain(env).open_sweep).toBeNull();
	});

	test("the decision keeps its provenance: model, instruction id and version", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		expect(links(env)).toEqual([
			{
				entity_a: 1,
				entity_b: 2,
				decision: "same",
				model: "mock-model",
				instruction_id: "link",
				instruction_version: 2,
			},
		]);
		// The request carried link v2, and the version mark records it.
		const asked = env.inference.calls.filter((c) => c.purpose === "link");
		expect(asked.length).toBeGreaterThan(0);
		for (const call of asked)
			expect([call.instructionId, call.instructionVersion]).toEqual([
				"link",
				2,
			]);
		const marked = rows(
			env.db,
			"SELECT DISTINCT instruction_id, instruction_version FROM knowledge_link_versions",
		);
		expect(marked).toEqual([
			{ instruction_id: "link", instruction_version: 2 },
		]);
	});

	test("different and unsure are recorded too, and a decided pair is never asked again", async () => {
		const env = makeLinkEnv();
		env.decide = (m, c) =>
			m.name === c.name
				? m.description.includes("one")
					? "different"
					: "unsure"
				: "different";
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		// doc 2's mention is asked about doc 1's mention.
		expect(links(env).map((l) => l.decision)).toEqual(["unsure"]);
		const asked = env.calls.link;
		expect(asked).toBe(1);
		// Forget that version 1 and 2 were compared: the pair has a decision, so nothing is asked.
		env.db.run("DELETE FROM knowledge_link_versions");
		env.db.run(
			"UPDATE knowledge_link_chain SET open_sweep = NULL, advanced_at = NULL",
		);
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		await drainAll(env);
		expect(marks(env)).toHaveLength(2);
		expect(env.calls.link).toBe(asked);
		expect(links(env)).toHaveLength(1);
	});

	test("an invalid answer fails that mention only; the others are compared and the job does not fail", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp and Beta Ltd.");
		await ingestOnly(env);
		putDoc(env, 2, "Alpha Corp and Beta Ltd again.");
		env.linkAnswer = (input) =>
			input.mention.name === "Alpha Corp"
				? "this is not json"
				: JSON.stringify({
						decisions: input.candidates.map((c) => ({
							candidate: c.id,
							decision: c.name === input.mention.name ? "same" : "different",
						})),
					});
		await ingestOnly(env);
		const logs: unknown[] = [];
		while (linkJobs(env).length > 0) {
			const job = env.sink.open.splice(
				env.sink.open.indexOf(linkJobs(env)[0]!),
				1,
			)[0]!;
			logs.push(
				await runJob(env.db, env.link, env.link.schema.parse(job.payload)),
			);
		}
		expect(
			logs.every(
				(l) =>
					(l as { outcome?: { type: string } }).outcome?.type === "success",
			),
		).toBe(true);
		expect(marks(env).map((m) => m.state)).toEqual(["done", "done"]);
		// Entities: 1 Alpha(doc 1), 2 Beta(doc 1), 3 Alpha(doc 2), 4 Beta(doc 2). Mentions named
		// Alpha got an unusable answer, so the pair of the two Alphas has no decision, and the
		// failures of both versions are counted.
		expect(marks(env).map((m) => m.failed_mentions)).toEqual([1, 1]);
		expect(links(env).map((l) => [l.entity_a, l.entity_b, l.decision])).toEqual(
			[
				[1, 4, "different"],
				[2, 3, "different"],
				[2, 4, "same"],
			],
		);
	});

	test("an unknown or duplicate candidate fails the mention without storing any decision of the answer", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		await ingestOnly(env);
		putDoc(env, 2, "Alpha Corp two.");
		env.linkAnswer = () =>
			JSON.stringify({
				decisions: [
					{ candidate: "c1", decision: "same" },
					{ candidate: "c9", decision: "same" },
				],
			});
		await scanAndDrain(env);
		expect(links(env)).toHaveLength(0);
		expect(marks(env).find((m) => m.version_id === 2)).toMatchObject({
			state: "done",
			failed_mentions: 1,
		});
		env.linkAnswer = () =>
			JSON.stringify({
				decisions: [
					{ candidate: "c1", decision: "same" },
					{ candidate: "c1", decision: "different" },
				],
			});
		putDoc(env, 3, "Alpha Corp three.");
		await scanAndDrain(env);
		expect(links(env).filter((l) => (l.entity_b as number) === 3)).toHaveLength(
			0,
		);
	});

	describe("temporary failures wait; they are not counted", () => {
		async function setup() {
			const env = makeLinkEnv({ transientRetryDelayMs: 1000 });
			putDoc(env, 1, "Alpha Corp one.");
			putDoc(env, 2, "Alpha Corp two.");
			await ingestOnly(env);
			return env;
		}
		const failLinks = (env: LinkEnv, how: "throw" | "not_ok") => {
			const good = env.inference.script;
			env.inference.script = (request, call, signal) => {
				if (request.purpose !== "link") return good(request, call, signal);
				if (how === "throw") throw new Error("provider down");
				return {
					ok: false,
					error: "unavailable",
					model: null,
					usage: noUsage,
					durationMs: 1,
				};
			};
			return good;
		};

		test("a port that throws: the versions wait, the chain closes, a later scan resumes", async () => {
			const env = await setup();
			const good = failLinks(env, "throw");
			const now = env.clock.t;
			await drainAllWith(env, "once");
			expect(chain(env).open_sweep).toBeNull();
			expect(
				marks(env).map((m) => [
					m.state,
					m.not_before,
					m.transient_failures,
					m.failed_mentions,
				]),
			).toEqual([
				["partial", now + 1000, 1, 0],
				["partial", now + 1000, 1, 0],
			]);
			expect(links(env)).toHaveLength(0);
			// Before the wait ends a scan does not start the chain; afterwards it does.
			env.inference.script = good;
			await scanAndDrain(env);
			expect(chain(env).open_sweep).toBeNull();
			expect(marks(env).every((m) => m.state === "partial")).toBe(true);
			env.clock.t += 1001;
			await scanAndDrain(env);
			expect(marks(env).every((m) => m.state === "done")).toBe(true);
			expect(links(env)).toHaveLength(1);
		});

		test("ok:false from the port is a port failure too, and the wait doubles", async () => {
			const env = await setup();
			failLinks(env, "not_ok");
			await drainAllWith(env, "once");
			expect(marks(env).map((m) => m.transient_failures)).toEqual([1, 1]);
			env.clock.t += 1001;
			await runJob(
				env.db,
				env.sync,
				{ scanId: randomUUID(), cursor: null, page: 0 },
				undefined,
				{ attempts: "once" },
			);
			await drainAllWith(env, "once");
			for (const m of marks(env)) {
				expect(m.transient_failures).toBe(2);
				expect(m.not_before).toBe(env.clock.t + 2000);
			}
		});

		for (const outcome of [
			{ type: "interrupted", errorCode: "restart" },
			{ type: "expired" },
		] as const) {
			test(`a link settled as ${outcome.type} only delays its version`, async () => {
				const env = await setup();
				const job = linkJobs(env)[0]!;
				const payload = env.link.schema.parse(job.payload);
				const claim = claimFor(env, payload);
				const prepared = env.db.transaction(() =>
					env.link.prepareInTransaction(env.db, claim),
				)();
				if (prepared.status !== "ready") throw new Error("prepare");
				env.db.transaction(() =>
					env.link.settleInTransaction(env.db, claim, prepared.input, outcome),
				)();
				expect(marks(env)[0]).toMatchObject({
					state: "partial",
					not_before: env.clock.t + 1000,
					transient_failures: 1,
					failed_mentions: 0,
				});
			});
		}
	});

	test("cancel closes the chain and makes the target wait", async () => {
		const env = makeLinkEnv({ transientRetryDelayMs: 1000 });
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await ingestOnly(env);
		const job = linkJobs(env)[0]!;
		const payload = env.link.schema.parse(job.payload);
		const claim = claimFor(env, payload);
		const prepared = env.db.transaction(() =>
			env.link.prepareInTransaction(env.db, claim),
		)();
		expect(prepared.status).toBe("ready");
		env.db.transaction(() =>
			env.link.cancelInTransaction(
				env.db,
				{ jobId: claim.jobId, payload },
				"operator",
			),
		)();
		expect(chain(env).open_sweep).toBeNull();
		expect(marks(env)).toEqual([
			expect.objectContaining({
				version_id: 1,
				state: "partial",
				not_before: env.clock.t + 1000,
			}),
		]);
		// A late settle of the cancelled link changes nothing and queues nothing.
		const before = env.sink.calls.length;
		if (prepared.status === "ready") {
			env.db.transaction(() =>
				env.link.settleInTransaction(env.db, claim, prepared.input, {
					type: "success",
					result: {
						kind: "compared",
						versionId: 1,
						processed: 0,
						failed: 0,
						finished: true,
					},
				}),
			)();
		}
		expect(env.sink.calls.length).toBe(before);
		expect(marks(env)[0]).toMatchObject({ state: "partial" });
	});

	test("settle re-checks: a version that is no longer the published one is not marked done", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		await ingestOnly(env);
		const job = linkJobs(env)[0]!;
		env.sink.open.splice(env.sink.open.indexOf(job), 1);
		const payload = env.link.schema.parse(job.payload);
		const claim = claimFor(env, payload);
		const prepared = env.db.transaction(() =>
			env.link.prepareInTransaction(env.db, claim),
		)();
		if (prepared.status !== "ready") throw new Error("prepare");
		const result = await env.link.execute(prepared.input, {
			signal: new AbortController().signal,
			jobId: claim.jobId,
			attempt: 1,
		});
		// The document is retired between execute and settle.
		env.db.run("UPDATE knowledge_documents SET state = 'stale'");
		const settled = env.db.transaction(() =>
			env.link.settleInTransaction(env.db, claim, prepared.input, {
				type: "success",
				result,
			}),
		)();
		expect(settled).toBe("stale");
		expect(marks(env).every((m) => m.state !== "done")).toBe(true);
	});

	test("a version with more mentions than maxMentionsPerVersion is compared over several links", async () => {
		const env = makeLinkEnv({ maxMentionsPerVersion: 2 });
		putDoc(env, 1, "Alpha Corp, Beta Ltd, Gamma Inc and Delta.");
		await ingestOnly(env);
		putDoc(env, 2, "Alpha Corp, Beta Ltd, Gamma Inc and Delta again.");
		await ingestOnly(env);
		const outputs: unknown[] = [];
		while (linkJobs(env).length > 0) {
			const job = env.sink.open.splice(
				env.sink.open.indexOf(linkJobs(env)[0]!),
				1,
			)[0]!;
			const log = await runJob(
				env.db,
				env.link,
				env.link.schema.parse(job.payload),
			);
			outputs.push((log.outcome as { result?: unknown } | undefined)?.result);
		}
		const compared = outputs.filter(
			(o) => (o as { kind?: string })?.kind === "compared",
		) as { versionId: number; processed: number; finished: boolean }[];
		const forV2 = compared.filter((o) => o.versionId === 2);
		expect(forV2.map((o) => [o.processed, o.finished])).toEqual([
			[2, false],
			[2, true],
		]);
		// Version 1 (compared when nothing else existed, in two links as well) and 2 are done.
		expect(marks(env).map((m) => m.state)).toEqual(["done", "done"]);
		expect(links(env).filter((l) => l.decision === "same")).toHaveLength(4);
	});

	test("a scan restarts the chain when versions remain uncompared, but not while a live link is open", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		await ingestOnly(env);
		// The link job was lost: drop it. The chain still looks open.
		env.sink.open.length = 0;
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(linkJobs(env)).toHaveLength(0);
		// An hour later the open link counts as lost and the scan restarts the chain.
		env.clock.t += 61 * 60 * 1000;
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(linkJobs(env).map((j) => j.payload)).toEqual([{ sweep: 2 }]);
		await drainAll(env);
		expect(marks(env).map((m) => m.state)).toEqual(["done"]);
		expect(chain(env).open_sweep).toBeNull();
	});
});

/** Run only the open link jobs (and whatever link jobs they open) to the end. */
async function drainLinks(env: LinkEnv): Promise<void> {
	let guard = 0;
	while (linkJobs(env).length > 0 && guard++ < 200) {
		const job = env.sink.open.splice(
			env.sink.open.indexOf(linkJobs(env)[0]!),
			1,
		)[0]!;
		await runJob(env.db, env.link, env.link.schema.parse(job.payload));
	}
}

describe("a document that comes back as current", () => {
	for (const away of ["unavailable", "stale"] as const) {
		test(`after being ${away}, its version is compared again and the pair with the document compared meanwhile is asked`, async () => {
			const env = makeLinkEnv();
			putDoc(env, 1, "Alpha Corp one.");
			await ingestOnly(env);
			await drainLinks(env);
			expect(marks(env).map((m) => m.state)).toEqual(["done"]);
			putDoc(env, 2, "Alpha Corp two.");
			await ingestOnly(env);
			// Document 1 is away while document 2 is compared: it offers no candidate.
			env.db.run(
				"UPDATE knowledge_documents SET state = ? WHERE document_id = ?",
				[away, `wiki-${(1).toString(16).padStart(32, "0")}`],
			);
			await drainLinks(env);
			expect(marks(env).map((m) => m.state)).toEqual(["done", "done"]);
			expect(links(env)).toHaveLength(0);
			expect(env.calls.link).toBe(0);

			// The scan finds document 1 unchanged and current again: its version is open again,
			// and the answer must not claim that everything was compared meanwhile.
			await runJob(env.db, env.sync, {
				scanId: randomUUID(),
				cursor: null,
				page: 0,
			});
			expect(marks(env)[0]).toMatchObject({
				version_id: 1,
				state: "partial",
				cursor_entity_id: 0,
			});
			expect(marks(env)[1]).toMatchObject({ version_id: 2, state: "done" });
			expect(
				countUncomparedVersionsInSnapshot(env.db, ["wiki"]),
			).toBeGreaterThan(0);
			expect(linkJobs(env)).toHaveLength(1);

			await drainAll(env);
			expect(marks(env).every((m) => m.state === "done")).toBe(true);
			expect(countUncomparedVersionsInSnapshot(env.db, ["wiki"])).toBe(0);
			expect(
				links(env).map((l) => [l.entity_a, l.entity_b, l.decision]),
			).toEqual([[1, 2, "same"]]);
			// Only the missing pair was put to the model.
			expect(env.calls.link).toBe(1);
		});
	}

	test("a document that was never away is not compared again by a scan", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		const asked = env.calls.link;
		await scanAndDrain(env);
		expect(marks(env).every((m) => m.state === "done")).toBe(true);
		expect(env.calls.link).toBe(asked);
	});
});

describe("candidates beyond maxCandidatesPerMention", () => {
	test("are taken in the next links: every pair is asked in the end, and the version is not done before", async () => {
		const env = makeLinkEnv({ maxCandidatesPerMention: 2 });
		for (let n = 1; n <= 5; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		await ingestOnly(env);
		// One link: version 1 has 4 candidates, 2 are decided, the mention stays open.
		const job = linkJobs(env)[0]!;
		env.sink.open.splice(env.sink.open.indexOf(job), 1);
		await runJob(env.db, env.link, env.link.schema.parse(job.payload));
		expect(links(env)).toHaveLength(2);
		expect(marks(env)[0]).toMatchObject({
			version_id: 1,
			state: "partial",
			cursor_entity_id: 0,
			failed_mentions: 0,
		});
		expect(countUncomparedVersionsInSnapshot(env.db, ["wiki"])).toBe(5);
		await drainLinks(env);
		expect(marks(env).every((m) => m.state === "done")).toBe(true);
		expect(links(env)).toHaveLength(10);
		expect(links(env).every((l) => l.decision === "same")).toBe(true);
		// Each pair was put to the model exactly once.
		const asked = env.inference.calls
			.filter((c) => c.purpose === "link")
			.reduce((sum, c) => sum + (inputOf(c) as LinkInput).candidates.length, 0);
		expect(asked).toBe(10);
		expect(chain(env).open_sweep).toBeNull();
	});

	test("an unusable answer counts as a failure and passes the mention, so nothing repeats for ever", async () => {
		const env = makeLinkEnv({ maxCandidatesPerMention: 1 });
		env.linkAnswer = () => "not json";
		for (let n = 1; n <= 3; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		await ingestOnly(env);
		await drainLinks(env);
		expect(marks(env).map((m) => [m.state, m.failed_mentions])).toEqual([
			["done", 1],
			["done", 1],
			["done", 1],
		]);
		expect(links(env)).toHaveLength(0);
		expect(chain(env).open_sweep).toBeNull();
	});

	test("the mentions after the open one wait for it, in id order", async () => {
		const env = makeLinkEnv({ maxCandidatesPerMention: 1 });
		putDoc(env, 1, "Alpha Corp and Beta Ltd one.");
		putDoc(env, 2, "Alpha Corp and Beta Ltd two.");
		putDoc(env, 3, "Alpha Corp three.");
		await ingestOnly(env);
		await drainLinks(env);
		expect(marks(env).every((m) => m.state === "done")).toBe(true);
		// Alpha x3 and Beta x2: 3 + 1 pairs, all same.
		expect(links(env).filter((l) => l.decision === "same")).toHaveLength(4);
	});
});

describe("a link cut off after progress", () => {
	async function cutOff(abortAtCall: number) {
		const env = makeLinkEnv({ transientRetryDelayMs: 1000 });
		putDoc(env, 1, "Alpha Corp and Beta Ltd one.");
		putDoc(env, 2, "Alpha Corp and Beta Ltd two.");
		await ingestOnly(env);
		const controller = new AbortController();
		const good = env.inference.script;
		env.inference.script = (request, call, signal) => {
			const answer = good(request, call, signal);
			if (request.purpose === "link" && env.calls.link === abortAtCall) {
				controller.abort();
			}
			return answer;
		};
		const job = linkJobs(env)[0]!;
		env.sink.open.splice(env.sink.open.indexOf(job), 1);
		const payload = env.link.schema.parse(job.payload);
		const claim = claimFor(env, payload);
		const prepared = env.db.transaction(() =>
			env.link.prepareInTransaction(env.db, claim),
		)();
		if (prepared.status !== "ready") throw new Error("prepare");
		await expect(
			env.link.execute(prepared.input, {
				signal: controller.signal,
				jobId: claim.jobId,
				attempt: 1,
			}),
		).rejects.toBeDefined();
		env.db.transaction(() =>
			env.link.settleInTransaction(env.db, claim, prepared.input, {
				type: "interrupted",
				errorCode: "deadline",
			}),
		)();
		return env;
	}

	test("is not made to wait: the next link goes on at once", async () => {
		// The first mention is stored, the second is cut off.
		const env = await cutOff(2);
		expect(marks(env)[0]).toMatchObject({
			version_id: 1,
			state: "partial",
			not_before: 0,
			transient_failures: 0,
		});
		expect(marks(env)[0]!.cursor_entity_id).toBeGreaterThan(0);
		expect(linkJobs(env)).toHaveLength(1);
		await drainLinks(env);
		expect(marks(env).every((m) => m.state === "done")).toBe(true);
	});

	test("without progress it still waits", async () => {
		// Cut off inside the first mention, before anything is stored.
		const env = await cutOff(1);
		expect(marks(env)[0]).toMatchObject({
			state: "partial",
			cursor_entity_id: 0,
			not_before: env.clock.t + 1000,
			transient_failures: 1,
		});
	});
});

describe("summaries", () => {
	test("a summary is made for 3+ mentions over 2+ documents, once per member set, and again when it changes", async () => {
		const env = makeLinkEnv({ summaryMinMentions: 3 });
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		expect(
			rows(env.db, "SELECT * FROM knowledge_entity_summaries"),
		).toHaveLength(0);
		expect(env.calls.summarize).toBe(0);

		putDoc(env, 3, "Alpha Corp three.");
		await scanAndDrain(env);
		const summaries = rows(env.db, "SELECT * FROM knowledge_entity_summaries");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			anchor_entity_id: 1,
			status: "ok",
			model: "mock-model",
			instruction_id: "summarize",
			instruction_version: 1,
			summary: "SUMMARY(Alpha Corp; 3)",
		});
		expect(env.calls.summarize).toBe(1);

		// Nothing changed: no new summary call.
		await scanAndDrain(env);
		expect(env.calls.summarize).toBe(1);

		// A new version of document 3 gives new mentions: the member set changes, so it is summarized again.
		putDoc(env, 3, "Alpha Corp is now described otherwise.");
		await scanAndDrain(env);
		expect(env.calls.summarize).toBe(2);
		expect(
			rows(env.db, "SELECT members_digest FROM knowledge_entity_summaries"),
		).toHaveLength(1);
	});

	test("an invalid summary is recorded as failed and not asked again for the same member set", async () => {
		const env = makeLinkEnv({ summaryMinMentions: 2 });
		env.summaryAnswer = () => JSON.stringify({ summary: "", extra: 1 });
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		expect(
			rows(env.db, "SELECT status, summary FROM knowledge_entity_summaries"),
		).toEqual([{ status: "failed", summary: null }]);
		const asked = env.calls.summarize;
		await scanAndDrain(env);
		expect(env.calls.summarize).toBe(asked);
		expect(chain(env).open_sweep).toBeNull();
	});

	test("a port failure while summarizing waits instead of failing the cluster", async () => {
		const env = makeLinkEnv({
			summaryMinMentions: 2,
			transientRetryDelayMs: 1000,
		});
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		const good = env.inference.script;
		env.inference.script = (request, call, signal) => {
			if (request.purpose === "summarize") throw new Error("down");
			return good(request, call, signal);
		};
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		await drainAllWith(env, "once");
		const row = rows(
			env.db,
			"SELECT status, not_before, transient_failures FROM knowledge_entity_summaries",
		);
		expect(row).toEqual([
			{
				status: "waiting",
				not_before: env.clock.t + 1000,
				transient_failures: 1,
			},
		]);
		expect(chain(env).open_sweep).toBeNull();
		env.inference.script = good;
		env.clock.t += 1001;
		await scanAndDrain(env);
		expect(
			rows(env.db, "SELECT status FROM knowledge_entity_summaries"),
		).toEqual([{ status: "ok" }]);
	});
});

// ---------------------------------------------------------------------------

const noUsage = {
	inputTokens: null,
	cachedTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	calls: null,
};

function claimFor(env: LinkEnv, payload: { sweep: number }) {
	return {
		jobId: randomUUID(),
		kind: env.link.kind,
		payloadVersion: 1,
		payload,
		attempt: 1,
		maxAttempts: 1,
		deadlineAtMs: null,
	};
}

/** Like `drainAll`, with the host registering each job with one attempt (a retry settles as failed). */
async function drainAllWith(env: LinkEnv, attempts: "once"): Promise<void> {
	let guard = 0;
	while (env.sink.open.length > 0 && guard++ < 200) {
		const job = env.sink.open.shift()!;
		if (job.kind === "knowledge.sync-page") {
			await runJob(
				env.db,
				env.sync,
				env.sync.schema.parse(job.payload),
				undefined,
				{ attempts },
			);
		} else if (job.kind === "knowledge.ingest-next") {
			await runJob(
				env.db,
				env.ingest,
				env.ingest.schema.parse(job.payload),
				undefined,
				{ attempts },
			);
		} else {
			await runJob(
				env.db,
				env.link,
				env.link.schema.parse(job.payload),
				undefined,
				{ attempts },
			);
		}
	}
}
