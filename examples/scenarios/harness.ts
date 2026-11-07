// Assembles the real package (core, sqlite, client) with the example host and the mocks, the way
// Eumenes will run it: the same job definitions, a real SQLite file, the HTTP API and the client.
// Only the external functions (Docling, inference, embedding, time) are mocks. No network, no
// listening socket.
import { randomUUID } from "node:crypto";
import { createKnowledgeClient } from "../../src/client/index.js";
import type {
	AccessContext,
	EmbeddingPort,
	EmbeddingSpace,
	IngestDeps,
	IngestOptions,
	LinkOptions,
	StatusOptions,
} from "../../src/contracts/index.js";
import {
	createIngestNextHandler,
	createLinkNextHandler,
	createSyncPageHandler,
	createVectorIndex,
	readEvidence,
	readRelated,
	search,
	sha256Hex,
} from "../../src/core/index.js";
import {
	migrations,
	readScanInSnapshot,
	readStatusInSnapshot,
} from "../../src/sqlite/index.js";
import {
	fixtureCatalog,
	fixtureNames,
	readFixtureBytes,
	readFixtureMarkdown,
	type FixtureName,
} from "../fixtures/index.js";
import { createExampleHost, type ExampleHost } from "../host/index.js";
import {
	createTestClock,
	type QueueLimits,
	type TestClock,
} from "../host/runner.js";
import {
	createDoclingMock,
	mockDocumentId,
	type MockDocumentInput,
} from "../mocks/docling.js";
import { createDoclingSource } from "../mocks/docling-source.js";
import { createMeaninglessHashEmbedding } from "../mocks/embedding.js";
import {
	createScriptedInference,
	type ScriptedCallInfo,
	type ScriptedScenario,
	type ScriptedStep,
} from "../mocks/inference.js";

/** The vector space of the default embedding mock (synthetic; the vectors carry no meaning). */
export const TEST_SPACE: EmbeddingSpace = {
	modelId: "synthetic-embedding",
	revision: "test-1",
	artifactDigest: "0".repeat(64),
	dimension: 8,
	queryPrefix: "query: ",
	passagePrefix: "passage: ",
};

/** What the extraction instruction v1 is called with (one call per fragment). */
export const EXTRACT_CALL = {
	purpose: "extract",
	instructionId: "extract",
	instructionVersion: 1,
	outputSchema: true,
} as const;

/** An answer with nothing in it, for scenarios that do not look at the extraction. */
export const EMPTY_EXTRACTION = JSON.stringify({ entities: [], relations: [] });

/** A step answering the call it is given (purpose and instruction), with `text`. */
export function answering(info: ScriptedCallInfo, text: string): ScriptedStep {
	return {
		expect: {
			purpose: info.purpose,
			instructionId: info.instructionId,
			instructionVersion: info.instructionVersion,
		},
		answer: { text },
	};
}

/** Identity and summary calls when a scenario scripts none: no decision (unsure), a fixed summary. */
function defaultLinkStep(info: ScriptedCallInfo): ScriptedStep {
	return answering(
		info,
		info.instructionId === "summarize"
			? JSON.stringify({ summary: "合成の要約。" })
			: JSON.stringify({ decisions: [] }),
	);
}

function stepOf(
	script: ScriptedScenario,
	index: number,
	info: ScriptedCallInfo,
): ScriptedStep | undefined {
	return Array.isArray(script)
		? (script as readonly ScriptedStep[])[index]
		: (
				script as {
					steps: (
						i: number,
						info: ScriptedCallInfo,
					) => ScriptedStep | undefined;
				}
			).steps(index, info);
}

export const DOCLING_CREDENTIAL = "docling-mock-credential-0123456789abcdef";
export const START_MS = Date.parse("2026-11-07T09:00:00+09:00");
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Two principals with different Docling namespaces (p0.md §4: the difference is verified here). */
export const PRINCIPALS = {
	"alice-token-0123456789abcdefghij": {
		principal: "alice",
		namespaces: ["notes", "work", "personal"],
	},
	"bob-token-0123456789abcdefghijkl": {
		principal: "bob",
		namespaces: ["work"],
	},
} satisfies Record<string, AccessContext>;
export const ALICE = "alice-token-0123456789abcdefghij";
export const BOB = "bob-token-0123456789abcdefghijkl";

export async function fixtureDocuments(
	names: readonly FixtureName[] = fixtureNames,
): Promise<MockDocumentInput[]> {
	return Promise.all(
		names.map(async (name) => {
			const { namespace, path, title } = fixtureCatalog[name];
			return {
				namespace,
				path,
				title,
				markdown: await readFixtureMarkdown(name),
			};
		}),
	);
}

export function fixtureId(name: FixtureName): string {
	const { namespace, path } = fixtureCatalog[name];
	return mockDocumentId(namespace, path);
}

/** sha256 of the fixture file's bytes, BOM included: what Docling's `markdownSha256` must be. */
export async function fixtureSha256(name: FixtureName): Promise<string> {
	return sha256Hex(await readFixtureBytes(name));
}

