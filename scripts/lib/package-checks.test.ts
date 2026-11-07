import { expect, test } from "bun:test";
import {
	bareName,
	buildImportGraph,
	checkDistImports,
	checkEntryGraph,
	checkTarEntries,
	scanImports,
	type EntryRule,
} from "./package-checks.js";

test("scanImports reads real imports, not comments or strings", () => {
	const refs = scanImports(`// import x from "fake-comment"
/** import { a } from "fake-doc" */
import a from "./a.js";
export * from "./b.js";
const s = "from 'not-an-import'";
const d = await import("./dyn.js");`);
	expect(refs.map((r) => r.path)).toEqual(["./a.js", "./b.js", "./dyn.js"]);
});

test("scanImports accepts a shebang line", () => {
	expect(
		scanImports(`#!/usr/bin/env bun\nimport "./x.js";`).map((r) => r.path),
	).toEqual(["./x.js"]);
});

test("bareName", () => {
	expect(bareName("zod")).toBe("zod");
	expect(bareName("zod/v4")).toBe("zod");
	expect(bareName("@scope/pkg/sub")).toBe("@scope/pkg");
});

const goodTar = [
	"package/package.json",
	"package/LICENSE",
	"package/distribution-manifest.json",
	"package/dist/index.js",
	"package/dist/index.d.ts",
	"package/dist/cli/bin.js",
];

test("checkTarEntries accepts the declared shape", () => {
	expect(checkTarEntries(goodTar)).toEqual([]);
	expect(
		checkTarEntries([...goodTar, "package/THIRD_PARTY_NOTICES.md"]),
	).toEqual([]);
});

test("checkTarEntries rejects source, tests, examples, p0 and strays", () => {
	for (const bad of [
		"package/src/index.ts",
		"package/examples/host/x.ts",
		"package/p0/distribution.md",
		"package/scripts/build.ts",
		"package/dist/core/core.test.js",
		"package/dist/mock-host.js",
		"package/CHANGELOG.md",
		"package/dist/../../etc/passwd",
		"/abs/path",
	]) {
		expect(checkTarEntries([...goodTar, bad]).length).toBeGreaterThan(0);
	}
});

test("checkTarEntries requires package.json, LICENSE and dist", () => {
	expect(
		checkTarEntries(["package/package.json", "package/LICENSE"]).join(),
	).toContain("package/dist/");
	expect(
		checkTarEntries(goodTar.filter((p) => p !== "package/LICENSE")).join(),
	).toContain("package/LICENSE");
});

test("checkDistImports keeps relative imports inside dist and bare ones declared", () => {
	const distRoot = "/pkg/dist";
	const files = new Set(["/pkg/dist/a.js", "/pkg/dist/sub/b.js"]);
	const options = {
		distRoot,
		declared: new Set(["zod"]),
		exists: (path: string) => files.has(path),
	};
	const ok = checkDistImports(
		[
			{
				path: "/pkg/dist/sub/c.js",
				source: `import "../a.js"; import "./b.js"; import { z } from "zod"; import fs from "node:fs";`,
			},
		],
		options,
	);
	expect(ok).toEqual([]);

	const bad = checkDistImports(
		[
			{
				path: "/pkg/dist/sub/c.js",
				source: `import "../../src/x.js"; import "./missing.js"; import "left-pad";`,
			},
		],
		options,
	);
	expect(bad).toHaveLength(3);
	expect(bad.join("\n")).toContain("leaves dist");
	expect(bad.join("\n")).toContain("missing");
	expect(bad.join("\n")).toContain("undeclared dependency");
});

function fakeFs(files: Record<string, string>) {
	return (path: string) => files[path] ?? null;
}
const rule = (over: Partial<EntryRule>): EntryRule => ({
	name: ".",
	file: "/p/dist/index.js",
	forbidDirs: ["/p/dist/cli"],
	builtins: false,
	...over,
});
const allowed = new Set(["zod"]);

test("checkEntryGraph passes a clean closure", () => {
	const graph = buildImportGraph(
		"/p/dist/index.js",
		fakeFs({
			"/p/dist/index.js": `export * from "./a.js"; import "zod";`,
			"/p/dist/a.js": `export const a = 1;`,
		}),
	);
	expect(checkEntryGraph(graph, rule({}), allowed)).toEqual([]);
});

test("checkEntryGraph reports forbidden reach, builtins, undeclared and unreadable modules", () => {
	const graph = buildImportGraph(
		"/p/dist/index.js",
		fakeFs({
			"/p/dist/index.js": `import "./cli/x.js"; import "node:fs"; import "bun:sqlite"; import "left-pad"; import "./gone.js";`,
			"/p/dist/cli/x.js": `export {}`,
		}),
	);
	const problems = checkEntryGraph(graph, rule({}), allowed).join("\n");
	expect(problems).toContain("reaches /p/dist/cli/x.js");
	expect(problems).toContain("builtin node:fs");
	expect(problems).toContain("builtin bun:sqlite");
	expect(problems).toContain("undeclared import left-pad");
	expect(problems).toContain("unreadable module /p/dist/gone.js");
});

test("checkEntryGraph allows only the listed builtins when the rule is a list", () => {
	const graph = buildImportGraph(
		"/p/dist/index.js",
		fakeFs({
			"/p/dist/index.js": `import "node:crypto"; import "node:fs";`,
		}),
	);
	const problems = checkEntryGraph(
		graph,
		rule({ builtins: ["node:crypto"] }),
		allowed,
	).join("\n");
	expect(problems).not.toContain("node:crypto");
	expect(problems).toContain("builtin node:fs");
});

test("checkEntryGraph allows builtins for entries that declare it", () => {
	const graph = buildImportGraph(
		"/p/dist/index.js",
		fakeFs({ "/p/dist/index.js": `import "node:fs";` }),
	);
	expect(checkEntryGraph(graph, rule({ builtins: true }), allowed)).toEqual([]);
});

test("buildImportGraph handles import cycles", () => {
	const graph = buildImportGraph(
		"/p/dist/a.js",
		fakeFs({
			"/p/dist/a.js": `import "./b.js";`,
			"/p/dist/b.js": `import "./a.js";`,
		}),
	);
	expect(graph.size).toBe(2);
});
