import { describe, expect, test } from "bun:test";
import { docId, rows } from "../core/harness.fixture.js";
import {
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "../core/link/link.fixture.js";
import {
	readGraphDocumentsInSnapshot,
	readGraphEvidenceInSnapshot,
	readGraphMentionsInSnapshot,
	readGraphRelationsAmongInSnapshot,
	readGraphLinksInSnapshot,
} from "./graph.js";

async function populated(): Promise<LinkEnv> {
	// `text` candidates: Beta Ltd is compared with the Alpha Corp of its document's text, so the
	// store also holds `different` links.
	const env = makeLinkEnv({ candidateMatch: "text" });
	putDoc(env, 1, "Alpha Corp and Beta Ltd.", "wiki");
	putDoc(env, 2, "Alpha Corp again.", "wiki");
	putDoc(env, 3, "Alpha Corp abroad.", "other");
	putDoc(env, 4, "Gamma Inc alone.", "secret");
	await scanAndDrain(env);
	return env;
}

describe("graph reads", () => {
	test("mentions are the current ones of the namespaces in entity id order, cut at the cap", async () => {
		const env = await populated();
		const all = readGraphMentionsInSnapshot(env.db, ["wiki", "other"], 100);
		expect(all.truncated).toBe(false);
		expect(all.mentions.map((m) => m.name)).toEqual([
			"Alpha Corp",
			"Beta Ltd",
			"Alpha Corp",
			"Alpha Corp",
		]);
		const ids = all.mentions.map((m) => m.entityId);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(all.mentions[0]).toMatchObject({
			localId: "e1",
			fragmentOrdinal: 0,
		});

		const cut = readGraphMentionsInSnapshot(env.db, ["wiki", "other"], 3);
		expect(cut.truncated).toBe(true);
		expect(cut.mentions.map((m) => m.entityId)).toEqual(ids.slice(0, 3));
		const exact = readGraphMentionsInSnapshot(env.db, ["wiki", "other"], 4);
		expect(exact.truncated).toBe(false);

		expect(
			readGraphMentionsInSnapshot(env.db, ["secret"], 10).mentions.map(
				(m) => m.name,
			),
		).toEqual(["Gamma Inc"]);
		expect(readGraphMentionsInSnapshot(env.db, [], 10).mentions).toEqual([]);
		// A document that is no longer current offers no mention.
		env.db.run(
			"UPDATE knowledge_documents SET state = 'stale' WHERE document_id = ?",
			[docId(2)],
		);
		expect(
			readGraphMentionsInSnapshot(env.db, ["wiki"], 10).mentions.map(
				(m) => m.name,
			),
		).toEqual(["Alpha Corp", "Beta Ltd"]);
		expect(() => readGraphMentionsInSnapshot(env.db, ["wiki"], 0)).toThrow();
	});

	test("same links are read only when both ends are in the given set", async () => {
		const env = await populated();
		const { mentions } = readGraphMentionsInSnapshot(
			env.db,
			["wiki", "other", "secret"],
			100,
		);
		const alphas = mentions.filter((m) => m.name === "Alpha Corp");
		expect(alphas).toHaveLength(3);
		const all = readGraphLinksInSnapshot(
			env.db,
			mentions.map((m) => m.entityId),
		);
		expect(all.length).toBeGreaterThanOrEqual(2);
		for (const l of all) {
			expect(l.a).toBeLessThan(l.b);
			expect(l.instructionId).toBe("link");
			expect(l.instructionVersion).toBeGreaterThanOrEqual(1);
		}
		const [first, second] = alphas;
		const part = readGraphLinksInSnapshot(env.db, [
			first!.entityId,
			second!.entityId,
		]);
		expect(
			part.every((l) => [first!.entityId, second!.entityId].includes(l.a)),
		).toBe(true);
		expect(
			part.every((l) => [first!.entityId, second!.entityId].includes(l.b)),
		).toBe(true);
		expect(readGraphLinksInSnapshot(env.db, [])).toEqual([]);
		// `same` and `different` are read (the latter is a constraint); `unsure` is not read.
		const same = all.filter((l) => l.decision === "same");
		expect(same.length).toBeGreaterThanOrEqual(2);
		expect(all.some((l) => l.decision === "different")).toBe(true);
		const ids = mentions.map((m) => m.entityId);
		env.db.run(
			"UPDATE knowledge_entity_links SET decision = 'unsure' WHERE entity_a = ? AND entity_b = ?",
			[same[0]!.a, same[0]!.b],
		);
		expect(readGraphLinksInSnapshot(env.db, ids)).toHaveLength(all.length - 1);
		env.db.run("UPDATE knowledge_entity_links SET decision = 'unsure'");
		expect(readGraphLinksInSnapshot(env.db, ids)).toEqual([]);
	});

	test("documents, relations and evidence are read by batch for the versions and subjects given", async () => {
		const env = await populated();
		const { mentions } = readGraphMentionsInSnapshot(env.db, ["wiki"], 100);
		const versions = [...new Set(mentions.map((m) => m.versionId))];
		const docs = readGraphDocumentsInSnapshot(env.db, versions);
		expect(docs.map((d) => d.documentId)).toEqual([docId(1), docId(2)]);
		expect(docs[0]).toMatchObject({ namespace: "wiki", path: "notes/1.md" });
		expect(readGraphDocumentsInSnapshot(env.db, [])).toEqual([]);

		// The scripted extraction has no relation: insert one between two mentions of one fragment.
		const byFragment = new Map<string, typeof mentions>();
		for (const m of mentions) {
			const k = `${m.versionId}:${m.fragmentOrdinal}`;
			byFragment.set(k, [...(byFragment.get(k) ?? []), m]);
		}
		const [m1, m2] = [...byFragment.values()].find((g) => g.length >= 2) ?? [];
		if (!m1 || !m2) throw new Error("no fragment with two mentions");
		const insert = (localId: string, target: string, relation: string) =>
			env.db.run(
				`INSERT INTO knowledge_relation_mentions (version_id, fragment_ordinal, local_id, source_local_id,
 target_local_id, directed, relation, description, keywords_json, qualifier_negated, qualifier_condition, qualifier_certainty)
VALUES (?, ?, ?, ?, ?, 1, ?, 'd', '["k","l"]', 1, 'if so', 'uncertain')`,
				[
					m1.versionId,
					m1.fragmentOrdinal,
					localId,
					m1.localId,
					target,
					relation,
				],
			);
		insert("r1", m2.localId, "partner");
		const ids = mentions.map((m) => m.entityId);
		const read = readGraphRelationsAmongInSnapshot(env.db, ids, 10);
		expect(read.truncated).toBe(false);
		expect(read.relations).toEqual([
			{
				relationId: expect.any(Number),
				versionId: m1.versionId,
				fragmentOrdinal: m1.fragmentOrdinal,
				sourceLocalId: m1.localId,
				targetLocalId: m2.localId,
				directed: true,
				relation: "partner",
				keywords: ["k", "l"],
				negated: true,
				condition: "if so",
				certainty: "uncertain",
			},
		]);
		// Only relations whose two ends are both among the mentions given are read.
		expect(
			readGraphRelationsAmongInSnapshot(env.db, [m1.entityId], 10),
		).toEqual({
			relations: [],
			truncated: false,
		});
		expect(readGraphRelationsAmongInSnapshot(env.db, [], 10)).toEqual({
			relations: [],
			truncated: false,
		});
		// A second relation of the same ends, and one whose target is no mention (never read).
		insert("r0", m2.localId, "x");
		insert("r2", "e999", "y");
		const cut = readGraphRelationsAmongInSnapshot(env.db, ids, 1);
		expect(cut.truncated).toBe(true);
		expect(cut.relations.map((r) => r.relation)).toEqual(["x"]);
		const both = readGraphRelationsAmongInSnapshot(env.db, ids, 2);
		expect(both.truncated).toBe(false);
		expect(both.relations.map((r) => r.relation)).toEqual(["x", "partner"]);
		expect(() => readGraphRelationsAmongInSnapshot(env.db, ids, 0)).toThrow();
		// Two ends of one key are one node's loop: not read, so they never spend the cap.
		const setKey = (entityId: number, key: string) =>
			env.db.run(
				"UPDATE knowledge_entity_mentions SET name_key = ? WHERE entity_id = ?",
				[key, entityId],
			);
		setKey(m1.entityId, "lantern");
		setKey(m2.entityId, "lantern");
		expect(readGraphRelationsAmongInSnapshot(env.db, ids, 1)).toEqual({
			relations: [],
			truncated: false,
		});
		setKey(m2.entityId, "mysql");
		expect(
			readGraphRelationsAmongInSnapshot(env.db, ids, 2).relations,
		).toHaveLength(2);

		const evidence = readGraphEvidenceInSnapshot(
			env.db,
			"entity",
			mentions.map((m) => m.entityId),
			3,
		);
		expect(evidence.map((e) => e.subjectId)).toEqual(
			evidence.map((e) => e.subjectId).sort((a, b) => a - b),
		);
		expect(new Set(evidence.map((e) => e.subjectId))).toEqual(
			new Set(mentions.map((m) => m.entityId)),
		);
		expect(
			readGraphEvidenceInSnapshot(
				env.db,
				"relation",
				[read.relations[0]!.relationId],
				3,
			),
		).toEqual([]);
		const perSubject = (
			rows(
				env.db,
				"SELECT MAX(position) AS p FROM knowledge_evidence WHERE subject_kind = 'entity'",
			)[0] as { p: number }
		).p;
		expect(perSubject).toBeGreaterThanOrEqual(0);
		expect(readGraphEvidenceInSnapshot(env.db, "entity", [], 3)).toEqual([]);
		expect(() =>
			readGraphEvidenceInSnapshot(env.db, "entity", [1], 0),
		).toThrow();
	});
});
