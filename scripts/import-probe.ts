// Import side-effect probe (plan section 10: no DB / migration / network / server / model fetch
// at import). For each public entry it
//   1. walks the import graph in dist and checks the allowed closure (no CLI/MCP reached from the
//      library entries, only declared bare imports, no builtins where none are allowed),
//   2. imports the entry in a fresh bun process with scripts/import-guard.ts preloaded, in an
//      empty cwd, and expects: no recorded side effect, no new file, a clean exit within the limit.
// A positive-control fixture per kind proves the guard really detects them (the guard stubs the
// APIs, so the controls never connect, listen, spawn or write).
//
// usage: bun scripts/import-probe.ts [packageRoot]
//   packageRoot = a directory holding dist/ (default: this repository; verify-package passes the
//   installed copy under the consumer's node_modules).
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { removeTempDir, repoRoot } from "./lib/common.js";
import {
	buildImportGraph,
	checkEntryGraph,
	type EntryRule,
} from "./lib/package-checks.js";

const here = import.meta.dir;
const guard = join(here, "import-guard.ts");
export const PROBE_TMP_PREFIX = "eumenes-knowledge-probe-";
const IMPORT_TIMEOUT_MS = 5000;

/**
 * Builtins the library entries may import: pure computation only (sha256 for digests and the
 * embedding space key). fs, net, child_process and `bun:sqlite` stay forbidden.
 */
export const PURE_BUILTINS: readonly string[] = ["node:crypto"];

/** The five importable entries and what each may reach (p0.md #20; p0/distribution.md 6). */
export function entryRules(packageRoot: string): EntryRule[] {
	const dir = (name: string) => join(packageRoot, "dist", name);
	return [
		{
			name: ".",
			file: join(packageRoot, "dist/index.js"),
			forbidDirs: [dir("cli"), dir("mcp"), dir("client")],
			builtins: PURE_BUILTINS,
		},
		{
			name: "./sqlite",
			file: join(packageRoot, "dist/sqlite/index.js"),
			forbidDirs: [dir("cli"), dir("mcp"), dir("client")],
			builtins: PURE_BUILTINS,
		},
		{
			name: "./client",
			file: join(packageRoot, "dist/client/index.js"),
			forbidDirs: [dir("cli"), dir("mcp"), dir("core"), dir("sqlite")],
			builtins: PURE_BUILTINS,
		},
		{
			name: "./cli",
			file: join(packageRoot, "dist/cli/index.js"),
			// The CLI talks to the host through the client only; it never opens the database.
			forbidDirs: [dir("mcp"), dir("core"), dir("sqlite")],
			builtins: true,
		},
		{
			name: "./mcp",
			file: join(packageRoot, "dist/mcp/index.js"),
			forbidDirs: [dir("cli"), dir("core"), dir("sqlite")],
			builtins: true,
		},
	];
}

/** Bare imports any entry may use: the declared dependencies. */
export const allowedBareImports: ReadonlySet<string> = new Set(["zod"]);

type Result = { name: string; ok: boolean; detail: string };

type ChildRun = {
	exitCode: number | null;
	elapsedMs: number;
	created: string[];
	stderr: string;
	violations: string[];
};

async function importInChild(target: string): Promise<ChildRun> {
	const base = mkdtempSync(join(tmpdir(), PROBE_TMP_PREFIX));
	try {
		const cwd = join(base, "cwd");
		mkdirSync(cwd);
		const report = join(base, "report.json");
		const started = performance.now();
		const child = Bun.spawn(
			[
				process.execPath,
				"--preload",
				guard,
				"-e",
				`await import(${JSON.stringify(pathToFileURL(target).href)})`,
			],
			{
				cwd,
				env: { ...process.env, GUARD_REPORT: report },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => child.kill(), IMPORT_TIMEOUT_MS);
		const exitCode = await child.exited;
		clearTimeout(timer);
		const stderr = await new Response(child.stderr).text();
		const parsed = existsSync(report)
			? (JSON.parse(readFileSync(report, "utf8")) as { violations: string[] })
			: { violations: ["(no report: process killed or hung)"] };
		return {
			exitCode,
			elapsedMs: Math.round(performance.now() - started),
			created: readdirSync(cwd),
			stderr: stderr.trim(),
			violations: parsed.violations,
		};
	} finally {
		removeTempDir(base, PROBE_TMP_PREFIX);
	}
}

const controls: Record<string, string> = {
	fetch: "fetch",
	serve: "Bun.serve",
	listen: "Bun.listen",
	timer: "setInterval",
	spawn: "Bun.spawn",
	sqlite: "bun:sqlite.Database#exec",
	"write-file": "node:fs.writeFileSync",
};

export async function probe(packageRoot: string): Promise<Result[]> {
	const results: Result[] = [];
	const read = (path: string) =>
		existsSync(path) ? readFileSync(path, "utf8") : null;
	const label = (path: string) => path.slice(packageRoot.length + 1);

	for (const rule of entryRules(packageRoot)) {
		const graph = buildImportGraph(rule.file, read);
		const problems = checkEntryGraph(graph, rule, allowedBareImports, label);
		results.push({
			name: `graph ${rule.name}`,
			ok: problems.length === 0,
			detail: problems.join("; ") || `${graph.size} module(s)`,
		});
	}

	for (const rule of entryRules(packageRoot)) {
		const run = await importInChild(rule.file);
		const clean =
			run.exitCode === 0 &&
			run.violations.length === 0 &&
			run.created.length === 0;
		results.push({
			name: `import ${rule.name}`,
			ok: clean,
			detail: clean
				? `exit 0 in ${run.elapsedMs}ms, no side effect, no file`
				: `exit=${run.exitCode} violations=[${run.violations}] files=[${run.created}] ${run.stderr.slice(0, 200)}`,
		});
	}

	// Positive controls: the guard must flag each of these.
	for (const [fixture, expected] of Object.entries(controls)) {
		const run = await importInChild(
			join(here, "probe-fixtures", `${fixture}.ts`),
		);
		// ESM named imports of node:fs bypass the stub; a created file is the signal there.
		const detected =
			run.violations.includes(expected) ||
			(fixture === "write-file" && run.created.includes("created.txt"));
		results.push({
			name: `control ${fixture}`,
			ok: detected,
			detail: detected
				? `detected ${expected}`
				: `NOT detected (${run.violations}; ${run.stderr.slice(0, 120)})`,
		});
	}
	return results;
}

if (import.meta.main) {
	const packageRoot = resolve(process.argv[2] ?? repoRoot);
	const results = await probe(packageRoot);
	for (const r of results) {
		console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
	}
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}
