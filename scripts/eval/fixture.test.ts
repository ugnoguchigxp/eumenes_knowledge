import { describe, expect, test } from "bun:test";
import { PRINCIPALS, ALICE } from "../../examples/scenarios/harness.js";
import { chunkMarkdown } from "../../src/core/index.js";
import {
	computeManifest,
	loadFixture,
	manifestMatches,
	questionKinds,
	type EvalFixture,
} from "./fixture.js";
import { buildDocumentScript, buildScripts } from "./script.js";

const fixture: EvalFixture = loadFixture();
const norm = (text: string) => text.normalize("NFKC").toLowerCase();
const documentByKey = new Map(fixture.documents.map((d) => [d.key, d]));
const bodies = fixture.documents.map((d) => ({
	key: d.key,
	text: norm(d.markdown),
}));
const withText = (query: string) =>
	bodies.filter((b) => b.text.includes(norm(query))).map((b) => b.key);
const rawWithText = (query: string) =>
	fixture.documents.filter((d) => d.markdown.includes(query)).map((d) => d.key);

/** All words the extraction fixture offers for a document (what the entity and relation routes can match). */
function scriptText(key: string): string[] {
	const entry = fixture.extraction.documents[key];
	if (!entry) return [];
	return [
		...entry.entities.flatMap((e) => [e.name, e.description]),
		...entry.relations.flatMap((r) => [
			r.relation,
			r.description,
			...r.keywords,
		]),
	];
}

describe("corpus", () => {
	test("20 to 40 documents in several namespaces the example principal can read", () => {
		expect(fixture.documents.length).toBeGreaterThanOrEqual(20);
		expect(fixture.documents.length).toBeLessThanOrEqual(40);
		const namespaces = new Set(fixture.documents.map((d) => d.namespace));
		expect(namespaces.size).toBeGreaterThanOrEqual(3);
		for (const namespace of namespaces)
			expect(PRINCIPALS[ALICE].namespaces).toContain(namespace);
	});

	test("the unseen set is a separate group of documents", () => {
		const seen = fixture.documents.filter((d) => d.set === "seen");
		const unseen = fixture.documents.filter((d) => d.set === "unseen");
		expect(seen.length).toBeGreaterThan(0);
		expect(unseen.length).toBeGreaterThanOrEqual(5);
		expect(new Set(seen.map((d) => d.key)).size + unseen.length).toBe(
			fixture.documents.length,
		);
	});

	test("every document has a title heading and several fragments, and mixes the writing the questions probe", () => {
		for (const d of fixture.documents) {
			expect(d.markdown.startsWith("# ")).toBe(true);
			expect(chunkMarkdown(d.bytes, d.markdown).length).toBeGreaterThanOrEqual(
				2,
			);
		}
		const all = fixture.documents.map((d) => d.markdown).join("\n");
		expect(all).toMatch(/^\| --- /m); // tables
		expect(all).toMatch(/^- /m); // lists
		expect(all).toMatch(/^[0-9]+\. /m); // numbered lists
		expect(all).toMatch(/[A-Za-z]+-[A-Z0-9]+/); // alphanumeric model numbers
		expect(all).toMatch(/[０-９]/); // full-width digits
		expect(all).toMatch(/[Ａ-Ｚ]/); // full-width letters
	});

	test("document ids are unique", () => {
		expect(new Set(fixture.documents.map((d) => d.documentId)).size).toBe(
			fixture.documents.length,
		);
	});
});

describe("digests and versions", () => {
	test("manifest.json states the digests of the files as they are", () => {
		expect(fixture.manifest).not.toBeNull();
		expect(manifestMatches(fixture)).toBe(true);
	});

	test("every input has a version and a digest, and the unseen groups have their own", () => {
		const m = fixture.digests;
		for (const digest of [
			m.corpus.digest,
			m.corpus.seen.digest,
			m.corpus.unseen.digest,
			m.extraction.digest,
			m.questions.digest,
			m.questions.seen.digest,
			m.questions.unseen.digest,
		])
			expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(m.corpus.version).toBeGreaterThanOrEqual(1);
		expect(m.extraction.version).toBeGreaterThanOrEqual(1);
		expect(m.questions.version).toBeGreaterThanOrEqual(1);
		expect(m.corpus.seen.digest).not.toBe(m.corpus.unseen.digest);
		expect(m.corpus.seen.count + m.corpus.unseen.count).toBe(
			fixture.documents.length,
		);
		expect(m.questions.seen.count + m.questions.unseen.count).toBe(
			fixture.questions.length,
		);
	});

	test("changing one byte of a document changes the corpus digest only", () => {
		const first = fixture.documents[0];
		if (!first) throw new Error("no document");
		const changed = fixture.documents.map((d) =>
			d === first ? { ...d, sha256: "0".repeat(64) } : d,
		);
		const bytes = new Uint8Array(0);
		const a = computeManifest(
			fixture.documents,
			bytes,
			fixture.questions,
			null,
		);
		const b = computeManifest(changed, bytes, fixture.questions, null);
		expect(b.corpus.digest).not.toBe(a.corpus.digest);
		expect(b.questions.digest).toBe(a.questions.digest);
		expect(b.extraction.digest).toBe(a.extraction.digest);
	});

	test("changing a question changes the questions digest", () => {
		const changed = fixture.questions.map((q, i) =>
			i === 0 ? { ...q, query: `${q.query}!` } : q,
		);
		const a = computeManifest(
			fixture.documents,
			new Uint8Array(0),
			fixture.questions,
			null,
		);
		const b = computeManifest(
			fixture.documents,
			new Uint8Array(0),
			changed,
			null,
		);
		expect(b.questions.digest).not.toBe(a.questions.digest);
	});
});

