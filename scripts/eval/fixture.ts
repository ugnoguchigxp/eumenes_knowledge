// Loads the evaluation fixture (examples/fixtures/eval): synthetic Markdown documents, the
// scripted extraction answers and the questions, with their versions and digests (p3.md section 6).
// Nothing here is a product feature: it only reads files and checks their shape.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { mockDocumentId } from "../../examples/mocks/docling.js";

export const FIXTURE_DIR = resolve(
	import.meta.dir,
	"..",
	"..",
	"examples",
	"fixtures",
	"eval",
);

export const evalSets = ["seen", "unseen"] as const;
export type EvalSet = (typeof evalSets)[number];

/** Corpus directory of each set: the unseen set is kept apart from the seen one. */
export const CORPUS_DIRS: Readonly<Record<EvalSet, string>> = {
	seen: "corpus",
	unseen: "corpus-unseen",
};

export const questionKinds = [
	/** The phrase is in the body as written. */
	"verbatim",
	/** Full/half width or letter case differs from the body (NFKC and lower case make them equal). */
	"variant_width",
	/** Another spelling or word for something the body writes differently (only the extraction knows it). */
	"variant_orthography",
	/** The query is the name of an entity the extraction found. */
	"entity_name",
	/** The query is a phrase of a relation's description, not of the body. */
	"relation",
	/** Two characters: too short for a trigram index. */
	"short2",
	/** A paraphrase that needs real embeddings; the mock embeddings carry no meaning. */
	"semantic",
	/** The corpus has no answer. */
	"no_answer",
] as const;
export type QuestionKind = (typeof questionKinds)[number];

/** A document of the corpus. `key` is `<namespace>/<path>` and names a document in questions. */
export type EvalDocument = {
	key: string;
	namespace: string;
	path: string;
	title: string;
	set: EvalSet;
	markdown: string;
	bytes: Uint8Array;
	sha256: string;
	/** The id the mock Docling gives the document. */
	documentId: string;
};

const quote = z.string().min(1).max(400);
const scriptEntitySchema = z.strictObject({
	name: z.string().min(1).max(200),
	type: z.string().min(1).max(80),
	description: z.string().min(1).max(1000),
	/** Contiguous quotations of the document; the ones inside a fragment become its evidence. */
	evidence: z.array(quote).min(1).max(4),
});
const scriptRelationSchema = z.strictObject({
	/** Entity names of the same document. */
	source: z.string().min(1),
	target: z.string().min(1),
	relation: z.string().min(1).max(120),
	description: z.string().min(1).max(1000),
	keywords: z.array(z.string().min(1).max(60)).max(10),
	evidence: z.array(quote).min(1).max(4),
	directed: z.boolean(),
	qualifiers: z.strictObject({
		negated: z.boolean(),
		condition: z.string().min(1).max(300).nullable(),
		certainty: z.enum(["stated", "uncertain", "hypothetical"]),
	}),
});
export const extractionFileSchema = z.strictObject({
	version: z.number().int().min(1),
	note: z.string(),
	documents: z.record(
		z.string(),
		z.strictObject({
			entities: z.array(scriptEntitySchema),
			relations: z.array(scriptRelationSchema),
		}),
	),
});
export type ExtractionFile = z.infer<typeof extractionFileSchema>;
export type ScriptEntity = z.infer<typeof scriptEntitySchema>;
export type ScriptRelation = z.infer<typeof scriptRelationSchema>;

export const questionSchema = z.strictObject({
	id: z.string().regex(/^[su][0-9]{2,}$/),
	set: z.enum(evalSets),
	kind: z.enum(questionKinds),
	query: z.string().min(1).max(1000),
	/** Document keys; empty when the corpus has no answer. */
	expected: z.array(z.string().min(1)),
});
export type EvalQuestion = z.infer<typeof questionSchema>;
export const questionsFileSchema = z.strictObject({
	version: z.number().int().min(1),
	note: z.string(),
	questions: z.array(questionSchema).min(1),
});
export type QuestionsFile = z.infer<typeof questionsFileSchema>;

