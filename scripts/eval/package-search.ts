// Finds the package's search at run time, so the evaluation is written against the contract's
// `Search` type and does not need the implementation to exist to be compiled or tested.
import type { Search, VectorIndex } from "../../src/contracts/index.js";
import { fakeSearch } from "./fake-search.js";

export type SearchImplementation = {
	/** `package`: the package's `search`; `fake`: the minimal stand-in (`--search fake`). */
	source: "package" | "fake";
	search: Search;
	createVectorIndex: () => VectorIndex;
};

export async function loadPackageSearch(): Promise<SearchImplementation | null> {
	const core = (await import("../../src/core/index.js")) as unknown as Record<
		string,
		unknown
	>;
	const { search, createVectorIndex } = core;
	if (typeof search !== "function" || typeof createVectorIndex !== "function")
		return null;
	return {
		source: "package",
		search: search as Search,
		createVectorIndex: () => (createVectorIndex as () => VectorIndex)(),
	};
}

export const fakeSearchImplementation: SearchImplementation = {
	source: "fake",
	search: fakeSearch,
	createVectorIndex: () => ({ kind: "knowledge.vector-index" }),
};
