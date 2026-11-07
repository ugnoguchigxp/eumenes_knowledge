import { describe, expect, test } from "bun:test";
import { embeddingSpaceKey } from "../contracts/index.js";
import {
	SPACE,
	docId,
	inferenceOk,
	makeDoc,
	makeEnv,
	rows,
	syncAll,
	type Env,
} from "../core/harness.fixture.js";
import { mentionAnswer } from "../core/search/search.fixture.js";
import {
	cleanupInTransaction,
	countSearchableFragmentsInSnapshot,
	listSearchableVersionIdsInSnapshot,
	readEvidenceTargetInSnapshot,
	readSearchCoverageInSnapshot,
	readSearchableFragmentsInSnapshot,
	retireDocumentInTransaction,
	scanFragmentsInSnapshot,
	scanMentionsInSnapshot,
	searchFragmentsInSnapshot,
	searchMentionsInSnapshot,
} from "./index.js";
import {
	listPublishedVersionsOfSpaceInSnapshot,
	readFragmentsOverlappingInSnapshot,
	readVersionVectorMatrixInSnapshot,
} from "./reads.js";

const NS = ["wiki"];
const spaceKey = embeddingSpaceKey(SPACE);

async function ready(): Promise<Env> {
	const env = makeEnv();
	env.inference.script = (request) => inferenceOk(mentionAnswer(request));
	env.source.namespaces = ["wiki", "other"];
	env.source.put(
		makeDoc(
			1,
			`# One\n\n${"a".repeat(1500)}\n\nTokyo weather is fine today. ${"b".repeat(1500)}\n`,
		),
	);
	env.source.put(makeDoc(2, "# Two\n\nOsaka food is famous.\n"));
	env.source.put(
		makeDoc(3, "# Three\n\nSecret Tokyo notes.\n", { namespace: "other" }),
	);
	await syncAll(env);
	return env;
}

const count = (env: Env, table: string) =>
	rows(env.db, `SELECT 1 FROM ${table}`).length;

describe("mention full-text index", () => {
	test("staging writes one index row per mention, in normalized text", async () => {
		const env = await ready();
		expect(count(env, "knowledge_entity_fts")).toBe(
			count(env, "knowledge_entity_mentions"),
		);
		expect(count(env, "knowledge_relation_fts")).toBe(
			count(env, "knowledge_relation_mentions"),
		);
		expect(count(env, "knowledge_entity_fts")).toBeGreaterThan(0);
		const text = rows(
			env.db,
			"SELECT search_text AS t FROM knowledge_entity_fts LIMIT 1",
		)[0]!.t as string;
		expect(text).toBe(text.normalize("NFKC").toLowerCase());
		expect(text.split("\n").length).toBeGreaterThanOrEqual(3);
	});

	test("cleanup removes the index rows of retired versions, and nothing else", async () => {
		const env = await ready();
		const before = count(env, "knowledge_entity_fts");
		env.db.transaction(() =>
			retireDocumentInTransaction(
				env.db,
				{ sourceNamespace: "docling", documentId: docId(2) },
				"removed",
				env.clock.t,
			),
		)();
		let steps = 0;
		while (
			env.db.transaction(() =>
				cleanupInTransaction(env.db, 5, { now: env.clock.t }),
			)().more
		) {
			steps++;
			expect(steps).toBeLessThan(200);
		}
		expect(count(env, "knowledge_entity_fts")).toBeLessThan(before);
		expect(count(env, "knowledge_entity_fts")).toBe(
			count(env, "knowledge_entity_mentions"),
		);
		expect(count(env, "knowledge_relation_fts")).toBe(
			count(env, "knowledge_relation_mentions"),
		);
		expect(
			searchMentionsInSnapshot(env.db, "entity", "name-", 10, NS).length,
		).toBeGreaterThan(0);
	});
});

