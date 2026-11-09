import type { NameToken, TokenizerPort } from "../../contracts/ports.js";

/**
 * The rules that turn tokens into names, without a model (kg2.md §3.1, G3). Their version is
 * recorded with every extraction (`names:<tokenizer>@rules<version>`). Version 4 is the one
 * measured in kg2.md §7.1–7.3; version 5 (§7.4) blanks only the ASCII characters of a URL or a
 * path, and also e-mail addresses and secret-like strings (`scripts/kg-alt/sudachi_nouns.py` is
 * version 5 in Python); version 6 (§7.9, from real text) adds math, citation lines, the middle
 * dot, plain words for the space join, the identifier boundary and glosses in parentheses.
 *
 * - A name is a run of adjacent noun tokens (nouns, prefixes, noun-like suffixes) and ASCII
 *   words. Two plain capitalized words (a capital, then small letters: "Temporal Reasoning")
 *   with one space between stay one run; an identifier ("PaLM", "GPT-4") is not joined across a
 *   space. Katakana words joined by a middle dot are one run ("サム・アルトマン"). A run is cut
 *   between an identifier (a digit, a capital after the first letter, or capitals only) and a
 *   Japanese word ("GPT-4カスタムモデル" is GPT-4 and カスタムモデル). Leading prefixes and trailing
 *   suffixes are dropped.
 * - Full-width ASCII and the ideographic space become ASCII one for one first (offsets stay;
 *   ．！？ stay). Then URLs, e-mail addresses, paths under a home or temporary directory or a
 *   Windows drive, secret-like strings (API keys of a known form, JWTs, the value after
 *   `password=` and the like) are blanked out: their ASCII characters only, so the Japanese text
 *   written right after one stays, and a trailing full stop or comma stays. Math (TeX: a
 *   `{\displaystyle …}` group, `$$…$$`, `\(…\)`, `\[…\]`, a TeX command) and every line that
 *   cites (an ISBN, ISSN, DOI or arXiv number) are blanked out too.
 * - No name: a run of one character, or of digits and symbols only; a formal noun (こと, もの,
 *   ...) ends a run; a single English function word or note marker (TODO); a command-line
 *   option (--full); a number with a unit (16GB); a token-like ASCII string (32 characters or
 *   more of hexadecimal digits, or of letters and digits with upper case, lower case and a
 *   digit). A sentence's full stop and a leading dot before a letter are not part of a name.
 * - Proper: a token the tokenizer tags a proper noun, or an ASCII word that is an identifier
 *   (has a digit or one of _ - . / + #) or is not a function word; a lower-case English word
 *   counts only outside an English sentence (one without kana) and outside parentheses (there it
 *   is a gloss of the word before: 「生成的事前学習（generative pre-training）」).
 *
 * The lists are general (function words, formal nouns, markers), never names of a subject
 * (plan.md §5.3 as approved for KG2).
 */
export const NAME_RULES_VERSION = 6;

/** A name found in a text: where it is (UTF-16 offsets), how it is keyed, and whether proper. */
export type NameCandidate = {
	/** The name in the blanked text (half-width; the original text has the same offsets). */
	surface: string;
	start: number;
	end: number;
	/** The tokens' normalized forms joined (ASCII words as written); not yet NFKC or lower case. */
	key: string;
	proper: boolean;
};

