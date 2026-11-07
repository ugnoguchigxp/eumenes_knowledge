import { describe, expect, test } from "bun:test";
import { rows } from "../core/harness.fixture.js";
import {
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "../core/link/link.fixture.js";
import { bumpLinkGenerationInTransaction } from "./link-chain.js";
import { retireDocumentInTransaction } from "./documents.js";
import {
	canonicalPair,
	clusterDigest,
	listLinkedMentionIdsInSnapshot,
	listSameClustersInTransaction,
	recordSummaryWaitInTransaction,
	pickSummaryWorkInTransaction,
	readLinkCandidatesInTransaction,
	readMentionQuotesInTransaction,
	readSameClusterInTransaction,
	recordLinkDecisionsInTransaction,
	storeSummaryInTransaction,
} from "./links.js";

const provenance = { model: "m", instructionId: "link", instructionVersion: 1 };
const entityOf = (env: LinkEnv, doc: number, name: string): number =>
	(
		rows(
			env.db,
			`SELECT m.entity_id AS id FROM knowledge_entity_mentions m
JOIN knowledge_versions v ON v.version_id = m.version_id
JOIN knowledge_documents d ON d.published_version_id = v.version_id
WHERE d.document_id = ? AND m.name = ?`,
			`wiki-${doc.toString(16).padStart(32, "0")}`,
			name,
		)[0] as { id: number }
	).id;

/** Ingest documents without ever running the identity chain (its jobs are dropped). */
async function ingestWithoutLinking(env: LinkEnv): Promise<void> {
	const { randomUUID } = await import("node:crypto");
	const { runJob } = await import("../core/harness.fixture.js");
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

describe("candidates", () => {
	test("canonical order puts the smaller id first", () => {
		expect(canonicalPair(9, 3)).toEqual([3, 9]);
		expect(() => canonicalPair(4, 4)).toThrow();
	});

	test("candidates cross namespaces, skip the same document, and show only current published mentions", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp in wiki.", "wiki");
		putDoc(env, 2, "Alpha Corp in other.", "other");
		putDoc(env, 3, "Alpha Corp in third.", "wiki");
		putDoc(env, 4, "Beta Ltd only.", "wiki");
		await ingestWithoutLinking(env);
		const a1 = entityOf(env, 1, "Alpha Corp");
		const ids = (id: number) =>
			readLinkCandidatesInTransaction(env.db, id, 10).map((c) => c.entityId);
		expect(ids(a1)).toEqual([
			entityOf(env, 2, "Alpha Corp"),
			entityOf(env, 3, "Alpha Corp"),
		]);
		// A document that is no longer current (stale, unavailable, ...) offers no candidate.
		env.db.run(
			"UPDATE knowledge_documents SET state = 'unavailable' WHERE document_id = ?",
			[`wiki-${(3).toString(16).padStart(32, "0")}`],
		);
		expect(ids(a1)).toEqual([entityOf(env, 2, "Alpha Corp")]);
		// And the mention of a document that is not current has no candidates either.
		expect(ids(entityOf(env, 3, "Alpha Corp"))).toEqual([]);
		// The limit applies.
		expect(readLinkCandidatesInTransaction(env.db, a1, 1)).toHaveLength(1);
	});

	test("the mention full-text index finds a name inside another mention's description; equal names come first", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp is here.");
		// The Delta mention's description contains the text "Alpha Corp".
		putDoc(env, 2, "Alpha Corp and Delta.");
		putDoc(env, 3, "Alpha Corp again.");
		await ingestWithoutLinking(env);
		const a1 = entityOf(env, 1, "Alpha Corp");
		const found = readLinkCandidatesInTransaction(env.db, a1, 10).map((c) => [
			c.documentId.slice(-1),
			c.name,
		]);
		// Exact name matches first (docs 2 and 3), then the Delta mention whose description names Alpha Corp.
		expect(found).toEqual([
			["2", "Alpha Corp"],
			["3", "Alpha Corp"],
			["2", "Delta"],
		]);
	});

	test("names shorter than 3 characters match by equality only", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Delta here.");
		putDoc(env, 2, "Delta there.");
		await ingestWithoutLinking(env);
		// Make doc 1's name two characters; the index cannot answer a phrase that short.
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name = 'Dx', name_norm = 'dx' WHERE entity_id = 1",
		);
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name = 'Dx', name_norm = 'dx' WHERE entity_id = 2",
		);
		expect(
			readLinkCandidatesInTransaction(env.db, 1, 10).map((c) => c.entityId),
		).toEqual([2]);
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name = 'Dy', name_norm = 'dy' WHERE entity_id = 2",
		);
		expect(readLinkCandidatesInTransaction(env.db, 1, 10)).toEqual([]);
	});

	test("a pair that has a decision is not offered again, whatever the decision", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await ingestWithoutLinking(env);
		expect(readLinkCandidatesInTransaction(env.db, 1, 10)).toHaveLength(1);
		expect(
			recordLinkDecisionsInTransaction(
				env.db,
				[{ entityId: 2, otherId: 1, decision: "unsure" }],
				provenance,
				5,
			),
		).toBe(1);
		expect(readLinkCandidatesInTransaction(env.db, 1, 10)).toEqual([]);
		expect(readLinkCandidatesInTransaction(env.db, 2, 10)).toEqual([]);
		// The first decision stays; the pair is stored once, in canonical order.
		expect(
			recordLinkDecisionsInTransaction(
				env.db,
				[{ entityId: 1, otherId: 2, decision: "same" }],
				provenance,
				6,
			),
		).toBe(0);
		expect(
			rows(
				env.db,
				"SELECT entity_a, entity_b, decision, version_a, version_b FROM knowledge_entity_links",
			),
		).toEqual([
			{
				entity_a: 1,
				entity_b: 2,
				decision: "unsure",
				version_a: 1,
				version_b: 2,
			},
		]);
		// A mention that does not exist is skipped.
		expect(
			recordLinkDecisionsInTransaction(
				env.db,
				[{ entityId: 1, otherId: 999, decision: "same" }],
				provenance,
				6,
			),
		).toBe(0);
	});

	test("the quotations are cut from the fragment by the evidence range", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "日本語の Alpha Corp という会社。");
		await ingestWithoutLinking(env);
		expect(readMentionQuotesInTransaction(env.db, 1, 400)).toEqual([
			"Alpha Corp",
		]);
		expect(readMentionQuotesInTransaction(env.db, 1, 5)).toEqual(["Alpha"]);
	});
});

