import {
	EXTRACTION_LIMITS,
	type EvidenceRange,
	type ExtractionDropReason,
	type Fragment,
	type FragmentExtraction,
	type VerifiedEntity,
	type VerifiedRelation,
} from "../../contracts/index-data.js";
import type { NameToken, TokenizerPort } from "../../contracts/ports.js";
import { sha256Hex } from "../bytes.js";
import { markdownStructure } from "../text/chunk.js";
import { normalizeForSearch } from "../text/normalize.js";
import {
	blankOut,
	blankStructure,
	NAME_RULES_VERSION,
	type NameStructure,
	namesFromTokens,
} from "./names.js";

/** Limits of one fragment's model-free extraction; what is beyond is counted as `over_limit` or `proper_over_limit`. */
export const NAMES_LIMITS = {
	entities: 100,
	relations: 200,
	evidencePerItem: EXTRACTION_LIMITS.evidencePerItem,
	quoteChars: EXTRACTION_LIMITS.quoteChars,
	/** Longer names (a run of capitalized words, a long kanji run) are no names. */
	nameChars: EXTRACTION_LIMITS.nameChars,
} as const;

/** The relation name of two names written in one sentence (kg2.md §3.1); it claims nothing more. */
export const SAME_SENTENCE_RELATION = "同じ文";

/** Entity types of the model-free extractor: a proper name, or any other noun run. */
export const NAME_TYPES = { proper: "固有名", noun: "名詞" } as const;

/**
 * The identity key of a name (kg2.md §3.3): the tokenizer's normalized forms joined (ASCII words
 * as written), NFKC, lower case, white space removed. Equal keys of one namespace are one entity.
 */
export const nameKey = (key: string): string =>
	normalizeForSearch(key).replace(/\s+/gu, "");

/** The `model` recorded with a model-free extraction: the tokenizer and the rules' version. */
export const namesModel = (tokenizer: Pick<TokenizerPort, "id">): string =>
	`names:${tokenizer.id}@rules${NAME_RULES_VERSION}`;

/**
 * The tokenizer threw (a missing dictionary, a stopped process): the host's port failed, not the
 * fragment. Carries no message of the tokenizer (it may hold a path or a text).
 */
export class TokenizerFailure extends Error {
	override readonly name = "TokenizerFailure";
	constructor() {
		super("tokenizer_failed");
	}
}

type Span = { start: number; end: number };

/**
 * The structure of each fragment (fragment-local ranges), read from the whole body: a fenced
 * code block or a frontmatter may span fragments, and a fragment alone cannot tell that it starts
 * inside one. `texts` are the fragments' texts in order; together they are the body.
 */
export function fragmentStructures(texts: readonly string[]): NameStructure[] {
	const body = texts.join("");
	const whole = markdownStructure(body);
	const clip = (r: Span, from: number, to: number): Span | null => {
		const start = Math.max(r.start, from);
		const end = Math.min(r.end, to);
		return start < end ? { start: start - from, end: end - from } : null;
	};
	/**
	 * The frontmatter's part of a fragment from its first whole line: keys are found at line
	 * starts, and a fragment cut inside a long line starts with no key.
	 */
	const frontmatterOf = (from: number, to: number): Span | null => {
		const part = whole.frontmatter && clip(whole.frontmatter, from, to);
		if (!part || from === 0) return part;
		const before = body[from - 1];
		if (before === "\n" || before === "\r") return part;
		const text = body.slice(from, from + part.end);
		const lineEnd = text.search(/\r\n?|\n/);
		if (lineEnd < 0) return null;
		const next = lineEnd + (text.startsWith("\r\n", lineEnd) ? 2 : 1);
		return next < part.end ? { start: next, end: part.end } : null;
	};
	let from = 0;
	return texts.map((text) => {
		const to = from + text.length;
		const code = whole.code
			.map((r) => clip(r, from, to))
			.filter((r): r is Span => r !== null);
		const frontmatter = frontmatterOf(from, to);
		from = to;
		return { code, frontmatter };
	});
}