const ASCII_WORD = /^[A-Za-z0-9_\-./+#]+$/;
const HAS_LETTER = /[A-Za-z]/;
const IDENTIFIER_MARK = /[0-9_\-./+#]/;
const MARKERS = new Set(["todo", "fixme", "tbd", "wip", "xxx"]);
const FORMAL_NOUNS = new Set(
	"こと もの ため ところ よう とき はず わけ ほう うち まま つもり".split(" "),
);
const NUMBER_UNIT = /^\d+(?:[.,]\d+)?[A-Za-z]{1,3}$/;
const LOWER_WORD = /^[a-z]+$/;
const SENTENCE_END = /[。．！？!?\n]|\.(?=\s)/g;
const KANA = /[ぁ-ゟ゠-ヿ]/;
/** ASCII only, so a Japanese text written right after one is not taken with it. */
const URL = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LOCAL_PATH =
	/(?:~\/|\/(?:Users|home|private|var\/folders|tmp)\/|(?<![A-Za-z0-9])[A-Za-z]:\\)[A-Za-z0-9._\-/\\~+@%]*/g;
/** API keys of a known form and JWTs. */
const SECRET =
	/(?<![A-Za-z0-9])(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;
/** The value written after `password=`, `token: ` and the like. */
const SECRET_VALUE =
	/(?<![A-Za-z0-9])((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)([!-~]+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?']+$/;
/** A book or paper number: ISBN, ISSN, DOI or arXiv, each with its number. */
const CITATION =
	/\b(?:ISBN(?:-1[03])?:?\s*[0-9][0-9Xx-]*|ISSN:?\s*[0-9][0-9Xx-]*|doi\s*:?\s*10\.[!-~]*|arXiv\s*:\s*[0-9][!-~]*)/gi;
/** A part of a line up to a Japanese sentence end: the unit a citation blanks. */
const CITATION_UNIT = /[^。！？\n]+/g;
/** A unit longer than this is prose that cites, not a bibliography entry: only the number goes. */
const CITATION_UNIT_CHARS = 300;
const MATH_GROUP = /\{\\(?:displaystyle|textstyle|scriptstyle)(?![A-Za-z])/g;
/** `$$…$$`, `\(…\)`, `\[…\]` within one paragraph (no blank line) and at most 1000 characters. */
const MATH_DELIMITED =
	/\$\$(?:[^$\n]|\$(?!\$)|\n(?![ \t]*\n)){1,1000}?\$\$|\\\((?:[^\n]|\n(?![ \t]*\n)){1,1000}?\\\)|\\\[(?:[^\n]|\n(?![ \t]*\n)){1,1000}?\\\]/g;
/**
 * A backslash and letters: a TeX command (`x\alpha` too). The parts of a Windows path or a regular
 * expression go with them (`src\core`, `\w+`); they are no names either.
 */
const TEX_COMMAND = /\\[A-Za-z]+/g;
const KATAKANA_WORD = /^[\p{Script=Katakana}ー]+$/u;
const MIDDLE_DOT = new Set(["・", "･"]);
/** A plain word: a capital, then small letters (hyphenated parts too: "Pre-trained"). */
const PLAIN_WORD = /^[A-Z][a-z]+(?:-[A-Za-z][a-z]*)*$/;
/** An identifier: a digit, a capital after the first letter, or capitals only (two or more). */
const IDENTIFIER =
	/^(?=.*[A-Za-z])(?:.*[0-9].*|.[^A-Z]*[A-Z].*|[A-Z][A-Z0-9_\-./+#]+)$/;
const LOWER_ONLY = /^[a-z][a-z-]*$/;
const TOKEN_LIKE =
	/^(?:[0-9A-Fa-f]{32,}|(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{32,})$/;
/** Common English function words: every word of an English sentence is a noun to a Japanese tokenizer. */
const STOPWORDS = new Set(
	`a about above after again all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further
had has have having he her here hers him his how i if in into is it its just me more most my
no nor not now of off on once only or other our out over own same she should so some such
than that the their them then there these they this those through to too under until up us
use used uses using very was we were what when where which while who whom why will with
would you your`.split(/\s+/),
);

const asciiWord = (t: NameToken) => ASCII_WORD.test(t.surface);
const asciiProper = (t: NameToken) =>
	asciiWord(t) &&
	HAS_LETTER.test(t.surface) &&
	(IDENTIFIER_MARK.test(t.surface) || !STOPWORDS.has(t.surface.toLowerCase()));
const plainWord = (t: NameToken) => PLAIN_WORD.test(t.surface);
const identifier = (t: NameToken) => asciiWord(t) && IDENTIFIER.test(t.surface);
const japanese = (t: NameToken) => !asciiWord(t) && t.kind !== "space";
const katakanaWord = (t: NameToken) => KATAKANA_WORD.test(t.surface);
const nounish = (t: NameToken) =>
	t.kind === "noun" || t.kind === "prefix" || t.kind === "suffix";

/**
 * Every character is a decimal digit, an underscore, or neither a letter nor a number (Python's
 * ^[\d\W_]+$; JavaScript's \W would also take Japanese letters).
 */
const onlyDigitsOrSymbols = (s: string): boolean =>
	[...s].every(
		(c) => /\p{Nd}/u.test(c) || c === "_" || !/[\p{L}\p{N}]/u.test(c),
	);

/** Spaces for every character but line breaks (the lines stay where they were). */
const blankKeepingLines = (m: string): string => m.replace(/[^\n]/g, " ");

/**
 * Math as TeX: `{\displaystyle …}` groups to their matching brace (to the line's end when
 * unbalanced; `\{` and `\}` are no group braces), `$$…$$`, `\(…\)`, `\[…\]`, then any TeX command
 * left. Linear: a group inside one already blanked is skipped.
 */
function blankMath(text: string): string {
	const parts: string[] = [];
	let done = 0;
	for (const m of text.matchAll(MATH_GROUP)) {
		if (m.index < done) continue;
		let depth = 0;
		let end = m.index;
		for (; end < text.length; end++) {
			const c = text[end];
			if (c === "\n") break;
			if (end > m.index && text[end - 1] === "\\") continue;
			if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				end++;
				break;
			}
		}
		parts.push(
			text.slice(done, m.index),
			blankKeepingLines(text.slice(m.index, end)),
		);
		done = end;
	}
	parts.push(text.slice(done));
	return parts
		.join("")
		.replace(MATH_DELIMITED, blankKeepingLines)
		.replace(TEX_COMMAND, blankKeepingLines);
}

/**
 * A citation (rules version 6): the part of the line up to a Japanese sentence end that holds a
 * book or paper number becomes spaces (its names are bibliography, not the subject); a part
 * longer than `CITATION_UNIT_CHARS` is prose, and only the number goes.
 */
const blankCitations = (text: string): string =>
	text.replace(CITATION_UNIT, (unit) => {
		CITATION.lastIndex = 0;
		if (!CITATION.test(unit)) return unit;
		return unit.length <= CITATION_UNIT_CHARS
			? " ".repeat(unit.length)
			: unit.replace(CITATION, (m) => " ".repeat(m.length));
	});

/**
 * The text the rules read: full-width ASCII and the ideographic space become ASCII one for one,
 * then URLs, e-mail addresses, home, temporary and drive paths and secret-like strings become
 * spaces of the same length (a trailing full stop or comma of a URL or a path stays), then math
 * and citations (rules version 6). The length never changes, so an offset into it is
 * an offset into the original text. ．！？ stay (sentence ends).
 */
export function blankOut(text: string): string {
	const blank = (m: string) => " ".repeat(m.length);
	const blankBody = (m: string) => {
		const body = m.replace(TRAILING_PUNCTUATION, "");
		return blank(body) + m.slice(body.length);
	};
	return text
		.replace(/[＂-－／-＞＠-～　]/g, (c) =>
			c === "　" ? " " : String.fromCharCode(c.charCodeAt(0) - 0xfee0),
		)
		.replace(URL, blankBody)
		.replace(EMAIL, blank)
		.replace(LOCAL_PATH, blankBody)
		.replace(SECRET, blank)
		.replace(
			SECRET_VALUE,
			(_, key: string, value: string) => key + blank(value),
		)
		.replace(/^[\s\S]*$/, blankMath)
		.replace(/^[\s\S]*$/, blankCitations);
}

/** Whether the sentence around text[start, end) is English: it has letters and no kana. */
function englishSentence(text: string, start: number, end: number): boolean {
	let left = 0;
	let right = text.length;
	for (const m of text.matchAll(SENTENCE_END)) {
		if (m.index < start) left = m.index + m[0].length;
		else if (m.index >= end) {
			right = m.index;
			break;
		}
	}
	const sentence = text.slice(left, right);
	return /[A-Za-z]/.test(sentence) && !KANA.test(sentence);
}

/**
 * Every name the tokens of a (blanked) text hold, in text order, one per occurrence. Throws a
 * `RangeError` when the tokens do not describe the text (a tokenizer's fault).
 */
export function namesFromTokens(
	text: string,
	tokens: readonly NameToken[],
): NameCandidate[] {
	if (!Array.isArray(tokens))
		throw new RangeError("tokens do not describe the text");
	const splits = (at: number) =>
		at > 0 &&
		at < text.length &&
		/[\uDC00-\uDFFF]/.test(text[at] as string) &&
		/[\uD800-\uDBFF]/.test(text[at - 1] as string);
	let cursor = 0;
	for (const t of tokens) {
		if (
			typeof t !== "object" ||
			t === null ||
			typeof t.surface !== "string" ||
			typeof t.norm !== "string" ||
			!Number.isSafeInteger(t.start) ||
			!Number.isSafeInteger(t.end) ||
			t.start < cursor ||
			t.end <= t.start ||
			t.end > text.length ||
			text.slice(t.start, t.end) !== t.surface ||
			splits(t.start) ||
			splits(t.end)
		)
			throw new RangeError("tokens do not describe the text");
		cursor = t.end;
	}
	// How many pairs of parentheses closed within the line hold each offset (an unclosed "(", as
	// in ":(", holds nothing).
	const depth = new Int32Array(text.length + 1);
	const open: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\n") open.length = 0;
		else if (c === "(") open.push(i);
		else if (c === ")") {
			const at = open.pop();
			if (at !== undefined) {
				(depth[at + 1] as number)++;
				(depth[i] as number)--;
			}
		}
	}
	for (let i = 1; i <= text.length; i++)
		depth[i] = (depth[i] as number) + (depth[i - 1] as number);
	const runs: NameToken[][] = [];
	let current: NameToken[] = [];
	const close = () => {
		if (current.length > 0) runs.push(current);
		current = [];
	};
	tokens.forEach((t, i) => {
		if (t.kind === "space") {
			const prev = current.at(-1);
			const next = tokens[i + 1];
			if (
				t.surface === " " &&
				prev &&
				next &&
				plainWord(prev) &&
				plainWord(next)
			) {
				current.push(t);
				return;
			}
			close();
			return;
		}
		// A middle dot between two katakana words ("サム・アルトマン") stays in the run.
		if (MIDDLE_DOT.has(t.surface)) {
			const prev = current.at(-1);
			const next = tokens[i + 1];
			if (
				prev &&
				next &&
				prev.end === t.start &&
				next.start === t.end &&
				katakanaWord(prev) &&
				katakanaWord(next) &&
				nounish(next)
			) {
				current.push(t);
				return;
			}
			close();
			return;
		}
		if (FORMAL_NOUNS.has(t.surface)) {
			close();
			return;
		}
		if (nounish(t) || asciiWord(t)) {
			const last = current.at(-1);
			// An identifier and a Japanese word are two names ("GPT-4カスタムモデル").
			if (
				last &&
				(last.end !== t.start ||
					(identifier(last) && japanese(t)) ||
					(japanese(last) && identifier(t)))
			)
				close();
			current.push(t);
		} else close();
	});
	close();
	const out: NameCandidate[] = [];
	for (let run of runs) {
		while (run.length > 0 && run[0]?.kind === "prefix") run = run.slice(1);
		// A suffix, or a middle dot left before one, is not part of the name.
		while (
			run.length > 0 &&
			(run.at(-1)?.kind === "suffix" ||
				MIDDLE_DOT.has(run.at(-1)?.surface ?? ""))
		)
			run = run.slice(0, -1);
		const first = run[0];
		const last = run.at(-1);
		if (!first || !last) continue;
		let surface = text.slice(first.start, last.end);
		const trimmed = surface.replace(/\.+$/, "");
		const cut = surface.length - trimmed.length;
		surface = trimmed;
		// The sentence is found from the name's end without the full stop.
		const nameEnd = first.start + trimmed.length;
		if (surface.startsWith("-") || NUMBER_UNIT.test(surface)) continue;
		const lead = /^\.\p{L}/u.test(surface) ? 1 : 0;
		surface = surface.slice(lead);
		if ([...surface].length < 2 || onlyDigitsOrSymbols(surface)) continue;
		// One word of letters that is a function word or a marker is no name ("it." too).
		const lower = surface.toLowerCase();
		if (
			/^[A-Za-z]+$/.test(surface) &&
			(STOPWORDS.has(lower) || MARKERS.has(lower))
		)
			continue;
		// A hash, a key or another token-like string is no name (and may be a secret).
		if (TOKEN_LIKE.test(surface)) continue;
		let key = run
			.map((t) => (asciiWord(t) || t.kind === "space" ? t.surface : t.norm))
			.join("");
		if (cut > 0) key = key.replace(/\.+$/, "");
		key = key.slice(lead);
		const english = englishSentence(text, first.start, nameEnd);
		// Inside parentheses, small-letter English is a gloss of the word before (rules v6), even
		// when the tokenizer tags it proper (Sudachi tags some unknown English words so).
		const gloss = (depth[first.start] ?? 0) > 0;
		const proper = run.some((t) => {
			const bare = t.surface.replace(/^\.+|\.+$/g, "");
			if (gloss && LOWER_ONLY.test(bare)) return false;
			return (
				t.proper ||
				(asciiProper(t) &&
					!(english && LOWER_WORD.test(bare)) &&
					!MARKERS.has(t.surface.toLowerCase()))
			);
		});
		const start = first.start + lead;
		out.push({ surface, start, end: start + surface.length, key, proper });
	}
	return out;
}

/**
 * The package's tokenizer without a dictionary (kg2.md §3.2 c): runs of one script. Kanji and
 * katakana runs are nouns, ASCII words are ASCII words, nothing is a proper noun by its tag
 * (only ASCII words can be proper, by the rules). It splits names that hold hiragana (送り仮名:
 * 「書き込み」) and cannot tell a Japanese proper noun; a host may pass a morphological analyzer.
 * Expects a blanked text (`blankOut`): full-width letters are ASCII there.
 */
export function createCharclassTokenizer(): TokenizerPort {
	const re =
		/([A-Za-z0-9_\-/+#]+(?:\.[A-Za-z0-9_\-/+#]+)*)|([\p{Script=Han}々〆ヶ]+)|([\p{Script=Katakana}ー]+)|(\s+)|(.)/gsu;
	return {
		id: "charclass",
		tokenize(text: string): NameToken[] {
			const out: NameToken[] = [];
			for (const m of text.matchAll(re)) {
				const surface = m[0];
				out.push({
					surface,
					start: m.index,
					end: m.index + surface.length,
					kind: m[2] || m[3] ? "noun" : m[4] ? "space" : "other",
					proper: false,
					norm: surface,
				});
			}
			return out;
		},
	};
}