describe("clusters", () => {
	test("a cluster is the connected component of same links among current mentions", async () => {
		const env = makeLinkEnv();
		for (let n = 1; n <= 4; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		await ingestWithoutLinking(env);
		const [a1, a2, a3, a4] = [1, 2, 3, 4].map((n) =>
			entityOf(env, n, "Alpha Corp"),
		) as [number, number, number, number];
		recordLinkDecisionsInTransaction(
			env.db,
			[
				{ entityId: a1, otherId: a2, decision: "same" },
				{ entityId: a3, otherId: a2, decision: "same" },
				{ entityId: a3, otherId: a4, decision: "different" },
			],
			provenance,
			1,
		);
		const cluster = readSameClusterInTransaction(env.db, a3);
		expect(cluster.members.map((m) => m.entityId)).toEqual([a1, a2, a3]);
		expect(cluster.links.map((l) => [l.a, l.b])).toEqual([
			[a1, a2],
			[a2, a3],
		]);
		expect(cluster.truncated).toBe(false);
		expect(
			readSameClusterInTransaction(env.db, a4).members.map((m) => m.entityId),
		).toEqual([a4]);
		expect(
			listSameClustersInTransaction(env.db).map((c) => c.memberIds),
		).toEqual([[a1, a2, a3]]);
		// The cap cuts a larger cluster and says so.
		const cut = readSameClusterInTransaction(env.db, a1, 2);
		expect(cut.members).toHaveLength(2);
		expect(cut.truncated).toBe(true);
	});

	test("unsure and different links do not connect", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await ingestWithoutLinking(env);
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: 1, otherId: 2, decision: "unsure" }],
			provenance,
			1,
		);
		expect(listSameClustersInTransaction(env.db)).toEqual([]);
		expect(readSameClusterInTransaction(env.db, 1).members).toHaveLength(1);
	});

	test("retiring a version changes the cluster at once and cleanup deletes its links, mark and summary", async () => {
		const env = makeLinkEnv({ summaryMinMentions: 3 });
		for (let n = 1; n <= 3; n++) putDoc(env, n, `Alpha Corp note ${n}.`);
		await scanAndDrain(env);
		const before = readSameClusterInTransaction(env.db, 1);
		expect(before.members.map((m) => m.entityId)).toEqual([1, 2, 3]);
		expect(
			rows(env.db, "SELECT status FROM knowledge_entity_summaries"),
		).toEqual([{ status: "ok" }]);

		// Document 3 gets a new version without the company: its old mention (id 3) retires.
		putDoc(env, 3, "Nothing to see.");
		await scanAndDrain(env);
		const after = readSameClusterInTransaction(env.db, 1);
		expect(after.members.map((m) => m.entityId)).toEqual([1, 2]);
		expect(readSameClusterInTransaction(env.db, 3).members).toEqual([]);
		// Cleanup ran in the ingest link: nothing names the retired version any more.
		expect(
			rows(
				env.db,
				"SELECT COUNT(*) AS n FROM knowledge_entity_links WHERE version_a = 3 OR version_b = 3",
			)[0],
		).toEqual({ n: 0 });
		expect(
			rows(
				env.db,
				"SELECT COUNT(*) AS n FROM knowledge_link_versions WHERE version_id = 3",
			)[0],
		).toEqual({ n: 0 });
		expect(
			rows(
				env.db,
				"SELECT COUNT(*) AS n FROM knowledge_entity_mentions WHERE version_id = 3",
			)[0],
		).toEqual({ n: 0 });
		// The old summary was made for {1,2,3}: it no longer matches and is not used.
		expect(clusterDigest([1, 2])).not.toBe(clusterDigest([1, 2, 3]));
		expect(
			pickSummaryWorkInTransaction(env.db, { minMentions: 3, now: 0 }),
		).toBeNull();
	});

	test("a summary whose cluster changed is refused", async () => {
		const env = makeLinkEnv({ summaryMinMentions: 2 });
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		const digest = clusterDigest([1, 2]);
		const store = (d: string) =>
			storeSummaryInTransaction(
				env.db,
				{ anchorEntityId: 1, digest: d, summary: "S", provenance },
				9,
			);
		expect(store(clusterDigest([1, 2, 3]))).toBe(false);
		expect(store(digest)).toBe(true);
	});
});

