// Helpers for the script tests only (not imported by any script).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTempDir } from "./common.js";

export const TEST_TMP_PREFIX = "eumenes-knowledge-test-";

/** Runs `body` in a fresh temp directory and removes it afterwards (also when `body` throws). */
export async function withTempDir<T>(
	body: (dir: string) => Promise<T> | T,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), TEST_TMP_PREFIX));
	try {
		return await body(dir);
	} finally {
		removeTempDir(dir, TEST_TMP_PREFIX);
	}
}

/** Writes `files` (relative path -> text) below `root`, creating directories. */
export function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, text] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}