export type ScenarioOptions = {
	documents?: readonly MockDocumentInput[];
	pageSize?: number;
	/** Reopen an existing host directory (restart). */
	dir?: string;
	keep?: boolean;
	clock?: TestClock;
	queueLimits?: QueueLimits;
	maxAttempts?: number;
	deadlineMs?: number;
	docling?: ReturnType<typeof createDoclingMock>;
	/**
	 * The extraction script, chosen by the order of the extraction calls only (identity and summary
	 * calls do not consume it). Default: an empty answer for every call.
	 */
	inference?: ScriptedScenario;
	/** The identity and summary script, by the order of those calls. Default: no decision, a fixed summary. */
	linking?: ScriptedScenario;
	linkOptions?: LinkOptions;
	embedding?: EmbeddingPort;
	ingestOptions?: IngestOptions;
};

export type Scenario = Awaited<ReturnType<typeof createScenario>>;

export async function createScenario(options: ScenarioOptions = {}) {
	const clock = options.clock ?? createTestClock(START_MS);
	const docling =
		options.docling ??
		createDoclingMock({
			documents: options.documents ?? (await fixtureDocuments()),
			namespaces: ["notes", "work", "personal"],
			pageSize: options.pageSize ?? 100,
			credential: DOCLING_CREDENTIAL,
		});
	const source = createDoclingSource({
		fetch: (input, init) => docling.app.request(input, init),
		baseUrl: "http://docling.mock",
		credential: DOCLING_CREDENTIAL,
	});
	// One scripted provider for every purpose; each purpose keeps its own call order, so the
	// identity chain running between ingests does not shift the extraction script (plan §7.1: by
	// order, never by the prompt).
	let extractCalls = 0;
	let linkCalls = 0;
	const inference = createScriptedInference({
		scenarios: {
			script: {
				steps: (_index, info) => {
					if (info.purpose === "extract")
						return options.inference
							? stepOf(options.inference, extractCalls++, info)
							: answering(info, EMPTY_EXTRACTION);
					return options.linking
						? stepOf(options.linking, linkCalls++, info)
						: defaultLinkStep(info);
				},
			},
		},
		scenarioId: "script",
		clock,
	});
	const linkOptions: LinkOptions = options.linkOptions ?? {};
	const embedding =
		options.embedding ??
		createMeaninglessHashEmbedding({ space: TEST_SPACE }).port;
	const statusOptions: StatusOptions = {
		verifiedWithinMs: DAY_MS,
		maxUnappliedAttempts: options.ingestOptions?.maxUnappliedAttempts ?? 3,
		get binding() {
			return source.binding();
		},
	};
	const host: ExampleHost = createExampleHost({
		...(options.dir ? { dir: options.dir } : {}),
		keep: options.keep ?? false,
		source,
		principals: PRINCIPALS,
		clock,
		inference: inference.port,
		embedding,
		handlerFactories: [
			(deps: IngestDeps) =>
				createSyncPageHandler(deps, {
					maxUnappliedAttempts: options.ingestOptions?.maxUnappliedAttempts,
					summaryMinMentions: linkOptions.summaryMinMentions,
				}),
			(deps: IngestDeps) =>
				createIngestNextHandler(deps, options.ingestOptions),
			(deps: IngestDeps) => createLinkNextHandler(deps, linkOptions),
		],
		readStatusInSnapshot,
		readScanInSnapshot,
		packageMigrations: migrations,
		statusOptions,
		search,
		readEvidence,
		readRelated,
		createVectorIndex,
		searchOptions: {
			verifiedWithinMs: DAY_MS,
			maxUnappliedAttempts: options.ingestOptions?.maxUnappliedAttempts ?? 3,
		},
		...(options.queueLimits ? { queueLimits: options.queueLimits } : {}),
		...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
		...(options.deadlineMs
			? { deadlineFor: (_job, now) => now + options.deadlineMs! }
			: {}),
	});
	await host.ready;
	const client = (token: string) =>
		createKnowledgeClient({
			baseUrl: "http://example.host",
			token,
			fetch: async (input, init) => host.app.request(input, init),
		});

	/** Ask for a sync as `token` and run the host until no job is left. */
	async function sync(token = ALICE) {
		const requestId = randomUUID();
		const accepted = await client(token).requestSync(requestId);
		const run = await host.runner.runUntilIdle({ maxSteps: 10_000 });
		const finished = await client(token).getSyncRequest(requestId);
		return { requestId, accepted, finished, run };
	}

	type DocRow = {
		document_id: string;
		namespace: string;
		path: string;
		title: string;
		state: string;
		generation: number;
		ingest_retry: number;
		observed_markdown_sha256: string;
		applied_markdown_sha256: string | null;
		applied_byte_length: number | null;
		observed_etag: string;
	};
	function documentRow(id: string): DocRow | null {
		return host.store.read(
			(db) =>
				db
					.query("SELECT * FROM knowledge_documents WHERE document_id = ?")
					.get(id) as DocRow | null,
		);
	}
	function count(table: string): number {
		return host.store.read(
			(db) =>
				(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
					.n,
		);
	}
	function jobs(kind?: string) {
		return host.runner
			.listJobs()
			.filter((job) => kind === undefined || job.kind === kind);
	}

	return {
		clock,
		docling,
		inference: inference.control,
		source,
		host,
		client,
		sync,
		documentRow,
		count,
		jobs,
		close: () => host.close(),
	};
}
