// Mention candidates without a model from any tokenizer (kg2.md G1): the package's rules
// (src/core/extract/names.ts, version 5; scripts/kg-alt/sudachi_nouns.py is the same rules in
// Python, its docstring lists them) over each engine's tokens. "proper" when the run holds a
// proper noun or an ASCII word that is not a common English function word.
//
// Engines: kuromoji and lindera (IPADIC) and @nikkei/napi-sudachi are loaded from a directory
// where they were installed (--js-modules; they are not dependencies of the package); charclass
// is the package's tokenizer without a dictionary: runs of one script (kanji, katakana, ASCII)
// stand in for nouns, and only ASCII words can be "proper".
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NameToken, TokenizerPort } from "../../src/contracts/index.js";
import {
	blankOut,
	createCharclassTokenizer,
	namesFromTokens,
} from "../../src/core/extract/index.js";

export { blankOut };

export type Candidate = [surface: string, key: string, kind: "noun" | "proper"];

type TokenKind = NameToken["kind"];
type Token = NameToken;

const ASCII_WORD = /^[A-Za-z0-9_\-./+#]+$/;

/**
 * The candidates of one text: the package's rules (src/core/extract/names.ts) over the tokens of
 * the blanked text, one per surface in the order of first occurrence.
 */
function candidatesOf(tokenizer: TokenizerPort, text: string): Candidate[] {
	const t = blankOut(text);
	const out: Candidate[] = [];
	const seen = new Set<string>();
	for (const n of namesFromTokens(t, tokenizer.tokenize(t))) {
		if (seen.has(n.surface)) continue;
		seen.add(n.surface);
		out.push([n.surface, n.key, n.proper ? "proper" : "noun"]);
	}
	return out;
}

/** Places the tokens' surfaces in the text one after another (start and end in UTF-16 units). */
function place(
	text: string,
	parts: readonly Omit<Token, "start" | "end">[],
): Token[] {
	let cursor = 0;
	const out: Token[] = [];
	for (const p of parts) {
		// An empty token (some analyzers emit one) holds no text.
		if (p.surface.length === 0) continue;
		const at = text.indexOf(p.surface, cursor);
		// Only white space may lie between two tokens: a tokenizer that changes or drops other
		// characters would shift every later token, so it stops the run instead.
		if (at < 0 || text.slice(cursor, at).trim() !== "")
			throw new Error("tokens do not follow the text");
		out.push({ ...p, start: at, end: at + p.surface.length });
		cursor = at + p.surface.length;
	}
	return out;
}

const spaceKind = (surface: string): TokenKind | null =>
	/^\s+$/u.test(surface) ? "space" : null;

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export type Engine = "kuromoji" | "lindera" | "charclass" | "sudachi-napi";

/**
 * IPADIC part of speech (kuromoji and lindera use the same dictionary). A suffix that is an
 * adjectival or auxiliary stem (「的」「みたい」) ends the run, as Sudachi's 形状詞的 suffix does;
 * a token of symbols only (an unknown emoji is tagged a noun) is not part of a name.
 */
function ipadicKind(
	surface: string,
	pos: string,
	sub1: string,
	sub2: string,
): TokenKind {
	if (!/[\p{L}\p{N}]/u.test(surface)) return "other";
	if (pos === "名詞") {
		if (sub1 !== "接尾") return "noun";
		return sub2 === "形容動詞語幹" || sub2 === "助動詞語幹"
			? "other"
			: "suffix";
	}
	if (pos === "接頭詞") return "prefix";
	return "other";
}

/** IPADIC tags an unknown ASCII word a proper noun: ASCII words are judged by asciiProper only. */
const ipadicProper = (surface: string, sub1: string): boolean =>
	sub1 === "固有名詞" && !ASCII_WORD.test(surface);

/** The dictionary is loaded and tags a known noun: a wrong field name would tag nothing. */
function selfCheck(tokenizer: TokenizerPort, engine: string): void {
	if (
		!candidatesOf(tokenizer, "東京タワーの記録").some(
			([surface]) => surface === "記録",
		)
	)
		throw new Error(`--engine ${engine}: the tokenizer tags no noun`);
}

/**
 * One engine as the package's `TokenizerPort` (its id names the engine). charclass is the
 * package's own (runs of one script, no dictionary). The others are loaded from `modulesDir`
 * (--js-modules) and checked once on a known noun.
 */
export async function loadTokenizer(
	engine: Engine,
	modulesDir: string | null,
): Promise<TokenizerPort> {
	if (engine === "charclass") return createCharclassTokenizer();
	if (!modulesDir)
		throw new Error(`--engine ${engine} needs --js-modules <dir>`);
	const require = createRequire(join(modulesDir, "package.json"));
	let tokenizer: TokenizerPort;
	if (engine === "sudachi-napi") {
		// @nikkei/napi-sudachi (Sudachi.rs through napi). It reads NAPI_SUDACHI_ROOT and
		// SUDACHI_DICT_PATH from the process environment, set by the caller (Bun does not pass a
		// process.env change to the native module), and aborts the process on a bad dictionary.
		const sudachi = require("@nikkei/napi-sudachi/wrapper.js");
		const native = new sudachi.Tokenizer();
		const mode = sudachi.SplitMode.c();
		tokenizer = {
			id: engine,
			tokenize: (t) =>
				place(
					t,
					(
						native.tokenize(t, mode) as {
							surface: string;
							partOfSpeech: string[];
							normalizedForm: string;
						}[]
					).map((x) => {
						const [pos = "", sub1 = ""] = x.partOfSpeech;
						const kind: TokenKind =
							spaceKind(x.surface) ??
							(pos === "名詞"
								? "noun"
								: pos === "接頭辞"
									? "prefix"
									: pos === "接尾辞" && sub1 === "名詞的"
										? "suffix"
										: "other");
						return {
							surface: x.surface,
							kind,
							proper: sub1 === "固有名詞",
							norm: x.normalizedForm || x.surface,
						};
					}),
				),
		};
	} else if (engine === "lindera") {
		const { TokenizerBuilder } = require("lindera-wasm-nodejs-ipadic");
		const builder = new TokenizerBuilder();
		builder.setDictionary("embedded://ipadic");
		builder.setMode("normal");
		builder.setKeepWhitespace(true);
		const native = builder.build();
		tokenizer = {
			id: engine,
			tokenize: (t) =>
				place(
					t,
					(
						native.tokenize(t) as {
							surface: string;
							partOfSpeech: string;
							partOfSpeechSubcategory1?: string;
							partOfSpeechSubcategory2?: string;
							baseForm?: string;
						}[]
					).map((x) => ({
						surface: x.surface,
						kind:
							spaceKind(x.surface) ??
							ipadicKind(
								x.surface,
								x.partOfSpeech,
								x.partOfSpeechSubcategory1 ?? "",
								x.partOfSpeechSubcategory2 ?? "",
							),
						proper: ipadicProper(x.surface, x.partOfSpeechSubcategory1 ?? ""),
						norm: x.baseForm && x.baseForm !== "*" ? x.baseForm : x.surface,
					})),
				),
		};
	} else {
		const kuromoji = require("kuromoji");
		const dicPath = join(modulesDir, "node_modules/kuromoji/dict");
		const native = await new Promise<{
			tokenize: (s: string) => {
				surface_form: string;
				pos: string;
				pos_detail_1: string;
				pos_detail_2: string;
				basic_form: string;
			}[];
		}>((ok, fail) =>
			kuromoji
				.builder({ dicPath })
				.build((error: unknown, t: never) => (error ? fail(error) : ok(t))),
		);
		tokenizer = {
			id: engine,
			tokenize: (t) =>
				place(
					t,
					native.tokenize(t).map((x) => ({
						surface: x.surface_form,
						kind:
							spaceKind(x.surface_form) ??
							ipadicKind(x.surface_form, x.pos, x.pos_detail_1, x.pos_detail_2),
						proper: ipadicProper(x.surface_form, x.pos_detail_1),
						norm:
							x.basic_form && x.basic_form !== "*"
								? x.basic_form
								: x.surface_form,
					})),
				),
		};
	}
	selfCheck(tokenizer, engine);
	return tokenizer;
}

/** A function from a text to its candidates, for one engine. */
export async function loadEngine(
	engine: Engine,
	modulesDir: string | null,
): Promise<(text: string) => Candidate[]> {
	const tokenizer = await loadTokenizer(engine, modulesDir);
	return (text) => candidatesOf(tokenizer, text);
}
