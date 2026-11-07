// Import side-effect probe (plan section 10: "no DB / migration / network / server /
// model fetch at import"). For each entry it
//   1. statically walks the import graph in dist and checks the allowed closure
//      (no CLI/MCP reached from core, only declared bare imports, no builtins),
//   2. imports the entry in a fresh bun process with scripts/import-guard.ts
//      preloaded, in an empty cwd, and expects: no recorded side effect, no new
//      file, a clean exit (not a hang) within the time limit.
// A positive-control fixture per kind proves the guard really detects them (the
// guard stubs the APIs, so the controls never connect, listen or write).
//
// usage: bun scripts/import-probe.ts [packageRoot]   (default: this package;
//        packageRoot = a directory holding dist/, e.g. an installed copy)
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dir;
const packageRoot = resolve(process.argv[2] ?? join(here, ".."));
const guard = join(here, "import-guard.ts");

const entries = [
	{
		name: ".",
		file: "dist/index.js",
		forbidDirs: ["dist/cli", "dist/mcp", "dist/client"],
	},
	{
		name: "./sqlite",
		file: "dist/sqlite/index.js",
		forbidDirs: ["dist/cli", "dist/mcp", "dist/client", "dist/core"],
	},
	{
		name: "./client",
		file: "dist/client/index.js",
		forbidDirs: ["dist/cli", "dist/mcp", "dist/core", "dist/sqlite"],
	},
	{
		name: "./cli",
		builtins: true,
		file: "dist/cli/index.js",
		forbidDirs: ["dist/mcp"],
	},
	{
		name: "./mcp",
		builtins: true,
		file: "dist/mcp/index.js",
		forbidDirs: ["dist/cli"],
	},
];
const allowedBare = new Set(["zod"]); // declared dependencies only

function graph(
	file: string,
	seen = new Map<string, string[]>(),
): Map<string, string[]> {
	if (seen.has(file)) return seen;
	const source = readFileSync(file, "utf8");
	const specs = [
		...source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g),
	].map((m) => m[1] as string);
	seen.set(file, specs);
	for (const spec of specs)
		if (spec.startsWith(".")) graph(resolve(dirname(file), spec), seen);
	return seen;
}

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const rel = (path: string) => path.slice(packageRoot.length + 1);

for (const entry of entries) {
	const modules = graph(join(packageRoot, entry.file));
	const problems: string[] = [];
	for (const [file, specs] of modules) {
		for (const dir of entry.forbidDirs) {
			if (file.startsWith(`${join(packageRoot, dir)}/`))
				problems.push(`reaches ${rel(file)}`);
		}
		for (const spec of specs) {
			if (spec.startsWith(".")) continue;
			if (spec.startsWith("bun:") || spec.startsWith("node:")) {
				// core/sqlite/client may not import any builtin (fs, net, bun:sqlite, ...):
				// ESM named imports of builtins cannot be trapped at runtime, so this
				// static rule is the primary guard and the runtime guard is the second.
				if (!entry.builtins) problems.push(`builtin ${spec} in ${rel(file)}`);
				continue;
			}
			const bare = spec.startsWith("@")
				? spec.split("/").slice(0, 2).join("/")
				: (spec.split("/")[0] as string);
			if (!allowedBare.has(bare))
				problems.push(`undeclared import ${spec} in ${rel(file)}`);
		}
	}
	results.push({
		name: `graph ${entry.name}`,
		ok: problems.length === 0,
		detail: problems.join("; ") || `${modules.size} module(s)`,
	});
}

async function importInChild(target: string, timeoutMs = 5000) {
	const cwd = mkdtempSync(join(tmpdir(), "import-probe-"));
	const report = join(
		tmpdir(),
		`guard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
	);
	const started = performance.now();
	const child = Bun.spawn(
		[
			"bun",
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
	const timer = setTimeout(() => child.kill(), timeoutMs);
	const exitCode = await child.exited;
	clearTimeout(timer);
	const elapsedMs = Math.round(performance.now() - started);
	const parsed = existsSync(report)
		? (JSON.parse(readFileSync(report, "utf8")) as { violations: string[] })
		: { violations: ["(no report: process killed or hung)"] };
	const created = readdirSync(cwd);
	const stderr = await new Response(child.stderr).text();
	rmSync(cwd, { recursive: true, force: true });
	rmSync(report, { force: true });
	return { exitCode, elapsedMs, created, stderr: stderr.trim(), ...parsed };
}

for (const entry of entries) {
	const run = await importInChild(join(packageRoot, entry.file));
	const clean =
		run.exitCode === 0 &&
		run.violations.length === 0 &&
		run.created.length === 0;
	results.push({
		name: `import ${entry.name}`,
		ok: clean,
		detail: clean
			? `exit 0 in ${run.elapsedMs}ms, no side effect, no file`
			: `exit=${run.exitCode} violations=[${run.violations}] files=[${run.created}] ${run.stderr.slice(0, 200)}`,
	});
}

// Positive controls: the guard must flag each of these.
const controls: Record<string, string> = {
	fetch: "fetch",
	serve: "Bun.serve",
	timer: "setInterval",
	sqlite: "bun:sqlite.Database#exec",
	"write-file": "node:fs.writeFileSync",
};
for (const [fixture, expected] of Object.entries(controls)) {
	const run = await importInChild(
		join(here, "probe-fixtures", `${fixture}.ts`),
	);
	// ESM named imports of node:fs bypass the stub; a created file is the signal.
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

for (const r of results)
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