describe("which cluster needs a summary", () => {
	test("two documents and the minimum number of mentions are needed", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await ingestWithoutLinking(env);
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: 1, otherId: 2, decision: "same" }],
			provenance,
			1,
		);
		expect(
			pickSummaryWorkInTransaction(env.db, { minMentions: 3, now: 0 }),
		).toBeNull();
		expect(
			pickSummaryWorkInTransaction(env.db, { minMentions: 2, now: 0 }),
		).toEqual({
			anchorEntityId: 1,
			memberIds: [1, 2],
			digest: clusterDigest([1, 2]),
		});
		// A cluster over the member cap given is not summarized.
		expect(
			pickSummaryWorkInTransaction(env.db, {
				minMentions: 2,
				maxMentions: 1,
				now: 0,
			}),
		).toBeNull();
	});

	test("a cluster inside one document is not summarized", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp and Delta.");
		await ingestWithoutLinking(env);
		// Two mentions of document 1 joined by a (hand-made) link: only one document.
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: 1, otherId: 2, decision: "same" }],
			provenance,
			1,
		);
		expect(listSameClustersInTransaction(env.db)).toEqual([
			{ memberIds: [1, 2], documents: 1 },
		]);
		expect(
			pickSummaryWorkInTransaction(env.db, { minMentions: 2, now: 0 }),
		).toBeNull();
	});
});

describe("clusters read inside a set of namespaces", () => {
	async function threeDocs() {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.", "wiki");
		putDoc(env, 2, "Alpha Corp two.", "other");
		putDoc(env, 3, "Alpha Corp three.", "wiki");
		putDoc(env, 4, "Alpha Corp four.", "wiki");
		await ingestWithoutLinking(env);
		const [a1, a2, a3, a4] = [1, 2, 3, 4].map((n) =>
			entityOf(env, n, "Alpha Corp"),
		) as [number, number, number, number];
		recordLinkDecisionsInTransaction(
			env.db,
			[
				{ entityId: a1, otherId: a2, decision: "same" },
				{ entityId: a2, otherId: a3, decision: "same" },
				{ entityId: a3, otherId: a4, decision: "same" },
			],
			provenance,
			1,
		);
		return { env, a1, a2, a3, a4 };
	}

	test("a mention outside never connects two inside, and the cap counts the inside only", async () => {
		const { env, a1, a2, a3, a4 } = await threeDocs();
		const ids = (c: { members: { entityId: number }[] }) =>
			c.members.map((m) => m.entityId);
		expect(ids(readSameClusterInTransaction(env.db, a1))).toEqual([
			a1,
			a2,
			a3,
			a4,
		]);
		const wiki = readSameClusterInTransaction(env.db, a3, 500, ["wiki"]);
		expect(ids(wiki)).toEqual([a3, a4]);
		expect(wiki.links.map((l) => [l.a, l.b])).toEqual([[a3, a4]]);
		expect(
			ids(readSameClusterInTransaction(env.db, a1, 500, ["wiki"])),
		).toEqual([a1]);
		// The outside mention is not counted against the cap.
		const capped = readSameClusterInTransaction(env.db, a3, 2, ["wiki"]);
		expect(capped.truncated).toBe(false);
		expect(readSameClusterInTransaction(env.db, a3, 2).truncated).toBe(true);
		// A seed outside is not read; no namespace at all reads nothing.
		expect(
			readSameClusterInTransaction(env.db, a2, 500, ["wiki"]).members,
		).toEqual([]);
		expect(readSameClusterInTransaction(env.db, a1, 500, []).members).toEqual(
			[],
		);
	});
});

