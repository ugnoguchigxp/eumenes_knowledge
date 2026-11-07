import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	lstatSync,
	mkdtempSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	removeBuildDir,
	removeTempDir,
	repoRoot,
	sha256,
	walkFiles,
} from "./common.js";
import { TEST_TMP_PREFIX, withTempDir, writeTree } from "./test-util.js";

test("repoRoot is the directory holding package.json", () => {
	expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
});

test("sha256 of the empty string", () => {
	expect(sha256("")).toBe(
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
});

test("walkFiles lists files recursively in sorted order", async () => {
	await withTempDir((dir) => {
		writeTree(dir, { "b/2.txt": "", "a.txt": "", "b/1.txt": "" });
		expect(walkFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual([
			"a.txt",
			"b/1.txt",
			"b/2.txt",
		]);
	});
});

test("removeBuildDir removes dist and out of a package directory only", async () => {
	await withTempDir((root) => {
		writeTree(root, {
			"package.json": "{}",
			"dist/a.js": "",
			"out/b.tgz": "",
			"src/x.ts": "",
		});
		removeBuildDir(root, "dist");
		removeBuildDir(root, "out");
		expect(existsSync(join(root, "dist"))).toBe(false);
		expect(existsSync(join(root, "out"))).toBe(false);
		expect(existsSync(join(root, "src/x.ts"))).toBe(true);
	});
});

test("removeBuildDir refuses relative roots, non-package roots and other names", async () => {
	expect(() => removeBuildDir("relative/path", "dist")).toThrow(
		"remove_refused",
	);
	await withTempDir((root) => {
		mkdirSync(join(root, "dist"));
		expect(() => removeBuildDir(root, "dist")).toThrow("remove_refused");
		expect(existsSync(join(root, "dist"))).toBe(true);
		writeTree(root, { "package.json": "{}", "src/x.ts": "" });
		expect(() => removeBuildDir(root, "src" as "dist")).toThrow(
			"remove_refused",
		);
		expect(() =>
			removeBuildDir(`${root}/../${root.split("/").pop()}`, "dist"),
		).toThrow("remove_refused");
		expect(existsSync(join(root, "src/x.ts"))).toBe(true);
	});
});

test("removeBuildDir refuses a dist that is a symbolic link and leaves its target alone", async () => {
	await withTempDir((root) => {
		writeTree(root, { "package.json": "{}", "elsewhere/keep.txt": "keep" });
		symlinkSync(join(root, "elsewhere"), join(root, "dist"));
		expect(() => removeBuildDir(root, "dist")).toThrow("symbolic link");
		expect(lstatSync(join(root, "dist")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(root, "elsewhere/keep.txt"))).toBe(true);
	});
});

test("removeBuildDir is a no-op when dist does not exist", async () => {
	await withTempDir((root) => {
		writeTree(root, { "package.json": "{}" });
		removeBuildDir(root, "dist");
		expect(existsSync(join(root, "dist"))).toBe(false);
	});
});

test("removeTempDir removes a prefixed directory directly inside the temp root", () => {
	const dir = mkdtempSync(join(tmpdir(), TEST_TMP_PREFIX));
	writeTree(dir, { "a/b.txt": "x" });
	removeTempDir(dir, TEST_TMP_PREFIX);
	expect(existsSync(dir)).toBe(false);
});

test("removeTempDir refuses wrong prefix, wrong parent, bare prefix and symlinks", async () => {
	await withTempDir((dir) => {
		const other = join(dir, "inner");
		mkdirSync(other);
		// right prefix but not directly inside the temp root
		mkdirSync(join(dir, `${TEST_TMP_PREFIX}y`));
		expect(() =>
			removeTempDir(join(dir, `${TEST_TMP_PREFIX}y`), TEST_TMP_PREFIX),
		).toThrow("remove_refused");
		expect(existsSync(join(dir, `${TEST_TMP_PREFIX}y`))).toBe(true);
		// prefix mismatch, relative path, bare prefix, short prefix
		expect(() => removeTempDir(dir, "something-else-")).toThrow(
			"remove_refused",
		);
		expect(() => removeTempDir("relative", TEST_TMP_PREFIX)).toThrow(
			"remove_refused",
		);
		expect(() =>
			removeTempDir(join(tmpdir(), TEST_TMP_PREFIX), TEST_TMP_PREFIX),
		).toThrow("remove_refused");
		expect(() => removeTempDir(dir, "tmp")).toThrow("remove_refused");
		// symlink named like a test directory
		const link = join(tmpdir(), `${TEST_TMP_PREFIX}link-${process.pid}`);
		symlinkSync(other, link);
		try {
			expect(() => removeTempDir(link, TEST_TMP_PREFIX)).toThrow(
				"remove_refused",
			);
			expect(existsSync(other)).toBe(true);
		} finally {
			unlinkSync(link);
		}
	});
});
