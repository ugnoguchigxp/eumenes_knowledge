import { KnowledgeError, type Tx } from "../contracts/index.js";

/**
 * The identity chain (p3.md §8): one open `knowledge.link-next` link at a time, with the same
 * rules as the ingest chain (`chain.ts`): sweep numbers strictly increasing and never reused,
 * because the host keeps every job's dedupe key unique for good. It is a separate row, so a
 * long ingest and a long comparison never take each other for lost.
 */

const invalid = (): never => {
	throw new KnowledgeError("invalid_input");
};

export type LinkChainState = {
	nextSweep: number;
	openSweep: number | null;
	openedAt: number | null;
	advancedAt: number | null;
};

/** What the open link works on, so a cancel (which gets the sweep only) can find it. */
export type LinkActive =
	| { kind: "version"; versionId: number }
	| { kind: "summary"; anchorEntityId: number; digest: string };

export function getLinkChainInTransaction(db: Tx): LinkChainState {
	const r = db
		.query<{
			next_sweep: number;
			open_sweep: number | null;
			opened_at: number | null;
			advanced_at: number | null;
		}>(
			"SELECT next_sweep, open_sweep, opened_at, advanced_at FROM knowledge_link_chain WHERE id = 1",
		)
		.get();
	if (!r) return invalid();
	return {
		nextSweep: r.next_sweep,
		openSweep: r.open_sweep,
		openedAt: r.opened_at,
		advancedAt: r.advanced_at,
	};
}

/** True when a link is open and advanced less than `staleAfterMs` ago. */
export function isLinkChainLiveInTransaction(
	db: Tx,
	now: number,
	staleAfterMs: number,
): boolean {
	const c = getLinkChainInTransaction(db);
	return (
		c.openSweep !== null &&
		c.advancedAt !== null &&
		now - c.advancedAt < staleAfterMs
	);
}

function takeNext(db: Tx, now: number, keepOpenedAt: boolean): number {
	const c = getLinkChainInTransaction(db);
	db.query(
		`UPDATE knowledge_link_chain SET next_sweep = next_sweep + 1, open_sweep = ?1,
 opened_at = CASE WHEN ?3 = 1 THEN opened_at ELSE ?2 END, advanced_at = ?2,
 active_kind = NULL, active_id = NULL, active_digest = NULL
WHERE id = 1`,
	).run(c.nextSweep, now, keepOpenedAt ? 1 : 0);
	return c.nextSweep;
}

/**
 * Start the chain: returns the new sweep number when it is stopped, or open but not advanced for
 * `staleAfterMs` (its job was lost; that number is never handed out again). Null when a live link
 * is open.
 */
export function openLinkChainInTransaction(
	db: Tx,
	now: number,
	staleAfterMs: number,
): number | null {
	if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs)) return invalid();
	if (isLinkChainLiveInTransaction(db, now, staleAfterMs)) return null;
	return takeNext(db, now, false);
}

/** Move from link `sweep` to the next one; null (nothing written) when `sweep` is not the open link. */
export function advanceLinkChainInTransaction(
	db: Tx,
	sweep: number,
	now: number,
): number | null {
	if (!Number.isFinite(now)) return invalid();
	if (getLinkChainInTransaction(db).openSweep !== sweep) return null;
	return takeNext(db, now, true);
}

/** Stop the chain if `sweep` is the open link. */
export function closeLinkChainInTransaction(db: Tx, sweep: number): boolean {
	return (
		db
			.query(
				`UPDATE knowledge_link_chain SET open_sweep = NULL, advanced_at = NULL,
 active_kind = NULL, active_id = NULL, active_digest = NULL
WHERE id = 1 AND open_sweep = ?`,
			)
			.run(sweep).changes === 1
	);
}

/** The link `sweep` is alive (it wrote a step); only the open link moves it. */
export function touchLinkChainInTransaction(
	db: Tx,
	sweep: number,
	now: number,
): boolean {
	if (!Number.isFinite(now)) return invalid();
	return (
		db
			.query(
				"UPDATE knowledge_link_chain SET advanced_at = ? WHERE id = 1 AND open_sweep = ?",
			)
			.run(now, sweep).changes === 1
	);
}

/** Record what the open link `sweep` works on (`null`: nothing). False when `sweep` is not open. */
export function setActiveLinkInTransaction(
	db: Tx,
	sweep: number,
	active: LinkActive | null,
): boolean {
	const kind = active?.kind ?? null;
	const id =
		active === null
			? null
			: active.kind === "version"
				? active.versionId
				: active.anchorEntityId;
	const digest = active?.kind === "summary" ? active.digest : null;
	return (
		db
			.query(
				`UPDATE knowledge_link_chain SET active_kind = ?2, active_id = ?3, active_digest = ?4
WHERE id = 1 AND open_sweep = ?1`,
			)
			.run(sweep, kind, id, digest).changes === 1
	);
}

export function getActiveLinkInTransaction(
	db: Tx,
	sweep: number,
): LinkActive | null {
	const r = db
		.query<{
			active_kind: "version" | "summary" | null;
			active_id: number | null;
			active_digest: string | null;
		}>(
			"SELECT active_kind, active_id, active_digest FROM knowledge_link_chain WHERE id = 1 AND open_sweep = ?",
		)
		.get(sweep);
	if (!r || r.active_kind === null || r.active_id === null) return null;
	if (r.active_kind === "version") {
		return { kind: "version", versionId: r.active_id };
	}
	if (r.active_digest === null) return null;
	return {
		kind: "summary",
		anchorEntityId: r.active_id,
		digest: r.active_digest,
	};
}

/**
 * The set of current mentions or of `same` links may have changed (a link added, a document
 * became or stopped being current, a version published, link rows cleaned up): the summary
 * search must look again.
 */
export function bumpLinkGenerationInTransaction(db: Tx): void {
	db.query(
		"UPDATE knowledge_link_chain SET link_generation = link_generation + 1 WHERE id = 1",
	).run();
}

/** Whether the summary search must run: something changed (or a waiting summary came due) since the last search that found nothing. */
export function isSummarySearchNeededInTransaction(
	db: Tx,
	key: string,
	now: number,
): boolean {
	const r = db
		.query<{
			link_generation: number;
			summary_checked_key: string | null;
			summary_recheck_at: number | null;
		}>(
			"SELECT link_generation, summary_checked_key, summary_recheck_at FROM knowledge_link_chain WHERE id = 1",
		)
		.get();
	if (!r) return invalid();
	if (r.summary_checked_key !== `${r.link_generation}:${key}`) return true;
	return r.summary_recheck_at !== null && now >= r.summary_recheck_at;
}

/** A search for summary work found nothing; `recheckAt` is when a waiting summary comes due. */
export function recordSummarySearchEmptyInTransaction(
	db: Tx,
	key: string,
	recheckAt: number | null,
): void {
	db.query(
		`UPDATE knowledge_link_chain SET summary_checked_key = link_generation || ':' || ?1,
 summary_recheck_at = ?2 WHERE id = 1`,
	).run(key, recheckAt);
}
