// Ingests the evaluation corpus with the example host (`createScenario`: the real package, a real
// SQLite file, the mock Docling, scripted inference, mock embedding). Documents are added to the
// mock Docling one at a time and synced, so the scripted inference (chosen by call order only)
// always knows which document it answers for.
import {
	EXTRACT_CALL,
	createScenario,
	type Scenario,
} from "../../examples/scenarios/harness.js";
import type {
	ScriptedScenario,
	ScriptedStep,
} from "../../examples/mocks/inference.js";
import type { ExtractionOutput } from "../../src/contracts/index.js";
import type { EvalFixture } from "./fixture.js";
import {
	countEmbedding,
	type CountingEmbedding,
	type EvalPorts,
} from "./ports.js";
import { buildScripts, type DocumentScript } from "./script.js";

export class EvalIngestError extends Error {
	constructor(
		readonly code: string,
		detail: string,
	) {
		super(`${code}: ${detail}`);
	}
}

export type IngestStats = {
	documents: number;
	fragments: number;
	/** Every inference call while ingesting (extraction plus the identity chain). */
	inferenceCalls: number;
	/** Extraction calls: one per fragment. */
	extractionCalls: number;
	/** Identity and summary calls of the link chain (p3.md §8). */
	linkCalls: number;
	embeddingCalls: number;
	embeddingTexts: number;
	/** Entity and relation records the scripted answers carried. */
	scriptedEntities: number;
	scriptedRelations: number;
};

export type IngestedCorpus = {
	scenario: Scenario;
	stats: IngestStats;
	/** Embedding wrapper for the search phase (kept apart from the ingest count). */
	searchEmbedding: CountingEmbedding;
	close(): Promise<void>;
};

const step = (answer: ExtractionOutput): ScriptedStep => ({
	expect: EXTRACT_CALL,
	answer: { text: JSON.stringify(answer) },
});

export async function ingestCorpus(
	fixture: EvalFixture,
	ports: EvalPorts,
): Promise<IngestedCorpus> {
	const { scripts, problems } = buildScripts(
		fixture.documents,
		fixture.extraction,
	);
	if (problems.length > 0)
		throw new EvalIngestError(
			"fixture_inconsistent",
			problems
				.slice(0, 5)
				.map((p) => `${p.document} ${p.code}`)
				.join("; "),
		);

	// The script of the document being synced; `base` is the extraction call count before it
	// started. The harness numbers extraction calls on their own (identity and summary calls of the
	// link chain do not shift them).
	let current: { script: DocumentScript; base: number } | null = null;
	const inference: ScriptedScenario = {
		steps: (index) => {
			const active = current;
			const answer = active?.script.answers[index - active.base];
			return answer ? step(answer) : undefined;
		},
	};
	const ingestEmbedding = countEmbedding(ports.embedding);
	const searchEmbedding = countEmbedding(ports.embedding);
	const scenario = await createScenario({
		documents: [],
		inference,
		embedding: ingestEmbedding.port,
	});
	try {
		let fragments = 0;
		let scriptedEntities = 0;
		let scriptedRelations = 0;
		for (const document of fixture.documents) {
			const script = scripts.get(document.key);
			if (!script) throw new EvalIngestError("script_missing", document.key);
			const base = extractionCalls(scenario).length;
			current = { script, base };
			scenario.docling.control.addDocument({
				namespace: document.namespace,
				path: document.path,
				title: document.title,
				markdown: document.markdown,
			});
			const { finished } = await scenario.sync();
			if (finished.state !== "completed" || !finished.complete)
				throw new EvalIngestError("sync_incomplete", document.key);
			const row = scenario.documentRow(document.documentId);
			if (
				!row ||
				row.state !== "current" ||
				row.applied_markdown_sha256 !== document.sha256
			)
				throw new EvalIngestError("document_not_ingested", document.key);
			const calls = extractionCalls(scenario);
			if (calls.length - base !== script.fragments.length)
				throw new EvalIngestError(
					"inference_call_count",
					`${document.key}: ${calls.length - base} calls for ${script.fragments.length} fragments`,
				);
			if (calls.slice(base).some((call) => call.outcome !== "answered"))
				throw new EvalIngestError("inference_not_answered", document.key);
			fragments += script.fragments.length;
			for (const answer of script.answers) {
				scriptedEntities += answer.entities.length;
				scriptedRelations += answer.relations.length;
			}
		}
		current = null;
		const embedding = ingestEmbedding.counts();
		return {
			scenario,
			searchEmbedding,
			stats: {
				documents: fixture.documents.length,
				fragments,
				inferenceCalls: scenario.inference.calls().length,
				extractionCalls: extractionCalls(scenario).length,
				linkCalls:
					scenario.inference.calls().length - extractionCalls(scenario).length,
				embeddingCalls: embedding.calls,
				embeddingTexts: embedding.texts,
				scriptedEntities,
				scriptedRelations,
			},
			close: () => scenario.close(),
		};
	} catch (error) {
		await scenario.close().catch(() => {});
		throw error;
	}
}

/** The extraction calls (one per fragment); the identity chain's calls are counted apart. */
function extractionCalls(scenario: {
	inference: { calls(): readonly { purpose: string; outcome: string }[] };
}) {
	return scenario.inference
		.calls()
		.filter((call) => call.purpose === "extract");
}
