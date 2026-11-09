import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AccessContext, FollowUpJob } from "../../contracts/index.js";
import { getPublishedVersionInSnapshot } from "../../sqlite/index.js";
import {
	NAME_KEY_PROVENANCE,
	listLinkedMentionIdsInSnapshot,
	readSameClusterInTransaction,
	recordLinkDecisionsInTransaction,
} from "../../sqlite/links.js";
import { docId, makeDoc, rows, runJob } from "../harness.fixture.js";
import { readGraph } from "./graph.js";
import {
	drainAll,
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "./link.fixture.js";
import { readRelated } from "./related.js";

const deps = (env: LinkEnv) => ({
	read: <T>(op: (db: LinkEnv["db"]) => T): T => op(env.db),
	clock: env.clock,
	options: { verifiedWithinMs: 10 ** 12 },
});
const access = (...namespaces: string[]): AccessContext => ({
	principal: "tester",
	namespaces,
});
const KEY = { ...NAME_KEY_PROVENANCE };
const PERSON = { model: null, instructionId: "person", instructionVersion: 1 };

/** Two documents of `wiki` and one of `other`, ingested by the model-free extractor. */
async function ingested(): Promise<LinkEnv> {
	const env = makeLinkEnv({}, { extractor: "names" });
	putDoc(env, 1, "# 設計\n\nLantern は MySQL を使う。");
	putDoc(env, 2, "# 移行\n\nＬａｎｔｅｒｎ の移行は夜間に行う。");
	putDoc(env, 3, "# 別の部署\n\nLantern という別の製品。", "other");
	await scanAndDrain(env);
	return env;
}

const nodeOf = (
	g: ReturnType<typeof readGraph>,
	name: string,
): ReturnType<typeof readGraph>["nodes"] =>
	g.nodes.filter((n) => n.names.includes(name));

/** The entity id of the current mention named `name` in document `n`. */
const mentionOf = (env: LinkEnv, n: number, name: string): number => {
	const found = rows(
		env.db,
		`SELECT m.entity_id FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE d.document_id = ? AND m.name = ? ORDER BY m.entity_id`,
		docId(n),
		name,
	)[0]?.entity_id;
	if (typeof found !== "number") throw new Error(`no ${name} in ${n}`);
	return found;
};

const versionOf = (env: LinkEnv, n: number): number => {
	const v = getPublishedVersionInSnapshot(env.db, {
		sourceNamespace: "docling",
		documentId: docId(n),
	});
	if (!v) throw new Error(`no version of ${n}`);
	return v.versionId;
};

function judge(
	env: LinkEnv,
	a: number,
	b: number,
	decision: "same" | "different",
): void {
	recordLinkDecisionsInTransaction(
		env.db,
		[{ entityId: a, otherId: b, decision }],
		PERSON,
		env.clock.now(),
	);
}

describe("identity by key (kg2.md G4)", () => {
	test("mentions of one namespace with one key are one node, joined by name_key; no model is asked", async () => {
		const env = await ingested();
		expect(env.calls).toEqual({ link: 0, summarize: 0, extract: 0 });
		const g = readGraph(deps(env), access("wiki"), {});
		const [lantern, ...more] = nodeOf(g, "Lantern");
		expect(more).toEqual([]);
		expect(new Set(lantern?.names)).toEqual(
			new Set(["Lantern", "Ｌａｎｔｅｒｎ"]),
		);
		expect(lantern?.documentIds).toEqual([docId(1), docId(2)].sort());
		expect(lantern?.decidedBy).toEqual([KEY]);
		// A node of one mention is decided by nothing.
		expect(nodeOf(g, "MySQL")[0]?.decidedBy).toEqual([]);
		// The identity chain compared nothing with the model and left nothing pending.
		expect(g.partialReasons).toEqual([]);
		expect(
			rows(env.db, "SELECT state FROM knowledge_link_versions").map(
				(r) => r.state,
			),
		).toEqual(["done", "done", "done"]);
		expect(rows(env.db, "SELECT 1 FROM knowledge_entity_links")).toEqual([]);
	});

	test("a key never joins two namespaces", async () => {
		const env = await ingested();
		const g = readGraph(deps(env), access("wiki", "other"), {});
		expect(nodeOf(g, "Lantern").map((n) => n.documentIds)).toEqual([
			[docId(1), docId(2)].sort(),
			[docId(3)],
		]);
	});

	test("a person's `different` keeps a key join apart, without a linking conflict", async () => {
		const env = await ingested();
		judge(
			env,
			mentionOf(env, 1, "Lantern"),
			mentionOf(env, 2, "Ｌａｎｔｅｒｎ"),
			"different",
		);
		const g = readGraph(deps(env), access("wiki"), {});
		expect(nodeOf(g, "Lantern").map((n) => n.documentIds)).toEqual([
			[docId(1)],
		]);
		expect(nodeOf(g, "Ｌａｎｔｅｒｎ").map((n) => n.documentIds)).toEqual([
			[docId(2)],
		]);
		expect(g.partialReasons).not.toContain("linking_conflict");
	});

	test("documents sharing a key are related, the share decided by name_key", async () => {
		const env = await ingested();
		const related = readRelated(deps(env), access("wiki", "other"), {
			documentId: docId(1),
		});
		expect(related.status).toBe("ok");
		// Document 3 shares the key but lives in another namespace.
		expect(related.results.map((r) => r.documentId)).toEqual([docId(2)]);
		const [shared] = related.results[0]?.shared ?? [];
		expect([shared?.label, shared?.relatedLabel]).toEqual([
			"Lantern",
			"Ｌａｎｔｅｒｎ",
		]);
		expect(shared?.decidedBy).toEqual(KEY);
		expect(related.partialReasons).toEqual([]);
	});

	test("a stored link across namespaces never lets the caller see the other side's key group", async () => {
		const env = await ingested();
		// A person joined wiki's Lantern (doc 1) and other's Lantern (doc 3).
		judge(
			env,
			mentionOf(env, 1, "Lantern"),
			mentionOf(env, 3, "Lantern"),
			"same",
		);
		// Reading `other` alone: doc 1 is outside, so neither it nor its key-mate doc 2 shows.
		const g = readGraph(deps(env), access("other"), {});
		expect(nodeOf(g, "Lantern").map((n) => n.documentIds)).toEqual([
			[docId(3)],
		]);
		expect(
			readRelated(deps(env), access("other"), { documentId: docId(3) }).results,
		).toEqual([]);
		// Reading both: one node, joined by the person and by the key.
		const both = readGraph(deps(env), access("wiki", "other"), {});
		const [node, ...more] = nodeOf(both, "Lantern");
		expect(more).toEqual([]);
		expect(node?.documentIds).toEqual([docId(1), docId(2), docId(3)].sort());
		expect(new Set(node?.decidedBy)).toEqual(new Set([PERSON, KEY]));
	});

	test("a cluster read stops at its cap inside one key group; without keys it follows stored links only", async () => {
		const env = makeLinkEnv({}, { extractor: "names" });
		for (let n = 1; n <= 6; n++)
			putDoc(env, n, `# 記録${n}\n\nLantern を使う。`);
		await scanAndDrain(env);
		const seed = mentionOf(env, 1, "Lantern");
		const cut = readSameClusterInTransaction(env.db, seed, 3);
		expect(cut.members).toHaveLength(3);
		expect(cut.truncated).toBe(true);
		const whole = readSameClusterInTransaction(env.db, seed);
		expect(whole.members).toHaveLength(6);
		expect(whole.truncated).toBe(false);
		for (const link of whole.links) {
			expect(link.a).toBeLessThan(link.b);
			expect(link.provenance).toEqual(KEY);
			expect(link.decidedAt).toBe(0);
		}
		const stored = readSameClusterInTransaction(env.db, seed, 500, undefined, {
			keys: false,
		});
		expect(stored.members.map((m) => m.entityId)).toEqual([seed]);
	});

	test("a key starts a related search only when another current version of the namespace has it", async () => {
		const env = await ingested();
		putDoc(
			env,
			4,
			"# 単独\n\nLantern の話。\n\n## 続き\n\nLantern の続き。",
			"solo",
		);
		await scanAndDrain(env);
		const starts = (n: number) =>
			listLinkedMentionIdsInSnapshot(env.db, versionOf(env, n), 100).entityIds;
		expect(starts(1)).toEqual([mentionOf(env, 1, "Lantern")]);
		// Only another namespace has it (doc 3), or only the same version does (doc 4).
		expect(starts(3)).toEqual([]);
		expect(starts(4)).toEqual([]);
		// Doc 2 no longer names Lantern: its old version does not make doc 1 a start.
		env.source.put(makeDoc(2, "# 移行\n\n夜間に行う。"));
		await scanAndDrain(env);
		expect(starts(1)).toEqual([]);
	});

	test("summaries follow stored links alone: a key-mate never keeps the chain asking for one", async () => {
		const env = makeLinkEnv({ summaryMinMentions: 2 }, { extractor: "names" });
		putDoc(env, 1, "# 一\n\nLantern を使う。");
		putDoc(env, 2, "# 二\n\nLanternAlias を使う。");
		putDoc(env, 3, "# 三\n\nLantern の話。");
		await scanAndDrain(env);
		// A person joins two different keys; doc 3 is a key-mate of doc 1.
		judge(
			env,
			mentionOf(env, 1, "Lantern"),
			mentionOf(env, 2, "LanternAlias"),
			"same",
		);
		const ran = await scanAndDrain(env);
		expect(env.sink.open).toEqual([]);
		expect(
			ran.filter((j) => j.kind === "knowledge.link-next").length,
		).toBeLessThan(10);
		// The summary was made for the stored cluster (docs 1 and 2) ...
		expect(env.calls.summarize).toBe(1);
		// ... and is not shown for the node the key made larger.
		const g = readGraph(deps(env), access("wiki"), {});
		const [node] = nodeOf(g, "Lantern");
		expect(node?.documentIds).toEqual([docId(1), docId(2), docId(3)].sort());
		expect(node?.summary).toBeNull();
	});

	test("in a version with keyed and unkeyed mentions, only the unkeyed ones are compared by the model", async () => {
		// The model's extraction, then keys given to Alpha Corp's mentions before the chain runs.
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp と Beta Ltd の契約。");
		putDoc(env, 2, "Alpha Corp と Beta Ltd の請求。");
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const held: FollowUpJob[] = [];
		while (env.sink.open.length > 0) {
			const job = env.sink.open.shift() as FollowUpJob;
			if (job.kind === "knowledge.link-next") held.push(job);
			else if (job.kind === "knowledge.sync-page")
				await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
			else
				await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
		}
		env.db.run(
			"UPDATE knowledge_entity_mentions SET name_key = 'alpha corp' WHERE name = 'Alpha Corp'",
		);
		env.sink.open.push(...held);
		await drainAll(env);
		expect(env.sink.open).toEqual([]);
		expect(env.calls.link).toBeGreaterThan(0);
		// Every stored judgment is about Beta Ltd; Alpha Corp joins by key.
		expect(
			rows(
				env.db,
				`SELECT DISTINCT m.name FROM knowledge_entity_links l
JOIN knowledge_entity_mentions m ON m.entity_id IN (l.entity_a, l.entity_b)`,
			).map((r) => r.name),
		).toEqual(["Beta Ltd"]);
		expect(
			rows(env.db, "SELECT state FROM knowledge_link_versions").map(
				(r) => r.state,
			),
		).toEqual(["done", "done"]);
		const g = readGraph(deps(env), access("wiki"), {});
		expect(nodeOf(g, "Alpha Corp")[0]?.decidedBy).toEqual([KEY]);
		expect(nodeOf(g, "Beta Ltd")[0]?.documentIds).toHaveLength(2);
		expect(nodeOf(g, "Beta Ltd")[0]?.decidedBy[0]?.instructionId).toBe("link");
	});
});
