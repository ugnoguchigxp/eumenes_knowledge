import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrations } from "./schema.js";

test("the identity-key migration keeps the rows of a database made before it (kg2.md G4)", () => {
	const db = new Database(":memory:");
	db.exec(migrations[0] as string);
	db.exec(migrations[1] as string);
	// A mention written before the key existed (its version row is not needed here).
	db.exec("PRAGMA foreign_keys = OFF");
	db.run(
		`INSERT INTO knowledge_entity_mentions (version_id, fragment_ordinal, local_id, name, type, description)
VALUES (1, 0, 'e1', 'Lantern', 'product', 'd')`,
	);
	db.exec(migrations[2] as string);
	expect(
		db.query("SELECT name, name_key FROM knowledge_entity_mentions").all(),
	).toEqual([{ name: "Lantern", name_key: "" }]);
	expect(
		db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'knowledge_entity_mentions_name_key'",
			)
			.all(),
	).toHaveLength(1);
	db.close();
});

test("the extractor migration keeps the versions written before it, recorded as '' (kg2.md G7)", () => {
	const db = new Database(":memory:");
	for (const m of migrations.slice(0, 3)) db.exec(m);
	db.exec("PRAGMA foreign_keys = OFF");
	db.run(
		`INSERT INTO knowledge_versions (source_namespace, document_id, markdown_sha256, generation,
 ingest_retry, namespace, byte_length, state, expected_fragments, instruction_digest, created_at)
VALUES ('docling', 'd1', ?, 0, 0, 'wiki', 3, 'published', 1, 'x', 0)`,
		["a".repeat(64)],
	);
	db.exec(migrations[3] as string);
	expect(
		db
			.query(
				"SELECT extractor, reextract_not_before, reextract_failures FROM knowledge_versions",
			)
			.all(),
	).toEqual([
		{ extractor: "", reextract_not_before: 0, reextract_failures: 0 },
	]);
	expect(
		db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'knowledge_versions_reextract'",
			)
			.all(),
	).toHaveLength(1);
	db.close();
});

test("the truncation migration adds the column, 0 for the versions written before it (kg2.md §7.10)", () => {
	const db = new Database(":memory:");
	for (const m of migrations.slice(0, 5)) db.exec(m);
	db.exec("PRAGMA foreign_keys = OFF");
	db.run(
		`INSERT INTO knowledge_versions (source_namespace, document_id, markdown_sha256, generation,
 ingest_retry, namespace, byte_length, state, expected_fragments, instruction_digest, created_at)
VALUES ('docling', 'd1', ?, 0, 0, 'wiki', 3, 'published', 1, 'x', 0)`,
		["a".repeat(64)],
	);
	db.exec(migrations[5] as string);
	expect(
		db.query("SELECT extraction_truncated AS t FROM knowledge_versions").all(),
	).toEqual([{ t: 0 }]);
	expect(() =>
		db.run("UPDATE knowledge_versions SET extraction_truncated = 2"),
	).toThrow();
	db.close();
});

test("the last migration drops the relation pairs, and the versions stay (kg2.md §7.14)", () => {
	const db = new Database(":memory:");
	for (const m of migrations.slice(0, 7)) db.exec(m);
	db.exec("PRAGMA foreign_keys = OFF");
	db.run(
		`INSERT INTO knowledge_versions (source_namespace, document_id, markdown_sha256, generation,
 ingest_retry, namespace, byte_length, state, expected_fragments, instruction_digest, created_at)
VALUES ('docling', 'd1', ?, 0, 0, 'wiki', 3, 'published', 1, 'x', 0)`,
		["a".repeat(64)],
	);
	db.run(
		`INSERT INTO knowledge_relation_pairs (version_id, source_key, target_key, directed, negated,
 certainty, relation, mentions, first_ids) VALUES (1, 'a', 'b', 0, 0, 'stated', '同じ文', 1, '[1]')`,
	);
	expect(migrations).toHaveLength(8);
	db.exec(migrations[7] as string);
	expect(
		db
			.query(
				"SELECT name FROM sqlite_master WHERE name LIKE 'knowledge_relation_pairs%'",
			)
			.all(),
	).toEqual([]);
	expect(
		db.query("SELECT COUNT(*) AS n FROM knowledge_versions").get(),
	).toEqual({ n: 1 });
	db.close();
});
