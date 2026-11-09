import { z } from "zod";
import {
	KNOWLEDGE_JOB_KINDS,
	KnowledgeError,
	LINK_LIMITS,
	linkNextDedupeKey,
	linkNextPayloadSchema,
	type CreateLinkNextHandler,
	type InferenceRequest,
	type InferenceResult,
	type IngestDeps,
	type KnowledgeJobHandler,
	type LinkNextPayload,
	type LinkOptions,
	type SettleResult,
	type Tx,
} from "../../contracts/index.js";
import { instruction } from "../../contexts/index.js";
import {
	advanceLinkChainInTransaction,
	closeLinkChainInTransaction,
	getActiveLinkInTransaction,
	getLinkChainInTransaction,
	pickSummaryWorkInTransaction,
	setActiveLinkInTransaction,
	touchLinkChainInTransaction,
} from "../../sqlite/index.js";
import {
	advanceLinkVersionInTransaction,
	clusterDigest,
	getCurrentMentionInTransaction,
	getLinkVersionInTransaction,
	hasMentionsAfterInTransaction,
	isVersionComparableInTransaction,
	listMentionsAfterInTransaction,
	markLinkVersionDoneInTransaction,
	pickVersionToCompareInTransaction,
	readMentionQuotesInTransaction,
	readSameClusterInTransaction,
	recordLinkDecisionsInTransaction,
	recordLinkVersionWaitInTransaction,
	recordSummaryFailureInTransaction,
	recordSummaryWaitInTransaction,
	storeSummaryInTransaction,
	type LinkDecision,
} from "../../sqlite/links.js";
import {
	buildLinkRequest,
	buildSummaryRequest,
	candidateId,
	LINK_INSTRUCTION_ID,
	SUMMARIZE_INSTRUCTION_ID,
} from "../link/request.js";
import { pickLinkCandidatesInTransaction } from "../link/candidates.js";
import { verifyLinkAnswer, verifySummaryAnswer } from "../link/verify.js";
import {
	DEFAULT_TRANSIENT_RETRY_DELAY_MS,
	PortFailure,
	classifyJobError,
	safeEmit,
} from "../support.js";
import {
	DEFAULT_SUMMARY_MIN_MENTIONS,
	MAX_SUMMARY_MENTIONS,
} from "./link-start.js";

const DEFAULT_MAX_CANDIDATES_PER_MENTION = 10;
/** Candidates of one mention read at once before one per part of a node is offered (kg.md §7.2). */
const CANDIDATE_POOL = 200;
/** The most candidates of one mention ever read (the read grows fourfold up to it). */
const MAX_CANDIDATE_POOL = 3_200;
const DEFAULT_MAX_MENTIONS_PER_VERSION = 200;
const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;
/** Characters of one quotation shown to the model (the extraction's own limit). */
const QUOTE_CHARS = 400;

// ---------------------------------------------------------------------------
// What prepare fixes and what execute returns
// ---------------------------------------------------------------------------

export type LinkNextInput =
	| {
			mode: "compare";
			sweep: number;
			versionId: number;
			/** The mentions up to this entity id were handled by earlier links. */
			cursorEntityId: number;
			/** The version's recorded steps when the link began (a rise is progress). */
			steps: number;
			deadlineAtMs: number | null;
	  }
	| {
			mode: "summarize";
			sweep: number;
			anchorEntityId: number;
			digest: string;
			deadlineAtMs: number | null;
	  };

const count = z.number().int().min(0);

export const linkNextOutputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("compared"),
		versionId: z.number().int().min(1),
		/** Mentions handled by this link (their decisions are already stored). */
		processed: count,
		/** Of those, the mentions that got no usable answer. */
		failed: count,
		/** No mention of the version is left above the last one handled. */
		finished: z.boolean(),
	}),
	z.strictObject({
		kind: z.literal("summarized"),
		anchorEntityId: z.number().int().min(1),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		answer: z.discriminatedUnion("status", [
			z.strictObject({
				status: z.literal("ok"),
				summary: z.string().min(1).max(LINK_LIMITS.summaryChars),
				model: z.string().nullable(),
			}),
			z.strictObject({ status: z.literal("invalid"), errorCode: z.string() }),
		]),
	}),
	/** The version or cluster the link was prepared for is gone or changed: nothing was done. */
	z.strictObject({ kind: z.literal("stale_target") }),
]);
export type LinkNextOutput = z.infer<typeof linkNextOutputSchema>;

