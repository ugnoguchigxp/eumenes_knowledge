/**
 * Form of a text for the full-text index (p0.md #8): NFKC, then lower case. Both the indexed
 * fragments and the queries go through this one function. `toLowerCase()` does not depend on
 * the locale. The result can differ in length from the input, so offsets in it are not offsets
 * in the original.
 */
export function normalizeForSearch(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}