describe("reads fail closed on namespaces", () => {
	test("an empty namespace list returns nothing from every read", async () => {
		const env = await ready();
		const none: string[] = [];
		expect(searchFragmentsInSnapshot(env.db, "tokyo", 10, none)).toEqual([]);
		expect(scanFragmentsInSnapshot(env.db, "to", 10, none)).toEqual([]);
		expect(
			searchMentionsInSnapshot(env.db, "entity", "name-", 10, none),
		).toEqual([]);
		expect(scanMentionsInSnapshot(env.db, "relation", "li", 10, none)).toEqual(
			[],
		);
		expect(countSearchableFragmentsInSnapshot(env.db, none)).toBe(0);
		expect(listSearchableVersionIdsInSnapshot(env.db, spaceKey, none)).toEqual(
			[],
		);
		expect(
			readSearchableFragmentsInSnapshot(
				env.db,
				[{ versionId: 1, ordinal: 0 }],
				none,
			),
		).toEqual([]);
		expect(readEvidenceTargetInSnapshot(env.db, docId(1), none)).toBeNull();
		const cov = readSearchCoverageInSnapshot(env.db, none, env.clock.t, {
			verifiedWithinMs: 1e9,
		});
		expect(cov.coverage).toEqual({
			documents: 0,
			searchable: 0,
			stale: 0,
			unavailable: 0,
			failed: 0,
			extractionIncomplete: 0,
		});
	});

	test("a malformed list throws instead of widening", async () => {
		const env = await ready();
		for (const bad of [undefined, null, "wiki"]) {
			expect(() =>
				scanFragmentsInSnapshot(env.db, "to", 10, bad as never),
			).toThrow();
			expect(() =>
				searchMentionsInSnapshot(env.db, "entity", "name", 10, bad as never),
			).toThrow();
			expect(() =>
				countSearchableFragmentsInSnapshot(env.db, bad as never),
			).toThrow();
			expect(() =>
				listSearchableVersionIdsInSnapshot(env.db, spaceKey, bad as never),
			).toThrow();
			expect(() =>
				readEvidenceTargetInSnapshot(env.db, docId(1), bad as never),
			).toThrow();
		}
	});

	test("only the given namespaces and only current documents are read", async () => {
		const env = await ready();
		const docs = (hits: unknown[]) => hits.length;
		expect(docs(scanFragmentsInSnapshot(env.db, "tokyo", 10, NS))).toBe(1);
		expect(docs(scanFragmentsInSnapshot(env.db, "tokyo", 10, ["other"]))).toBe(
			1,
		);
		expect(
			docs(scanFragmentsInSnapshot(env.db, "tokyo", 10, ["wiki", "other"])),
		).toBe(2);
		expect(countSearchableFragmentsInSnapshot(env.db, NS)).toBe(
			rows(
				env.db,
				"SELECT 1 FROM knowledge_fragments f JOIN knowledge_documents d ON d.published_version_id = f.version_id WHERE d.namespace = 'wiki'",
			).length,
		);
		expect(readEvidenceTargetInSnapshot(env.db, docId(3), NS)).toBeNull();
		expect(
			readEvidenceTargetInSnapshot(env.db, docId(3), ["other"]),
		).not.toBeNull();
		// withdrawn: no longer readable
		env.db
			.query(
				"UPDATE knowledge_documents SET state = 'unavailable' WHERE document_id = ?",
			)
			.run(docId(1));
		expect(scanFragmentsInSnapshot(env.db, "tokyo", 10, NS)).toEqual([]);
		expect(
			searchMentionsInSnapshot(env.db, "entity", "name-", 100, NS).length,
		).toBe(
			searchMentionsInSnapshot(env.db, "entity", "name-", 100, NS).filter(
				(m) => m.versionId !== 1,
			).length,
		);
		const ids = listSearchableVersionIdsInSnapshot(env.db, spaceKey, NS);
		expect(ids).toHaveLength(1);
	});
});

describe("internal reads", () => {
	test("published versions of a space, as a packed matrix", async () => {
		const env = await ready();
		const list = listPublishedVersionsOfSpaceInSnapshot(env.db, spaceKey);
		expect(list).toHaveLength(3);
		expect(list[0]!.fragments).toBeGreaterThanOrEqual(2);
		expect(list.slice(1).map((v) => v.fragments)).toEqual([1, 1]);
		expect(listPublishedVersionsOfSpaceInSnapshot(env.db, "nope")).toEqual([]);
		const n = list[0]!.fragments;
		const m = readVersionVectorMatrixInSnapshot(
			env.db,
			list[0]!.versionId,
			spaceKey,
			SPACE.dimension,
			n,
		);
		expect(Array.from(m.ordinals)).toEqual(
			Array.from({ length: n }, (_, i) => i),
		);
		expect(m.matrix).toHaveLength(n * SPACE.dimension);
		expect(() =>
			readVersionVectorMatrixInSnapshot(
				env.db,
				list[0]!.versionId,
				spaceKey,
				SPACE.dimension,
				3,
			),
		).toThrow();
		// a retired version leaves the list
		env.db.transaction(() =>
			retireDocumentInTransaction(
				env.db,
				{ sourceNamespace: "docling", documentId: docId(1) },
				"excluded",
				env.clock.t,
			),
		)();
		expect(
			listPublishedVersionsOfSpaceInSnapshot(env.db, spaceKey),
		).toHaveLength(2);
	});

	test("fragments overlapping a range", async () => {
		const env = await ready();
		const v = listPublishedVersionsOfSpaceInSnapshot(env.db, spaceKey)[0]!;
		const all = readFragmentsOverlappingInSnapshot(
			env.db,
			v.versionId,
			0,
			10_000,
		);
		expect(all.length).toBeGreaterThanOrEqual(2);
		expect(all.map((f) => f.ordinal)).toEqual(all.map((_, i) => i));
		const second = readFragmentsOverlappingInSnapshot(
			env.db,
			v.versionId,
			all[1]!.byteStart,
			all[1]!.byteStart + 1,
		);
		expect(second.map((f) => f.ordinal)).toEqual([1]);
		expect(
			readFragmentsOverlappingInSnapshot(env.db, v.versionId, 10_000, 10_001),
		).toEqual([]);
	});
});
