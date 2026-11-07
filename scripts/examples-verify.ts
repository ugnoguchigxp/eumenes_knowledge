// `bun run examples:verify`: runs `bun test examples` as a child process and checks, besides the
// test result, that the run leaves nothing behind (plan section 10):
//   - it finishes within the time limit (a stuck listener or unreleased handle would not),
//   - no temporary directory named `eumenes-knowledge-example-*` remains,
//   - no process started by the run is still alive.
// The child gets its own session/process group and its own TMPDIR, so "what the run started" and
// "what the run created" are exact, and only those are inspected and cleaned up.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir, repoRoot, walkFiles } from "./lib/common.js";

export const EXAMPLE_TMP_PREFIX = "eumenes-knowledge-example-";
export const RUN_TMP_PREFIX = "eumenes-knowledge-exverify-";
export const DEFAULT_TIMEOUT_MS = 120_000;

export type RunObservation = {
	exitCode: number | null;
	timedOut: boolean;
	/** No example test file exists, so the run proves nothing. */
	noTests: boolean;
	/** Entries named with EXAMPLE_TMP_PREFIX still in the run's TMPDIR. */
	leftoverTempDirs: readonly string[];
	/** `pid command` of processes of the run's process group still alive after it ended. */
	leftoverProcesses: readonly string[];
};

/** Turns what was observed into failure messages. Empty means the run was clean. Pure. */
export function judgeExamplesRun(observed: RunObservation): string[] {
	const failures: string[] = [];
	if (observed.noTests)
		failures.push("no example test files found under examples/");
	if (observed.timedOut) {
		failures.push(
			"did not finish within the time limit (listener or unreleased handle?); it was killed",
		);
	} else if (observed.exitCode !== 0) {
		failures.push(`bun test examples failed (exit ${observed.exitCode})`);
	}
	for (const dir of observed.leftoverTempDirs) {
		failures.push(`temporary directory left behind: ${dir}`);
	}
	for (const proc of observed.leftoverProcesses) {
		failures.push(`process left running after the run: ${proc}`);
	}
	return failures;
}

/** Whether `dir` holds at least one `*.test.ts` file (recursively). */
export function hasTestFiles(dir: string): boolean {
	return (
		existsSync(dir) &&
		walkFiles(dir).some((file) => /\.test\.[cm]?[jt]sx?$/.test(file))
	);
}

/** Live processes whose process group is `pgid`, as `pid command` strings. */
function processesInGroup(pgid: number): string[] {
	const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat=,command="], {
		encoding: "utf8",
	});
	if (ps.status !== 0) return [];
	return ps.stdout
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
		.flatMap((m) =>
			m !== null && Number(m[2]) === pgid && !(m[3] as string).startsWith("Z")
				? [`${m[1]} ${(m[4] as string).slice(0, 120)}`]
				: [],
		);
}

/** Kills the run's own process group. `pgid` is the pid of the child this script spawned. */
function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

export type RunOptions = {
	cmd: string[];
	cwd: string;
	timeoutMs: number;
	/** Where the child's TMPDIR is created. Defaults to the OS temp directory. */
	tmpRoot?: string;
	/** Reports "no tests" itself (the default checks `<cwd>/examples`). */
	noTests?: boolean;
};

export async function observeRun(options: RunOptions): Promise<RunObservation> {
	const tmpRoot = options.tmpRoot ?? tmpdir();
	const runTmp = mkdtempSync(join(tmpRoot, RUN_TMP_PREFIX));
	let group: number | null = null;
	const onSignal = () => {
		if (group !== null && processesInGroup(group).length > 0) killGroup(group);
		removeTempDir(runTmp, RUN_TMP_PREFIX, tmpRoot);
		process.exit(130);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const [file, ...args] = options.cmd as [string, ...string[]];
		// `detached` gives the child its own session and process group (pgid == pid).
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: { ...process.env, TMPDIR: runTmp },
			stdio: "inherit",
			detached: true,
		});
		const pid = child.pid;
		if (pid === undefined) throw new Error("could not start the child process");
		group = pid;
		let timedOut = false;
		let exited = false;
		const timer = setTimeout(() => {
			if (exited) return;
			timedOut = true;
			killGroup(pid);
		}, options.timeoutMs);
		const exitCode = await new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(null));
			child.once("exit", (code) => resolve(code));
		});
		exited = true;
		clearTimeout(timer);

		// The leader has exited, so its pid may be reused. Signal the group only while it still has
		// members of ours (a group id cannot be reused while any member lives); never blindly.
		const leftoverProcesses = processesInGroup(pid);
		if (leftoverProcesses.length > 0) killGroup(pid);
		group = null;
		const leftoverTempDirs = readdirSync(runTmp).filter((name) =>
			name.startsWith(EXAMPLE_TMP_PREFIX),
		);
		return {
			exitCode,
			timedOut,
			noTests: options.noTests ?? false,
			leftoverTempDirs,
			leftoverProcesses,
		};
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		removeTempDir(runTmp, RUN_TMP_PREFIX, tmpRoot);
	}
}

if (import.meta.main) {
	const timeoutArg = process.argv.find((arg) =>
		arg.startsWith("--timeout-ms="),
	);
	const timeoutMs = timeoutArg
		? Number(timeoutArg.slice("--timeout-ms=".length))
		: DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		console.error("examples:verify: --timeout-ms must be a positive number");
		process.exit(2);
	}
	const noTests = !hasTestFiles(join(repoRoot, "examples"));
	const observed = noTests
		? ({
				exitCode: null,
				timedOut: false,
				noTests,
				leftoverTempDirs: [],
				leftoverProcesses: [],
			} as const)
		: await observeRun({
				cmd: [process.execPath, "test", "examples"],
				cwd: repoRoot,
				timeoutMs,
				noTests,
			});
	const failures = judgeExamplesRun(observed);
	for (const failure of failures) console.error(`FAIL  ${failure}`);
	console.log(
		failures.length === 0
			? "PASS  examples:verify: tests passed; no leftover listener, process or temporary directory"
			: `FAIL  examples:verify: ${failures.length} problem(s)`,
	);
	process.exit(failures.length === 0 ? 0 : 1);
}
