import { KnowledgeError, type Tx } from "../../contracts/index.js";
import {
	readLinkCandidatesInTransaction,
	readLinkNeighbourhoodInTransaction,
	type CandidateMatch,
	type LinkCandidate,
} from "../../sqlite/links.js";
import { normalizeForSearch } from "../text/normalize.js";
import { constrainedComponents } from "./components.js";

export type LinkCandidateChoice = {
	/** At most `limit` candidates, the first of each part not asked about yet, in candidate order. */
	candidates: LinkCandidate[];
	/** More parts may be left (the caller takes the mention again after these answers). */
	hasMore: boolean;
};

/**
 * The candidates to ask the model about for one mention: one per part of a node (kg.md §7.2).
 *
 * The candidates (as `readLinkCandidatesInTransaction` orders them), the mention, the mentions it
 * has a decision with, and the mentions one link beyond them are joined into parts by the rule
 * of the graph read (`constrainedComponents`: `same` links under the `different` judgments),
 * using only `same` links between two mentions of one namespace. A part is therefore inside one
 * namespace and connected there, so a node stays connected in every reader's scope (reads never
 * bridge through a mention outside it). A part that holds a mention the mention has a `same` or
 * `different` decision with is not asked about again; `unsure` blocks nothing. Of every other
 * part only its first candidate is offered.
 *
 * The candidates are read `pool` at a time. While the read is full and does not give more than
 * `limit` parts, it is read again four times as large, up to `maxPool`: a large node whose other
 * members fill the read does not hide the parts behind it. Candidates beyond `maxPool` are not
 * looked at.
 */
export function pickLinkCandidatesInTransaction(
	tx: Tx,
	entityId: number,
	options: {
		limit: number;
		pool: number;
		maxPool: number;
		match: CandidateMatch;
	},
): LinkCandidateChoice {
	const { limit, pool, maxPool, match } = options;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		!Number.isSafeInteger(pool) ||
		pool < limit ||
		!Number.isSafeInteger(maxPool) ||
		maxPool < pool
	) {
		throw new KnowledgeError("invalid_input");
	}
	for (let size = pool; ; size = Math.min(size * 4, maxPool)) {
		const found = readLinkCandidatesInTransaction(tx, entityId, size, match);
		const parts = firstOfEachPart(tx, entityId, found);
		const full = found.length === size;
		if (!full || parts.length > limit || size >= maxPool) {
			return {
				candidates: parts.slice(0, limit),
				hasMore: parts.length > limit || (full && parts.length > 0),
			};
		}
	}
}

function firstOfEachPart(
	tx: Tx,
	entityId: number,
	found: readonly LinkCandidate[],
): LinkCandidate[] {
	if (found.length === 0) return [];
	const near = readLinkNeighbourhoodInTransaction(
		tx,
		entityId,
		found.map((c) => c.entityId),
	);
	const ids = [...near.mentions.keys()];
	const index = new Map(ids.map((id, i) => [id, i]));
	const info = ids.map(
		(id) =>
			near.mentions.get(id) as {
				name: string;
				nameNorm: string;
				namespace: string;
			},
	);
	const same: [number, number][] = [];
	const different: [number, number][] = [];
	for (const link of near.links) {
		const a = index.get(link.a);
		const b = index.get(link.b);
		if (a === undefined || b === undefined) continue;
		if (link.decision === "different") different.push([a, b]);
		else if (info[a]?.namespace === info[b]?.namespace) same.push([a, b]);
	}
	const { of } = constrainedComponents(
		info.map((m) =>
			m.nameNorm !== "" ? m.nameNorm : normalizeForSearch(m.name),
		),
		same,
		different,
	);
	const part = (id: number): string => {
		const i = index.get(id);
		return i === undefined ? `gone:${id}` : String(of[i]);
	};
	const blocked = new Set(
		near.decided
			.filter((d) => d.decision !== "unsure")
			.map((d) => part(d.other)),
	);
	const seen = new Set<string>();
	const picked: LinkCandidate[] = [];
	for (const candidate of found) {
		const key = part(candidate.entityId);
		if (blocked.has(key) || seen.has(key)) continue;
		seen.add(key);
		picked.push(candidate);
	}
	return picked;
}
