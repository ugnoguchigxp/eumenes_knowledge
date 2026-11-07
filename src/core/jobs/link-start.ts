import {
	KNOWLEDGE_JOB_KINDS,
	linkNextDedupeKey,
	type JobSink,
	type LinkNextPayload,
	type Tx,
} from "../../contracts/index.js";
import {
	MAX_SUMMARY_MEMBERS,
	hasVersionToCompareInTransaction,
	isLinkChainLiveInTransaction,
	openLinkChainInTransaction,
	pickSummaryWorkInTransaction,
} from "../../sqlite/index.js";
import { CHAIN_STALE_AFTER_MS } from "../support.js";

/** Default of `LinkOptions.summaryMinMentions` (p3.md §8). */
export const DEFAULT_SUMMARY_MIN_MENTIONS = 3;
/** A cluster with more mentions than this is not summarized (the prompt would grow without bound). */
export const MAX_SUMMARY_MENTIONS = MAX_SUMMARY_MEMBERS;

/**
 * Open the identity chain with one `knowledge.link-next` job, unless a live link is open or was
 * lost less than an hour ago (then that link finds the work itself when it settles). The caller
 * decides that there is work. Returns the new sweep, or null when none was started.
 */
export function startLinkChainInTransaction(
	tx: Tx,
	jobs: JobSink,
	now: number,
): number | null {
	const sweep = openLinkChainInTransaction(tx, now, CHAIN_STALE_AFTER_MS);
	if (sweep === null) return null;
	const payload: LinkNextPayload = { sweep };
	jobs.enqueueInTransaction(tx, {
		kind: KNOWLEDGE_JOB_KINDS.linkNext,
		payloadVersion: 1,
		dedupeKey: linkNextDedupeKey(payload),
		payload,
		lane: "background",
	});
	return sweep;
}

/**
 * Start the chain when a published version was not compared yet (or, with `checkSummaries`, a
 * cluster needs a summary) and no live link is open. The cheap checks come first.
 */
export function startLinkChainIfWorkInTransaction(
	tx: Tx,
	jobs: JobSink,
	now: number,
	options: { checkSummaries: boolean; summaryMinMentions: number },
): number | null {
	if (isLinkChainLiveInTransaction(tx, now, CHAIN_STALE_AFTER_MS)) return null;
	const work =
		hasVersionToCompareInTransaction(tx, now) ||
		(options.checkSummaries &&
			pickSummaryWorkInTransaction(tx, {
				minMentions: options.summaryMinMentions,
				maxMentions: MAX_SUMMARY_MENTIONS,
				now,
			}) !== null);
	return work ? startLinkChainInTransaction(tx, jobs, now) : null;
}
