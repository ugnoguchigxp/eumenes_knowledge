import { z } from "zod";
import {
	documentInputSchema,
	embeddingSpaceKey,
	ingestNextDedupeKey,
	ingestNextPayloadSchema,
	KNOWLEDGE_JOB_KINDS,
	KnowledgeError,
	MAX_EMBED_BATCH,
	MAX_FRAGMENT_BYTES,
	SourceError,
	type CreateIngestNextHandler,
	type EmbeddingSpace,
	type Fragment,
	type FragmentExtraction,
	type InferenceRequest,
	type InferenceResult,
	type IngestDeps,
	type IngestNextPayload,
	type IngestOptions,
	type KnowledgeJobHandler,
	type SettleResult,
	type Tx,
} from "../../contracts/index.js";
import { instruction, INSTRUCTION_SET_DIGEST } from "../../contexts/index.js";
import {
	abandonVersionInTransaction,
	advanceChainInTransaction,
	cleanupInTransaction,
	closeChainInTransaction,
	countPublishedFragmentsInTransaction,
	createStagingVersionInTransaction,
	discardStagingInTransaction,
	getActiveIngestInTransaction,
	getChainInTransaction,
	getDocumentInTransaction,
	hasCleanupInTransaction,
	markDocumentUnavailableInTransaction,
	markIngestSupersededInTransaction,
	delayReextractInTransaction,
	pickNextDocumentInTransaction,
	pickVersionToReextractInTransaction,
	publishVersionInTransaction,
	readVersionToCopyInTransaction,
	republishVersionInTransaction,
	recordIngestFailureInTransaction,
	recordTransientIngestFailureInTransaction,
	setActiveIngestInTransaction,
	stageExtractionsInTransaction,
	stageFragmentsInTransaction,
	stageLinksInTransaction,
	stageVectorsInTransaction,
	touchChainInTransaction,
	type IngestExpectation,
	type LinkToStage,
} from "../../sqlite/index.js";
import { sha256Hex, utf8Bytes } from "../bytes.js";
import {
	buildExtractionRequest,
	EXTRACT_INSTRUCTION_ID,
	mergeGleaning,
	verifyExtraction,
	createCharclassTokenizer,
	extractNames,
	fragmentStructures,
	type NameStructure,
	TokenizerFailure,
} from "../extract/index.js";
import {
	DEFAULT_MAX_FRAGMENTS_PER_DOCUMENT,
	DEFAULT_MAX_INDEXED_FRAGMENTS,
	DEFAULT_MAX_UNAPPLIED_ATTEMPTS,
	DEFAULT_ORPHAN_STAGING_AFTER_MS,
	DEFAULT_TRANSIENT_RETRY_DELAY_MS,
	PortFailure,
	classifyJobError,
	isContentErrorCode,
	safeEmit,
} from "../support.js";
import {
	chunkMarkdown,
	linkName,
	markdownLinks,
	normalizeForSearch,
} from "../text/index.js";
import { DEFAULT_EXTRACTOR, extractorFingerprint } from "./extractor.js";
import { startLinkChainInTransaction } from "./link-start.js";

export const DEFAULT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLEANUP_BATCH_ROWS = 300;
const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;
/** Fragments and vectors go to staging in bundles of this many. */
const STAGE_BATCH = 64;
/** One staging write of extractions holds at most about this many rows (extraction, mention, evidence). */
const STAGE_EXTRACTION_ROWS = 2_000;

// ---------------------------------------------------------------------------
// What prepare fixes and what execute returns
// ---------------------------------------------------------------------------

/** The tuple prepare fixed (p0.md §2.2); every field must still match when the result is applied. */
export type IngestTarget = IngestExpectation;

export type IngestNextInput =
	| {
			mode: "ingest";
			sweep: number;
			binding: string;
			target: IngestTarget;
			/** The job's deadline (epoch ms), or null without one. */
			deadlineAtMs: number | null;
	  }
	/**
	 * A published version extracted by another extractor (kg2.md G7): extract its stored
	 * fragments again and publish the result in its place.
	 */
	| {
			mode: "reextract";
			sweep: number;
			/** The published version that is copied. */
			versionId: number;
			target: IngestTarget;
			deadlineAtMs: number | null;
	  }
	/** No document to ingest, only retired or abandoned rows to delete. */
	| { mode: "cleanup"; sweep: number };

