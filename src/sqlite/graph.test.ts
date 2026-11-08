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
	readGraphRelationsInSnapshot,
	readGraphLinksInSnapshot,
} from "./graph.js";

async function populated(): Promise<LinkEnv> {
	const env = makeLinkEnv();
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

		// The scripted extraction has no relation: insert one for the first version.
		env.db.run(
			`INSERT INTO knowledge_relation_mentions (version_id, fragment_ordinal, local_id, source_local_id,
 target_local_id, directed, relation, description, keywords_json, qualifier_negated, qualifier_condition, qualifier_certainty)
VALUES (?, 0, 'r1', 'e1', 'e2', 1, 'partner', 'd', '["k","l"]', 1, 'if so', 'uncertain')`,
			[versions[0]!],
		);
		const read = readGraphRelationsInSnapshot(env.db, versions, 10);
		expect(read.truncated).toBe(false);
		const relations = read.relations;
		expect(relations).toEqual([
			{
				relationId: expect.any(Number),
				versionId: versions[0]!,
				fragmentOrdinal: 0,
				sourceLocalId: "e1",
				targetLocalId: "e2",
				directed: true,
				relation: "partner",
				keywords: ["k", "l"],
				negated: true,
				condition: "if so",
				certainty: "uncertain",
			},
		]);
		expect(readGraphRelationsInSnapshot(env.db, [versions[1]!], 10)).toEqual({
			relations: [],
			truncated: false,
		});
		// More relations than the cap: the first ones in (version, fragment, local id) order.
		env.db.run(
			`INSERT INTO knowledge_relation_mentions (version_id, fragment_ordinal, local_id, source_local_id,
 target_local_id, directed, relation, description, keywords_json, qualifier_negated, qualifier_condition, qualifier_certainty)
VALUES (?, 0, 'r0', 'e1', 'e2', 0, 'x', 'd', '[]', 0, NULL, 'stated'),
 (?, 1, 'a', 'e1', 'e2', 0, 'y', 'd', '[]', 0, NULL, 'stated')`,
			[versions[0]!, versions[0]!],
		);
		const cut = readGraphRelationsInSnapshot(env.db, versions, 2);
		expect(cut.truncated).toBe(true);
		expect(cut.relations.map((r) => [r.fragmentOrdinal, r.relation])).toEqual([
			[0, "x"],
			[0, "partner"],
		]);
		expect(readGraphRelationsInSnapshot(env.db, versions, 3).truncated).toBe(
			false,
		);
		expect(() => readGraphRelationsInSnapshot(env.db, versions, 0)).toThrow();

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
				[relations[0]!.relationId],
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
