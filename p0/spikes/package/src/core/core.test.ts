import { expect, test } from "bun:test";
import { search } from "./index.js";

test("search validates input then calls the host port", async () => {
	const result = await search(
		{ search: async () => ({ hits: [], complete: true }) },
		{ query: "x" },
	);
	expect(result.complete).toBe(true);
	await expect(
		search(
			{ search: async () => ({ hits: [], complete: true }) },
			{ query: "" },
		),
	).rejects.toThrow();
});