const targetSchema = z.strictObject({
	sourceNamespace: z.string().min(1),
	documentId: z.string().min(1),
	markdownSha256: z.string().regex(/^[a-f0-9]{64}$/),
	generation: z.number().int().min(0),
	retry: z.number().int().min(0),
	namespace: z.string().min(1),
});

const count = z.number().int().min(0);

export const ingestNextOutputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("ingested"),
		binding: z.string(),
		versionId: z.number().int().min(1),
		target: targetSchema,
		stats: z.strictObject({
			fragments: count,
			extractionsOk: count,
			extractionsFailed: count,
			/** Elements and quotations of the model's answers that the checks dropped. */
			dropped: count,
		}),
	}),
	/** The source answered 404/403: the document becomes unavailable. */
	z.strictObject({
		kind: z.literal("unavailable"),
		binding: z.string(),
		target: targetSchema,
		reason: z.enum(["not_found", "forbidden"]),
	}),
	/** The source holds another version (or the row moved on): nothing is applied. */
	z.strictObject({
		kind: z.literal("superseded"),
		binding: z.string(),
		target: targetSchema,
	}),
	/** A re-extracted copy of `previousVersionId`, staged as `versionId` (kg2.md G7). */
	z.strictObject({
		kind: z.literal("reextracted"),
		versionId: z.number().int().min(1),
		previousVersionId: z.number().int().min(1),
		target: targetSchema,
		stats: z.strictObject({
			fragments: count,
			extractionsOk: count,
			extractionsFailed: count,
			dropped: count,
		}),
	}),
	/** The version to re-extract is no longer published: nothing was done. */
	z.strictObject({
		kind: z.literal("reextract_gone"),
		previousVersionId: z.number().int().min(1),
	}),
	z.strictObject({ kind: z.literal("cleanup_only") }),
]);
export type IngestNextOutput = z.infer<typeof ingestNextOutputSchema>;

export type IngestNextHandler = KnowledgeJobHandler<
	IngestNextPayload,
	IngestNextInput,
	IngestNextOutput
>;

/**
 * The job that ingests the registry's stale documents one by one (p2.md §2, §3). One link of the
 * chain ingests one document: prepare fixes the tuple, execute reads, splits, extracts and
 * embeds outside any transaction and stages the result in bundles through the host's writer,
 * settle publishes it if the tuple still holds, deletes a bounded number of retired rows and
 * hands the next link to the host's queue.
 */
export const createIngestNextHandler: CreateIngestNextHandler = (
	deps: IngestDeps,
	options: IngestOptions = {},
) => buildHandler(deps, options);

