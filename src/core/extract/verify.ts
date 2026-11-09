import {
	extractionDropReasons,
	extractionOutputSchema,
	type EvidenceRange,
	type ExtractionDropReason,
	type ExtractionEntity,
	type ExtractionRelation,
	type Fragment,
	type FragmentExtraction,
	type VerifiedEntity,
	type VerifiedRelation,
} from "../../contracts/index-data.js";
import type { InferenceResult } from "../../contracts/ports.js";
import { sha256Hex } from "../bytes.js";

type OkExtraction = Extract<FragmentExtraction, { status: "ok" }>;

/** Error codes of a failed fragment (codes only; never the answer, a quote or a provider message). */
export const extractionErrorCodes = [
	"inference_failed",
	"invalid_json",
	"schema_violation",
	/** The model-free extractor's tokenizer answered tokens that do not describe the text. */
	"invalid_tokens",
] as const;

function failed(
	fragment: Pick<Fragment, "ordinal">,
	errorCode: (typeof extractionErrorCodes)[number],
	model: string | null,
): FragmentExtraction {
	return {
		fragmentOrdinal: fragment.ordinal,
		status: "failed",
		errorCode,
		model,
	};
}

/**
 * Checks the model's answer for one fragment (p2.md 4). Only mechanical checks are made: the
 * JSON syntax (surrounding whitespace is allowed, nothing is repaired), the schema, the ids, and
 * whether each quotation occurs in the fragment's text. Quotations are located by exact match;
 * their positions are UTF-8 byte ranges in the document body.
 */
export function verifyExtraction(
	fragment: Pick<Fragment, "ordinal" | "byteStart" | "text">,
	result: InferenceResult,
): FragmentExtraction {
	if (!result.ok) return failed(fragment, "inference_failed", result.model);
	let json: unknown;
	try {
		json = JSON.parse(result.text);
	} catch {
		return failed(fragment, "invalid_json", result.model);
	}
	const parsed = extractionOutputSchema.safeParse(json);
	if (!parsed.success) {
		return failed(fragment, "schema_violation", result.model);
	}

	const dropped = new Map<ExtractionDropReason, number>();
	const drop = (reason: ExtractionDropReason, count = 1) => {
		dropped.set(reason, (dropped.get(reason) ?? 0) + count);
	};
	const locate = (quotes: readonly string[]): EvidenceRange[] | null => {
		const ranges: EvidenceRange[] = [];
		const seen = new Set<string>();
		for (const quote of quotes) {
			const range = locateQuote(fragment, quote);
			if (range === null) {
				drop("not_in_fragment");
				continue;
			}
			const key = `${range.byteStart}:${range.byteEnd}`;
			if (seen.has(key)) continue;
			seen.add(key);
			ranges.push(range);
		}
		return ranges.length === 0 ? null : ranges;
	};

	// Ids seen so far, dropped ones included: a later element with the same id is the duplicate.
	const entityIds = new Set<string>();
	const keptEntityIds = new Set<string>();
	const entities: VerifiedEntity[] = [];
	for (const entity of parsed.data.entities) {
		if (entityIds.has(entity.id)) {
			drop("duplicate_id");
			continue;
		}
		entityIds.add(entity.id);
		const evidence = locate(entity.evidence);
		if (evidence === null) {
			drop("no_evidence");
			continue;
		}
		keptEntityIds.add(entity.id);
		entities.push({ ...withoutEvidence(entity), evidence });
	}

	const relationIds = new Set<string>();
	const relations: VerifiedRelation[] = [];
	for (const relation of parsed.data.relations) {
		if (relationIds.has(relation.id)) {
			drop("duplicate_id");
			continue;
		}
		relationIds.add(relation.id);
		if (
			!keptEntityIds.has(relation.source) ||
			!keptEntityIds.has(relation.target)
		) {
			drop("unknown_entity");
			continue;
		}
		const evidence = locate(relation.evidence);
		if (evidence === null) {
			drop("no_evidence");
			continue;
		}
		relations.push({ ...withoutEvidence(relation), evidence });
	}

	return {
		fragmentOrdinal: fragment.ordinal,
		status: "ok",
		entities,
		relations,
		dropped: droppedList(dropped),
		model: result.model,
	};
}

function withoutEvidence<T extends ExtractionEntity | ExtractionRelation>(
	element: T,
): Omit<T, "evidence"> {
	const { evidence: _evidence, ...rest } = element;
	return rest;
}

function droppedList(counts: ReadonlyMap<ExtractionDropReason, number>) {
	return extractionDropReasons.flatMap((reason) => {
		const count = counts.get(reason) ?? 0;
		return count > 0 ? [{ reason, count }] : [];
	});
}

/**
 * Finds `quote` in the fragment text by exact match and returns where it is in the document
 * body. The first occurrence is used; `ambiguous` says there is another one. A quotation with a
 * lone surrogate is refused: it could otherwise match half of a character.
 */
function locateQuote(
	fragment: Pick<Fragment, "ordinal" | "byteStart" | "text">,
	quote: string,
): EvidenceRange | null {
	const quoteBytes = Buffer.from(quote, "utf8");
	if (quoteBytes.toString("utf8") !== quote) return null;
	const index = fragment.text.indexOf(quote);
	if (index < 0) return null;
	const offset = Buffer.byteLength(fragment.text.slice(0, index), "utf8");
	return {
		fragmentOrdinal: fragment.ordinal,
		byteStart: fragment.byteStart + offset,
		byteEnd: fragment.byteStart + offset + quoteBytes.length,
		quoteSha256: sha256Hex(quoteBytes),
		ambiguous: fragment.text.indexOf(quote, index + 1) >= 0,
	};
}

// ---------------------------------------------------------------------------
// Gleaning
// ---------------------------------------------------------------------------

/**
 * Combines the checked results of two passes over the same fragment (the second one being a
 * gleaning pass). Ids are renumbered so the two answers' local ids cannot collide, and a relation
 * keeps pointing at the entity of its own pass. Records are not merged by name: whether two
 * records are the same thing is not decided here. A failed second pass adds nothing; a failed
 * first pass is returned as it is (there was no first result to refine).
 */
export function mergeGleaning(
	first: FragmentExtraction,
	second: FragmentExtraction,
): FragmentExtraction {
	if (first.status === "failed" || second.status === "failed") return first;
	if (first.fragmentOrdinal !== second.fragmentOrdinal) {
		throw new RangeError("gleaning results belong to different fragments");
	}

	const entities: VerifiedEntity[] = [];
	const relations: VerifiedRelation[] = [];
	for (const pass of [first, second]) {
		const idMap = new Map<string, string>();
		for (const entity of pass.entities) {
			const id = `e${entities.length + 1}`;
			idMap.set(entity.id, id);
			entities.push({ ...entity, id });
		}
		for (const relation of pass.relations) {
			const source = idMap.get(relation.source);
			const target = idMap.get(relation.target);
			// verifyExtraction keeps only relations between kept entities of the same pass.
			if (source === undefined || target === undefined) continue;
			relations.push({
				...relation,
				id: `r${relations.length + 1}`,
				source,
				target,
			});
		}
	}

	const counts = new Map<ExtractionDropReason, number>();
	for (const { reason, count } of [...first.dropped, ...second.dropped]) {
		counts.set(reason, (counts.get(reason) ?? 0) + count);
	}
	const merged: OkExtraction = {
		fragmentOrdinal: first.fragmentOrdinal,
		status: "ok",
		entities,
		relations,
		dropped: droppedList(counts),
		model: first.model ?? second.model,
	};
	return merged;
}
