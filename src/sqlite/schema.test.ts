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