export type LinkNextHandler = KnowledgeJobHandler<
	LinkNextPayload,
	LinkNextInput,
	LinkNextOutput
>;

/**
 * The job that compares newly published mentions for identity and then summarizes entities
 * (p3.md §8). Same rules as the ingest chain: one open link at a time, sweep numbers used once,
 * prepare fixes one target, execute works outside any transaction and writes through the host's
 * writer in short transactions, settle re-checks and hands the next link to the host's queue.
 *
 * A link has one target: a published version to compare (at most `maxMentionsPerVersion`
 * mentions per link; the rest follow in the next links), or, when every version was compared, a
 * cluster of `same` mentions that spans two or more documents and has `summaryMinMentions` or
 * more mentions and no summary for its current member set.
 */
export const createLinkNextHandler: CreateLinkNextHandler = (
	deps: IngestDeps,
	options: LinkOptions = {},
) => buildHandler(deps, options);

function buildHandler(deps: IngestDeps, options: LinkOptions): LinkNextHandler {
	const maxCandidates =
		options.maxCandidatesPerMention ?? DEFAULT_MAX_CANDIDATES_PER_MENTION;
	const maxMentions =
		options.maxMentionsPerVersion ?? DEFAULT_MAX_MENTIONS_PER_VERSION;
	const candidateMatch = options.candidateMatch ?? "name";
	if (candidateMatch !== "name" && candidateMatch !== "text")
		throw new KnowledgeError("invalid_input");
	const candidatePool = Math.max(CANDIDATE_POOL, maxCandidates);
	const maxCandidatePool = Math.max(MAX_CANDIDATE_POOL, candidatePool);
	const summaryMinMentions =
		options.summaryMinMentions ?? DEFAULT_SUMMARY_MIN_MENTIONS;
	const inferenceTimeoutMs =
		options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
	const transientRetryDelayMs =
		options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
	const linkInstruction = instruction(LINK_INSTRUCTION_ID);
	const summarizeInstruction = instruction(SUMMARIZE_INSTRUCTION_ID);
	const linkRef = { id: linkInstruction.id, version: linkInstruction.version };
	const summarizeRef = {
		id: summarizeInstruction.id,
		version: summarizeInstruction.version,
	};

	const pickSummary = (tx: Tx, now: number) =>
		pickSummaryWorkInTransaction(tx, {
			minMentions: summaryMinMentions,
			maxMentions: MAX_SUMMARY_MENTIONS,
			now,
		});
	const hasWork = (tx: Tx, now: number) =>
		pickVersionToCompareInTransaction(tx, now) !== null ||
		pickSummary(tx, now) !== null;

	/** The port threw or answered a failure (an abort excepted, which ends the job). */
	async function complete(
		request: InferenceRequest,
		signal: AbortSignal,
	): Promise<InferenceResult> {
		let result: InferenceResult;
		try {
			result = await deps.inference.complete(request, signal);
		} catch (error) {
			if (signal.aborted) throw error;
			throw new PortFailure("inference");
		}
		if (!result.ok) throw new PortFailure("inference");
		return result;
	}
	const deadlineAt = (jobDeadlineAtMs: number | null) =>
		Math.min(
			jobDeadlineAtMs ?? Number.POSITIVE_INFINITY,
			deps.clock.now() + inferenceTimeoutMs,
		);

	/**
	 * A temporary failure of the link's target: wait before it is picked again. A comparison that
	 * recorded a step since `stepsAtStart` made progress, so it is not made to wait.
	 */
	const delayTarget = (
		tx: Tx,
		sweep: number,
		reason: string,
		stepsAtStart: number | null = null,
	) => {
		const target = getActiveLinkInTransaction(tx, sweep);
		if (!target) return;
		if (
			stepsAtStart !== null &&
			target.kind === "version" &&
			(getLinkVersionInTransaction(tx, target.versionId)?.steps ?? 0) >
				stepsAtStart
		) {
			return;
		}
		const now = deps.clock.now();
		const written =
			target.kind === "version"
				? recordLinkVersionWaitInTransaction(
						tx,
						target.versionId,
						linkRef,
						now,
						transientRetryDelayMs,
					)
				: recordSummaryWaitInTransaction(
						tx,
						{ anchorEntityId: target.anchorEntityId, digest: target.digest },
						summarizeRef,
						now,
						transientRetryDelayMs,
					);
		if (written) {
			safeEmit(deps.events, {
				type: "knowledge.link.delayed",
				level: "info",
				fields: { kind: target.kind, reason },
			});
		}
	};

	return {
		kind: KNOWLEDGE_JOB_KINDS.linkNext,
		payloadVersions: [1],
		schema: linkNextPayloadSchema,
		recovery: "replay_safe",

		prepareInTransaction(tx, claim) {
			const { sweep } = claim.payload;
			const now = deps.clock.now();
			if (getLinkChainInTransaction(tx).openSweep !== sweep) {
				return { status: "stale", reason: "superseded" };
			}
			const versionId = pickVersionToCompareInTransaction(tx, now);
			if (versionId !== null) {
				setActiveLinkInTransaction(tx, sweep, { kind: "version", versionId });
				return {
					status: "ready",
					input: {
						mode: "compare",
						sweep,
						versionId,
						cursorEntityId:
							getLinkVersionInTransaction(tx, versionId)?.cursorEntityId ?? 0,
						steps: getLinkVersionInTransaction(tx, versionId)?.steps ?? 0,
						deadlineAtMs: claim.deadlineAtMs,
					},
				};
			}
			const work = pickSummary(tx, now);
			if (work) {
				setActiveLinkInTransaction(tx, sweep, {
					kind: "summary",
					anchorEntityId: work.anchorEntityId,
					digest: work.digest,
				});
				return {
					status: "ready",
					input: {
						mode: "summarize",
						sweep,
						anchorEntityId: work.anchorEntityId,
						digest: work.digest,
						deadlineAtMs: claim.deadlineAtMs,
					},
				};
			}
			setActiveLinkInTransaction(tx, sweep, null);
			closeLinkChainInTransaction(tx, sweep);
			return { status: "stale", reason: "nothing_to_do" };
		},

		async execute(input, context): Promise<LinkNextOutput> {
			const { signal } = context;
			const { sweep } = input;
			// Every write is one short transaction on the host's writer. Each also tells the chain
			// that this link is alive, and none runs unless this is still the open link.
			const write = <T>(operation: (tx: Tx) => T): Promise<T | null> =>
				deps.writer.write((tx) => {
					if (getLinkChainInTransaction(tx).openSweep !== sweep) return null;
					touchLinkChainInTransaction(tx, sweep, deps.clock.now());
					return operation(tx);
				});
			return input.mode === "compare"
				? compareVersion(input, signal, write)
				: summarizeCluster(input, signal, write);
		},

		classify: classifyJobError,

		settleInTransaction(tx, claim, input, outcome): SettleResult {
			if (outcome.type === "retry") return "applied";
			const { sweep } = claim.payload;
			const now = deps.clock.now();
			const open = getLinkChainInTransaction(tx).openSweep === sweep;
			let result: SettleResult = "applied";
			if (outcome.type === "success") {
				result = open ? applySuccess(tx, input, outcome.result, now) : "stale";
			} else if (open) {
				// Nothing about the content failed the link (a bad answer only fails its mention):
				// an interruption, an expiry or any other failure only delays the next pick.
				// A cut-off link that recorded progress does not wait (the next link goes on).
				const cutOff =
					outcome.type === "expired" || outcome.type === "interrupted";
				delayTarget(
					tx,
					sweep,
					outcome.type,
					cutOff && input?.mode === "compare" ? input.steps : null,
				);
			}
			if (hasWork(tx, now)) {
				const next = advanceLinkChainInTransaction(tx, sweep, now);
				if (next !== null) {
					const payload: LinkNextPayload = { sweep: next };
					deps.jobs.enqueueInTransaction(tx, {
						kind: KNOWLEDGE_JOB_KINDS.linkNext,
						payloadVersion: 1,
						dedupeKey: linkNextDedupeKey(payload),
						payload,
						lane: "background",
					});
				}
			} else if (closeLinkChainInTransaction(tx, sweep)) {
				safeEmit(deps.events, {
					type: "knowledge.link.chain_closed",
					level: "debug",
					fields: { sweep },
				});
			}
			return result;
		},

		cancelInTransaction(tx, job, reason) {
			const payload = linkNextPayloadSchema.safeParse(job.payload);
			if (!payload.success) return;
			const { sweep } = payload.data;
			delayTarget(tx, sweep, "cancelled");
			if (closeLinkChainInTransaction(tx, sweep)) {
				safeEmit(deps.events, {
					type: "knowledge.link.cancelled",
					level: "info",
					fields: { sweep, reasonLength: reason.length },
				});
			}
		},
	};

	// -----------------------------------------------------------------------

	async function compareVersion(
		input: Extract<LinkNextInput, { mode: "compare" }>,
		signal: AbortSignal,
		write: <T>(operation: (tx: Tx) => T) => Promise<T | null>,
	): Promise<LinkNextOutput> {
		const { versionId } = input;
		const stale: LinkNextOutput = { kind: "stale_target" };
		signal.throwIfAborted();
		const batch = await write((tx) =>
			isVersionComparableInTransaction(tx, versionId)
				? listMentionsAfterInTransaction(
						tx,
						versionId,
						input.cursorEntityId,
						maxMentions,
					)
				: null,
		);
		if (batch === null) return stale;
		let processed = 0;
		let failed = 0;
		let cursor = input.cursorEntityId;
		let resumeSameMention = false;
		for (const mention of batch) {
			signal.throwIfAborted();
			// 1. Read the candidates (and their quotations) in one short transaction.
			const prepared = await write((tx) => {
				if (!isVersionComparableInTransaction(tx, versionId)) return null;
				const self = getCurrentMentionInTransaction(tx, mention.entityId);
				if (!self) return null;
				// One candidate per part of a node; `hasMore` tells whether parts are left over.
				const found = pickLinkCandidatesInTransaction(tx, mention.entityId, {
					limit: maxCandidates,
					pool: candidatePool,
					maxPool: maxCandidatePool,
					match: candidateMatch,
				});
				const candidates = found.candidates.map((candidate) => ({
					entityId: candidate.entityId,
					view: {
						name: candidate.name,
						type: candidate.type,
						description: candidate.description,
						evidence: readMentionQuotesInTransaction(
							tx,
							candidate.entityId,
							QUOTE_CHARS,
						),
					},
				}));
				return {
					view: {
						name: mention.name,
						type: mention.type,
						description: mention.description,
						evidence: readMentionQuotesInTransaction(
							tx,
							mention.entityId,
							QUOTE_CHARS,
						),
					},
					candidates,
					hasMore: found.hasMore,
				};
			});
			if (prepared === null) return stale;

			// 2. Ask the model, up to `candidatesPerCall` candidates per call.
			const decided: {
				entityId: number;
				otherId: number;
				decision: LinkDecision;
			}[] = [];
			let model: string | null = null;
			let mentionFailed = false;
			for (
				let from = 0;
				from < prepared.candidates.length;
				from += LINK_LIMITS.candidatesPerCall
			) {
				signal.throwIfAborted();
				const chunk = prepared.candidates.slice(
					from,
					from + LINK_LIMITS.candidatesPerCall,
				);
				const ids = chunk.map((_, i) => candidateId(i));
				const result = await complete(
					buildLinkRequest(
						prepared.view,
						chunk.map((c) => c.view),
						{
							instruction: linkInstruction,
							deadlineAtMs: deadlineAt(input.deadlineAtMs),
						},
					),
					signal,
				);
				const verdict = verifyLinkAnswer(ids, result);
				if (verdict.status === "failed") {
					mentionFailed = true;
					safeEmit(deps.events, {
						type: "knowledge.link.answer_invalid",
						level: "warn",
						fields: { versionId, errorCode: verdict.errorCode },
					});
					break;
				}
				model = verdict.model ?? model;
				verdict.decisions.forEach((d, i) => {
					decided.push({
						entityId: mention.entityId,
						otherId: (chunk[i] as { entityId: number }).entityId,
						decision: d.decision,
					});
				});
			}

			// 3. Store the decisions and the progress together.
			resumeSameMention = prepared.hasMore && !mentionFailed;
			signal.throwIfAborted();
			const stored = await write((tx) => {
				if (!isVersionComparableInTransaction(tx, versionId)) return false;
				const now = deps.clock.now();
				recordLinkDecisionsInTransaction(
					tx,
					decided,
					{
						model,
						instructionId: linkInstruction.id,
						instructionVersion: linkInstruction.version,
					},
					now,
				);
				// Candidates beyond the limit are left for the next link, which takes this mention
				// again (decided pairs are skipped, so it goes on with the next ones). A failed
				// answer is counted and passed, or it would be asked for ever.
				advanceLinkVersionInTransaction(
					tx,
					versionId,
					{
						cursorEntityId: resumeSameMention ? cursor : mention.entityId,
						failed: mentionFailed ? 1 : 0,
					},
					linkRef,
					now,
				);
				return true;
			});
			if (!stored) return stale;
			if (resumeSameMention) break;
			cursor = mention.entityId;
			processed += 1;
			if (mentionFailed) failed += 1;
		}
		const finished = await write(
			(tx) => !hasMentionsAfterInTransaction(tx, versionId, cursor),
		);
		if (finished === null) return stale;
		return { kind: "compared", versionId, processed, failed, finished };
	}

	async function summarizeCluster(
		input: Extract<LinkNextInput, { mode: "summarize" }>,
		signal: AbortSignal,
		write: <T>(operation: (tx: Tx) => T) => Promise<T | null>,
	): Promise<LinkNextOutput> {
		signal.throwIfAborted();
		const members = await write((tx) => {
			const cluster = readSameClusterInTransaction(tx, input.anchorEntityId);
			const ids = cluster.members.map((m) => m.entityId);
			if (
				cluster.truncated ||
				ids[0] !== input.anchorEntityId ||
				clusterDigest(ids) !== input.digest
			) {
				return null;
			}
			return cluster.members.map((m) => ({
				name: m.name,
				description: m.description,
			}));
		});
		if (members === null) return { kind: "stale_target" };
		const result = await complete(
			buildSummaryRequest(members, {
				instruction: summarizeInstruction,
				deadlineAtMs: deadlineAt(input.deadlineAtMs),
			}),
			signal,
		);
		const verdict = verifySummaryAnswer(result);
		return {
			kind: "summarized",
			anchorEntityId: input.anchorEntityId,
			digest: input.digest,
			answer:
				verdict.status === "ok"
					? { status: "ok", summary: verdict.summary, model: verdict.model }
					: { status: "invalid", errorCode: verdict.errorCode },
		};
	}

	function applySuccess(
		tx: Tx,
		input: LinkNextInput | null,
		raw: unknown,
		now: number,
	): SettleResult {
		const parsed = linkNextOutputSchema.safeParse(raw);
		if (!parsed.success) return "stale";
		const out = parsed.data;
		if (out.kind === "stale_target") return "stale";
		if (out.kind === "compared") {
			// The version must still be the published version of a current document.
			if (!isVersionComparableInTransaction(tx, out.versionId)) return "stale";
			if (out.finished) {
				markLinkVersionDoneInTransaction(tx, out.versionId, linkRef, now);
				safeEmit(deps.events, {
					type: "knowledge.link.version_compared",
					level: "info",
					fields: {
						versionId: out.versionId,
						processed: out.processed,
						failed: out.failed,
					},
				});
			}
			return "applied";
		}
		if (input?.mode === "summarize") {
			if (
				input.anchorEntityId !== out.anchorEntityId ||
				input.digest !== out.digest
			) {
				return "stale";
			}
		}
		const target = { anchorEntityId: out.anchorEntityId, digest: out.digest };
		if (out.answer.status === "ok") {
			const stored = storeSummaryInTransaction(
				tx,
				{
					...target,
					summary: out.answer.summary,
					provenance: {
						model: out.answer.model,
						instructionId: summarizeInstruction.id,
						instructionVersion: summarizeInstruction.version,
					},
				},
				now,
			);
			if (!stored) return "stale";
			safeEmit(deps.events, {
				type: "knowledge.link.summarized",
				level: "info",
				fields: { anchorEntityId: out.anchorEntityId },
			});
			return "applied";
		}
		if (!recordSummaryFailureInTransaction(tx, target, summarizeRef, now)) {
			return "stale";
		}
		safeEmit(deps.events, {
			type: "knowledge.link.summary_invalid",
			level: "warn",
			fields: {
				anchorEntityId: out.anchorEntityId,
				errorCode: out.answer.errorCode,
			},
		});
		return "applied";
	}
}
