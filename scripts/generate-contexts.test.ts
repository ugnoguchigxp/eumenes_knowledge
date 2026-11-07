import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	generateContexts,
	instructionSetDigest,
	readInstructionSources,
	renderGenerated,
} from "./generate-contexts.js";
import { repoRoot, sha256 } from "./lib/common.js";
import { withTempDir, writeTree } from "./lib/test-util.js";

const EMPTY_DIGEST = sha256("");

test("zero instructions render an empty, valid module", () => {
	const text = renderGenerated([]);
	expect(text).toContain("= [];");
	expect(text).toContain(EMPTY_DIGEST);
	expect(instructionSetDigest([])).toBe(EMPTY_DIGEST);
});

test("a missing sources directory means no instructions, and generate writes the file", async () => {
	await withTempDir((root) => {
		writeTree(root, { "src/contexts/placeholder.txt": "" });
		const result = generateContexts({ root, check: false });
		expect(result.ok).toBe(true);
		expect(readFileSync(join(root, "src/contexts/generated.ts"), "utf8")).toBe(
			renderGenerated([]),
		);
		expect(generateContexts({ root, check: true }).ok).toBe(true);
	});
});

test("several instructions are ordered by id then numeric version, with digests", async () => {
	await withTempDir((root) => {
		writeTree(root, {
			"src/contexts/sources/extract-entities.v10.md": "ten\n",
			"src/contexts/sources/extract-entities.v2.md": "two\n",
			"src/contexts/sources/answer.v1.md": "日本語の指示\n",
		});
		const entries = readInstructionSources(join(root, "src/contexts/sources"));
		expect(entries.map((e) => `${e.id}@${e.version}`)).toEqual([
			"answer@1",
			"extract-entities@2",
			"extract-entities@10",
		]);
		expect(entries[0]?.sha256).toBe(sha256("日本語の指示\n"));
		expect(entries[0]?.text).toBe("日本語の指示\n");
		const digest = sha256(
			entries.map((e) => `${e.id}@${e.version}:${e.sha256}`).join("\n"),
		);
		expect(instructionSetDigest(entries)).toBe(digest);
		const rendered = renderGenerated(entries);
		expect(rendered).toContain(digest);
		expect(rendered).toContain("extract-entities");
	});
});

test("--check passes when current, fails after a source or the output changes", async () => {
	await withTempDir((root) => {
		writeTree(root, { "src/contexts/sources/a.v1.md": "one\n" });
		expect(generateContexts({ root, check: true }).ok).toBe(false); // nothing generated yet
		expect(generateContexts({ root, check: false }).ok).toBe(true);
		expect(generateContexts({ root, check: true }).ok).toBe(true);

		writeFileSync(join(root, "src/contexts/sources/a.v1.md"), "changed\n");
		const stale = generateContexts({ root, check: true });
		expect(stale.ok).toBe(false);
		expect(stale.message).toContain("stale");

		generateContexts({ root, check: false });
		writeFileSync(join(root, "src/contexts/generated.ts"), "// tampered\n");
		expect(generateContexts({ root, check: true }).ok).toBe(false);
	});
});

test("bad file names and CRLF sources are rejected", async () => {
	await withTempDir((root) => {
		const dir = join(root, "src/contexts/sources");
		writeTree(root, { "src/contexts/sources/Bad_Name.md": "x\n" });
		expect(() => readInstructionSources(dir)).toThrow(
			"bad instruction file name",
		);
	});
	await withTempDir((root) => {
		writeTree(root, { "src/contexts/sources/a.v1.md": "x\r\ny\r\n" });
		expect(() =>
			readInstructionSources(join(root, "src/contexts/sources")),
		).toThrow("LF");
	});
	await withTempDir((root) => {
		writeTree(root, { "src/contexts/sources/a.v0.md": "x\n" });
		expect(() =>
			readInstructionSources(join(root, "src/contexts/sources")),
		).toThrow("bad instruction file name");
	});
});

test("the committed generated.ts is current", () => {
	expect(existsSync(join(repoRoot, "src/contexts/generated.ts"))).toBe(true);
	expect(generateContexts({ root: repoRoot, check: true }).ok).toBe(true);
});
