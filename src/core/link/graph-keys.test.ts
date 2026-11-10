import { describe, expect, test } from "bun:test";
import type { AccessContext, GraphRequest } from "../../contracts/index.js";
import { canReadGraphByKeysInSnapshot } from "../../sqlite/graph.js";
import { docId, rows } from "../harness.fixture.js";
import { readGraph, readGraphIn } from "./graph.js";
import {
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "./link.fixture.js";

const access = (...namespaces: string[]): AccessContext => ({
	principal: "tester",
	namespaces,
});
const deps = (env: LinkEnv) => ({
	read: <T>(op: (db: LinkEnv["db"]) => T): T => op(env.db),
	clock: env.clock,
	options: { verifiedWithinMs: 10 ** 12 },
});

/** A seeded generator (the corpus is the same on every run). */
function random(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

const PROPER = [
	"Lantern",
	"MySQL",
	"Zircon",
	"Mira Okafor",
	"GPT-4",
	"Anthropic",
	"Kafka",
	"Redis",
	"Tokyo",
	"Hono",
];
const NOUNS = ["設計", "索引", "運用", "検索", "障害", "会議"];

/** Documents of sentences naming a few names each, in two namespaces. */
async function corpus(seed: number, docs: number): Promise<LinkEnv> {
	const next = random(seed);
	const pick = <T>(list: readonly T[]) =>
		list[Math.floor(next() * list.length)] as T;
	const env = makeLinkEnv({}, { extractor: "names" });
	for (let n = 1; n <= docs; n++) {
		const sentences = Array.from({ length: 2 + Math.floor(next() * 5) }, () => {
			const names = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
				next() < 0.6 ? pick(PROPER) : pick(NOUNS),
			);
			return `${names.join(" と ")}の話。`;
		});
		putDoc(env, n, `${sentences.join("\n")}\n`, n % 3 === 0 ? "team" : "wiki");
	}
	await scanAndDrain(env);
	return env;
}

describe("the graph by identity keys (kg2.md §7.12)", () => {
	const REQUESTS: GraphRequest[] = [
		{},
		{ maxNodes: 3 },
		{ maxNodes: 5, maxEdges: 4 },
		{ types: ["固有名"] },
		{ minDocuments: 2 },
		{ minEdgeDocuments: 2, maxNodes: 8 },
		{ namespaces: ["team"] },
	];

	test("gives the answer reading mention by mention gives, for any request", async () => {
		for (const seed of [1, 2, 3]) {
			const env = await corpus(seed, 12);
			expect(canReadGraphByKeysInSnapshot(env.db, ["wiki", "team"])).toBe(true);
			for (const request of REQUESTS) {
				const keys = readGraphIn("keys")(
					deps(env),
					access("wiki", "team"),
					request,
				);
				const mentions = readGraphIn("mentions")(
					deps(env),
					access("wiki", "team"),
					request,
				);
				expect(keys).toEqual(mentions);
				// Not a comparison of two empty answers.
				if (Object.keys(request).length === 0) {
					expect(keys.nodes.length).toBeGreaterThan(5);
					// The model-free extractor makes no relation (rules version 8, kg2.md §7.14).
					expect(keys.edges).toEqual([]);
				}
				if (request.maxNodes === 3)
					expect(keys.partialReasons).toContain("nodes_truncated");
				expect(readGraph(deps(env), access("wiki", "team"), request)).toEqual(
					keys,
				);
			}
		}
	});

	test("a node of many documents lists the most mentioned 20 and counts them all", async () => {
		// One line per fragment: a name is one mention per line.
		const env = makeLinkEnv({}, { extractor: "names", maxFragmentBytes: 32 });
		// Lantern is in 25 documents: twice (two fragments) in 22 to 25.
		for (let n = 1; n <= 25; n++)
			putDoc(
				env,
				n,
				n >= 22
					? "Lantern と MySQL。\n\nLantern の話。\n"
					: "Lantern と MySQL。\n",
			);
		await scanAndDrain(env);
		for (const mode of ["keys", "mentions"] as const) {
			const g = readGraphIn(mode)(deps(env), access("wiki"), {});
			const lantern = g.nodes.find((n) => n.label === "Lantern");
			expect(lantern?.documentCount).toBe(25);
			expect(lantern?.documentIds).toHaveLength(20);
			expect(lantern?.documentIds).toEqual(
				[...(lantern?.documentIds ?? [])].sort(),
			);
			for (const n of [22, 23, 24, 25])
				expect(lantern?.documentIds).toContain(docId(n));
			// The answer names only the listed documents: 1 to 20 (MySQL: equal counts, smallest
			// ids) and 22 to 25 (Lantern's most mentioned).
			expect(g.documents.map((d) => d.documentId)).toEqual(
				[...Array.from({ length: 20 }, (_, i) => i + 1), 22, 23, 24, 25].map(
					docId,
				),
			);
		}
	});

	test("every document a quotation comes from is in the answer's documents", async () => {
		// One line per fragment: Lantern is one mention in 1 to 3, two in 4 to 25, so its listed
		// documents are 4 to 23 and its first quotations come from 1, 2 and 3.
		const env = makeLinkEnv({}, { extractor: "names", maxFragmentBytes: 32 });
		for (let n = 1; n <= 25; n++)
			putDoc(
				env,
				n,
				n <= 3 ? "Lantern の話。\n" : "Lantern の話。\n\nLantern と MySQL。\n",
			);
		await scanAndDrain(env);
		for (const mode of ["keys", "mentions"] as const) {
			const g = readGraphIn(mode)(deps(env), access("wiki"), {});
			const lantern = g.nodes.find((n) => n.label === "Lantern");
			expect(lantern?.documentIds).not.toContain(docId(1));
			expect(lantern?.evidence.map((e) => e.documentId)).toContain(docId(1));
			const listed = new Set(g.documents.map((d) => d.documentId));
			for (const x of [...g.nodes, ...g.edges])
				for (const e of x.evidence) expect(listed.has(e.documentId)).toBe(true);
		}
	});

	test("one key in two namespaces is two nodes; a key outside the scope shows nowhere", async () => {
		const env = makeLinkEnv({}, { extractor: "names" });
		putDoc(env, 1, "Lantern と MySQL。\n", "wiki");
		putDoc(env, 2, "Lantern と MySQL。\n", "team");
		putDoc(env, 3, "Lantern と Zircon。\n", "secret");
		await scanAndDrain(env);
		const g = readGraph(deps(env), access("wiki", "team"), {});
		expect(g.nodes.map((n) => [n.label, n.mentionCount])).toEqual([
			["Lantern", 1],
			["Lantern", 1],
			["MySQL", 1],
			["MySQL", 1],
		]);
		expect(g.edges).toEqual([]);
		expect(g.nodes.some((n) => n.label === "Zircon")).toBe(false);
		expect(g).toEqual(
			readGraphIn("mentions")(deps(env), access("wiki", "team"), {}),
		);
	});

	test("a relation of rules version 7 not yet extracted again is drawn mention by mention only (kg2.md §7.14)", async () => {
		const env = makeLinkEnv({}, { extractor: "names" });
		putDoc(env, 1, "Lantern と MySQL。\n");
		await scanAndDrain(env);
		const [a, b] = rows(
			env.db,
			"SELECT version_id, fragment_ordinal, local_id FROM knowledge_entity_mentions ORDER BY entity_id",
		);
		// What rules version 7 wrote for two names of one sentence.
		env.db.run(
			`INSERT INTO knowledge_relation_mentions (version_id, fragment_ordinal, local_id,
 source_local_id, target_local_id, directed, relation, description, keywords_json,
 qualifier_negated, qualifier_condition, qualifier_certainty)
VALUES (?, ?, 'r1', ?, ?, 0, '同じ文', '', '[]', 0, NULL, 'stated')`,
			[
				a?.version_id as number,
				a?.fragment_ordinal as number,
				a?.local_id as string,
				b?.local_id as string,
			],
		);
		expect(canReadGraphByKeysInSnapshot(env.db, ["wiki"])).toBe(true);
		expect(readGraph(deps(env), access("wiki"), {}).edges).toEqual([]);
		expect(
			readGraphIn("mentions")(deps(env), access("wiki"), {}).edges.map(
				(e) => e.relation,
			),
		).toEqual(["同じ文"]);
	});

	test("a judgment of two mentions, or a model's version, makes the graph read mention by mention", async () => {
		const env = await corpus(4, 6);
		expect(canReadGraphByKeysInSnapshot(env.db, ["wiki", "team"])).toBe(true);
		const [a, b] = rows(
			env.db,
			"SELECT entity_id FROM knowledge_entity_mentions ORDER BY entity_id LIMIT 2",
		).map((r) => r.entity_id as number);
		env.db.run(
			`INSERT INTO knowledge_entity_links (entity_a, entity_b, version_a, version_b, decision, model,
 instruction_id, instruction_version, decided_at)
SELECT ?1, ?2, ma.version_id, mb.version_id, 'different', NULL, 'person', 1, 0
FROM knowledge_entity_mentions ma, knowledge_entity_mentions mb WHERE ma.entity_id = ?1 AND mb.entity_id = ?2`,
			[a as number, b as number],
		);
		expect(canReadGraphByKeysInSnapshot(env.db, ["wiki", "team"])).toBe(false);
		env.db.run("DELETE FROM knowledge_entity_links");
		expect(canReadGraphByKeysInSnapshot(env.db, ["wiki", "team"])).toBe(true);
		env.db.run(
			`UPDATE knowledge_versions SET extractor = 'model:extract@1' WHERE version_id =
 (SELECT published_version_id FROM knowledge_documents WHERE document_id = ?)`,
			[docId(1)],
		);
		expect(canReadGraphByKeysInSnapshot(env.db, ["wiki", "team"])).toBe(false);
		expect(canReadGraphByKeysInSnapshot(env.db, ["team"])).toBe(true);
	});
});
