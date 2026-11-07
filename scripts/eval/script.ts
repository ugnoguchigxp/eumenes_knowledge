// Turns the extraction fixture into the scripted inference answers of one document: one answer
// per fragment, in fragment order (the mock chooses its answer by call order only). The fragments
// are the ones the package itself cuts (`chunkMarkdown`); every quotation comes from their text.
// The prompt is never read.
import {
	extractionOutputSchema,
	type ExtractionOutput,
	type Fragment,
} from "../../src/contracts/index.js";
import { chunkMarkdown } from "../../src/core/index.js";
import type { EvalDocument, ExtractionFile } from "./fixture.js";

export type DocumentScript = {
	fragments: Fragment[];
	/** One answer per fragment, in fragment order. */
	answers: ExtractionOutput[];
};

/** Problems of the fixture (empty when it is consistent). Codes carry the document key. */
export type ScriptProblem = { document: string; code: string; detail: string };

const withinFragment = (fragment: Fragment, quote: string) =>
	fragment.text.includes(quote);

export function buildDocumentScript(
	document: EvalDocument,
	extraction: ExtractionFile,
): { script: DocumentScript; problems: ScriptProblem[] } {
	const problems: ScriptProblem[] = [];
	const problem = (code: string, detail: string) =>
		problems.push({ document: document.key, code, detail });
	const fragments = chunkMarkdown(document.bytes, document.markdown);
	const entry = extraction.documents[document.key];
	if (!entry) {
		problem("script_missing", "no entry for the document");
		return {
			script: {
				fragments,
				answers: fragments.map(() => ({ entities: [], relations: [] })),
			},
			problems,
		};
	}
	const { entities, relations } = entry;
	const byName = new Map(entities.map((e, index) => [e.name, index]));
	if (byName.size !== entities.length)
		problem("entity_name_duplicated", "entity names must be unique");

	// An entity belongs to the first fragment that holds one of its quotations, and to each
	// fragment where a relation uses it as an endpoint.
	const quotesIn = (quotes: readonly string[], fragment: Fragment) =>
		quotes.filter((q) => withinFragment(fragment, q));
	const home = entities.map((e) =>
		fragments.findIndex((f) => quotesIn(e.evidence, f).length > 0),
	);
	entities.forEach((e, index) => {
		if (home[index] === -1)
			problem("entity_quote_not_in_fragment", `${e.name}`);
	});
	const members: Set<number>[] = fragments.map(() => new Set<number>());
	home.forEach((fragmentIndex, entityIndex) => {
		if (fragmentIndex >= 0) members[fragmentIndex]?.add(entityIndex);
	});
	const relationHome = relations.map((r) =>
		fragments.findIndex((f) => quotesIn(r.evidence, f).length > 0),
	);
	relations.forEach((r, index) => {
		const fragmentIndex = relationHome[index] ?? -1;
		const fragment = fragments[fragmentIndex];
		if (!fragment) {
			problem("relation_quote_not_in_fragment", `${r.source} -> ${r.target}`);
			return;
		}
		for (const name of [r.source, r.target]) {
			const entityIndex = byName.get(name);
			const entity =
				entityIndex === undefined ? undefined : entities[entityIndex];
			if (entityIndex === undefined || !entity) {
				problem("relation_endpoint_unknown", name);
			} else if (quotesIn(entity.evidence, fragment).length === 0) {
				problem(
					"relation_endpoint_not_in_fragment",
					`${name} (${r.source} -> ${r.target})`,
				);
			} else {
				members[fragmentIndex]?.add(entityIndex);
			}
		}
	});

	const answers = fragments.map((fragment, fragmentIndex): ExtractionOutput => {
		const entityIndexes = [...(members[fragmentIndex] ?? [])].sort(
			(a, b) => a - b,
		);
		const localId = new Map(
			entityIndexes.map((entityIndex, n) => [entityIndex, `e${n + 1}`]),
		);
		const answerEntities = entityIndexes.map((entityIndex) => {
			const e = entities[entityIndex]!;
			return {
				id: localId.get(entityIndex)!,
				name: e.name,
				type: e.type,
				description: e.description,
				evidence: quotesIn(e.evidence, fragment),
			};
		});
		let n = 0;
		const answerRelations = relations.flatMap((r, relationIndex) => {
			if (relationHome[relationIndex] !== fragmentIndex) return [];
			const source = localId.get(byName.get(r.source) ?? -1);
			const target = localId.get(byName.get(r.target) ?? -1);
			if (!source || !target) return [];
			n += 1;
			return [
				{
					id: `r${n}`,
					source,
					target,
					directed: r.directed,
					relation: r.relation,
					description: r.description,
					keywords: r.keywords,
					qualifiers: r.qualifiers,
					evidence: quotesIn(r.evidence, fragment),
				},
			];
		});
		return { entities: answerEntities, relations: answerRelations };
	});
	answers.forEach((answer, index) => {
		const parsed = extractionOutputSchema.safeParse(answer);
		if (!parsed.success)
			problem("answer_schema_violation", `fragment ${index}`);
	});
	return { script: { fragments, answers }, problems };
}

/** The scripts of every document, with all problems found. */
export function buildScripts(
	documents: readonly EvalDocument[],
	extraction: ExtractionFile,
): { scripts: Map<string, DocumentScript>; problems: ScriptProblem[] } {
	const scripts = new Map<string, DocumentScript>();
	const problems: ScriptProblem[] = [];
	for (const document of documents) {
		const built = buildDocumentScript(document, extraction);
		scripts.set(document.key, built.script);
		problems.push(...built.problems);
	}
	for (const key of Object.keys(extraction.documents)) {
		if (!documents.some((d) => d.key === key))
			problems.push({
				document: key,
				code: "script_without_document",
				detail: "the extraction names a document the corpus lacks",
			});
	}
	return { scripts, problems };
}