describe("mentions that can start a cluster", () => {
	test("only mentions with a same link, in id order, with a limit", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp, Beta Ltd and Delta.");
		putDoc(env, 2, "Alpha Corp, Beta Ltd and Delta again.");
		await ingestWithoutLinking(env);
		const [a1, b1, d1] = ["Alpha Corp", "Beta Ltd", "Delta"].map((n) =>
			entityOf(env, 1, n),
		) as [number, number, number];
		const a2 = entityOf(env, 2, "Alpha Corp");
		const b2 = entityOf(env, 2, "Beta Ltd");
		const d2 = entityOf(env, 2, "Delta");
		recordLinkDecisionsInTransaction(
			env.db,
			[
				{ entityId: b2, otherId: b1, decision: "same" },
				{ entityId: a1, otherId: a2, decision: "same" },
				{ entityId: d1, otherId: d2, decision: "unsure" },
			],
			provenance,
			1,
		);
		expect(listLinkedMentionIdsInSnapshot(env.db, 1, 10)).toEqual({
			entityIds: [a1, b1],
			truncated: false,
		});
		expect(listLinkedMentionIdsInSnapshot(env.db, 1, 1)).toEqual({
			entityIds: [a1],
			truncated: true,
		});
	});
});

describe("the summary search runs only after a change", () => {
	test("an empty search is remembered until a link or a document changes, or a waiting summary comes due", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await ingestWithoutLinking(env);
		const search = (now = 0) =>
			pickSummaryWorkInTransaction(env.db, { minMentions: 2, now });
		const key = () =>
			(
				rows(
					env.db,
					"SELECT summary_checked_key AS k FROM knowledge_link_chain",
				)[0] as {
					k: string | null;
				}
			).k;
		// No links: nothing to do, and the search is remembered for this generation.
		expect(search()).toBeNull();
		const remembered = key();
		expect(remembered).not.toBeNull();
		// A same link is a change.
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: 1, otherId: 2, decision: "same" }],
			provenance,
			1,
		);
		expect(search()?.anchorEntityId).toBe(1);
		// A found work is not remembered as empty; once summarized the search is.
		expect(
			storeSummaryInTransaction(
				env.db,
				{
					anchorEntityId: 1,
					digest: clusterDigest([1, 2]),
					summary: "S",
					provenance,
				},
				2,
			),
		).toBe(true);
		expect(search()).toBeNull();
		// The remembered answer is used without reading the links again: the summary row is
		// removed behind its back and nothing is found until something changes.
		env.db.run("DELETE FROM knowledge_entity_summaries");
		expect(search()).toBeNull();
		bumpLinkGenerationInTransaction(env.db);
		expect(search()?.anchorEntityId).toBe(1);
	});

	test("a waiting summary is looked at again when it comes due", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await ingestWithoutLinking(env);
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: 1, otherId: 2, decision: "same" }],
			provenance,
			1,
		);
		expect(
			recordSummaryWaitInTransaction(
				env.db,
				{ anchorEntityId: 1, digest: clusterDigest([1, 2]) },
				{ id: "summarize", version: 1 },
				0,
				1000,
			),
		).toBe(true);
		const search = (now: number) =>
			pickSummaryWorkInTransaction(env.db, { minMentions: 2, now });
		expect(search(10)).toBeNull();
		expect(search(999)).toBeNull();
		expect(search(1000)?.anchorEntityId).toBe(1);
	});

	test("a document that stops being current, and cleanup of link rows, advance the generation", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp one.");
		putDoc(env, 2, "Alpha Corp two.");
		await scanAndDrain(env);
		const generation = () =>
			(
				rows(
					env.db,
					"SELECT link_generation AS g FROM knowledge_link_chain",
				)[0] as { g: number }
			).g;
		const before = generation();
		retireDocumentInTransaction(
			env.db,
			{
				sourceNamespace: "docling",
				documentId: `wiki-${(1).toString(16).padStart(32, "0")}`,
			},
			"excluded",
			5,
		);
		expect(generation()).toBeGreaterThan(before);
	});
});