/**
 * Sentences of a text (UTF-16 spans without surrounding white space): a sentence ends after
 * 。．！？!? or at a line break.
 */
function sentencesOf(text: string): Span[] {
	const out: Span[] = [];
	let start = 0;
	const push = (end: number) => {
		let s = start;
		let e = end;
		while (s < e && /\s/u.test(text[s] as string)) s++;
		while (e > s && /\s/u.test(text[e - 1] as string)) e--;
		if (e > s) out.push({ start: s, end: e });
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "\n") {
			push(i);
			start = i + 1;
		} else if ("。．！？!?".includes(c)) {
			push(i + 1);
			start = i + 1;
		}
	}
	push(text.length);
	return out;
}

/** The span is whole characters: its UTF-8 bytes decode back to it (no lone surrogate). */
const wholeChars = (text: string, span: Span): boolean => {
	const quote = text.slice(span.start, span.end);
	return Buffer.from(quote, "utf8").toString("utf8") === quote;
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * A window of at most `max` UTF-16 units inside `outer` that holds `inner`, centered on it, never
 * splitting a surrogate pair of `text` (the original text: a blanked one has spaces where a URL
 * held an emoji). Null when `inner` is not inside `outer` or alone is longer than `max`.
 */
function windowAround(
	text: string,
	outer: Span,
	inner: Span,
	max: number,
): Span | null {
	if (inner.start < outer.start || inner.end > outer.end) return null;
	if (outer.end - outer.start <= max) return outer;
	if (inner.end - inner.start > max) return null;
	const room = max - (inner.end - inner.start);
	let start = Math.max(outer.start, inner.start - Math.floor(room / 2));
	let end = Math.min(outer.end, start + max);
	start = Math.max(outer.start, end - max);
	if (start > outer.start && isLow(text.charCodeAt(start))) start++;
	if (end < outer.end && isHigh(text.charCodeAt(end - 1))) end--;
	return { start, end };
}

/**
 * The evidence of a span of the fragment's original text (UTF-8 byte range in the document).
 * Null when the span is not whole characters (a lone surrogate would hash other bytes than the
 * document's), as the model's path refuses such a quotation.
 */
function evidenceOf(
	fragment: Pick<Fragment, "ordinal" | "byteStart" | "text">,
	span: Span,
): EvidenceRange | null {
	if (!wholeChars(fragment.text, span)) return null;
	const quote = fragment.text.slice(span.start, span.end);
	const bytes = Buffer.from(quote, "utf8");
	const offset = Buffer.byteLength(fragment.text.slice(0, span.start), "utf8");
	const first = fragment.text.indexOf(quote);
	return {
		fragmentOrdinal: fragment.ordinal,
		byteStart: fragment.byteStart + offset,
		byteEnd: fragment.byteStart + offset + bytes.length,
		quoteSha256: sha256Hex(bytes),
		ambiguous:
			first !== span.start || fragment.text.indexOf(quote, span.start + 1) >= 0,
	};
}

/**
 * The model-free extraction of one fragment (kg2.md §3.1, G3): its names as entities and every
 * two names written in one sentence as one undirected relation `同じ文`. Every quotation is a
 * sentence of the original text (or a window of it at most `quoteChars` long that holds the
 * names), located by offset, so it occurs in the fragment as written. Names are as written in
 * the original text; two occurrences of one name are one entity.
 *
 * What does not fit is counted in `dropped`:
 * - `over_limit`: a name longer than `nameChars`; common nouns beyond the limit of entities
 *   (proper names are kept first, then names in the order they first occur); two names of one
 *   sentence too far apart to be quoted; relations beyond the limit of relations (pairs of two
 *   proper names are kept first, then in the order of their first sentence: what is beyond is a
 *   sentence of many names, an enumeration). A dense fragment has many: not reported as a loss.
 * - `proper_over_limit` (kg2.md §7.10): proper names beyond the limit of entities, which no
 *   search by name finds. The version is reported `extraction_truncated`.
 * - `no_evidence`: a name with no quotation (one that crosses a sentence end).
 * Only a pair with a proper name at one end at least is a relation (two common nouns make none;
 * rules version 6), and never a pair of two names with one key. Relations are only made between
 * kept entities; the pairs a dropped entity would have made are not counted.
 *
 * `structure` (`fragmentStructures`) names the fragment's code and frontmatter: code is no
 * prose and holds no name (rules version 7). Without it the fragment is read as prose.
 *
 * Throws `TokenizerFailure` when the tokenizer throws. Tokens that do not describe the text (the
 * tokenizer's contract broken, the same for every attempt) fail this fragment alone
 * (`invalid_tokens`).
 */
export function extractNames(
	fragment: Pick<Fragment, "ordinal" | "byteStart" | "text">,
	tokenizer: TokenizerPort,
	structure?: NameStructure,
): FragmentExtraction {
	const model = namesModel(tokenizer);
	const blanked = structure
		? blankStructure(blankOut(fragment.text), structure)
		: blankOut(fragment.text);
	let tokens: NameToken[];
	try {
		tokens = tokenizer.tokenize(blanked);
	} catch {
		throw new TokenizerFailure();
	}
	let names: ReturnType<typeof namesFromTokens>;
	try {
		names = namesFromTokens(blanked, tokens);
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		return {
			fragmentOrdinal: fragment.ordinal,
			status: "failed",
			errorCode: "invalid_tokens",
			model,
		};
	}
	const sentences = sentencesOf(blanked);
	const sentenceOf = (at: number) =>
		sentences.findIndex((s) => s.start <= at && at < s.end);
	const dropped = new Map<ExtractionDropReason, number>();
	const drop = (count: number, reason: ExtractionDropReason = "over_limit") => {
		if (count > 0) dropped.set(reason, (dropped.get(reason) ?? 0) + count);
	};

	// Entities: one per name (by its blanked surface), in the order of first occurrence.
	const byName = new Map<
		string,
		{ order: number; proper: boolean; key: string; occurrences: Span[] }
	>();
	for (const n of names) {
		const entry = byName.get(n.surface);
		if (entry) {
			entry.occurrences.push(n);
			entry.proper ||= n.proper;
		} else
			byName.set(n.surface, {
				order: byName.size,
				proper: n.proper,
				// The first occurrence's key (a tokenizer may normalize one surface two ways).
				key: nameKey(n.key) || nameKey(n.surface),
				occurrences: [n],
			});
	}
	const all = [...byName.values()];
	const short = all.filter(
		(e) =>
			(e.occurrences[0] as Span).end - (e.occurrences[0] as Span).start <=
			NAMES_LIMITS.nameChars,
	);
	drop(all.length - short.length);
	const quoted = short.map((e) => ({ ...e, evidence: quotesOf(e) }));
	const withQuotes = quoted.filter((e) => e.evidence.length > 0);
	drop(quoted.length - withQuotes.length, "no_evidence");
	// Proper names first (a stable sort), then back to the order of first occurrence.
	const byProper = [...withQuotes].sort(
		(x, y) => Number(y.proper) - Number(x.proper),
	);
	const kept = byProper
		.slice(0, NAMES_LIMITS.entities)
		.sort((x, y) => x.order - y.order);
	const left = byProper.slice(NAMES_LIMITS.entities);
	drop(left.filter((e) => e.proper).length, "proper_over_limit");
	drop(left.filter((e) => !e.proper).length);
	const idOf = new Map(kept.map((e, i) => [e, `e${i + 1}`]));
	const entities: VerifiedEntity[] = kept.map((e) => {
		const first = e.occurrences[0] as Span;
		return {
			id: idOf.get(e) as string,
			name: fragment.text.slice(first.start, first.end),
			type: e.proper ? NAME_TYPES.proper : NAME_TYPES.noun,
			description: "",
			evidence: e.evidence,
			key: e.key.slice(0, EXTRACTION_LIMITS.keyChars),
		};
	});
	function quotesOf(e: { occurrences: Span[] }): EvidenceRange[] {
		const evidence: EvidenceRange[] = [];
		const seen = new Set<number>();
		for (const o of e.occurrences) {
			if (evidence.length >= NAMES_LIMITS.evidencePerItem) break;
			const s = sentenceOf(o.start);
			if (s < 0 || seen.has(s)) continue;
			seen.add(s);
			const span = windowAround(
				fragment.text,
				sentences[s] as Span,
				o,
				NAMES_LIMITS.quoteChars,
			);
			const point = span && evidenceOf(fragment, span);
			if (point) evidence.push(point);
		}
		return evidence;
	}

	// Relations: two kept names in one sentence, once per pair (whichever comes first in a
	// sentence), the sentences as evidence. A pair is keyed and directed by entity order.
	const indexOf = new Map(kept.map((e, i) => [e, i]));
	const inSentence = sentences.map(() => new Map<number, Span>());
	for (const e of kept)
		for (const o of e.occurrences) {
			const at = inSentence[sentenceOf(o.start)];
			const i = indexOf.get(e) as number;
			if (at && !at.has(i)) at.set(i, o);
		}
	const pairs = new Map<
		string,
		{ source: number; target: number; spans: Span[]; proper: number }
	>();
	inSentence.forEach((found, s) => {
		const list = [...found].sort((x, y) => x[1].start - y[1].start);
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++) {
				const [a, sa] = list[i] as [number, Span];
				const [b, sb] = list[j] as [number, Span];
				const source = Math.min(a, b);
				const target = Math.max(a, b);
				// Two common nouns make no relation (rules v6, kg2.md §7.9): they were most of the
				// pairs and of the noise, and none of the known relations needed them.
				if (
					!(kept[source] as { proper: boolean }).proper &&
					!(kept[target] as { proper: boolean }).proper
				)
					continue;
				// Two surfaces of one key are one entity when read ("Google" and "google", or a
				// tokenizer's normal form: Sudachi gives グーグル the key of Google): no relation.
				if (
					(kept[source] as { key: string }).key ===
					(kept[target] as { key: string }).key
				)
					continue;
				const key = `${source} ${target}`;
				const pair = pairs.get(key) ?? {
					source,
					target,
					spans: [],
					proper:
						Number((kept[source] as { proper: boolean }).proper) +
						Number((kept[target] as { proper: boolean }).proper),
				};
				if (pair.spans.length < NAMES_LIMITS.evidencePerItem) {
					const span = windowAround(
						fragment.text,
						sentences[s] as Span,
						{ start: sa.start, end: Math.max(sa.end, sb.end) },
						NAMES_LIMITS.quoteChars,
					);
					if (span && wholeChars(fragment.text, span)) pair.spans.push(span);
				}
				pairs.set(key, pair);
			}
	});
	const withEvidence = [...pairs.values()].filter((p) => p.spans.length > 0);
	drop(pairs.size - withEvidence.length);
	// A stable sort: within one count of proper names, the order of the first sentence stays.
	const sortedPairs = [...withEvidence].sort((x, y) => y.proper - x.proper);
	const keptPairs = sortedPairs.slice(0, NAMES_LIMITS.relations);
	// More than the limit is a sentence of many names (an enumeration): its pairs say little.
	const leftPairs = sortedPairs.slice(NAMES_LIMITS.relations);
	drop(leftPairs.length);
	const relations: VerifiedRelation[] = keptPairs.map((p, i) => ({
		id: `r${i + 1}`,
		source: `e${p.source + 1}`,
		target: `e${p.target + 1}`,
		directed: false,
		relation: SAME_SENTENCE_RELATION,
		description: "",
		keywords: [],
		qualifiers: { negated: false, condition: null, certainty: "stated" },
		evidence: p.spans.map(
			(span) => evidenceOf(fragment, span) as EvidenceRange,
		),
	}));

	return {
		fragmentOrdinal: fragment.ordinal,
		status: "ok",
		entities,
		relations,
		dropped: [...dropped].map(([reason, count]) => ({ reason, count })),
		model,
	};
}
