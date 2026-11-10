import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	KnowledgeError,
	embeddingSpaceKey,
	knowledgeStatusSchema,
	type DocumentSummary,
	type EmbeddingSpace,
	type FragmentExtraction,
} from "../contracts/index.js";
import {
	abandonVersionInTransaction,
	advanceChainInTransaction,
	cleanupInTransaction,
	closeChainInTransaction,
	createStagingVersionInTransaction,
	discardStagingInTransaction,
	getActiveIngestInTransaction,
	getChainInTransaction,
	getDocumentInTransaction,
	getPublishedVersionInSnapshot,
	getVersionInTransaction,
	hasCleanupInTransaction,
	isChainOpenInTransaction,
	countPublishedFragmentsInTransaction,
	markDocumentUnavailableInTransaction,
	markIngestSupersededInTransaction,
	migrations,
	observeDocumentInTransaction,
	openChainInTransaction,
	pickNextDocumentInTransaction,
	publishVersionInTransaction,
	readPublishedVectorsInSnapshot,
	readStatusInSnapshot,
	recordIngestFailureInTransaction,
	recordTransientIngestFailureInTransaction,
	resetIngestFailuresInTransaction,
	pruneScansInTransaction,
	touchChainInTransaction,
	beginScanInTransaction,
	settleScanPageInTransaction,
	failScanInTransaction,
	retireDocumentInTransaction,
	searchFragmentsInSnapshot,
	setActiveIngestInTransaction,
	stageExtractionsInTransaction,
	stageFragmentsInTransaction,
	stageVectorsInTransaction,
	type IngestExpectation,
	type StagingTicket,
} from "./index.js";
import {
	getRetainedVersionInSnapshot,
	listEntityMentionsInSnapshot,
	listEvidenceInSnapshot,
	listExtractionsInSnapshot,
	listFragmentsInSnapshot,
	listRelationMentionsInSnapshot,
	readVersionVectorsInSnapshot,
} from "./reads.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const docId = (n: number) => `wiki-${n.toString(16).padStart(32, "0")}`;
const SPACE: EmbeddingSpace = {
	modelId: "m",
	revision: "1",
	artifactDigest: "a".repeat(64),
	dimension: 3,
	queryPrefix: "q: ",
	passagePrefix: "p: ",
};

function makeDb(): Database {
	const db = new Database(":memory:");
	for (const sql of migrations) db.exec(sql);
	return db;
}

function summary(n: number, body: string, namespace = "wiki"): DocumentSummary {
	const markdownSha256 = sha(body);
	return {
		sourceNamespace: "docling",
		documentId: docId(n),
		namespace,
		path: `d/${n}.md`,
		title: `Doc ${n}`,
		etag: `"${sha(`e${body}`)}"`,
		markdownSha256,
		contentDigest: sha(`c${body}`),
	};
}

type Staged = {
	versionId: number;
	expectation: IngestExpectation;
	ticket: StagingTicket;
};

/** Observe a document (stale), then stage `texts` as fragments with all parts. */
function ingest(
	db: Database,
	n: number,
	texts: string[],
	opts: {
		publish?: boolean;
		failOrdinal?: number;
		body?: string;
		now?: number;
	} = {},
): Staged {
	const body = opts.body ?? texts.join("");
	const now = opts.now ?? 1000;
	const obs = observeDocumentInTransaction(db, summary(n, body), ["wiki"], now);
	const expectation: IngestExpectation = {
		sourceNamespace: "docling",
		documentId: docId(n),
		markdownSha256: sha(body),
		generation: obs.generation,
		retry: obs.retry,
		namespace: "wiki",
	};
	const ticket: StagingTicket = {
		...expectation,
		byteLength: Buffer.byteLength(body),
		expectedFragments: texts.length,
		instructionDigest: "i".repeat(64),
	};
	const versionId = createStagingVersionInTransaction(db, ticket, now);
	let start = 0;
	stageFragmentsInTransaction(
		db,
		versionId,
		texts.map((text, ordinal) => {
			const len = Buffer.byteLength(text);
			const f = {
				ordinal,
				byteStart: start,
				byteEnd: start + len,
				headingPath: ["h"],
				text,
			};
			start += len;
			return { fragment: f, searchText: text.normalize("NFKC").toLowerCase() };
		}),
	);
	stageVectorsInTransaction(
		db,
		versionId,
		SPACE,
		texts.map((_, ordinal) => ({ ordinal, vector: [ordinal, 1, 0.5] })),
	);
	stageExtractionsInTransaction(
		db,
		versionId,
		texts.map((t, ordinal): FragmentExtraction => {
			if (ordinal === opts.failOrdinal) {
				return {
					fragmentOrdinal: ordinal,
					status: "failed",
					errorCode: "invalid_json",
					model: null,
				};
			}
			const fragmentStart = texts
				.slice(0, ordinal)
				.reduce((n, x) => n + Buffer.byteLength(x), 0);
			const ev = {
				fragmentOrdinal: ordinal,
				byteStart: fragmentStart,
				byteEnd: fragmentStart + Math.min(3, Buffer.byteLength(t)),
				quoteSha256: sha(t.slice(0, 1)),
				ambiguous: false,
			};
			return {
				fragmentOrdinal: ordinal,
				status: "ok",
				entities: [
					{ id: "e1", name: "A", type: "t", description: "d", evidence: [ev] },
					{
						id: "e2",
						name: "B",
						type: "t",
						description: "d",
						evidence: [ev, ev],
					},
				],
				relations: [
					{
						id: "r1",
						source: "e1",
						target: "e2",
						directed: true,
						relation: "rel",
						description: "d",
						keywords: ["k1", "k2"],
						qualifiers: {
							negated: false,
							condition: "if",
							certainty: "stated",
						},
						evidence: [ev],
					},
				],
				dropped: [{ reason: "not_in_fragment", count: 2 }],
				model: "mod",
			};
		}),
	);
	const staged = { versionId, expectation, ticket };
	if (opts.publish) {
		expect(
			publishVersionInTransaction(db, versionId, expectation, now + 1),
		).toBe(true);
	}
	return staged;
}