function buildHandler(
	deps: IngestDeps,
	options: IngestOptions,
): IngestNextHandler {
	const maxBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
	const maxFragmentBytes = options.maxFragmentBytes ?? MAX_FRAGMENT_BYTES;
	const gleaning = options.gleaning ?? 0;
	const maxUnappliedAttempts =
		options.maxUnappliedAttempts ?? DEFAULT_MAX_UNAPPLIED_ATTEMPTS;
	const transientRetryDelayMs =
		options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
	const maxFragmentsPerDocument =
		options.maxFragmentsPerDocument ?? DEFAULT_MAX_FRAGMENTS_PER_DOCUMENT;
	const maxIndexedFragments =
		options.maxIndexedFragments ?? DEFAULT_MAX_INDEXED_FRAGMENTS;
	const orphanStagingAfterMs =
		options.orphanStagingAfterMs ?? DEFAULT_ORPHAN_STAGING_AFTER_MS;
	const cleanupBatchRows =
		options.cleanupBatchRows ?? DEFAULT_CLEANUP_BATCH_ROWS;
	const inferenceTimeoutMs =
		options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
	const extractInstruction = instruction(EXTRACT_INSTRUCTION_ID);
	const extractor = options.extractor ?? DEFAULT_EXTRACTOR;
	if (extractor !== "model" && extractor !== "names")
		throw new KnowledgeError("invalid_input");
	const tokenizer = deps.tokenizer ?? createCharclassTokenizer();
	const fingerprint = extractorFingerprint(extractor, tokenizer);
	/** Only the model-free extractor extracts published versions again (the model's is frozen). */
	const pickReextract = (tx: Tx, now: number) =>
		extractor === "names"
			? pickVersionToReextractInTransaction(tx, fingerprint, now)
			: null;

	/**
	 * An ingest ended without applying anything because of the content (digest, size, contract).
	 * Count it, but only while the row still matches the tuple: a row that moved on already has a
	 * newer tuple. The count is what caps the attempts at one version.
	 */
	const countUnapplied = (tx: Tx, target: IngestTarget, reason: string) => {
		if (recordIngestFailureInTransaction(tx, target, deps.clock.now())) {
			safeEmit(deps.events, {
				type: "knowledge.ingest.unapplied",
				level: "info",
				fields: {
					documentId: target.documentId,
					retry: target.retry + 1,
					reason,
				},
			});
		}
	};

	/**
	 * An ingest ended without applying anything for a temporary reason (a port, a shutdown, a
	 * restart, a deadline, a cancel). Nothing is counted; the document waits before it is picked
	 * again (longer after each consecutive one).
	 */
	const delayRetry = (tx: Tx, target: IngestTarget, reason: string) => {
		const now = deps.clock.now();
		if (
			recordTransientIngestFailureInTransaction(
				tx,
				target,
				now,
				transientRetryDelayMs,
			)
		) {
			safeEmit(deps.events, {
				type: "knowledge.ingest.delayed",
				level: "info",
				fields: { documentId: target.documentId, reason },
			});
		}
	};

	/**
	 * The checked extraction of one fragment. A port that throws or answers `ok: false` (an abort
	 * excepted, which ends the job) is the provider's failure, not the fragment's: the whole ingest
	 * ends as a temporary failure and nothing is published. Only an answer that arrived and is
	 * invalid (`invalid_json`, `schema_violation`) fails this fragment alone; the others go on.
	 */
	async function extractFragment(
		fragment: Fragment,
		structure: NameStructure | undefined,
		signal: AbortSignal,
		jobDeadlineAtMs: number | null,
	): Promise<FragmentExtraction> {
		if (extractor === "names") {
			// The extraction is synchronous: one turn of the event loop per fragment keeps the
			// host's timers (heartbeats, deadlines) running through a long document.
			await new Promise<void>((resolve) => setImmediate(resolve));
			signal.throwIfAborted();
			try {
				return extractNames(fragment, tokenizer, structure);
			} catch (error) {
				// A tokenizer that throws: the host's port failed, not the fragment (the ingest ends
				// as a temporary failure; the job's error code is `tokenizer`). Tokens that do not
				// fit the text fail the fragment alone (`invalid_tokens`); anything else is a fault
				// of this package and fails the job.
				if (error instanceof TokenizerFailure)
					throw new PortFailure("tokenizer");
				throw error;
			}
		}
		const complete = async (
			request: InferenceRequest,
		): Promise<InferenceResult> => {
			let result: InferenceResult;
			try {
				result = await deps.inference.complete(request, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				throw new PortFailure("inference");
			}
			if (!result.ok) throw new PortFailure("inference");
			return result;
		};
		// The earlier of the job's deadline and one inference's own limit.
		const deadlineAtMs = () =>
			Math.min(
				jobDeadlineAtMs ?? Number.POSITIVE_INFINITY,
				deps.clock.now() + inferenceTimeoutMs,
			);
		const first = await complete(
			buildExtractionRequest(fragment, {
				instruction: extractInstruction,
				deadlineAtMs: deadlineAtMs(),
			}),
		);
		let current = verifyExtraction(fragment, first);
		for (let pass = 0; pass < gleaning && current.status === "ok"; pass++) {
			signal.throwIfAborted();
			const answer = await complete(
				buildExtractionRequest(fragment, {
					instruction: extractInstruction,
					deadlineAtMs: deadlineAtMs(),
					previous: current,
				}),
			);
			const next = verifyExtraction(fragment, answer);
			if (next.status === "failed") break;
			current = mergeGleaning(current, next);
		}
		return current;
	}

	const hasWork = (tx: Tx, now: number) =>
		pickNextDocumentInTransaction(tx, { maxUnappliedAttempts, now }) !== null ||
		pickReextract(tx, now) !== null ||
		hasCleanupInTransaction(tx);

	return {
		kind: KNOWLEDGE_JOB_KINDS.ingestNext,
		payloadVersions: [1],
		schema: ingestNextPayloadSchema,
		recovery: "replay_safe",

		prepareInTransaction(tx, claim) {
			const { sweep } = claim.payload;
			const now = deps.clock.now();
			// Only the open link works; a replaced or closed one writes nothing.
			if (getChainInTransaction(tx).openSweep !== sweep) {
				return { status: "stale", reason: "superseded" };
			}
			// A rerun of this link (a retry, a restart) starts from nothing: the staging of what
			// the earlier run fixed is given up before the document is chosen again.
			const previous = getActiveIngestInTransaction(tx, sweep);
			if (previous) discardStagingInTransaction(tx, previous, now);

			const binding = deps.source.binding();
			if (binding === null) {
				setActiveIngestInTransaction(tx, sweep, null);
				closeChainInTransaction(tx, sweep);
				return { status: "stale", reason: "source_unconfigured" };
			}
			const row = pickNextDocumentInTransaction(tx, {
				maxUnappliedAttempts,
				now,
			});
			if (row) {
				const target: IngestTarget = {
					sourceNamespace: row.sourceNamespace,
					documentId: row.documentId,
					markdownSha256: row.observedMarkdownSha256,
					generation: row.generation,
					retry: row.ingestRetry,
					namespace: row.namespace,
				};
				setActiveIngestInTransaction(tx, sweep, target);
				return {
					status: "ready",
					input: {
						mode: "ingest",
						sweep,
						binding,
						target,
						deadlineAtMs: claim.deadlineAtMs,
					},
				};
			}
			// Every waiting document first; then the versions another extractor extracted.
			const reextract = pickReextract(tx, now);
			if (reextract) {
				const { versionId, ...target } = reextract;
				setActiveIngestInTransaction(tx, sweep, target);
				return {
					status: "ready",
					input: {
						mode: "reextract",
						sweep,
						versionId,
						target,
						deadlineAtMs: claim.deadlineAtMs,
					},
				};
			}
			setActiveIngestInTransaction(tx, sweep, null);
			if (hasCleanupInTransaction(tx)) {
				return { status: "ready", input: { mode: "cleanup", sweep } };
			}
			closeChainInTransaction(tx, sweep);
			return { status: "stale", reason: "nothing_to_do" };
		},

		async execute(input, context) {
			if (input.mode === "cleanup") return { kind: "cleanup_only" };
			if (input.mode === "reextract")
				return reextractVersion(input, context.signal);
			const { signal } = context;
			const { target, sweep, binding } = input;
			const assertBinding = () => {
				if (deps.source.binding() !== binding) {
					throw new SourceError("connection_changed");
				}
			};
			const superseded = (): IngestNextOutput => ({
				kind: "superseded",
				binding,
				target,
			});

			// 1. Read and check the body.
			assertBinding();
			signal.throwIfAborted();
			let raw: unknown;
			try {
				raw = await deps.source.read(target.documentId, signal);
			} catch (error) {
				if (
					error instanceof SourceError &&
					(error.code === "not_found" || error.code === "forbidden")
				) {
					return { kind: "unavailable", binding, target, reason: error.code };
				}
				throw error;
			}
			assertBinding();
			signal.throwIfAborted();
			const parsed = documentInputSchema.safeParse(raw);
			if (!parsed.success) throw new KnowledgeError("contract_mismatch");
			const { markdown, ...summary } = parsed.data;
			if (
				summary.documentId !== target.documentId ||
				summary.sourceNamespace !== target.sourceNamespace
			) {
				throw new KnowledgeError("document_mismatch");
			}
			if (
				summary.markdownSha256 !== target.markdownSha256 ||
				summary.namespace !== target.namespace
			) {
				return superseded();
			}
			const bytes = utf8Bytes(markdown);
			// The size check comes before the hash: no work is spent on a body that is refused anyway.
			if (bytes.byteLength > maxBytes) {
				throw new KnowledgeError("document_too_large");
			}
			if (sha256Hex(bytes) !== target.markdownSha256) {
				throw new KnowledgeError("digest_mismatch");
			}

			// 2. Split, and open a staging version (unless the row moved on meanwhile).
			const fragments = chunkMarkdown(bytes, markdown, {
				maxBytes: maxFragmentBytes,
			});
			if (fragments.length > maxFragmentsPerDocument) {
				throw new KnowledgeError("document_too_large");
			}
			// Every write below is one short transaction on the host's writer. Each also tells the
			// chain that this link is alive: a long ingest must not look lost to the next scan.
			const write = <T>(operation: (tx: Tx) => T): Promise<T> =>
				deps.writer.write((tx) => {
					touchChainInTransaction(tx, sweep, deps.clock.now());
					return operation(tx);
				});
			const versionId = await write((tx) => {
				if (getChainInTransaction(tx).openSweep !== sweep) return null;
				const row = getDocumentInTransaction(tx, target);
				if (
					!row ||
					row.state !== "stale" ||
					row.generation !== target.generation ||
					row.ingestRetry !== target.retry ||
					row.observedMarkdownSha256 !== target.markdownSha256 ||
					row.namespace !== target.namespace
				) {
					return null;
				}
				// The published versions together may not pass the cap (the document's own old
				// version retires when this one is published, so it is not counted). A fixed code:
				// nothing is staged, nothing is published.
				if (
					countPublishedFragmentsInTransaction(tx, target) + fragments.length >
					maxIndexedFragments
				) {
					throw new KnowledgeError("document_too_large");
				}
				return createStagingVersionInTransaction(
					tx,
					{
						...target,
						byteLength: bytes.byteLength,
						expectedFragments: fragments.length,
						instructionDigest: INSTRUCTION_SET_DIGEST,
						extractor: fingerprint,
					},
					deps.clock.now(),
				);
			});
			if (versionId === null) return superseded();

			await stageFragments(fragments, versionId, signal, write);

			// 3. Extract fragment by fragment; write the checked results in bundles.
			const stats = await extractAndStage(
				fragments,
				versionId,
				signal,
				input.deadlineAtMs,
				write,
			);

			// 4. Embed 64 passages at a time; the space must not change within one ingest.
			let firstSpace: { key: string; space: EmbeddingSpace } | null = null;
			for (const batch of batches(fragments, MAX_EMBED_BATCH)) {
				signal.throwIfAborted();
				let answer: unknown;
				try {
					answer = await deps.embedding.embed(
						batch.map((f) => f.text),
						"passage",
						signal,
					);
				} catch (error) {
					if (signal.aborted) throw error;
					throw new PortFailure("embedding");
				}
				signal.throwIfAborted();
				const checked = checkEmbedding(answer, batch.length);
				const key = embeddingSpaceKey(checked.space);
				if (firstSpace === null) firstSpace = { key, space: checked.space };
				else if (firstSpace.key !== key) {
					throw new KnowledgeError("contract_mismatch");
				}
				const items = batch.map((f, i) => ({
					ordinal: f.ordinal,
					vector: checked.vectors[i] as number[],
				}));
				await write((tx) =>
					stageVectorsInTransaction(tx, versionId, checked.space, items),
				);
			}

			return {
				kind: "ingested",
				binding,
				versionId,
				target,
				stats: { fragments: fragments.length, ...stats },
			};
		},

		classify: classifyJobError,

		settleInTransaction(tx, claim, input, outcome): SettleResult {
			if (outcome.type === "retry") return "applied";
			const { sweep } = claim.payload;
			const now = deps.clock.now();
			const open = getChainInTransaction(tx).openSweep === sweep;
			let result: SettleResult = "applied";

			if (outcome.type === "success") {
				result = applySuccess(tx, sweep, open, input, outcome.result, now);
			} else if (open) {
				// The ingest ended without applying: give up its staging. Only a failure the content
				// caused counts against the version; the rest (an interruption, an expiry, a failure
				// of any other code) only delays the next pick.
				const target =
					input?.mode === "ingest" || input?.mode === "reextract"
						? input.target
						: getActiveIngestInTransaction(tx, sweep);
				if (input?.mode === "reextract") {
					// A failed re-extraction waits; the document keeps its version meanwhile.
					discardStagingInTransaction(tx, input.target, now);
					delayReextractInTransaction(
						tx,
						input.versionId,
						now,
						transientRetryDelayMs,
					);
				} else if (target) {
					discardStagingInTransaction(tx, target, now);
					if (
						outcome.type === "failed" &&
						isContentErrorCode(outcome.errorCode)
					) {
						countUnapplied(tx, target, outcome.errorCode);
					} else {
						delayRetry(tx, target, outcome.type);
					}
				}
			}

			const cleaned = cleanupInTransaction(tx, cleanupBatchRows, {
				now,
				orphanStagingAfterMs,
			});
			if (cleaned.deletedRows > 0) {
				safeEmit(deps.events, {
					type: "knowledge.ingest.cleanup",
					level: "debug",
					fields: { deletedRows: cleaned.deletedRows, more: cleaned.more },
				});
			}

			if (hasWork(tx, now)) {
				// null: the chain was stopped or replaced meanwhile, so no second link.
				const next = advanceChainInTransaction(tx, sweep, now);
				if (next !== null) {
					const payload: IngestNextPayload = { sweep: next };
					deps.jobs.enqueueInTransaction(tx, {
						kind: KNOWLEDGE_JOB_KINDS.ingestNext,
						payloadVersion: 1,
						dedupeKey: ingestNextDedupeKey(payload),
						payload,
						lane: "background",
					});
				}
			} else if (closeChainInTransaction(tx, sweep)) {
				safeEmit(deps.events, {
					type: "knowledge.ingest.chain_closed",
					level: "debug",
					fields: { sweep },
				});
			}
			return result;
		},

		cancelInTransaction(tx, job, reason) {
			const payload = ingestNextPayloadSchema.safeParse(job.payload);
			if (!payload.success) return;
			const { sweep } = payload.data;
			// The cancel carries the sweep only; the tuple was recorded by prepare.
			const target = getActiveIngestInTransaction(tx, sweep);
			if (target) {
				const now = deps.clock.now();
				discardStagingInTransaction(tx, target, now);
				// A re-extraction's document is `current`: its published version waits instead.
				const row = getDocumentInTransaction(tx, target);
				if (row?.state === "current" && row.publishedVersionId !== null)
					delayReextractInTransaction(
						tx,
						row.publishedVersionId,
						now,
						transientRetryDelayMs,
					);
				else delayRetry(tx, target, "cancelled");
			}
			if (closeChainInTransaction(tx, sweep)) {
				safeEmit(deps.events, {
					type: "knowledge.ingest.cancelled",
					level: "info",
					fields: { sweep, reasonLength: reason.length },
				});
			}
		},
	};

	/**
	 * Write the fragments in batches, each with the links it holds to other Markdown documents
	 * (kg2.md §7.14; code holds none, read from the body's structure across fragments).
	 */
	async function stageFragments(
		fragments: readonly Fragment[],
		versionId: number,
		signal: AbortSignal,
		write: <T>(operation: (tx: Tx) => T) => Promise<T>,
	): Promise<void> {
		const structures = fragmentStructures(fragments.map((f) => f.text));
		const links = new Map<number, LinkToStage[]>(
			fragments.map((f, i) => [
				f.ordinal,
				markdownLinks(f.text, structures[i]?.code ?? []).map((href) => ({
					fragmentOrdinal: f.ordinal,
					href,
					targetName: linkName(href),
				})),
			]),
		);
		for (const batch of batches(fragments, STAGE_BATCH)) {
			signal.throwIfAborted();
			const items = batch.map((fragment) => ({
				fragment,
				searchText: normalizeForSearch(fragment.text),
			}));
			const batchLinks = batch.flatMap((f) => links.get(f.ordinal) ?? []);
			await write((tx) => {
				stageFragmentsInTransaction(tx, versionId, items);
				stageLinksInTransaction(tx, versionId, batchLinks);
			});
		}
	}

	/** Extract the fragments one by one and write the checked results in bundles. */
	async function extractAndStage(
		fragments: readonly Fragment[],
		versionId: number,
		signal: AbortSignal,
		deadlineAtMs: number | null,
		write: <T>(operation: (tx: Tx) => T) => Promise<T>,
	): Promise<{
		extractionsOk: number;
		extractionsFailed: number;
		dropped: number;
	}> {
		const stats = { extractionsOk: 0, extractionsFailed: 0, dropped: 0 };
		let pending: FragmentExtraction[] = [];
		let pendingRows = 0;
		const flush = async () => {
			const items = pending;
			pending = [];
			pendingRows = 0;
			if (items.length === 0) return;
			await write((tx) => stageExtractionsInTransaction(tx, versionId, items));
		};
		// The model-free names read the body's structure (code, frontmatter) across fragments.
		const structures =
			extractor === "names"
				? fragmentStructures(fragments.map((f) => f.text))
				: [];
		for (const [i, fragment] of fragments.entries()) {
			signal.throwIfAborted();
			const extraction = await extractFragment(
				fragment,
				structures[i],
				signal,
				deadlineAtMs,
			);
			if (extraction.status === "ok") {
				stats.extractionsOk += 1;
				for (const d of extraction.dropped) stats.dropped += d.count;
			} else {
				stats.extractionsFailed += 1;
			}
			// A bundle is bounded by rows (the extraction, its mentions and evidence), not by fragments.
			const rows = extractionRows(extraction);
			if (pending.length > 0 && pendingRows + rows > STAGE_EXTRACTION_ROWS) {
				await flush();
			}
			pending.push(extraction);
			pendingRows += rows;
			if (pendingRows >= STAGE_EXTRACTION_ROWS) await flush();
		}
		await flush();
		return stats;
	}

	/**
	 * Re-extraction (kg2.md G7): copy the published version's fragments and vectors into a new
	 * version (no source read, no embedding), extract them with this handler's extractor, and
	 * return it for settle to publish in place of the old one. The old version is read meanwhile.
	 */
	async function reextractVersion(
		input: Extract<IngestNextInput, { mode: "reextract" }>,
		signal: AbortSignal,
	): Promise<IngestNextOutput> {
		const { sweep, target } = input;
		const gone: IngestNextOutput = {
			kind: "reextract_gone",
			previousVersionId: input.versionId,
		};
		const write = <T>(operation: (tx: Tx) => T): Promise<T> =>
			deps.writer.write((tx) => {
				touchChainInTransaction(tx, sweep, deps.clock.now());
				return operation(tx);
			});
		signal.throwIfAborted();
		const copy = await write((tx) =>
			getChainInTransaction(tx).openSweep === sweep
				? readVersionToCopyInTransaction(tx, input.versionId)
				: null,
		);
		if (!copy || copy.vectors.length !== copy.fragments.length) return gone;
		const versionId = await write((tx) => {
			if (getChainInTransaction(tx).openSweep !== sweep) return null;
			const row = getDocumentInTransaction(tx, target);
			if (
				!row ||
				row.state !== "current" ||
				row.publishedVersionId !== input.versionId ||
				row.generation !== target.generation
			) {
				return null;
			}
			return createStagingVersionInTransaction(
				tx,
				{
					...target,
					byteLength: copy.byteLength,
					expectedFragments: copy.fragments.length,
					instructionDigest: INSTRUCTION_SET_DIGEST,
					extractor: fingerprint,
				},
				deps.clock.now(),
			);
		});
		if (versionId === null) return gone;
		await stageFragments(copy.fragments, versionId, signal, write);
		const stats = await extractAndStage(
			copy.fragments,
			versionId,
			signal,
			input.deadlineAtMs,
			write,
		);
		for (const batch of batches(copy.vectors, MAX_EMBED_BATCH)) {
			signal.throwIfAborted();
			await write((tx) =>
				stageVectorsInTransaction(tx, versionId, copy.space, batch),
			);
		}
		return {
			kind: "reextracted",
			versionId,
			previousVersionId: input.versionId,
			target,
			stats: { fragments: copy.fragments.length, ...stats },
		};
	}

	function applySuccess(
		tx: Tx,
		sweep: number,
		open: boolean,
		input: IngestNextInput | null,
		raw: unknown,
		now: number,
	): SettleResult {
		const parsed = ingestNextOutputSchema.safeParse(raw);
		if (!parsed.success) {
			// An answer we cannot read is not applied; count it against what was prepared.
			if (input?.mode === "reextract") {
				discardStagingInTransaction(tx, input.target, now);
				delayReextractInTransaction(
					tx,
					input.versionId,
					now,
					transientRetryDelayMs,
				);
				return "stale";
			}
			const target =
				input?.mode === "ingest"
					? input.target
					: getActiveIngestInTransaction(tx, sweep);
			if (target) {
				discardStagingInTransaction(tx, target, now);
				countUnapplied(tx, target, "invalid_result");
			}
			return "stale";
		}
		const out = parsed.data;
		if (out.kind === "cleanup_only") return "applied";
		if (out.kind === "reextract_gone") {
			// The copy could not be made (the version moved on, or lacks vectors or a space): wait,
			// or the same version would be chosen again at once.
			delayReextractInTransaction(
				tx,
				out.previousVersionId,
				now,
				transientRetryDelayMs,
			);
			return "stale";
		}
		if (out.kind === "reextracted") {
			// Published in place of the copied version, only while the document still publishes it
			// unchanged; otherwise the copy is given up (the document's own ingest follows).
			if (
				!republishVersionInTransaction(
					tx,
					out.versionId,
					out.previousVersionId,
					out.target,
					now,
				)
			) {
				abandonVersionInTransaction(tx, out.versionId, now);
				delayReextractInTransaction(
					tx,
					out.previousVersionId,
					now,
					transientRetryDelayMs,
				);
				return "stale";
			}
			startLinkChainInTransaction(tx, deps.jobs, now);
			safeEmit(deps.events, {
				type: "knowledge.document.reextracted",
				level: "info",
				fields: {
					documentId: out.target.documentId,
					versionId: out.versionId,
					previousVersionId: out.previousVersionId,
					fragments: out.stats.fragments,
					extractionsOk: out.stats.extractionsOk,
					extractionsFailed: out.stats.extractionsFailed,
				},
			});
			return "applied";
		}
		const target = out.target;

		if (out.kind === "superseded") {
			// The source holds another version or namespace: not an attempt that failed. Skip the
			// document until a scan observes it again.
			if (open && markIngestSupersededInTransaction(tx, target, now)) {
				safeEmit(deps.events, {
					type: "knowledge.ingest.superseded",
					level: "info",
					fields: { documentId: target.documentId },
				});
			}
			return "stale";
		}
		if (deps.source.binding() !== out.binding) {
			if (out.kind === "ingested") {
				abandonVersionInTransaction(tx, out.versionId, now);
			}
			if (open) delayRetry(tx, target, "binding_changed");
			return "stale";
		}
		if (out.kind === "unavailable") {
			if (!markDocumentUnavailableInTransaction(tx, target, now)) {
				if (open) delayRetry(tx, target, "stale_result");
				return "stale";
			}
			discardStagingInTransaction(tx, target, now);
			safeEmit(deps.events, {
				type: "knowledge.document.unavailable",
				level: "warn",
				fields: { documentId: target.documentId, reason: out.reason },
			});
			return "applied";
		}
		if (!publishVersionInTransaction(tx, out.versionId, target, now)) {
			abandonVersionInTransaction(tx, out.versionId, now);
			if (open) delayRetry(tx, target, "stale_result");
			return "stale";
		}
		// A new version has mentions nobody compared yet: open the identity chain (p3.md 8). A live
		// link already open finds the version itself when it settles.
		startLinkChainInTransaction(tx, deps.jobs, now);
		safeEmit(deps.events, {
			type: "knowledge.document.published",
			level: "info",
			fields: {
				documentId: target.documentId,
				versionId: out.versionId,
				fragments: out.stats.fragments,
				extractionsOk: out.stats.extractionsOk,
				extractionsFailed: out.stats.extractionsFailed,
				dropped: out.stats.dropped,
			},
		});
		return "applied";
	}
}

/** Rows one checked extraction writes: itself, its mentions and their evidence. */
function extractionRows(x: FragmentExtraction): number {
	if (x.status !== "ok") return 1;
	let rows = 1;
	for (const e of [...x.entities, ...x.relations])
		rows += 1 + e.evidence.length;
	return rows;
}

function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) {
		yield items.slice(i, i + size);
	}
}