describe("scripted extraction", () => {
	test("every quotation is a contiguous part of a fragment the package cuts, and every answer fits the schema", () => {
		const { problems, scripts } = buildScripts(
			fixture.documents,
			fixture.extraction,
		);
		expect(problems).toEqual([]);
		for (const d of fixture.documents) {
			const script = scripts.get(d.key);
			expect(script?.answers.length).toBe(script?.fragments.length);
			script?.answers.forEach((answer, index) => {
				const fragment = script.fragments[index];
				for (const item of [...answer.entities, ...answer.relations])
					for (const quote of item.evidence)
						expect(fragment?.text.includes(quote)).toBe(true);
			});
		}
	});

	test("every document has entities, and the relations name entities of the same document", () => {
		for (const d of fixture.documents) {
			const entry = fixture.extraction.documents[d.key];
			expect(entry?.entities.length).toBeGreaterThan(0);
			const names = new Set(entry?.entities.map((e) => e.name));
			for (const r of entry?.relations ?? []) {
				expect(names.has(r.source)).toBe(true);
				expect(names.has(r.target)).toBe(true);
			}
		}
	});

	test("a quotation that is not in the fragment is reported, not skipped", () => {
		const d = fixture.documents[0];
		if (!d) throw new Error("no document");
		const entry = fixture.extraction.documents[d.key];
		const broken = {
			...fixture.extraction,
			documents: {
				...fixture.extraction.documents,
				[d.key]: {
					entities: [
						...(entry?.entities ?? []),
						{
							name: "存在しない対象",
							type: "試験",
							description: "本文にない引用",
							evidence: ["この文は資料に無い"],
						},
					],
					relations: entry?.relations ?? [],
				},
			},
		};
		const { problems } = buildDocumentScript(d, broken);
		expect(problems.map((p) => p.code)).toContain(
			"entity_quote_not_in_fragment",
		);
	});

	test("the script has no entry for a document the corpus lacks", () => {
		for (const key of Object.keys(fixture.extraction.documents))
			expect(documentByKey.has(key)).toBe(true);
	});
});

describe("questions", () => {
	test("ids are unique and every kind is used", () => {
		expect(new Set(fixture.questions.map((q) => q.id)).size).toBe(
			fixture.questions.length,
		);
		for (const kind of questionKinds)
			expect(fixture.questions.some((q) => q.kind === kind)).toBe(true);
	});

	test("both groups exist, and each group's answers lie in its own documents", () => {
		for (const set of ["seen", "unseen"] as const) {
			const questions = fixture.questions.filter((q) => q.set === set);
			expect(questions.length).toBeGreaterThanOrEqual(10);
			for (const q of questions)
				for (const key of q.expected)
					expect(documentByKey.get(key)?.set).toBe(set);
		}
	});

	test("every expected document exists in the corpus", () => {
		for (const q of fixture.questions)
			for (const key of q.expected) expect(documentByKey.has(key)).toBe(true);
	});

	test("unseen questions use words that no seen document has", () => {
		const seenText = fixture.documents
			.filter((d) => d.set === "seen")
			.map((d) => norm(d.markdown));
		for (const q of fixture.questions.filter((x) => x.set === "unseen"))
			for (const text of seenText)
				expect(text.includes(norm(q.query))).toBe(false);
	});

	test("the kinds mean what they say", () => {
		for (const q of fixture.questions) {
			const length = [...q.query].length;
			const label = `${q.id} ${q.query}`;
			switch (q.kind) {
				case "verbatim":
					expect(length >= 3, label).toBe(true);
					expect(rawWithText(q.query).sort(), label).toEqual(
						[...q.expected].sort(),
					);
					break;
				case "short2":
					expect(length, label).toBe(2);
					expect(withText(q.query).sort(), label).toEqual(
						[...q.expected].sort(),
					);
					break;
				case "variant_width":
					// Written differently from every document, equal after NFKC and lower case.
					expect(rawWithText(q.query), label).toEqual([]);
					expect(withText(q.query).sort(), label).toEqual(
						[...q.expected].sort(),
					);
					break;
				case "entity_name":
					expect(withText(q.query).sort(), label).toEqual(
						[...q.expected].sort(),
					);
					for (const key of q.expected)
						expect(
							fixture.extraction.documents[key]?.entities.some(
								(e) => e.name === q.query,
							),
							label,
						).toBe(true);
					break;
				case "relation":
				case "variant_orthography":
					// Only the extraction says it: not in any body, but in an expected document's script.
					expect(withText(q.query), label).toEqual([]);
					expect(q.expected.length, label).toBeGreaterThan(0);
					for (const key of q.expected)
						expect(
							scriptText(key).some((t) => norm(t).includes(norm(q.query))),
							label,
						).toBe(true);
					break;
				case "semantic":
					expect(withText(q.query), label).toEqual([]);
					expect(q.expected.length, label).toBeGreaterThan(0);
					break;
				case "no_answer":
					expect(q.expected, label).toEqual([]);
					expect(withText(q.query), label).toEqual([]);
					for (const d of fixture.documents)
						expect(
							scriptText(d.key).some((t) => norm(t).includes(norm(q.query))),
							label,
						).toBe(false);
					break;
			}
		}
	});

	test("no word of a question appears as a special case in the evaluation code", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const dir = import.meta.dir;
		const sources = readdirSync(dir)
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
			.map((f) => readFileSync(join(dir, f), "utf8"))
			.join("\n");
		for (const q of fixture.questions)
			expect(sources.includes(q.query), q.query).toBe(false);
	});
});
