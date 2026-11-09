import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rows, runJob } from "../harness.fixture.js";
import { recordLinkDecisionsInTransaction } from "../../sqlite/links.js";
import { pickLinkCandidatesInTransaction } from "./candidates.js";
import { makeLinkEnv, putDoc, type LinkEnv } from "./link.fixture.js";

const provenance = { model: "m", instructionId: "link", instructionVersion: 3 };

const entityOf = (env: LinkEnv, doc: number, name: string): number =>
	(
		rows(
			env.db,
			`SELECT m.entity_id AS id FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE d.document_id = ? AND m.name = ?`,
			`wiki-${doc.toString(16).padStart(32, "0")}`,
			name,
		)[0] as { id: number }
	).id;

/** Ingest documents without ever running the identity chain (its jobs are dropped). */
async function ingestWithoutLinking(env: LinkEnv): Promise<void> {
	await runJob(env.db, env.sync, {
		scanId: randomUUID(),
		cursor: null,
		page: 0,
	});
	while (env.sink.open.length > 0) {
		const job = env.sink.open.shift()!;
		if (job.kind === "knowledge.link-next") continue;
		if (job.kind === "knowledge.sync-page") {
			await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
		} else {
			await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
		}
	}
}

function helpers(env: LinkEnv) {
	const decide = (
		pairs: [number, number, "same" | "different" | "unsure"][],
		at = 5,
	) =>
		recordLinkDecisionsInTransaction(
			env.db,
			pairs.map(([entityId, otherId, decision]) => ({
				entityId,
				otherId,
				decision,
			})),
			provenance,
			at,
		);
	const pick = (id: number, limit = 10, pool = 10, maxPool = pool) =>
		pickLinkCandidatesInTransaction(env.db, id, {
			limit,
			pool,
			maxPool,
			match: "name",
		});
	const offered = (id: number, limit = 10, pool = 10, maxPool = pool) =>
		pick(id, limit, pool, maxPool).candidates.map((c) => c.entityId);
	return { decide, pick, offered };
}