/**
 * The embedder's answer for one bundle: as many vectors as texts, each as long as the space's
 * dimension and finite throughout. Anything else breaks the port's contract.
 */
function checkEmbedding(
	answer: unknown,
	expected: number,
): { vectors: number[][]; space: EmbeddingSpace } {
	const bad = () => new KnowledgeError("contract_mismatch");
	if (typeof answer !== "object" || answer === null) throw bad();
	const { vectors, space } = answer as { vectors?: unknown; space?: unknown };
	if (typeof space !== "object" || space === null) throw bad();
	const s = space as Partial<EmbeddingSpace>;
	if (
		typeof s.modelId !== "string" ||
		s.modelId.length === 0 ||
		typeof s.revision !== "string" ||
		typeof s.artifactDigest !== "string" ||
		typeof s.queryPrefix !== "string" ||
		typeof s.passagePrefix !== "string" ||
		typeof s.dimension !== "number" ||
		!Number.isSafeInteger(s.dimension) ||
		s.dimension <= 0
	) {
		throw bad();
	}
	if (!Array.isArray(vectors) || vectors.length !== expected) throw bad();
	for (const v of vectors as unknown[]) {
		if (!Array.isArray(v) || v.length !== s.dimension) throw bad();
		for (const x of v as unknown[]) {
			if (typeof x !== "number" || !Number.isFinite(x)) throw bad();
		}
	}
	return { vectors: vectors as number[][], space: s as EmbeddingSpace };
}
