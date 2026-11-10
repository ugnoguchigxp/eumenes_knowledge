/**
 * Links of a Markdown text to other Markdown documents (kg2.md §7.14, F): what the author wrote,
 * read without a model. A link is kept as written (`href`, without its `#anchor` or `?query`,
 * percent-decoded) and resolved against the linking document's path when read, so a document
 * moved without a change of its body still resolves from where it is now. Paths compare with
 * their case, as on the web (a link written `readme.md` names no `README.md`).
 */

type Range = { readonly start: number; readonly end: number };

/** Links one fragment may record; more are left out (an index of documents is far below this). */
export const LINKS_PER_FRAGMENT = 200;
/** Longer hrefs are no link to a document of the library. */
export const HREF_CHARS = 1024;

/**
 * Link text: any character but brackets, or an escape. (An image inside a link, a badge, is
 * blanked first: no nesting here, which would make an unclosed text cost its length squared.)
 */
const TEXT = String.raw`(?:[^\[\]\n\\]|\\.)*`;
/** An image (`![alt](src "title")`): blanked before links are read, so a link around it stays. */
const IMAGE = /!\[(?:[^[\]\n\\]|\\.)*\]\([^()\n]*\)/g;
/** An href: no space, angle bracket or parenthesis but one balanced pair (`b(1).md`). */
const HREF = String.raw`<[^>\n]*>|(?:[^\s()<>]|\([^\s()<>]*\))+`;
/** `[text](href "title")`, not an image (`![alt](src)`). */
const INLINE = new RegExp(
	String.raw`(!?)\[${TEXT}\]\(\s*(${HREF})(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)`,
	"g",
);
/** A link reference definition: `[label]: href "title"`. */
const DEFINITION = /^[ \t]{0,3}\[(?:[^\]\n\\]|\\.)+\]:[ \t]*(<[^>\n]*>|\S+)/gm;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MARKDOWN = /\.(?:md|markdown)$/i;

/** `text` with the ranges blanked (same length: offsets stay). */
function blank(text: string, ranges: readonly Range[]): string {
	if (ranges.length === 0) return text;
	const chars = text.split("");
	for (const r of ranges)
		for (let i = Math.max(0, r.start); i < Math.min(chars.length, r.end); i++)
			if (chars[i] !== "\n") chars[i] = " ";
	return chars.join("");
}

/**
 * `text` with its inline code spans blanked (same length). As in CommonMark, a run of backticks
 * opens a span that the next run of the same length closes; a run with no such run is text. One
 * pass over the runs (a long run of backticks with no pair costs no more than its length).
 */
function blankCodeSpans(text: string): string {
	const runs: { start: number; length: number }[] = [];
	for (let i = 0; i < text.length;) {
		if (text[i] !== "`") {
			i += 1;
			continue;
		}
		let j = i;
		while (j < text.length && text[j] === "`") j += 1;
		runs.push({ start: i, length: j - i });
		i = j;
	}
	if (runs.length < 2) return text;
	// The next run of the same length, for every run.
	const next: (number | undefined)[] = Array.from({ length: runs.length });
	const latest = new Map<number, number>();
	for (let k = runs.length - 1; k >= 0; k--) {
		const length = (runs[k] as { length: number }).length;
		next[k] = latest.get(length);
		latest.set(length, k);
	}
	const spans: Range[] = [];
	for (let k = 0; k < runs.length;) {
		const close = next[k];
		if (close === undefined) {
			k += 1;
			continue;
		}
		const open = runs[k] as { start: number };
		const end = runs[close] as { start: number; length: number };
		spans.push({ start: open.start, end: end.start + end.length });
		k = close + 1;
	}
	return blank(text, spans);
}

/**
 * The document an href names, as written: null for a URL (any scheme, or `//host`), a link
 * within the same document (`#anchor`), and a file that is not Markdown (`.md`, `.markdown`).
 */
export function documentHref(raw: string): string | null {
	let href = raw.trim();
	if (href.startsWith("<") && href.endsWith(">"))
		href = href.slice(1, -1).trim();
	if (href === "" || href.startsWith("#") || href.startsWith("//")) return null;
	if (SCHEME.test(href)) return null;
	for (const mark of ["#", "?"]) {
		const at = href.indexOf(mark);
		if (at >= 0) href = href.slice(0, at);
	}
	try {
		href = decodeURIComponent(href);
	} catch {
		// Not percent-encoded as a whole: kept as written.
	}
	if (href.includes("\0") || href.length > HREF_CHARS) return null;
	return MARKDOWN.test(href) ? href : null;
}

/**
 * The hrefs of `text` that name another Markdown document, in the order written, each once.
 * `code` (fenced blocks, from the body's structure) and inline code spans hold no link.
 */
export function markdownLinks(
	text: string,
	code: readonly Range[] = [],
): string[] {
	const prose = blankCodeSpans(blank(text, code)).replace(IMAGE, (m) =>
		" ".repeat(m.length),
	);
	const found: { at: number; href: string }[] = [];
	for (const m of prose.matchAll(INLINE)) {
		if (m[1] === "!") continue;
		const href = documentHref(m[2] as string);
		if (href !== null) found.push({ at: m.index, href });
	}
	for (const m of prose.matchAll(DEFINITION)) {
		const href = documentHref(m[1] as string);
		if (href !== null) found.push({ at: m.index, href });
	}
	found.sort((x, y) => x.at - y.at);
	return [...new Set(found.map((f) => f.href))].slice(0, LINKS_PER_FRAGMENT);
}

/** The segments of a path, `.` and empty ones left out, `..` applied; null when it leaves the root. */
function segments(path: string): string[] | null {
	const out: string[] = [];
	for (const s of path.split("/")) {
		if (s === "" || s === ".") continue;
		if (s === "..") {
			if (out.length === 0) return null;
			out.pop();
		} else out.push(s);
	}
	return out;
}

/** A document path compared as the resolution gives it: no leading `/` or `./`. */
export function documentPath(path: string): string | null {
	const s = segments(path);
	return s && s.length > 0 ? s.join("/") : null;
}

/**
 * The path `href` names, written in the document at `sourcePath`: relative to that document's
 * folder, or to the namespace's root when it starts with `/`. Null when it leaves the root.
 */
export function resolveLink(sourcePath: string, href: string): string | null {
	const base = href.startsWith("/")
		? ""
		: sourcePath.split("/").slice(0, -1).join("/");
	return documentPath(`${base}/${href}`);
}

/** The key an href is found by from the document it names: its file name, lower case. */
export const linkName = (path: string): string =>
	(path.split("/").at(-1) ?? "").toLowerCase();
