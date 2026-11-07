import { expect, test } from "bun:test";
import { join } from "node:path";
import { entryRules, probe } from "./import-probe.js";
import { withTempDir, writeTree } from "./lib/test-util.js";

const cleanDist = {
	"dist/index.js": `export const CONTRACT_VERSION = 1;`,
	"dist/sqlite/index.js": `export const migrations = [];`,
	"dist/client/index.js": `export const createKnowledgeClient = () => ({});`,
	"dist/cli/index.js": `import { writeFileSync } from "node:fs"; export const runCli = () => { void writeFileSync; return 0; };`,
	"dist/mcp/index.js": `export const runMcp = () => 0;`,
};

test("entryRules covers the five importable entries", () => {
	expect(entryRules("/p").map((r) => r.name)).toEqual([
		".",
		"./sqlite",
		"./client",
		"./cli",
		"./mcp",
	]);
});

test("a clean package passes every graph check and import, and every positive control fires", async () => {
	await withTempDir(async (root) => {
		writeTree(root, cleanDist);
		const results = await probe(root);
		const failed = results.filter((r) => !r.ok);
		expect(failed).toEqual([]);
		expect(results.filter((r) => r.name.startsWith("control "))).toHaveLength(
			7,
		);
		expect(results.filter((r) => r.name.startsWith("graph "))).toHaveLength(5);
		expect(results.filter((r) => r.name.startsWith("import "))).toHaveLength(5);
	});
}, 60_000);

test("a package with side effects at import or forbidden imports fails the right checks", async () => {
	await withTempDir(async (root) => {
		writeTree(root, {
			...cleanDist,
			// timer at import
			"dist/index.js": `export const CONTRACT_VERSION = 1; setInterval(() => {}, 1000);`,
			// builtin in a library entry
			"dist/client/index.js": `import "node:fs"; export const createKnowledgeClient = () => ({});`,
			// the CLI reaching the database layer
			"dist/cli/index.js": `import "../sqlite/index.js"; export const runCli = () => 0;`,
		});
		const byName = new Map((await probe(root)).map((r) => [r.name, r]));
		expect(byName.get("import .")?.ok).toBe(false);
		expect(byName.get("import .")?.detail).toContain("setInterval");
		expect(byName.get("graph ./client")?.ok).toBe(false);
		expect(byName.get("graph ./client")?.detail).toContain("builtin node:fs");
		expect(byName.get("graph ./cli")?.ok).toBe(false);
		expect(byName.get("graph ./cli")?.detail).toContain("dist/sqlite/index.js");
		expect(byName.get("graph ./sqlite")?.ok).toBe(true);
		expect(byName.get("import ./sqlite")?.ok).toBe(true);
		expect(join(root, "dist")).toContain(root);
	});
}, 60_000);

test("a missing entry is reported, not ignored", async () => {
	await withTempDir(async (root) => {
		writeTree(root, { "dist/index.js": `export {};` });
		const results = await probe(root);
		expect(results.find((r) => r.name === "graph ./sqlite")?.ok).toBe(false);
		expect(results.find((r) => r.name === "import ./sqlite")?.ok).toBe(false);
	});
}, 60_000);