describe("one candidate per part of a node", () => {
	test("a part with a same or different decision is skipped, unsure blocks nothing, the first of every other part is offered", async () => {
		const env = makeLinkEnv();
		for (let n = 1; n <= 5; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		putDoc(env, 6, "Beta Ltd only.");
		await ingestWithoutLinking(env);
		const { decide, pick, offered } = helpers(env);
		const a = (doc: number) => entityOf(env, doc, "Alpha Corp");
		const beta = entityOf(env, 6, "Beta Ltd");
		// Nothing decided yet: every candidate is its own part.
		expect(offered(a(1))).toEqual([a(2), a(3), a(4), a(5)]);
		// 2 and 3 share a part: only its first candidate (2) is offered.
		decide([[a(2), a(3), "same"]]);
		expect(offered(a(1))).toEqual([a(2), a(4), a(5)]);
		// `unsure` with a member blocks nothing: the next member of that part is offered instead.
		decide([[a(1), a(3), "unsure"]]);
		expect(offered(a(1))).toEqual([a(2), a(4), a(5)]);
		// A `different` decision with a member skips the part.
		decide([[a(1), a(2), "different"]]);
		expect(offered(a(1))).toEqual([a(4), a(5)]);
		// 4 and 5 are joined through a mention that is no candidate (one link beyond them).
		decide([
			[a(4), beta, "same"],
			[a(5), beta, "same"],
		]);
		expect(offered(a(1))).toEqual([a(4)]);
		// The part the mention joins is skipped through that decision as well.
		decide([[a(1), beta, "same"]]);
		expect(pick(a(1))).toEqual({ candidates: [], hasMore: false });
		// Now the parts are {2, 3} and {1, Beta, 4, 5}. 2 has decisions with both (3 same, 1
		// different); 4 has one with its own part only, so it is offered the other.
		expect(pick(a(2))).toEqual({ candidates: [], hasMore: false });
		expect(offered(a(4))).toEqual([a(2)]);
		// A link of a version that is no longer current joins nothing: {1}, {4}, {5} come apart.
		env.db.run(
			"UPDATE knowledge_documents SET state = 'unavailable' WHERE document_id = ?",
			[`wiki-${(6).toString(16).padStart(32, "0")}`],
		);
		expect(offered(a(2))).toEqual([a(4), a(5)]);
		// The limit: more parts than offered tells the caller to come back.
		expect(pick(a(2), 1)).toMatchObject({ hasMore: true });
		expect(offered(a(2), 1)).toEqual([a(4)]);
		// The read sizes must hold the limit and grow.
		expect(() => pick(a(2), 2, 1)).toThrow();
		expect(() => pick(a(2), 1, 2, 1)).toThrow();
	});

	test("parts follow the rule of the graph read: a same link that conflicts with a different judgment joins nothing", async () => {
		const env = makeLinkEnv();
		for (let n = 1; n <= 4; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		await ingestWithoutLinking(env);
		const { decide, offered } = helpers(env);
		const a = (doc: number) => entityOf(env, doc, "Alpha Corp");
		// 2-3 same, 3-4 same, but 2-4 different: the graph read does not use 3-4 (linking_conflict),
		// so {2, 3} and {4} are two parts.
		decide([
			[a(2), a(3), "same"],
			[a(3), a(4), "same"],
			[a(2), a(4), "different"],
		]);
		decide([[a(1), a(2), "same"]], 6);
		// 1 decided {2, 3}; {4} is still offered (bare same links would have made it one part).
		expect(offered(a(1))).toEqual([a(4)]);
	});

	test("parts are joined inside one namespace only, so a node stays connected in each scope", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.", "wiki");
		putDoc(env, 2, "Alpha Corp two.", "other");
		putDoc(env, 3, "Alpha Corp three.", "wiki");
		putDoc(env, 4, "Alpha Corp four.", "wiki");
		putDoc(env, 5, "Alpha Corp five.", "other");
		await ingestWithoutLinking(env);
		const { decide, offered } = helpers(env);
		const a = (doc: number) => entityOf(env, doc, "Alpha Corp");
		// 1 (wiki) and 4 (wiki) are joined only through 2 (other); 2 and 5 (other) directly.
		decide([
			[a(1), a(2), "same"],
			[a(2), a(4), "same"],
			[a(2), a(5), "same"],
		]);
		// For 3 (wiki): wiki has the parts {1} and {4} (a reader of wiki alone sees them apart),
		// other has {2, 5}: three candidates.
		expect(offered(a(3))).toEqual([a(1), a(2), a(4)]);
		// A decision with the other part leaves both wiki parts to ask about.
		decide([[a(3), a(2), "same"]], 6);
		expect(offered(a(3))).toEqual([a(1), a(4)]);
	});

	test("a large part that fills the read does not hide the parts behind it", async () => {
		const env = makeLinkEnv();
		for (let n = 1; n <= 7; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		await ingestWithoutLinking(env);
		const { decide, pick, offered } = helpers(env);
		const a = (doc: number) => entityOf(env, doc, "Alpha Corp");
		// {2..6} is one part that 1 has a decision with; 7 is another part behind it.
		decide([
			[a(2), a(3), "same"],
			[a(2), a(4), "same"],
			[a(2), a(5), "same"],
			[a(2), a(6), "same"],
			[a(1), a(2), "different"],
		]);
		// A read of 2 holds only the blocked part; it grows (2, 8) and finds 7.
		expect(offered(a(1), 1, 2, 8)).toEqual([a(7)]);
		expect(pick(a(1), 1, 2, 8)).toMatchObject({ hasMore: false });
		// Without room to grow, the mention ends there (the documented cap).
		expect(pick(a(1), 1, 2, 2)).toEqual({ candidates: [], hasMore: false });
		// A full read that offers a part asks the caller to come back.
		expect(pick(a(7), 1, 1, 1)).toMatchObject({ hasMore: true });
	});
});
