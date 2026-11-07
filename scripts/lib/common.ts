// Shared helpers for the release scripts. Every deletion goes through the two
// guards below, which check the absolute target before anything is removed.
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

/** Repository root (this file is scripts/lib/common.ts). */
export const repoRoot = resolve(import.meta.dir, "..", "..");

export const sha256 = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

/** All files below `dir` as absolute paths, sorted by code unit (locale independent). */
export function walkFiles(dir: string): string[] {
	const files = readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walkFiles(full) : [full];
	});
	return files.sort();
}

/** `path` relative to `root`, with `/` separators. */
export const posixRelative = (root: string, path: string): string =>
	relative(root, path).split("\\").join("/");

export const buildDirNames = ["dist", "out"] as const;
export type BuildDirName = (typeof buildDirNames)[number];

/**
 * Removes `<root>/dist` or `<root>/out`. `root` must be an absolute, normalized path of a
 * package directory (it holds a package.json); nothing else can be removed through here.
 */
export function removeBuildDir(root: string, name: BuildDirName): void {
	if (!isAbsolute(root) || resolve(root) !== root) {
		throw new Error("remove_refused: root is not an absolute normalized path");
	}
	if (!(buildDirNames as readonly string[]).includes(name)) {
		throw new Error("remove_refused: not a build directory");
	}
	if (!existsSync(join(root, "package.json"))) {
		throw new Error("remove_refused: root is not a package directory");
	}
	const target = join(root, name);
	if (dirname(target) !== root || basename(target) !== name) {
		throw new Error("remove_refused: target is not directly under root");
	}
	// A symbolic link named dist/out could point anywhere; never follow it, never remove it.
	if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`remove_refused: ${name} is a symbolic link`);
	}
	rmSync(target, { recursive: true, force: true });
}

/**
 * Removes a temporary directory this process created: an absolute path, directly inside the OS
 * temporary directory, whose name starts with `prefix` (and has something after it).
 */
export function removeTempDir(
	path: string,
	prefix: string,
	tmpRoot: string = tmpdir(),
): void {
	if (prefix.length < 8) throw new Error("remove_refused: prefix too short");
	if (!isAbsolute(path) || resolve(path) !== path) {
		throw new Error("remove_refused: path is not absolute and normalized");
	}
	const name = basename(path);
	if (!name.startsWith(prefix) || name.length === prefix.length) {
		throw new Error("remove_refused: name lacks the expected prefix");
	}
	if (!existsSync(path)) return;
	if (realpathSync(dirname(path)) !== realpathSync(tmpRoot)) {
		throw new Error("remove_refused: not directly inside the temp directory");
	}
	if (lstatSync(path).isSymbolicLink()) {
		throw new Error("remove_refused: path is a symbolic link");
	}
	rmSync(path, { recursive: true, force: true });
}

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** Runs a command to completion (no shell) and captures its output. */
export function runSync(
	cmd: string[],
	options: { cwd: string; env?: Record<string, string | undefined> },
): RunResult {
	const result = Bun.spawnSync(cmd, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}
