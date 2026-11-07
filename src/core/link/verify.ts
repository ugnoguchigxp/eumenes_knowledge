import {
	linkAnswerSchema,
	summaryAnswerSchema,
	type LinkAnswer,
} from "../../contracts/index-data.js";
import type { InferenceResult } from "../../contracts/ports.js";

/** Error codes of an answer that cannot be used (codes only; never the answer or a provider message). */
export const linkErrorCodes = [
	"inference_failed",
	"invalid_json",
	"schema_violation",
	/** A decision names a candidate id the request did not contain. */
	"unknown_candidate",
	/** Two decisions name the same candidate. */
	"duplicate_candidate",
	/** The answer left a candidate out: a partial answer is refused as a whole. */
	"incomplete_answer",
] as const;
export type LinkErrorCode = (typeof linkErrorCodes)[number];

export type LinkVerdict =
	| {
			status: "ok";
			/** One decision per candidate, in the order of `candidateIds`. */
			decisions: {
				candidate: string;
				decision: LinkAnswer["decisions"][number]["decision"];
			}[];
			model: string | null;
	  }
	| { status: "failed"; errorCode: LinkErrorCode; model: string | null };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/**
 * Checks the model's answer for one mention and its candidates (p3.md §8). Only mechanical
 * checks are made: the JSON syntax (surrounding whitespace is allowed; nothing is repaired), the
 * strict schema, that every named candidate exists, that none is named twice and that every
 * candidate of the request is answered. An answer that breaks any of them is refused as a whole.
 */
export function verifyLinkAnswer(
	candidateIds: readonly string[],
	result: InferenceResult,
): LinkVerdict {
	if (!result.ok) {
		return {
			status: "failed",
			errorCode: "inference_failed",
			model: result.model,
		};
	}
	const fail = (errorCode: LinkErrorCode): LinkVerdict => ({
		status: "failed",
		errorCode,
		model: result.model,
	});
	const json = parseJson(result.text);
	if (!json.ok) return fail("invalid_json");
	const parsed = linkAnswerSchema.safeParse(json.value);
	if (!parsed.success) return fail("schema_violation");
	const known = new Set(candidateIds);
	const seen = new Map<string, LinkAnswer["decisions"][number]["decision"]>();
	for (const { candidate, decision } of parsed.data.decisions) {
		if (!known.has(candidate)) return fail("unknown_candidate");
		if (seen.has(candidate)) return fail("duplicate_candidate");
		seen.set(candidate, decision);
	}
	// A candidate the model did not answer is not recorded as `unsure`: that would claim a
	// judgment nobody made. The whole answer is refused instead.
	if (candidateIds.some((candidate) => !seen.has(candidate))) {
		return fail("incomplete_answer");
	}
	return {
		status: "ok",
		decisions: candidateIds.map((candidate) => ({
			candidate,
			decision: seen.get(
				candidate,
			) as LinkAnswer["decisions"][number]["decision"],
		})),
		model: result.model,
	};
}

export type SummaryVerdict =
	| { status: "ok"; summary: string; model: string | null }
	| {
			status: "failed";
			errorCode: Exclude<
				LinkErrorCode,
				"unknown_candidate" | "duplicate_candidate" | "incomplete_answer"
			>;
			model: string | null;
	  };

/** Checks the model's summary: valid JSON, the strict schema and its length limit. */
export function verifySummaryAnswer(result: InferenceResult): SummaryVerdict {
	if (!result.ok) {
		return {
			status: "failed",
			errorCode: "inference_failed",
			model: result.model,
		};
	}
	const json = parseJson(result.text);
	if (!json.ok) {
		return { status: "failed", errorCode: "invalid_json", model: result.model };
	}
	const parsed = summaryAnswerSchema.safeParse(json.value);
	if (!parsed.success) {
		return {
			status: "failed",
			errorCode: "schema_violation",
			model: result.model,
		};
	}
	return { status: "ok", summary: parsed.data.summary, model: result.model };
}
