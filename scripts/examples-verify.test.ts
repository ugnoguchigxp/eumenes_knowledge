import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	EXAMPLE_TMP_PREFIX,
	hasTestFiles,
	judgeExamplesRun,
	observeRun,
	type RunObservation,
} from "./examples-verify.js";
import { withTempDir, writeTree } from "./lib/test-util.js";

const clean: RunObservation = {
	exitCode: 0,
	timedOut: false,
	noTests: false,
	leftoverTempDirs: [],
	leftoverProcesses: [],
};

test("a clean run has no failures", () => {
	expect(judgeExamplesRun(clean)).toEqual([]);
});

test("each kind of problem is reported", () => {
	expect(judgeExamplesRun({ ...clean, exitCode: 1 })[0]).toContain(
		"failed (exit 1)",
	);
	expect(
		judgeExamplesRun({ ...clean, timedOut: true, exitCode: null })[0],
	).toContain("time limit");
	expect(judgeExamplesRun({ ...clean, noTests: true }).join()).toContain(
		"no example test files",
	);
	expect(
		judgeExamplesRun({
			...clean,
			leftoverTempDirs: ["eumenes-knowledge-example-x"],
		})[0],
	).toContain("temporary directory");
	expect(
		judgeExamplesRun({ ...clean, leftoverProcesses: ["123 sleep 30"] })[0],
	).toContain("process left running");
});

test("hasTestFiles looks for *.test.ts recursively", async () => {
	await withTempDir((dir) => {
		expect(hasTestFiles(join(dir, "missing"))).toBe(false);
		writeTree(dir, { "a/fixture.ts": "" });
		expect(hasTestFiles(dir)).toBe(false);
		writeTree(dir, { "a/b/c.test.ts": "" });
		expect(hasTestFiles(dir)).toBe(true);
	});
});

const bun = process.execPath;
const observe = (
	code: string,
	timeoutMs: number,
	tmpRoot: string,
	cwd: string,
) => observeRun({ cmd: [bun, "-e", code], cwd, timeoutMs, tmpRoot });

test("observeRun: a program that exits cleanly is clean, and the run directory is removed", async () => {
	await withTempDir(async (tmpRoot) => {
		const seen = await observe("process.exit(0)", 10_000, tmpRoot, tmpRoot);
		expect(judgeExamplesRun(seen)).toEqual([]);
		expect(readdirSync(tmpRoot)).toEqual([]);
	});
});

test("observeRun: a failing exit code is reported", async () => {
	await withTempDir(async (tmpRoot) => {
		const seen = await observe("process.exit(3)", 10_000, tmpRoot, tmpRoot);
		expect(seen.exitCode).toBe(3);
		expect(judgeExamplesRun(seen).join()).toContain("exit 3");
	});
});

test("observeRun: a run that never ends is killed at the time limit", async () => {
	await withTempDir(async (tmpRoot) => {
		const seen = await observe(
			"setInterval(() => {}, 1000)",
			400,
			tmpRoot,
			tmpRoot,
		);
		expect(seen.timedOut).toBe(true);
		expect(judgeExamplesRun(seen).join()).toContain("time limit");
	});
});

test("observeRun: example temp directories created in the run's TMPDIR are detected and removed", async () => {
	await withTempDir(async (tmpRoot) => {
		const code = `require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/${EXAMPLE_TMP_PREFIX}")`;
		const seen = await observe(code, 10_000, tmpRoot, tmpRoot);
		expect(seen.leftoverTempDirs).toHaveLength(1);
		expect(seen.leftoverTempDirs[0]?.startsWith(EXAMPLE_TMP_PREFIX)).toBe(true);
		expect(readdirSync(tmpRoot)).toEqual([]); // cleaned up by observeRun
	});
});

test("observeRun: a child process that outlives the run is detected and killed", async () => {
	await withTempDir(async (tmpRoot) => {
		const marker = join(tmpRoot, "child.pid");
		mkdirSync(join(tmpRoot, "work"));
		const code = `const c = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(c.pid));
c.unref();`;
		const seen = await observe(code, 10_000, tmpRoot, join(tmpRoot, "work"));
		expect(seen.leftoverProcesses.length).toBeGreaterThan(0);
		expect(seen.leftoverProcesses.join()).toContain("sleep");
		expect(judgeExamplesRun(seen).join()).toContain("process left running");
		// the leftover was killed by observeRun (only our own group)
		const pid = Number(await Bun.file(marker).text());
		await Bun.sleep(100);
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
		expect(existsSync(marker)).toBe(true);
	});
});
