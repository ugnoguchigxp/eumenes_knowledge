// `bun run verify`: the fixed checks of plan section 10, in this order, all run to the end so one
// failure does not hide the others. Exit code is non-zero when any stage failed.
import { join } from "node:path";
import { repoRoot } from "./lib/common.js";

export type Stage = { name: string; cmd: string[] };
export type StageResult = {
	name: string;
	ok: boolean;
	exitCode: number;
	ms: number;
};

export function stages(root: string): Stage[] {
	const bun = process.execPath;
	return [
		{
			name: "contexts:check",
			cmd: [bun, "scripts/generate-contexts.ts", "--check"],
		},
		{ name: "format (bun fmt --check)", cmd: [bun, "fmt", "--check"] },
		{
			name: "lint (oxlint)",
			cmd: [join(root, "node_modules/.bin/oxlint"), "--deny-warnings"],
		},
		{ name: "typecheck (bun check)", cmd: [bun, "check"] },
		{
			name: "typecheck build (bun check -p tsconfig.build.json)",
			cmd: [bun, "check", "-p", "tsconfig.build.json"],
		},
		{ name: "test (bun test)", cmd: [bun, "test"] },
	];
}

/** The table printed at the end, and whether everything passed. Pure. */
export function summarize(results: readonly StageResult[]): {
	text: string;
	ok: boolean;
} {
	const ok = results.length > 0 && results.every((r) => r.ok);
	const lines = results.map(
		(r) =>
			`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` (exit ${r.exitCode})`}  ${r.ms}ms`,
	);
	const failed = results.filter((r) => !r.ok).length;
	lines.push(
		ok
			? "verify: all stages passed"
			: `verify: ${failed} of ${results.length} stage(s) failed`,
	);
	return { text: lines.join("\n"), ok };
}

export function runStages(root: string, list: readonly Stage[]): StageResult[] {
	return list.map((stage) => {
		console.log(`\n=== ${stage.name} ===`);
		const started = performance.now();
		const result = Bun.spawnSync(stage.cmd, {
			cwd: root,
			stdio: ["inherit", "inherit", "inherit"],
		});
		const exitCode = result.exitCode ?? 1;
		return {
			name: stage.name,
			ok: exitCode === 0,
			exitCode,
			ms: Math.round(performance.now() - started),
		};
	});
}

if (import.meta.main) {
	const summary = summarize(runStages(repoRoot, stages(repoRoot)));
	console.log(`\n${summary.text}`);
	process.exit(summary.ok ? 0 : 1);
}