const count = (db: Database, table: string, where = "1=1"): number =>
	db
		.query<{ n: number }, []>(
			`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
		)
		.get()!.n;
const DERIVED = [
	"knowledge_fragments",
	"knowledge_fragment_fts",
	"knowledge_vectors",
	"knowledge_extractions",
	"knowledge_entity_mentions",
	"knowledge_relation_mentions",
	"knowledge_entity_fts",
	"knowledge_relation_fts",
	"knowledge_evidence",
];
const derivedRows = (db: Database) =>
	DERIVED.reduce((n, t) => n + count(db, t), 0);
const throwsCode = (fn: () => unknown, code: KnowledgeError["code"]) => {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(KnowledgeError);
		expect((e as KnowledgeError).code).toBe(code);
		return;
	}
	throw new Error("did not throw");
};
const key = (n: number) => ({
	sourceNamespace: "docling",
	documentId: docId(n),
});

describe("staging to publish", () => {
	test("a whole version is staged, published and readable", () => {
		const db = makeDb();
		const s = ingest(db, 1, ["東京都の天気予報です。", "大阪府の天気です。"]);
		let v = getVersionInTransaction(db, s.versionId)!;
		expect(v.state).toBe("staging");
		expect([
			v.fragmentsWritten,
			v.vectorsWritten,
			v.extractionsWritten,
		]).toEqual([2, 2, 2]);
		expect(v.spaceKey).toBe(embeddingSpaceKey(SPACE));
		expect(getPublishedVersionInSnapshot(db, key(1))).toBeNull();

		expect(
			publishVersionInTransaction(db, s.versionId, s.expectation, 2000),
		).toBe(true);
		v = getPublishedVersionInSnapshot(db, key(1))!;
		expect(v.versionId).toBe(s.versionId);
		expect(v.state).toBe("published");
		expect(v.publishedAt).toBe(2000);
		expect(v.extractionPartial).toBe(false);
		const doc = getDocumentInTransaction(db, key(1))!;
		expect(doc.state).toBe("current");
		expect(doc.publishedVersionId).toBe(s.versionId);
		expect(doc.appliedMarkdownSha256).toBe(s.expectation.markdownSha256);
		expect(doc.appliedByteLength).toBe(s.ticket.byteLength);
		expect(doc.lastVerifiedAt).toBe(2000);

		const frags = listFragmentsInSnapshot(db, s.versionId);
		expect(frags.map((f) => f.text)).toEqual([
			"東京都の天気予報です。",
			"大阪府の天気です。",
		]);
		expect(frags[0]!.headingPath).toEqual(["h"]);
		expect(frags[0]!.textSha256).toBe(sha(frags[0]!.text));
		expect(frags[1]!.byteStart).toBe(frags[0]!.byteEnd);
		expect(listExtractionsInSnapshot(db, s.versionId)[0]).toMatchObject({
			status: "ok",
			model: "mod",
			droppedCount: 2,
			dropped: [{ reason: "not_in_fragment", count: 2 }],
		});
		const ents = listEntityMentionsInSnapshot(db, s.versionId);
		const rels = listRelationMentionsInSnapshot(db, s.versionId);
		const ev = listEvidenceInSnapshot(db, s.versionId);
		expect(ents).toHaveLength(4);
		expect(rels).toHaveLength(2);
		expect(rels[0]).toMatchObject({
			sourceLocalId: "e1",
			directed: true,
			keywords: ["k1", "k2"],
			qualifiers: { negated: false, condition: "if", certainty: "stated" },
		});
		// per fragment: e1 has 1, e2 has 2, r1 has 1
		expect(ev).toHaveLength(8);
		expect(
			ev.filter(
				(e) => e.subjectKind === "entity" && e.subjectId === ents[1]!.entityId,
			),
		).toHaveLength(2);

		const vecs = readVersionVectorsInSnapshot(
			db,
			s.versionId,
			embeddingSpaceKey(SPACE),
		);
		expect(Array.from(vecs[1]!.vector)).toEqual([1, 1, 0.5]);
		expect(
			readPublishedVectorsInSnapshot(db, embeddingSpaceKey(SPACE), ["wiki"]),
		).toHaveLength(2);
		expect(count(db, "knowledge_embedding_spaces")).toBe(1);
	});

	test("a new version retires the previous one", () => {
		const db = makeDb();
		const a = ingest(db, 1, ["古い版の本文です。"], { publish: true });
		const b = ingest(db, 1, ["新しい版の本文です。"], {
			publish: true,
			now: 3000,
		});
		expect(getVersionInTransaction(db, a.versionId)!.state).toBe("retired");
		expect(getVersionInTransaction(db, a.versionId)!.retiredAt).toBe(3001);
		expect(getPublishedVersionInSnapshot(db, key(1))!.versionId).toBe(
			b.versionId,
		);
		// only the published version is read
		expect(
			readPublishedVectorsInSnapshot(db, embeddingSpaceKey(SPACE), ["wiki"]),
		).toHaveLength(1);
		expect(searchFragmentsInSnapshot(db, "古い版の本文", 10, ["wiki"])).toEqual(
			[],
		);
		expect(
			searchFragmentsInSnapshot(db, "新しい版の本文", 10, ["wiki"]),
		).toHaveLength(1);
		expect(hasCleanupInTransaction(db)).toBe(true);
	});

	test("an older staging of the same document is abandoned", () => {
		const db = makeDb();
		const a = ingest(db, 1, ["最初の試行の本文です。"]);
		const b = ingest(db, 1, ["最初の試行の本文です。"]);
		expect(getVersionInTransaction(db, a.versionId)!.state).toBe("abandoned");
		expect(getVersionInTransaction(db, b.versionId)!.state).toBe("staging");
		throwsCode(
			() => stageFragmentsInTransaction(db, a.versionId, []),
			"not_available",
		);
		throwsCode(
			() => stageVectorsInTransaction(db, a.versionId, SPACE, []),
			"not_available",
		);
		throwsCode(
			() => stageExtractionsInTransaction(db, a.versionId, []),
			"not_available",
		);
		// another document's staging is untouched
		const c = ingest(db, 2, ["別の文書の本文です。"]);
		ingest(db, 1, ["最初の試行の本文です。"]);
		expect(getVersionInTransaction(db, c.versionId)!.state).toBe("staging");
	});

	test("publish writes nothing unless the row and the counts match", () => {
		const db = makeDb();
		const s = ingest(db, 1, ["一つ目の断片です。", "二つ目の断片です。"]);
		const docs = () =>
			JSON.stringify(
				db
					.query("SELECT * FROM knowledge_documents WHERE document_id = ?")
					.all(docId(1)),
			);
		const before = docs();

		// the row moved on (new observation: generation advanced)
		const moved = {
			...s.expectation,
			generation: s.expectation.generation + 1,
		};
		expect(publishVersionInTransaction(db, s.versionId, moved, 5)).toBe(false);
		expect(
			publishVersionInTransaction(
				db,
				s.versionId,
				{ ...s.expectation, retry: 1 },
				5,
			),
		).toBe(false);
		expect(
			publishVersionInTransaction(
				db,
				s.versionId,
				{ ...s.expectation, namespace: "x" },
				5,
			),
		).toBe(false);
		expect(
			publishVersionInTransaction(
				db,
				s.versionId,
				{ ...s.expectation, markdownSha256: sha("z") },
				5,
			),
		).toBe(false);
		expect(publishVersionInTransaction(db, 9999, s.expectation, 5)).toBe(false);

		// counts not complete
		const t = ingest(db, 2, ["一つ目の断片です。", "二つ目の断片です。"]);
		db.query(
			"UPDATE knowledge_versions SET extractions_written = 1 WHERE version_id = ?",
		).run(t.versionId);
		expect(publishVersionInTransaction(db, t.versionId, t.expectation, 5)).toBe(
			false,
		);
		db.query(
			"UPDATE knowledge_versions SET extractions_written = 2, vectors_written = 1 WHERE version_id = ?",
		).run(t.versionId);
		expect(publishVersionInTransaction(db, t.versionId, t.expectation, 5)).toBe(
			false,
		);
		db.query(
			"UPDATE knowledge_versions SET vectors_written = 2, fragments_written = 0 WHERE version_id = ?",
		).run(t.versionId);
		expect(publishVersionInTransaction(db, t.versionId, t.expectation, 5)).toBe(
			false,
		);

		expect(docs()).toBe(before);
		expect(getVersionInTransaction(db, s.versionId)!.state).toBe("staging");

		// a row that is no longer stale
		const u = ingest(db, 3, ["三つ目の文書です。"]);
		expect(markDocumentUnavailableInTransaction(db, u.expectation, 6)).toBe(
			true,
		);
		expect(publishVersionInTransaction(db, u.versionId, u.expectation, 7)).toBe(
			false,
		);
		expect(getDocumentInTransaction(db, key(3))!.publishedVersionId).toBeNull();

		// the version was abandoned
		const w = ingest(db, 4, ["四つ目の文書です。"]);
		abandonVersionInTransaction(db, w.versionId);
		expect(publishVersionInTransaction(db, w.versionId, w.expectation, 8)).toBe(
			false,
		);

		// a version cannot be published twice
		expect(publishVersionInTransaction(db, s.versionId, s.expectation, 9)).toBe(
			true,
		);
		expect(
			publishVersionInTransaction(db, s.versionId, s.expectation, 10),
		).toBe(false);
	});

	test("a version staged for another tuple is not published", () => {
		const db = makeDb();
		const s = ingest(db, 1, ["本文のテキストです。"]);
		// the document is observed again with a new body: generation advances
		observeDocumentInTransaction(
			db,
			summary(1, "別の本文です。"),
			["wiki"],
			2000,
		);
		expect(
			publishVersionInTransaction(db, s.versionId, s.expectation, 3000),
		).toBe(false);
		expect(getDocumentInTransaction(db, key(1))!.state).toBe("stale");
	});

	test("extraction partial is recorded at publish", () => {
		const db = makeDb();
		const s = ingest(db, 1, ["一つ目です。", "二つ目です。"], {
			publish: true,
			failOrdinal: 1,
		});
		expect(getVersionInTransaction(db, s.versionId)!.extractionPartial).toBe(
			true,
		);
		expect(listExtractionsInSnapshot(db, s.versionId)[1]).toMatchObject({
			status: "failed",
			errorCode: "invalid_json",
		});
	});

	test("an empty body publishes with zero fragments", () => {
		const db = makeDb();
		const s = ingest(db, 1, [], { publish: true, body: "" });
		expect(getPublishedVersionInSnapshot(db, key(1))!.versionId).toBe(
			s.versionId,
		);
	});
});

describe("staging validation", () => {
	function open() {
		const db = makeDb();
		observeDocumentInTransaction(db, summary(1, "abc"), ["wiki"], 1);
		const t: StagingTicket = {
			sourceNamespace: "docling",
			documentId: docId(1),
			markdownSha256: sha("abc"),
			generation: 0,
			retry: 0,
			namespace: "wiki",
			byteLength: 3,
			expectedFragments: 2,
			instructionDigest: "d",
		};
		return { db, id: createStagingVersionInTransaction(db, t, 1), t };
	}

	test("the dimension CHECK and vector validation", () => {
		const { db, id } = open();
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 0, vector: [1, 2] },
				]),
			"invalid_input",
		);
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 0, vector: [1, NaN, 2] },
				]),
			"invalid_input",
		);
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 0, vector: [1, Infinity, 2] },
				]),
			"invalid_input",
		);
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 0, vector: [1e300, 0, 0] },
				]),
			"invalid_input",
		);
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 2, vector: [1, 2, 3] },
				]),
			"invalid_input",
		);
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 0, vector: [1, 2, 3] },
					{ ordinal: 0, vector: [1, 2, 3] },
				]),
			"invalid_input",
		);
		throwsCode(
			() => stageVectorsInTransaction(db, id, { ...SPACE, dimension: 0 }, []),
			"invalid_input",
		);
		throwsCode(
			() => stageVectorsInTransaction(db, id, { ...SPACE, dimension: 1.5 }, []),
			"invalid_input",
		);
		throwsCode(
			() => stageVectorsInTransaction(db, id, { ...SPACE, modelId: "" }, []),
			"invalid_input",
		);
		expect(count(db, "knowledge_vectors")).toBe(0);
		expect(getVersionInTransaction(db, id)!.spaceKey).toBeNull();
		// the table's own CHECK rejects a blob of the wrong length
		expect(() =>
			db
				.query(
					"INSERT INTO knowledge_embedding_spaces VALUES ('k','m','r','d',3,'','')",
				)
				.run(),
		).not.toThrow();
		expect(() =>
			db
				.query(
					"INSERT INTO knowledge_vectors (space_key, version_id, ordinal, dimension, vector) VALUES ('k', ?, 0, 3, ?)",
				)
				.run(id, new Uint8Array(11)),
		).toThrow();
		expect(() =>
			db
				.query(
					"INSERT INTO knowledge_vectors (space_key, version_id, ordinal, dimension, vector) VALUES ('k', ?, 0, 3, ?)",
				)
				.run(id, new Uint8Array(12)),
		).not.toThrow();
		// and the unique key (space, version, ordinal)
		expect(() =>
			db
				.query(
					"INSERT INTO knowledge_vectors (space_key, version_id, ordinal, dimension, vector) VALUES ('k', ?, 0, 3, ?)",
				)
				.run(id, new Uint8Array(12)),
		).toThrow();
	});

	test("a second space in one version is rejected", () => {
		const { db, id } = open();
		stageVectorsInTransaction(db, id, SPACE, [
			{ ordinal: 0, vector: [1, 2, 3] },
		]);
		stageVectorsInTransaction(db, id, SPACE, [
			{ ordinal: 1, vector: [1, 2, 3] },
		]);
		for (const other of [
			{ ...SPACE, modelId: "other" },
			{ ...SPACE, queryPrefix: "x" },
			{ ...SPACE, dimension: 4 },
		]) {
			throwsCode(
				() =>
					stageVectorsInTransaction(db, id, other, [
						{
							ordinal: 0,
							vector: Array.from({ length: other.dimension }, () => 1),
						},
					]),
				"invalid_input",
			);
		}
		expect(count(db, "knowledge_embedding_spaces")).toBe(1);
		expect(getVersionInTransaction(db, id)!.vectorsWritten).toBe(2);
		// more than expected
		throwsCode(
			() =>
				stageVectorsInTransaction(db, id, SPACE, [
					{ ordinal: 0, vector: [1, 2, 3] },
				]),
			"invalid_input",
		);
	});

	test("fragment and extraction checks", () => {
		const { db, id } = open();
		const frag = (
			ordinal: number,
			text: string,
			byteStart = 0,
			byteEnd = Buffer.byteLength(text),
		) => ({
			fragment: { ordinal, byteStart, byteEnd, headingPath: [], text },
			searchText: text,
		});
		throwsCode(
			() => stageFragmentsInTransaction(db, id, [frag(2, "x")]),
			"invalid_input",
		);
		throwsCode(
			() => stageFragmentsInTransaction(db, id, [frag(0, "あ", 0, 2)]),
			"invalid_input",
		);
		throwsCode(
			() => stageFragmentsInTransaction(db, id, [frag(0, "x", 3, 3)]),
			"invalid_input",
		);
		throwsCode(
			() => stageFragmentsInTransaction(db, id, [frag(0, "x"), frag(0, "y")]),
			"invalid_input",
		);
		expect(count(db, "knowledge_fragments")).toBe(0);
		stageFragmentsInTransaction(db, id, [frag(0, "x")]);
		// the same ordinal again is a unique violation
		expect(() => stageFragmentsInTransaction(db, id, [frag(0, "x")])).toThrow();

		const bad = (x: FragmentExtraction) =>
			throwsCode(
				() => stageExtractionsInTransaction(db, id, [x]),
				"invalid_input",
			);
		const ev = {
			fragmentOrdinal: 0,
			byteStart: 0,
			byteEnd: 1,
			quoteSha256: sha("x"),
			ambiguous: false,
		};
		const ent = {
			id: "e1",
			name: "n",
			type: "t",
			description: "d",
			evidence: [ev],
		};
		bad({
			fragmentOrdinal: 0,
			status: "ok",
			entities: [ent, ent],
			relations: [],
			dropped: [],
			model: null,
		});
		bad({
			fragmentOrdinal: 0,
			status: "ok",
			entities: [{ ...ent, evidence: [{ ...ev, fragmentOrdinal: 1 }] }],
			relations: [],
			dropped: [],
			model: null,
		});
		bad({
			fragmentOrdinal: 0,
			status: "ok",
			entities: [ent],
			relations: [
				{
					id: "r1",
					source: "e1",
					target: "e9",
					directed: false,
					relation: "r",
					description: "d",
					keywords: [],
					qualifiers: { negated: false, condition: null, certainty: "stated" },
					evidence: [ev],
				},
			],
			dropped: [],
			model: null,
		});
		bad({ fragmentOrdinal: 5, status: "failed", errorCode: "x", model: null });
		bad({ fragmentOrdinal: 0, status: "failed", errorCode: "", model: null });
		// An identity key is a non-empty string of at most keyChars.
		for (const key of ["", "k".repeat(401), 7 as never]) {
			bad({
				fragmentOrdinal: 0,
				status: "ok",
				entities: [{ ...ent, key }],
				relations: [],
				dropped: [],
				model: null,
			});
		}
		expect(count(db, "knowledge_extractions")).toBe(0);
		const rel = (id: string, source: string, target: string) => ({
			id,
			source,
			target,
			directed: false,
			relation: "r",
			description: "",
			keywords: [],
			qualifiers: {
				negated: false,
				condition: null,
				certainty: "stated" as const,
			},
			evidence: [ev],
		});
		// The key is stored with the mention; a mention without one stores ''.
		stageExtractionsInTransaction(db, id, [
			{
				fragmentOrdinal: 0,
				status: "ok",
				entities: [
					{ ...ent, key: "lantern" },
					{ ...ent, id: "e2" },
					{ ...ent, id: "e3", key: "mysql" },
				],
				relations: [
					// Indexed, whatever its ends (the model-free extractor makes none, kg2.md §7.14).
					{ ...rel("r1", "e1", "e2"), relation: "uses" },
					{ ...rel("r2", "e1", "e3"), relation: "uses" },
				],
				dropped: [],
				model: "names:charclass@rules8",
			},
		]);
		expect(
			db
				.query(
					"SELECT local_id, name_key FROM knowledge_entity_mentions ORDER BY local_id",
				)
				.all(),
		).toEqual([
			{ local_id: "e1", name_key: "lantern" },
			{ local_id: "e2", name_key: "" },
			{ local_id: "e3", name_key: "mysql" },
		]);
		// A keyed mention is indexed by its name alone; the other by name, type and description.
		expect(
			db
				.query(
					`SELECT m.local_id, f.search_text FROM knowledge_entity_fts f
JOIN knowledge_entity_mentions m ON m.entity_id = f.rowid ORDER BY m.local_id`,
				)
				.all(),
		).toEqual([
			{ local_id: "e1", search_text: "n" },
			{ local_id: "e2", search_text: "n\nt\nd" },
			{ local_id: "e3", search_text: "n" },
		]);
		expect(
			db
				.query(
					`SELECT m.local_id FROM knowledge_relation_fts f
JOIN knowledge_relation_mentions m ON m.relation_id = f.rowid ORDER BY m.local_id`,
				)
				.all(),
		).toEqual([{ local_id: "r1" }, { local_id: "r2" }]);
	});

	test("evidence must lie inside its fragment's byte range", () => {
		const { db, id } = open();
		const f = (ordinal: number, text: string, byteStart: number) => ({
			fragment: {
				ordinal,
				byteStart,
				byteEnd: byteStart + Buffer.byteLength(text),
				headingPath: [],
				text,
			},
			searchText: text,
		});
		stageFragmentsInTransaction(db, id, [f(0, "abcd", 0), f(1, "efgh", 4)]);
		const ok = (ordinal: number, byteStart: number, byteEnd: number) =>
			({
				fragmentOrdinal: ordinal,
				status: "ok",
				entities: [
					{
						id: "e1",
						name: "n",
						type: "t",
						description: "d",
						evidence: [
							{
								fragmentOrdinal: ordinal,
								byteStart,
								byteEnd,
								quoteSha256: sha("q"),
								ambiguous: false,
							},
						],
					},
				],
				relations: [],
				dropped: [],
				model: null,
			}) satisfies FragmentExtraction;
		// Fragment 1 is [4, 8): a range of fragment 0, or one that sticks out, is refused.
		for (const [a, b] of [
			[0, 3],
			[3, 5],
			[6, 9],
			[8, 9],
		] as const) {
			throwsCode(
				() => stageExtractionsInTransaction(db, id, [ok(1, a, b)]),
				"invalid_input",
			);
		}
		expect(count(db, "knowledge_extractions")).toBe(0);
		// An extraction of a fragment that was never staged is refused too.
		throwsCode(
			() => stageExtractionsInTransaction(db, id, [ok(2, 8, 9)]),
			"invalid_input",
		);
		stageExtractionsInTransaction(db, id, [ok(1, 4, 8), ok(0, 0, 4)]);
		expect(count(db, "knowledge_evidence")).toBe(2);
	});

	test("discarding staging abandons exactly the versions of one tuple", () => {
		const db = makeDb();
		const a = ingest(db, 1, ["a"]);
		// Not touched: another document's staging.
		const other = ingest(db, 2, ["b"]);
		const n = discardStagingInTransaction(db, a.expectation, 5000);
		expect(n).toBe(1);
		expect(getVersionInTransaction(db, a.versionId)!.state).toBe("abandoned");
		expect(getVersionInTransaction(db, other.versionId)!.state).toBe("staging");
		expect(discardStagingInTransaction(db, a.expectation, 6000)).toBe(0);
		// A different tuple (older retry) does not match.
		expect(
			discardStagingInTransaction(
				db,
				{ ...other.expectation, retry: other.expectation.retry + 1 },
				6000,
			),
		).toBe(0);
		expect(getVersionInTransaction(db, other.versionId)!.state).toBe("staging");
	});

	test("a ticket must name a registered document", () => {
		const { db, t } = open();
		throwsCode(
			() =>
				createStagingVersionInTransaction(
					db,
					{ ...t, documentId: docId(9) },
					1,
				),
			"not_available",
		);
		throwsCode(
			() =>
				createStagingVersionInTransaction(
					db,
					{ ...t, expectedFragments: -1 },
					1,
				),
			"invalid_input",
		);
		throwsCode(
			() =>
				createStagingVersionInTransaction(db, { ...t, markdownSha256: "x" }, 1),
			"invalid_input",
		);
	});
});

describe("withdrawal and cleanup", () => {
	test("excluded and removed retire the published version; unavailable keeps it", () => {
		const db = makeDb();
		const a = ingest(db, 1, ["除外される文書です。"], { publish: true });
		const b = ingest(db, 2, ["削除される文書です。"], { publish: true });
		const c = ingest(db, 3, ["到達不能な文書です。"], { publish: true });
		const d = ingest(db, 4, ["準備中の文書です。"]);

		expect(retireDocumentInTransaction(db, key(1), "excluded", 5000)).toBe(
			true,
		);
		expect(retireDocumentInTransaction(db, key(2), "removed", 5000)).toBe(true);
		expect(retireDocumentInTransaction(db, key(4), "excluded", 5000)).toBe(
			true,
		);
		expect(retireDocumentInTransaction(db, key(99), "removed", 5000)).toBe(
			false,
		);
		for (const x of [a, b]) {
			expect(getVersionInTransaction(db, x.versionId)!.state).toBe("retired");
		}
		expect(getVersionInTransaction(db, d.versionId)!.state).toBe("abandoned");
		expect(getPublishedVersionInSnapshot(db, key(1))).toBeNull();
		expect(getDocumentInTransaction(db, key(1))!.publishedVersionId).toBeNull();
		expect(
			searchFragmentsInSnapshot(db, "除外される文書", 5, ["wiki"]),
		).toEqual([]);

		// unavailable: set by an outside-namespace listing
		observeDocumentInTransaction(
			db,
			summary(3, "到達不能な文書です。", "other"),
			["wiki"],
			6000,
		);
		expect(getDocumentInTransaction(db, key(3))!.state).toBe("unavailable");
		expect(getVersionInTransaction(db, c.versionId)!.state).toBe("published");
		expect(getRetainedVersionInSnapshot(db, key(3))!.versionId).toBe(
			c.versionId,
		);
		// the read by state fails closed: no version is returned for an unavailable document
		expect(getPublishedVersionInSnapshot(db, key(3))).toBeNull();
		// but reads exclude it by state
		expect(
			searchFragmentsInSnapshot(db, "到達不能な文書", 5, ["wiki"]),
		).toEqual([]);
		expect(
			readPublishedVectorsInSnapshot(db, embeddingSpaceKey(SPACE), ["wiki"]),
		).toHaveLength(0);
	});

	test("cleanup is bounded, removes index rows and finally the version rows", () => {
		const db = makeDb();
		const texts = Array.from(
			{ length: 6 },
			(_, i) => `断片${i}番の本文テキスト`,
		);
		ingest(db, 1, texts, { publish: true });
		const keep = ingest(db, 2, ["残る文書の本文です。"], { publish: true });
		retireDocumentInTransaction(db, key(1), "removed", 9);
		const keepRows = derivedRows(db) - 0;
		const total = derivedRows(db) - 0;
		expect(count(db, "knowledge_fragment_fts")).toBe(7);
		expect(hasCleanupInTransaction(db)).toBe(true);
		expect(() => cleanupInTransaction(db, 0, { now: 1_000 })).toThrow();

		let deleted = 0;
		let calls = 0;
		for (;;) {
			const before = derivedRows(db) + count(db, "knowledge_versions");
			const r = cleanupInTransaction(db, 7, { now: 1_000 });
			const after = derivedRows(db) + count(db, "knowledge_versions");
			expect(r.deletedRows).toBeLessThanOrEqual(7);
			expect(before - after).toBe(r.deletedRows);
			deleted += r.deletedRows;
			calls++;
			expect(calls).toBeLessThan(100);
			if (!r.more) break;
			expect(r.deletedRows).toBeGreaterThan(0);
		}
		expect(calls).toBeGreaterThan(3);
		expect(hasCleanupInTransaction(db)).toBe(false);
		expect(count(db, "knowledge_versions")).toBe(1);
		expect(count(db, "knowledge_fragment_fts")).toBe(1);
		expect(count(db, "knowledge_fragments")).toBe(1);
		expect(
			count(db, "knowledge_evidence", `version_id = ${keep.versionId}`),
		).toBe(count(db, "knowledge_evidence"));
		expect(deleted).toBe(total - derivedRows(db) + 1);
		expect(keepRows).toBe(total);
		// nothing left to do
		expect(cleanupInTransaction(db, 10, { now: 1_000 })).toEqual({
			deletedRows: 0,
			more: false,
		});
		// the surviving document is intact
		expect(
			searchFragmentsInSnapshot(db, "残る文書の本文", 5, ["wiki"]),
		).toHaveLength(1);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("cleanup with a budget of one still makes progress", () => {
		const db = makeDb();
		ingest(db, 1, ["ひとつだけの断片です。"]);
		const v = ingest(db, 1, ["ひとつだけの断片です。"]);
		let steps = 0;
		while (cleanupInTransaction(db, 1, { now: 1_000 }).more) steps++;
		expect(steps).toBeLessThan(60);
		expect(count(db, "knowledge_versions")).toBe(1);
		expect(getVersionInTransaction(db, v.versionId)!.state).toBe("staging");
		expect(count(db, "knowledge_fragment_fts")).toBe(1);
	});
});

describe("search", () => {
	test("finds only the published version of current documents", () => {
		const db = makeDb();
		ingest(db, 1, ["東京都の天気予報は晴れです。"], { publish: true });
		ingest(db, 2, ["東京都の人口について。"]); // staging only
		ingest(db, 3, ["東京都の観光案内です。"], { publish: true });
		retireDocumentInTransaction(db, key(3), "excluded", 9);
		const hits = searchFragmentsInSnapshot(db, "東京都の", 10, ["wiki"]);
		expect(hits.map((h) => h.documentId)).toEqual([docId(1)]);
		expect(hits[0]).toMatchObject({
			ordinal: 0,
			namespace: "wiki",
			headingPath: ["h"],
		});
		expect(hits[0]!.text).toBe("東京都の天気予報は晴れです。");
		// fullwidth / uppercase in the index are normalized by the caller, query is the same form
		expect(searchFragmentsInSnapshot(db, "東京", 10, ["wiki"])).toEqual([]); // too short
		expect(
			searchFragmentsInSnapshot(db, "存在しない語句です", 10, ["wiki"]),
		).toEqual([]);
		expect(
			searchFragmentsInSnapshot(db, '"天気予報" OR x', 10, ["wiki"]),
		).toEqual([]);
		expect(searchFragmentsInSnapshot(db, "東京都の", 10, ["other"])).toEqual(
			[],
		);
		expect(
			searchFragmentsInSnapshot(db, "東京都の", 10, ["wiki"]),
		).toHaveLength(1);
		expect(() =>
			searchFragmentsInSnapshot(db, "東京都の", 0, ["wiki"]),
		).toThrow();

		// a stale document is not returned (new body observed), nor an unavailable one
		observeDocumentInTransaction(db, summary(1, "別の本文"), ["wiki"], 20);
		expect(searchFragmentsInSnapshot(db, "東京都の", 10, ["wiki"])).toEqual([]);
	});

	test("the limit applies after the filters", () => {
		const db = makeDb();
		for (let i = 1; i <= 5; i++)
			ingest(db, i, [`共通の語句を含む文書${i}です。`], {
				publish: i % 2 === 1,
			});
		expect(
			searchFragmentsInSnapshot(db, "共通の語句", 2, ["wiki"]),
		).toHaveLength(2);
		expect(
			searchFragmentsInSnapshot(db, "共通の語句", 10, ["wiki"]),
		).toHaveLength(3);
	});
});

describe("unapplied attempts of a version", () => {
	test("observing a different version restarts the count; the same version keeps it", () => {
		const db = makeDb();
		const first = summary(1, "v1");
		observeDocumentInTransaction(db, first, ["wiki"], 100);
		const expectation: IngestExpectation = {
			sourceNamespace: "docling",
			documentId: docId(1),
			markdownSha256: first.markdownSha256,
			generation: 0,
			retry: 0,
			namespace: "wiki",
		};
		expect(recordIngestFailureInTransaction(db, expectation, 110)).toBe(true);
		const again = observeDocumentInTransaction(db, first, ["wiki"], 120);
		expect(again.retry).toBe(1);
		expect(getDocumentInTransaction(db, expectation)!.ingestRetry).toBe(1);
		const next = observeDocumentInTransaction(
			db,
			summary(1, "v2"),
			["wiki"],
			130,
		);
		expect(next.retry).toBe(0);
		expect(getDocumentInTransaction(db, expectation)).toMatchObject({
			ingestRetry: 0,
			generation: 1,
		});
	});
});

describe("ingest chain", () => {
	test("the active document is bound to the open link and cleared when the link moves on", () => {
		const db = makeDb();
		const tuple: IngestExpectation = {
			sourceNamespace: "docling",
			documentId: docId(1),
			markdownSha256: sha("x"),
			generation: 2,
			retry: 1,
			namespace: "wiki",
		};
		expect(setActiveIngestInTransaction(db, 1, tuple)).toBe(false);
		const a = openChainInTransaction(db, 0, 1000)!;
		expect(getActiveIngestInTransaction(db, a)).toBeNull();
		expect(setActiveIngestInTransaction(db, a + 1, tuple)).toBe(false);
		expect(setActiveIngestInTransaction(db, a, tuple)).toBe(true);
		expect(getActiveIngestInTransaction(db, a)).toEqual(tuple);
		expect(getActiveIngestInTransaction(db, a + 1)).toBeNull();
		const b = advanceChainInTransaction(db, a, 10)!;
		expect(getActiveIngestInTransaction(db, a)).toBeNull();
		expect(getActiveIngestInTransaction(db, b)).toBeNull();
		setActiveIngestInTransaction(db, b, tuple);
		setActiveIngestInTransaction(db, b, null);
		expect(getActiveIngestInTransaction(db, b)).toBeNull();
		setActiveIngestInTransaction(db, b, tuple);
		closeChainInTransaction(db, b);
		expect(getActiveIngestInTransaction(db, b)).toBeNull();
		const c = openChainInTransaction(db, 20, 1000)!;
		expect(getActiveIngestInTransaction(db, c)).toBeNull();
	});

	test("sweep numbers are monotonic and never reused", () => {
		const db = makeDb();
		expect(isChainOpenInTransaction(db)).toBe(false);
		const used: number[] = [];
		const a = openChainInTransaction(db, 1000, 3600_000)!;
		used.push(a);
		expect(isChainOpenInTransaction(db)).toBe(true);
		expect(openChainInTransaction(db, 1001, 3600_000)).toBeNull();
		const b = advanceChainInTransaction(db, a, 1100)!;
		used.push(b);
		expect(advanceChainInTransaction(db, a, 1200)).toBeNull(); // not the open link any more
		const c = advanceChainInTransaction(db, b, 1200)!;
		used.push(c);
		expect(closeChainInTransaction(db, b)).toBe(false);
		expect(closeChainInTransaction(db, c)).toBe(true);
		expect(closeChainInTransaction(db, c)).toBe(false);
		expect(advanceChainInTransaction(db, c, 1300)).toBeNull();
		expect(isChainOpenInTransaction(db)).toBe(false);
		used.push(openChainInTransaction(db, 1400, 10)!);
		expect(used).toEqual([...used].sort((x, y) => x - y));
		expect(new Set(used).size).toBe(used.length);
		expect(getChainInTransaction(db)).toMatchObject({
			openSweep: used[3],
			advancedAt: 1400,
		});
	});

	test("a stalled chain restarts with a new number", () => {
		const db = makeDb();
		const a = openChainInTransaction(db, 0, 1000)!;
		expect(openChainInTransaction(db, 999, 1000)).toBeNull();
		// progress resets the clock
		const b = advanceChainInTransaction(db, a, 900)!;
		expect(openChainInTransaction(db, 1800, 1000)).toBeNull();
		const c = openChainInTransaction(db, 1900, 1000)!;
		expect(c).toBeGreaterThan(b);
		// the lost link can no longer advance or close the chain
		expect(advanceChainInTransaction(db, b, 2000)).toBeNull();
		expect(closeChainInTransaction(db, b)).toBe(false);
		expect(isChainOpenInTransaction(db)).toBe(true);
		expect(closeChainInTransaction(db, c)).toBe(true);
		expect(openChainInTransaction(db, 1901, 1000)).toBeGreaterThan(c);
	});

	test("the next document: fewest attempts, oldest observation, then id", () => {
		const db = makeDb();
		expect(
			pickNextDocumentInTransaction(db, {
				maxUnappliedAttempts: 3,
				now: 1_000,
			}),
		).toBeNull();
		const obs = (n: number, t: number) =>
			observeDocumentInTransaction(db, summary(n, `body${n}`), ["wiki"], t);
		obs(5, 100);
		obs(2, 100);
		obs(3, 50);
		obs(4, 10);
		const pick = () =>
			pickNextDocumentInTransaction(db, { maxUnappliedAttempts: 3, now: 1_000 })
				?.documentId;
		const fail = (n: number) => {
			const d = getDocumentInTransaction(db, key(n))!;
			recordIngestFailureInTransaction(
				db,
				{
					...key(n),
					generation: d.generation,
					retry: d.ingestRetry,
					markdownSha256: d.observedMarkdownSha256,
					namespace: d.namespace,
				},
				1,
			);
		};
		expect(pick()).toBe(docId(4));
		fail(4);
		expect(pick()).toBe(docId(3));
		fail(3);
		expect(pick()).toBe(docId(2)); // same time as 5: id order
		fail(2);
		expect(pick()).toBe(docId(5));
		fail(5);
		expect(pick()).toBe(docId(4)); // retry 1 each, oldest first
		for (let i = 0; i < 2; i++) for (const n of [2, 3, 4, 5]) fail(n);
		expect(pick()).toBeUndefined(); // all reached 3
		expect(
			pickNextDocumentInTransaction(db, { maxUnappliedAttempts: 4, now: 1_000 })
				?.documentId,
		).toBe(docId(4));
		// a current document is never picked
		const s = ingest(db, 6, ["現在の文書です。"], { publish: true });
		expect(
			pickNextDocumentInTransaction(db, {
				maxUnappliedAttempts: 99,
				now: 1_000,
			})?.documentId,
		).not.toBe(docId(6));
		expect(s.versionId).toBeGreaterThan(0);
	});
});

describe("status", () => {
	const status = (
		db: Database,
		extra: { maxUnappliedAttempts?: number } = {},
	) => {
		const s = readStatusInSnapshot(
			db,
			{ principal: "p", namespaces: ["wiki"] },
			2000,
			{
				verifiedWithinMs: 1e9,
				...extra,
			},
		);
		expect(knowledgeStatusSchema.parse(s)).toEqual(s);
		return s;
	};

	test("failed_documents counts stale documents at the attempt limit", () => {
		const db = makeDb();
		observeDocumentInTransaction(db, summary(1, "a"), ["wiki"], 1);
		expect(status(db).partialReasons).not.toContain("failed_documents");
		db.query("UPDATE knowledge_documents SET ingest_retry = 2").run();
		expect(status(db).partialReasons).not.toContain("failed_documents");
		expect(status(db, { maxUnappliedAttempts: 2 }).partialReasons).toContain(
			"failed_documents",
		);
		db.query("UPDATE knowledge_documents SET ingest_retry = 3").run();
		const s = status(db);
		expect(s.partialReasons).toContain("failed_documents");
		expect(s.documents.stale).toBe(1); // counting is unchanged
		// outside the caller's namespaces
		const other = readStatusInSnapshot(
			db,
			{ principal: "p", namespaces: ["x"] },
			2000,
			{ verifiedWithinMs: 1 },
		);
		expect(other.partialReasons).not.toContain("failed_documents");
	});

	test("extraction_incomplete follows the published version of current documents", () => {
		const db = makeDb();
		ingest(db, 1, ["完全な文書です。"], { publish: true });
		expect(status(db).partialReasons).not.toContain("extraction_incomplete");
		const p = ingest(db, 2, ["一つ目です。", "二つ目です。"], {
			publish: true,
			failOrdinal: 0,
		});
		expect(status(db).partialReasons).toContain("extraction_incomplete");
		// a new complete version replaces the partial one
		const q = ingest(db, 2, ["一つ目だよ。", "二つ目だよ。"], {
			publish: true,
			now: 5000,
		});
		expect(q.versionId).not.toBe(p.versionId);
		expect(status(db).partialReasons).not.toContain("extraction_incomplete");
		// a withdrawn partial document is not counted
		ingest(db, 3, ["欠けのある文書です。"], { publish: true, failOrdinal: 0 });
		expect(status(db).partialReasons).toContain("extraction_incomplete");
		retireDocumentInTransaction(db, key(3), "excluded", 9);
		expect(status(db).partialReasons).not.toContain("extraction_incomplete");
	});
});

describe("atomicity", () => {
	test("an exception in the host's transaction leaves nothing behind", () => {
		const db = makeDb();
		const base = ingest(db, 1, ["公開済みの文書です。"], { publish: true });
		const rows = () => [
			derivedRows(db),
			count(db, "knowledge_versions"),
			count(db, "knowledge_embedding_spaces"),
			JSON.stringify(db.query("SELECT * FROM knowledge_documents").all()),
		];
		const before = rows();
		const run = db.transaction(() => {
			const s = ingest(db, 1, ["新しい版の文書です。"], {
				body: "新しい版の文書です。",
				now: 7000,
			});
			expect(
				publishVersionInTransaction(db, s.versionId, s.expectation, 7001),
			).toBe(true);
			retireDocumentInTransaction(db, key(1), "removed", 7002);
			cleanupInTransaction(db, 1000, { now: 1_000 });
			throw new Error("boom");
		});
		expect(() => run()).toThrow("boom");
		expect(rows()).toEqual(before);
		expect(getPublishedVersionInSnapshot(db, key(1))!.versionId).toBe(
			base.versionId,
		);
		expect(
			searchFragmentsInSnapshot(db, "公開済みの文書", 5, ["wiki"]),
		).toHaveLength(1);
		expect(
			searchFragmentsInSnapshot(db, "新しい版の文書", 5, ["wiki"]),
		).toEqual([]);
	});

	test("a failing batch rolls back with the host transaction", () => {
		const db = makeDb();
		observeDocumentInTransaction(db, summary(1, "abc"), ["wiki"], 1);
		const t: StagingTicket = {
			sourceNamespace: "docling",
			documentId: docId(1),
			markdownSha256: sha("abc"),
			generation: 0,
			retry: 0,
			namespace: "wiki",
			byteLength: 3,
			expectedFragments: 2,
			instructionDigest: "d",
		};
		const id = createStagingVersionInTransaction(db, t, 1);
		const f = (ordinal: number) => ({
			fragment: {
				ordinal,
				byteStart: ordinal,
				byteEnd: ordinal + 1,
				headingPath: [],
				text: "x",
			},
			searchText: "x",
		});
		stageFragmentsInTransaction(db, id, [f(0)]);
		const tx = db.transaction(() => {
			stageFragmentsInTransaction(db, id, [f(1)]);
			stageFragmentsInTransaction(db, id, [f(1)]);
		});
		expect(() => tx()).toThrow();
		expect(count(db, "knowledge_fragments")).toBe(1);
		expect(count(db, "knowledge_fragment_fts")).toBe(1);
		expect(getVersionInTransaction(db, id)!.fragmentsWritten).toBe(1);
	});
});

describe("reads fail closed", () => {
	test("namespaces are required: an empty list returns nothing, another namespace returns nothing", () => {
		const db = makeDb();
		ingest(db, 1, ["東京都の天気予報は晴れです。"], { publish: true });
		const space = embeddingSpaceKey(SPACE);
		expect(searchFragmentsInSnapshot(db, "東京都の", 10, [])).toEqual([]);
		expect(readPublishedVectorsInSnapshot(db, space, [])).toEqual([]);
		expect(searchFragmentsInSnapshot(db, "東京都の", 10, ["other"])).toEqual(
			[],
		);
		expect(readPublishedVectorsInSnapshot(db, space, ["other"])).toEqual([]);
		expect(readPublishedVectorsInSnapshot(db, space, ["wiki"])).toHaveLength(1);
		// A caller that leaves the list out (a JS caller; the types forbid it) gets an error, not everything.
		expect(() =>
			(searchFragmentsInSnapshot as (...a: unknown[]) => unknown)(
				db,
				"東京都の",
				10,
			),
		).toThrow();
		expect(() =>
			(readPublishedVectorsInSnapshot as (...a: unknown[]) => unknown)(
				db,
				space,
			),
		).toThrow();
	});

	test("the published version is returned only while the document is current", () => {
		const db = makeDb();
		const v = ingest(db, 1, ["公開されている文書です。"], { publish: true });
		expect(getPublishedVersionInSnapshot(db, key(1))!.versionId).toBe(
			v.versionId,
		);
		// stale: a new version was observed
		observeDocumentInTransaction(db, summary(1, "別の本文です"), ["wiki"], 20);
		expect(getDocumentInTransaction(db, key(1))!.state).toBe("stale");
		expect(getPublishedVersionInSnapshot(db, key(1))).toBeNull();
		expect(getRetainedVersionInSnapshot(db, key(1))!.versionId).toBe(
			v.versionId,
		);
		// unavailable
		observeDocumentInTransaction(
			db,
			summary(1, "公開されている文書です。", "other"),
			["wiki"],
			30,
		);
		expect(getDocumentInTransaction(db, key(1))!.state).toBe("unavailable");
		expect(getPublishedVersionInSnapshot(db, key(1))).toBeNull();
		// back to current (same applied sha, allowed again)
		observeDocumentInTransaction(
			db,
			summary(1, "公開されている文書です。"),
			["wiki"],
			40,
		);
		expect(getDocumentInTransaction(db, key(1))!.state).toBe("current");
		expect(getPublishedVersionInSnapshot(db, key(1))!.versionId).toBe(
			v.versionId,
		);
	});

	test("the query is normalized (NFKC, lower case) before the length check and the match", () => {
		const db = makeDb();
		ingest(db, 1, ["Ｈｅｌｌｏ Ｗｏｒｌｄ　の本文です。"], { publish: true });
		const hit = (q: string) => searchFragmentsInSnapshot(db, q, 5, ["wiki"]);
		expect(hit("HELLO world")).toHaveLength(1);
		expect(hit("Ｈｅｌｌｏ")).toHaveLength(1);
		expect(hit("ＨＥＬＬＯ ＷＯＲＬＤ")).toHaveLength(1);
		// Two characters stay too short after normalization; a ligature expands to three.
		expect(hit("ＨＥ")).toEqual([]);
		ingest(db, 2, ["office hours"], { publish: true });
		expect(hit("ﬃce")).toHaveLength(1);
	});
});

describe("temporary failures, superseded marks and the reset", () => {
	const setup = () => {
		const db = makeDb();
		const first = summary(1, "v1");
		observeDocumentInTransaction(db, first, ["wiki"], 100);
		const tuple: IngestExpectation = {
			sourceNamespace: "docling",
			documentId: docId(1),
			markdownSha256: first.markdownSha256,
			generation: 0,
			retry: 0,
			namespace: "wiki",
		};
		return { db, first, tuple };
	};
	const pick = (db: Database, now: number, max = 3) =>
		pickNextDocumentInTransaction(db, { maxUnappliedAttempts: max, now });

	test("the wait doubles with each consecutive temporary failure up to the cap; nothing is counted", () => {
		const { db, tuple } = setup();
		const base = 300_000;
		const waits: number[] = [];
		let now = 1_000;
		for (let i = 0; i < 6; i++) {
			expect(
				recordTransientIngestFailureInTransaction(db, tuple, now, base),
			).toBe(true);
			const row = getDocumentInTransaction(db, tuple)!;
			waits.push(row.ingestNotBefore - now);
			expect(row.ingestRetry).toBe(0);
			expect(row.transientFailures).toBe(i + 1);
			now = row.ingestNotBefore;
		}
		expect(waits).toEqual([
			300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000,
		]);
		// A base above the cap is kept as it is.
		expect(
			recordTransientIngestFailureInTransaction(db, tuple, 0, 7_200_000),
		).toBe(true);
		expect(getDocumentInTransaction(db, tuple)!.ingestNotBefore).toBe(
			7_200_000,
		);
		// A row that moved on is not touched.
		expect(
			recordTransientIngestFailureInTransaction(
				db,
				{ ...tuple, generation: 9 },
				0,
				base,
			),
		).toBe(false);
		expect(() =>
			recordTransientIngestFailureInTransaction(db, tuple, 0, -1),
		).toThrow();
	});

	test("the pick leaves out a document that waits and takes it once the time has come", () => {
		const { db, tuple } = setup();
		recordTransientIngestFailureInTransaction(db, tuple, 1_000, 5_000);
		expect(pick(db, 5_999)).toBeNull();
		expect(pick(db, 6_000)!.documentId).toBe(docId(1));
		// A second document is picked meanwhile.
		observeDocumentInTransaction(db, summary(2, "other"), ["wiki"], 200);
		expect(pick(db, 2_000)!.documentId).toBe(docId(2));
		// Observing the same version again does not end the wait.
		observeDocumentInTransaction(db, summary(1, "v1"), ["wiki"], 300);
		expect(pick(db, 2_000)!.documentId).toBe(docId(2));
		expect(getDocumentInTransaction(db, tuple)!.ingestNotBefore).toBe(6_000);
		// A new version does.
		observeDocumentInTransaction(db, summary(1, "v1 edited"), ["wiki"], 400);
		expect(getDocumentInTransaction(db, tuple)).toMatchObject({
			ingestNotBefore: 0,
			transientFailures: 0,
		});
	});

	test("a superseded document is not picked until it is observed again", () => {
		const { db, first, tuple } = setup();
		expect(markIngestSupersededInTransaction(db, tuple, 150)).toBe(true);
		const row = getDocumentInTransaction(db, tuple)!;
		expect(row).toMatchObject({ supersededAt: 150, ingestRetry: 0 });
		expect(pick(db, 1_000)).toBeNull();
		// The mark is newer than the last observation (100) even with a later clock.
		expect(row.supersededAt!).toBeGreaterThan(row.lastObservedAt);
		// A row that moved on is not marked.
		expect(
			markIngestSupersededInTransaction(db, { ...tuple, retry: 4 }, 160),
		).toBe(false);
		// The next observation, same version or not, makes it pickable again and clears the mark.
		observeDocumentInTransaction(db, first, ["wiki"], 200);
		expect(getDocumentInTransaction(db, tuple)!.supersededAt).toBeNull();
		expect(pick(db, 1_000)!.documentId).toBe(docId(1));
		// A mark at the very time of the last observation also skips (equal is not older).
		db.query(
			"UPDATE knowledge_documents SET superseded_at = last_observed_at",
		).run();
		expect(pick(db, 1_000)).toBeNull();
	});

	test("the reset clears the count, the wait and the mark for one document or all", () => {
		const { db, tuple } = setup();
		observeDocumentInTransaction(db, summary(2, "two"), ["wiki"], 100);
		const two = { ...tuple, documentId: docId(2), markdownSha256: sha("two") };
		recordIngestFailureInTransaction(db, tuple, 110);
		recordIngestFailureInTransaction(db, two, 110);
		recordTransientIngestFailureInTransaction(
			db,
			{ ...tuple, retry: 1 },
			120,
			5_000,
		);
		markIngestSupersededInTransaction(db, { ...two, retry: 1 }, 120);
		expect(getDocumentInTransaction(db, tuple)!.ingestRetry).toBe(1);
		expect(resetIngestFailuresInTransaction(db, key(1))).toBe(1);
		expect(getDocumentInTransaction(db, key(1))).toMatchObject({
			ingestRetry: 0,
			transientFailures: 0,
			ingestNotBefore: 0,
			supersededAt: null,
		});
		expect(getDocumentInTransaction(db, key(2))).toMatchObject({
			ingestRetry: 1,
			supersededAt: 120,
		});
		expect(resetIngestFailuresInTransaction(db)).toBe(1);
		expect(getDocumentInTransaction(db, key(2))).toMatchObject({
			ingestRetry: 0,
			supersededAt: null,
		});
		// Nothing left to reset.
		expect(resetIngestFailuresInTransaction(db)).toBe(0);
		expect(pick(db, 1_000)).not.toBeNull();
	});

	test("failed_documents counts only the documents whose content-caused attempts reached the limit", () => {
		const { db, tuple } = setup();
		const status = () =>
			readStatusInSnapshot(
				db,
				{ principal: "p", namespaces: ["wiki"] },
				2_000,
				{
					verifiedWithinMs: 1e9,
				},
			);
		for (let i = 0; i < 10; i++) {
			const row = getDocumentInTransaction(db, tuple)!;
			recordTransientIngestFailureInTransaction(
				db,
				{ ...tuple, retry: row.ingestRetry },
				i,
				1,
			);
		}
		expect(status().partialReasons).not.toContain("failed_documents");
		for (let i = 0; i < 3; i++) {
			recordIngestFailureInTransaction(db, { ...tuple, retry: i }, 10);
		}
		expect(status().partialReasons).toContain("failed_documents");
		resetIngestFailuresInTransaction(db);
		expect(status().partialReasons).not.toContain("failed_documents");
	});

	test("publishing clears the wait and the mark", () => {
		const db = makeDb();
		const s = ingest(db, 1, ["本文です。"]);
		recordTransientIngestFailureInTransaction(db, s.expectation, 5, 100);
		markIngestSupersededInTransaction(db, s.expectation, 6);
		expect(
			publishVersionInTransaction(db, s.versionId, s.expectation, 2000),
		).toBe(true);
		expect(getDocumentInTransaction(db, key(1))).toMatchObject({
			state: "current",
			ingestNotBefore: 0,
			transientFailures: 0,
			supersededAt: null,
		});
	});
});

describe("chain liveness and housekeeping", () => {
	test("touching the chain moves advanced_at of the open link only, so a long ingest is not taken for lost", () => {
		const db = makeDb();
		const hour = 3_600_000;
		const sweep = openChainInTransaction(db, 1_000, hour)!;
		expect(touchChainInTransaction(db, sweep + 1, 5_000)).toBe(false);
		expect(getChainInTransaction(db).advancedAt).toBe(1_000);
		// Without a touch the link looks lost after an hour ...
		expect(openChainInTransaction(db, 1_000 + hour, hour)).not.toBeNull();
		// ... with touches it stays alive however long it runs.
		const link = getChainInTransaction(db).openSweep!;
		for (let t = 1; t <= 5; t++) {
			expect(
				touchChainInTransaction(db, link, 1_000 + hour + t * 40 * 60_000),
			).toBe(true);
			expect(
				openChainInTransaction(db, 1_000 + hour + t * 40 * 60_000 + 1, hour),
			).toBeNull();
		}
		expect(closeChainInTransaction(db, link)).toBe(true);
		expect(touchChainInTransaction(db, link, 9)).toBe(false);
	});

	test("an orphan staging version is abandoned; the one the live link works on is not", () => {
		const db = makeDb();
		const six = 6 * 3_600_000;
		const orphan = ingest(db, 1, ["孤児の本文です。"], { now: 1_000 });
		const live = ingest(db, 2, ["作業中の本文です。"], { now: 1_000 });
		const young = ingest(db, 3, ["新しい本文です。"], { now: six });
		const sweep = openChainInTransaction(db, 1_000, 3_600_000)!;
		setActiveIngestInTransaction(db, sweep, live.expectation);
		const now = six + 2_000;
		// The chain advanced long ago: nobody works on the live one either.
		cleanupInTransaction(db, 1000, { now, orphanStagingAfterMs: six });
		expect(getVersionInTransaction(db, live.versionId)).toBeNull();
		expect(getVersionInTransaction(db, orphan.versionId)).toBeNull();
		expect(getVersionInTransaction(db, young.versionId)!.state).toBe("staging");

		const db2 = makeDb();
		const o2 = ingest(db2, 1, ["孤児の本文です。"], { now: 1_000 });
		const l2 = ingest(db2, 2, ["作業中の本文です。"], { now: 1_000 });
		const sw = openChainInTransaction(db2, 1_000, 3_600_000)!;
		setActiveIngestInTransaction(db2, sw, l2.expectation);
		touchChainInTransaction(db2, sw, now - 60_000); // recently advanced
		cleanupInTransaction(db2, 1000, { now, orphanStagingAfterMs: six });
		expect(getVersionInTransaction(db2, o2.versionId)).toBeNull();
		expect(getVersionInTransaction(db2, l2.versionId)!.state).toBe("staging");
		// The default is 6 hours.
		const db3 = makeDb();
		const o3 = ingest(db3, 1, ["孤児の本文です。"], { now: 1_000 });
		cleanupInTransaction(db3, 1000, { now: 1_000 + six - 1 });
		expect(getVersionInTransaction(db3, o3.versionId)!.state).toBe("staging");
		cleanupInTransaction(db3, 1000, { now: 1_000 + six });
		expect(getVersionInTransaction(db3, o3.versionId)).toBeNull();
	});

	test("finished scans past their retention go, the newest few and the newest complete scan stay", () => {
		const db = makeDb();
		const day = 24 * 3_600_000;
		const scan = (id: string, at: number, complete: boolean, binding = "b") => {
			beginScanInTransaction(db, id, binding, at);
			settleScanPageInTransaction(db, id, 0, 0, complete, at + 1);
			if (!complete) failScanInTransaction(db, id, "failed_x", at + 1);
		};
		scan("old-complete", 0, true);
		for (let i = 0; i < 30; i++) scan(`old-failed-${i}`, 1_000 + i * 10, false);
		scan("recent", 20 * day, true);
		beginScanInTransaction(db, "running", "b", 1);
		const now = 20 * day + 100;
		const scans = () => count(db, "knowledge_scans");
		expect(scans()).toBe(33);
		// Bounded: at most 5 rows per call (pages first, then the scan row).
		let calls = 0;
		for (;;) {
			const r = pruneScansInTransaction(db, now, 5, { keepLatest: 3 });
			expect(r.deletedRows).toBeLessThanOrEqual(5);
			calls++;
			if (!r.more) break;
			expect(calls).toBeLessThan(100);
		}
		// Kept: the running scan, the newest 3 finished (recent + 2 newest failed), and the newest
		// complete scan of the binding (it is "recent", already among the 3).
		const left = db
			.query<{ scan_id: string }, []>(
				"SELECT scan_id FROM knowledge_scans ORDER BY scan_id",
			)
			.all()
			.map((r) => r.scan_id);
		expect(left).toEqual([
			"old-failed-28",
			"old-failed-29",
			"recent",
			"running",
		]);
		expect(count(db, "knowledge_scan_pages")).toBe(3);
		// A scan younger than the retention is never deleted.
		const young = makeDb();
		for (let i = 0; i < 30; i++) scan2(young, `s${i}`, 100 + i);
		expect(pruneScansInTransaction(young, 50 + 7 * day, 1000).deletedRows).toBe(
			0,
		);
		expect(
			pruneScansInTransaction(young, 111 + 7 * day, 1000).deletedRows,
		).toBe(20);
	});

	test("the cleanup also prunes old scans with the budget the versions leave", () => {
		const db = makeDb();
		const day = 24 * 3_600_000;
		for (let i = 0; i < 30; i++) scan2(db, `s${i}`, 100 + i);
		const r = cleanupInTransaction(db, 1000, { now: 10 * day });
		expect(r.deletedRows).toBeGreaterThan(0);
		expect(r.more).toBe(false);
		expect(count(db, "knowledge_scans")).toBe(20); // the newest 20 are kept
	});

	test("published fragments are counted without the document's own published version", () => {
		const db = makeDb();
		ingest(db, 1, ["一つ目です。", "二つ目です。"], { publish: true });
		ingest(db, 2, ["三つ目です。"], { publish: true });
		ingest(db, 3, ["準備中です。", "準備中です二。"]); // staging: not counted
		expect(countPublishedFragmentsInTransaction(db)).toBe(3);
		expect(countPublishedFragmentsInTransaction(db, key(1))).toBe(1);
		expect(countPublishedFragmentsInTransaction(db, key(3))).toBe(3);
	});

	test("an index serves the published_version_id join", () => {
		const db = makeDb();
		const plan = db
			.query<{ detail: string }, []>(
				"EXPLAIN QUERY PLAN SELECT 1 FROM knowledge_documents WHERE published_version_id = 5",
			)
			.all()
			.map((r) => r.detail)
			.join(" ");
		expect(plan).toContain("knowledge_documents_published");
	});
});

function scan2(db: Database, id: string, at: number): void {
	beginScanInTransaction(db, id, "b", at);
	settleScanPageInTransaction(db, id, 0, 0, true, at + 1);
}
