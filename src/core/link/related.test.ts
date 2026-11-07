import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AccessContext, RelatedResponse } from "../../contracts/index.js";
import { docId, rows, runJob } from "../harness.fixture.js";
import { readEvidence } from "../search/index.js";
import { recordLinkDecisionsInTransaction } from "../../sqlite/links.js";
import { sha256Hex } from "../bytes.js";
import { readRelated } from "./related.js";
import {
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "./link.fixture.js";

const deps = (env: LinkEnv) => ({
	read: <T>(op: (db: LinkEnv["db"]) => T): T => op(env.db),
	clock: env.clock,
	options: { verifiedWithinMs: 10 ** 12 },
});
const access = (...namespaces: string[]): AccessContext => ({
	principal: "tester",
	namespaces,
});
const related = (
	env: LinkEnv,
	doc: number,
	namespaces: string[],
	extra: { limit?: number; namespaces?: string[] } = {},
): RelatedResponse =>
	readRelated(deps(env), access(...namespaces), {
		documentId: docId(doc),
		...extra,
	});

async function ingestOnly(env: LinkEnv): Promise<void> {
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
const mentionId = (env: LinkEnv, doc: number, name: string): number =>
	(
		rows(
			env.db,
			`SELECT m.entity_id AS id FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE d.document_id = ? AND m.name = ?`,
			docId(doc),
			name,
		)[0] as { id: number }
	).id;
const decide = (
	env: LinkEnv,
	pairs: [number, number, "same" | "different" | "unsure", string?][],
) => {
	for (const [a, b, decision, model] of pairs) {
		recordLinkDecisionsInTransaction(
			env.db,
			[{ entityId: a, otherId: b, decision }],
			{ model: model ?? "m", instructionId: "link", instructionVersion: 1 },
			1,
		);
	}
};

const DOCS: [number, string, string][] = [
	[1, "Alpha Corp and Beta Ltd are partners.", "wiki"],
	[2, "Alpha Corp and Beta Ltd sign a deal.", "wiki"],
	[3, "Alpha Corp is mentioned abroad.", "other"],
	[4, "Gamma Inc stands alone.", "wiki"],
];

async function populated(options = { summaryMinMentions: 3 }) {
	const env = makeLinkEnv(options);
	for (const [n, text, ns] of DOCS) putDoc(env, n, text, ns);
	await scanAndDrain(env);
	return env;
}

describe("related documents", () => {
	test("ranks other documents by the number of shared entities, inside the caller's namespaces", async () => {
		const env = await populated();
		const both = related(env, 1, ["wiki", "other"]);
		expect(both.status).toBe("ok");
		expect(both.document).toEqual({
			documentId: docId(1),
			markdownSha256: rows(
				env.db,
				"SELECT markdown_sha256 AS s FROM knowledge_versions WHERE version_id = 1",
			)[0]!.s as string,
		});
		expect(
			both.results.map((r) => [r.rank, r.documentId, r.shared.length]),
		).toEqual([
			[1, docId(2), 2],
			[2, docId(3), 1],
		]);
		expect(both.results[0]).toMatchObject({
			namespace: "wiki",
			path: "notes/2.md",
			title: "Doc 2",
			state: "current",
		});
		expect(
			both.results[0]!.shared.map((s) => [s.label, s.relatedLabel]).sort(),
		).toEqual([
			["Alpha Corp", "Alpha Corp"],
			["Beta Ltd", "Beta Ltd"],
		]);
		expect(both.results[0]!.shared[0]!.decidedBy).toEqual({
			model: "mock-model",
			instructionId: "link",
			instructionVersion: 1,
		});
		expect(both.complete).toBe(true);
		expect(both.partialReasons).toEqual([]);

		// A document of a namespace the caller cannot read is never returned.
		const wikiOnly = related(env, 1, ["wiki"]);
		expect(wikiOnly.results.map((r) => r.documentId)).toEqual([docId(2)]);
		expect(JSON.stringify(wikiOnly)).not.toContain(docId(3));
		// `namespaces` in the request only narrows.
		const narrowed = related(env, 1, ["wiki", "other"], {
			namespaces: ["wiki"],
		});
		expect(narrowed.results.map((r) => r.documentId)).toEqual([docId(2)]);
		expect(
			related(env, 1, ["wiki"], { namespaces: ["wiki", "other"] }).results,
		).toHaveLength(1);
		// A document without shared entities has an empty list; limit applies.
		expect(related(env, 4, ["wiki", "other"]).results).toEqual([]);
		expect(
			related(env, 1, ["wiki", "other"], { limit: 1 }).results.map(
				(r) => r.documentId,
			),
		).toEqual([docId(2)]);
	});

	test("both evidence ranges lead back to the original text of each document", async () => {
		const env = await populated();
		const response = related(env, 1, ["wiki", "other"]);
		const body = (n: number) =>
			Buffer.from(DOCS.find((d) => d[0] === n)![1], "utf8");
		let checked = 0;
		for (const result of response.results) {
			const doc = Number(result.documentId.slice(-4));
			for (const shared of result.shared) {
				for (const [side, n] of [
					[shared.evidence.document, 1],
					[shared.evidence.related, doc],
				] as const) {
					expect(side.length).toBeGreaterThan(0);
					for (const point of side) {
						const slice = body(n).subarray(point.byteStart, point.byteEnd);
						expect(sha256Hex(slice)).toBe(point.quoteSha256);
						expect(slice.toString("utf8")).toBe(
							shared.label === slice.toString("utf8")
								? shared.label
								: slice.toString("utf8"),
						);
						expect(["Alpha Corp", "Beta Ltd"]).toContain(
							slice.toString("utf8"),
						);
						checked++;
					}
				}
			}
		}
		expect(checked).toBeGreaterThanOrEqual(6);
		// The evidence check accepts each range for its own document and version.
		const point = response.results[0]!.shared[0]!.evidence.related[0]!;
		const evidence = readEvidence(deps(env), access("wiki", "other"), {
			documentId: response.results[0]!.documentId,
			markdownSha256: response.results[0]!.markdownSha256,
			byteStart: point.byteStart,
			byteEnd: point.byteEnd,
			quoteSha256: point.quoteSha256,
		});
		expect(evidence.status).toBe("valid");
	});

	test("a summary is returned only when every mention of the entity is current and readable", async () => {
		const env = await populated();
		// Alpha Corp has three mentions: docs 1 and 2 (wiki) and 3 (other). Beta Ltd has two.
		const all = related(env, 1, ["wiki", "other"]);
		const summaryOf = (r: RelatedResponse, doc: number, label: string) =>
			r.results
				.find((x) => x.documentId === docId(doc))!
				.shared.find((s) => s.label === label)!.summary;
		expect(summaryOf(all, 2, "Alpha Corp")).toBe("SUMMARY(Alpha Corp; 3)");
		// Beta Ltd has two mentions only (below the minimum): no summary was made.
		expect(summaryOf(all, 2, "Beta Ltd")).toBeNull();
		// Without access to namespace "other" the third mention is out of range: no summary.
		const wiki = related(env, 1, ["wiki"]);
		expect(summaryOf(wiki, 2, "Alpha Corp")).toBeNull();
		expect(JSON.stringify(wiki)).not.toContain("SUMMARY");
	});

	test("an old summary is not returned after the entity's mentions change", async () => {
		const env = await populated();
		expect(JSON.stringify(related(env, 1, ["wiki", "other"]))).toContain(
			"SUMMARY(Alpha Corp; 3)",
		);
		// Document 3 gets a new version that does not name the company.
		putDoc(env, 3, "Nothing here now.", "other");
		await scanAndDrain(env);
		const after = related(env, 1, ["wiki", "other"]);
		expect(after.results.map((r) => r.documentId)).toEqual([docId(2)]);
		expect(JSON.stringify(after)).not.toContain("SUMMARY");
		expect(after.complete).toBe(true);
	});

	test("an uncompared version in range makes the answer partial: linking_pending", async () => {
		const env = await populated();
		putDoc(env, 5, "Alpha Corp new arrival.", "wiki");
		await ingestOnly(env);
		// The link jobs were dropped; once the chain counts as lost, a scan restarts it.
		env.clock.t += 61 * 60 * 1000;
		const pending = related(env, 1, ["wiki"]);
		expect(pending.partialReasons).toEqual(["linking_pending"]);
		expect(pending.complete).toBe(false);
		// A version outside the caller's namespaces is not in range.
		putDoc(env, 6, "Alpha Corp somewhere else.", "secret");
		await ingestOnly(env);
		expect(related(env, 1, ["wiki"]).partialReasons).toEqual([
			"linking_pending",
		]);
		env.clock.t += 61 * 60 * 1000;
		await scanAndDrain(env);
		expect(related(env, 1, ["wiki"]).partialReasons).toEqual([]);
		const hidden = makeLinkEnv();
		putDoc(hidden, 1, "Alpha Corp.", "wiki");
		await scanAndDrain(hidden);
		putDoc(hidden, 2, "Alpha Corp.", "secret");
		await ingestOnly(hidden);
		expect(related(hidden, 1, ["wiki"]).partialReasons).toEqual([]);
		expect(related(hidden, 1, ["wiki", "secret"]).partialReasons).toEqual([
			"linking_pending",
		]);
	});

	test("an unsure pair in range makes the answer partial: linking_unsure; it is not counted as the same entity", async () => {
		const env = makeLinkEnv();
		env.decide = (m, c) =>
			m.name === "Gamma Inc" && c.name === m.name
				? "unsure"
				: m.name === c.name
					? "same"
					: "different";
		putDoc(env, 1, "Alpha Corp and Gamma Inc.");
		putDoc(env, 2, "Alpha Corp and Gamma Inc.");
		putDoc(env, 3, "Delta alone.");
		await scanAndDrain(env);
		const r = related(env, 1, ["wiki"]);
		expect(r.partialReasons).toEqual(["linking_unsure"]);
		expect(
			r.results.map((x) => [x.documentId, x.shared.map((s) => s.label)]),
		).toEqual([[docId(2), ["Alpha Corp"]]]);
		// The reason is about the caller's range, not only the pairs of this document.
		expect(related(env, 3, ["wiki"]).partialReasons).toEqual([
			"linking_unsure",
		]);
		// A pair outside the caller's range does not count.
		env.db.run(
			"UPDATE knowledge_documents SET namespace = 'secret' WHERE document_id IN (?, ?)",
			[docId(1), docId(2)],
		);
		expect(related(env, 3, ["wiki"]).partialReasons).toEqual([]);
	});

	test("a mention that got no usable answer also shows as linking_unsure", async () => {
		const env = makeLinkEnv();
		putDoc(env, 1, "Alpha Corp.");
		putDoc(env, 2, "Alpha Corp.");
		env.linkAnswer = () => "oops";
		await scanAndDrain(env);
		expect(related(env, 1, ["wiki"]).partialReasons).toEqual([
			"linking_unsure",
		]);
	});

	test("not_available for unknown, out-of-range and narrowed-out documents; stale when the document is not current", async () => {
		const env = await populated();
		const res = (r: RelatedResponse): unknown[] => [
			r.status,
			r.document,
			r.results,
			r.complete,
			r.partialReasons,
		];
		const na = ["not_available", null, [], false, []];
		expect(res(related(env, 99, ["wiki"]))).toEqual(na);
		expect(res(related(env, 3, ["wiki"]))).toEqual(na);
		expect(res(related(env, 1, ["wiki"], { namespaces: ["other"] }))).toEqual(
			na,
		);
		expect(res(related(env, 1, []))).toEqual(na);

		env.db.run(
			"UPDATE knowledge_documents SET state = 'stale' WHERE document_id = ?",
			[docId(1)],
		);
		expect(res(related(env, 1, ["wiki"]))).toEqual([
			"stale",
			null,
			[],
			false,
			["stale_documents"],
		]);
		// A stale document is not offered as related either.
		expect(related(env, 2, ["wiki"]).results).toEqual([]);
		env.db.run(
			"UPDATE knowledge_documents SET state = 'unavailable' WHERE document_id = ?",
			[docId(1)],
		);
		expect(related(env, 1, ["wiki"]).status).toBe("stale");
	});

	test("a request that breaks the schema is invalid", async () => {
		const env = await populated();
		const bad = (r: unknown) =>
			readRelated(deps(env), access("wiki"), r as never);
		expect(() => bad({})).toThrow();
		expect(() => bad({ documentId: "x" })).toThrow();
		expect(() => bad({ documentId: docId(1), limit: 0 })).toThrow();
		expect(() => bad({ documentId: docId(1), extra: 1 })).toThrow();
	});

	describe("entities joined through other mentions", () => {
		async function chained() {
			const env = makeLinkEnv();
			putDoc(env, 1, "Alpha Corp one.", "wiki");
			putDoc(env, 2, "Alpha Corp two.", "other");
			putDoc(env, 3, "Alpha Corp three and Delta.", "wiki");
			await ingestOnly(env);
			const [a1, a2, a3] = [1, 2, 3].map((n) =>
				mentionId(env, n, "Alpha Corp"),
			) as [number, number, number];
			decide(env, [
				[a1, a2, "same", "m-12"],
				[a2, a3, "same", "m-23"],
			]);
			return { env, a1, a2, a3 };
		}

		test("a mention outside the caller's range does not connect two readable ones", async () => {
			const { env } = await chained();
			const wiki = related(env, 1, ["wiki"]);
			expect(wiki.results).toEqual([]);
		});

		test("with the whole chain readable, the requested side's first mention and the nearest mention of the other document are shown, with the first link's provenance", async () => {
			const { env } = await chained();
			const r = related(env, 1, ["wiki", "other"]);
			expect(r.results.map((x) => [x.documentId, x.shared.length])).toEqual([
				[docId(2), 1],
				[docId(3), 1],
			]);
			const direct = r.results[0]!.shared[0]!;
			expect(direct.decidedBy.model).toBe("m-12");
			const twoHops = r.results[1]!.shared[0]!;
			expect(twoHops.label).toBe("Alpha Corp");
			// doc 3 is joined to doc 1 only through doc 2: the first link on the path decides.
			expect(twoHops.decidedBy.model).toBe("m-12");
			// And from document 3 the path starts with the link (2,3).
			const back = related(env, 3, ["wiki", "other"]);
			expect(
				back.results.map((x) => [x.documentId, x.shared[0]!.decidedBy.model]),
			).toEqual([
				[docId(1), "m-23"],
				[docId(2), "m-23"],
			]);
		});

		test("when a document has several mentions in the entity, the nearest one is shown", async () => {
			const env = makeLinkEnv();
			putDoc(env, 1, "Alpha Corp one.");
			putDoc(env, 2, "Alpha Corp and Beta Ltd two.");
			putDoc(env, 3, "Beta Ltd three.");
			await ingestOnly(env);
			const a1 = mentionId(env, 1, "Alpha Corp");
			const a2 = mentionId(env, 2, "Alpha Corp");
			const b2 = mentionId(env, 2, "Beta Ltd");
			const b3 = mentionId(env, 3, "Beta Ltd");
			decide(env, [
				[a1, a2, "same", "m-a"],
				[a2, b2, "same", "m-b"],
				[b2, b3, "same", "m-c"],
			]);
			const r = related(env, 1, ["wiki"]);
			const forDoc2 = r.results.find((x) => x.documentId === docId(2))!;
			// Document 2 has two mentions in the cluster; Alpha Corp is one link away, Beta Ltd two.
			expect(forDoc2.shared).toHaveLength(1);
			expect(forDoc2.shared[0]!.relatedLabel).toBe("Alpha Corp");
			const forDoc3 = r.results.find((x) => x.documentId === docId(3))!;
			expect(forDoc3.shared[0]!.relatedLabel).toBe("Beta Ltd");
			expect(forDoc3.shared[0]!.decidedBy.model).toBe("m-a");
		});
	});

	describe("what is outside the caller's range does not show", () => {
		test("a large cluster outside leaves the readable result and reasons as they were", async () => {
			const env = await populated();
			const before = related(env, 1, ["wiki"]);
			expect(before.complete).toBe(true);
			// Document 3 (namespace "other") gets 600 more mentions of the company, chained
			// together and to its first one: more than one cluster may hold.
			const v3 = rows(
				env.db,
				"SELECT published_version_id AS v FROM knowledge_documents WHERE document_id = ?",
				docId(3),
			)[0]!.v as number;
			const a3 = mentionId(env, 3, "Alpha Corp");
			env.db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
INSERT INTO knowledge_entity_mentions (version_id, fragment_ordinal, local_id, name, type, description, name_norm)
SELECT ?, 0, 'x' || i, 'Alpha Corp', 'company', 'extra', 'alpha corp' FROM n`,
				[v3],
			);
			env.db.run(
				`INSERT INTO knowledge_entity_links (entity_a, entity_b, version_a, version_b, decision, model, instruction_id, instruction_version, decided_at)
SELECT ?1, entity_id, ?2, ?2, 'same', 'm', 'link', 1, 1 FROM knowledge_entity_mentions
WHERE version_id = ?2 AND local_id LIKE 'x%'`,
				[a3, v3],
			);
			const after = related(env, 1, ["wiki"]);
			expect(after).toEqual(before);
			expect(after.partialReasons).not.toContain("response_truncated");
			// The reader that may see "other" does see that the cluster is too large to follow.
			expect(related(env, 1, ["wiki", "other"]).partialReasons).toContain(
				"response_truncated",
			);
		});

		test("more starting mentions than the limit make the answer response_truncated", async () => {
			const env = await populated();
			const v1 = rows(
				env.db,
				"SELECT published_version_id AS v FROM knowledge_documents WHERE document_id = ?",
				docId(1),
			)[0]!.v as number;
			const a2 = mentionId(env, 2, "Alpha Corp");
			env.db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100)
INSERT INTO knowledge_entity_mentions (version_id, fragment_ordinal, local_id, name, type, description, name_norm)
SELECT ?, 0, 'y' || i, 'Alpha Corp', 'company', 'extra', 'alpha corp' FROM n`,
				[v1],
			);
			env.db.run(
				`INSERT INTO knowledge_entity_links (entity_a, entity_b, version_a, version_b, decision, model, instruction_id, instruction_version, decided_at)
SELECT ?1, entity_id, (SELECT version_id FROM knowledge_entity_mentions WHERE entity_id = ?1), ?2, 'same', 'm', 'link', 1, 1
FROM knowledge_entity_mentions WHERE version_id = ?2 AND local_id LIKE 'y%'`,
				[a2, v1],
			);
			const r = related(env, 1, ["wiki", "other"]);
			expect(r.partialReasons).toContain("response_truncated");
			expect(r.complete).toBe(false);
			// A document with few linked mentions is not cut.
			expect(related(env, 4, ["wiki"]).partialReasons).not.toContain(
				"response_truncated",
			);
		});
	});
});