const digestEntry = z.strictObject({
	count: z.number().int().min(0),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const manifestSchema = z.strictObject({
	/** Bumped by hand with `update-manifest` whenever a digest changes. */
	corpus: z.strictObject({
		version: z.number().int().min(1),
		digest: z.string().regex(/^[0-9a-f]{64}$/),
		seen: digestEntry,
		unseen: digestEntry,
	}),
	extraction: z.strictObject({
		version: z.number().int().min(1),
		digest: z.string().regex(/^[0-9a-f]{64}$/),
	}),
	questions: z.strictObject({
		version: z.number().int().min(1),
		digest: z.string().regex(/^[0-9a-f]{64}$/),
		seen: digestEntry,
		unseen: digestEntry,
	}),
});
export type FixtureManifest = z.infer<typeof manifestSchema>;

export const sha256Of = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

export type EvalFixture = {
	dir: string;
	documents: EvalDocument[];
	extraction: ExtractionFile;
	questions: EvalQuestion[];
	/** What the files hold now (recomputed). */
	digests: FixtureManifest;
	/** What `manifest.json` states, or null when the file does not exist. */
	manifest: FixtureManifest | null;
};

function listMarkdown(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? listMarkdown(join(dir, entry.name), `${prefix}${entry.name}/`)
				: entry.name.endsWith(".md")
					? [`${prefix}${entry.name}`]
					: [],
		)
		.sort();
}

function titleOf(markdown: string): string {
	const first = markdown.split("\n", 1)[0] ?? "";
	if (!first.startsWith("# ")) throw new Error("fixture_title_missing");
	return first.slice(2).trim();
}

export function loadDocuments(dir = FIXTURE_DIR): EvalDocument[] {
	const documents: EvalDocument[] = [];
	for (const set of evalSets) {
		const base = join(dir, CORPUS_DIRS[set]);
		for (const rel of listMarkdown(base)) {
			const slash = rel.indexOf("/");
			if (slash < 1) throw new Error(`fixture_path_invalid:${rel}`);
			const namespace = rel.slice(0, slash);
			const path = rel.slice(slash + 1);
			const bytes = new Uint8Array(readFileSync(join(base, rel)));
			// The BOM is kept (there is none in these files); a default decoder would drop it.
			const markdown = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes);
			documents.push({
				key: `${namespace}/${path}`,
				namespace,
				path,
				title: titleOf(markdown),
				set,
				markdown,
				bytes,
				sha256: sha256Of(bytes),
				documentId: mockDocumentId(namespace, path),
			});
		}
	}
	documents.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return documents;
}

const subset = <T extends { set: EvalSet }>(
	items: readonly T[],
	set: EvalSet,
) => items.filter((item) => item.set === set);

/** Digest of a document list: `[set, key, sha256]` rows in key order. */
export function corpusDigest(documents: readonly EvalDocument[]): string {
	return sha256Of(
		JSON.stringify(documents.map((d) => [d.set, d.key, d.sha256])),
	);
}

/** Digest of a question list: the questions as data, in file order. */
export function questionsDigest(questions: readonly EvalQuestion[]): string {
	return sha256Of(JSON.stringify(questions));
}

/** The versions are not part of the digests; they are taken from `previous` (default 1). */
export function computeManifest(
	documents: readonly EvalDocument[],
	extractionBytes: Uint8Array,
	questions: readonly EvalQuestion[],
	previous: FixtureManifest | null,
): FixtureManifest {
	const seenDocs = subset(documents, "seen");
	const unseenDocs = subset(documents, "unseen");
	const seenQs = subset(questions, "seen");
	const unseenQs = subset(questions, "unseen");
	return {
		corpus: {
			version: previous?.corpus.version ?? 1,
			digest: corpusDigest(documents),
			seen: { count: seenDocs.length, digest: corpusDigest(seenDocs) },
			unseen: { count: unseenDocs.length, digest: corpusDigest(unseenDocs) },
		},
		extraction: {
			version: previous?.extraction.version ?? 1,
			digest: sha256Of(extractionBytes),
		},
		questions: {
			version: previous?.questions.version ?? 1,
			digest: questionsDigest(questions),
			seen: { count: seenQs.length, digest: questionsDigest(seenQs) },
			unseen: { count: unseenQs.length, digest: questionsDigest(unseenQs) },
		},
	};
}

export function loadFixture(dir = FIXTURE_DIR): EvalFixture {
	const documents = loadDocuments(dir);
	const extractionBytes = new Uint8Array(
		readFileSync(join(dir, "extraction.json")),
	);
	const extraction = extractionFileSchema.parse(
		JSON.parse(new TextDecoder().decode(extractionBytes)),
	);
	const questions = questionsFileSchema.parse(
		JSON.parse(readFileSync(join(dir, "questions.json"), "utf8")),
	).questions;
	let manifest: FixtureManifest | null = null;
	try {
		manifest = manifestSchema.parse(
			JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return {
		dir,
		documents,
		extraction,
		questions,
		digests: computeManifest(documents, extractionBytes, questions, manifest),
		manifest,
	};
}

/** Whether `manifest.json` states the digests the files have now (versions are not compared). */
export function manifestMatches(fixture: EvalFixture): boolean {
	const strip = (m: FixtureManifest) => ({
		corpus: { ...m.corpus, version: 0 },
		extraction: { ...m.extraction, version: 0 },
		questions: { ...m.questions, version: 0 },
	});
	return (
		fixture.manifest !== null &&
		Bun.deepEquals(strip(fixture.manifest), strip(fixture.digests), true)
	);
}
