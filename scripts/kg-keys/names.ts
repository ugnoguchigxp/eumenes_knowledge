// Name cleaning of the key graph (kg.md §8.6), used by scripts/kg-keys.ts with --rules.

/**
 * Name cleaning before the key (--rules), versioned with the report. It reads the name as written
 * (before NFKC), so full-width brackets, which mark codes in Japanese text, are told apart from
 * ASCII ones in product names such as "Amazon (S3)". A name the rules would empty stays as it is.
 */
export const RULES = {
	version: 1,
	apply: (name: string): string => {
		const cleaned = name
			// A leading list number 「5. 」「2）」「3、」: the mark is followed by white space or by a
			// non-ASCII character, so versions and names such as 0.0.4, 1.x and 3.js stay.
			.replace(/^\s*[0-9０-９]{1,3}\s*[.．)）、](?:\s+|(?=\P{ASCII}))/u, "")
			// Code marks in full-width brackets: 「（E5）」「（M1、E2）」
			.replace(
				/\s*（\s*[A-ZＡ-Ｚ]{1,3}[0-9０-９]{1,3}(?:\s*[、,，・]\s*[A-ZＡ-Ｚ]{1,3}[0-9０-９]{1,3})*\s*）\s*/gu,
				" ",
			)
			// 約 / およそ before a number
			.replace(/^\s*(?:約|およそ)\s*(?=[0-9０-９])/u, "")
			.trim();
		return cleaned === "" ? name : cleaned;
	},
} as const;
