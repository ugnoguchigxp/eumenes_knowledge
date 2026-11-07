// build = contexts check -> clean dist -> tsc (TypeScript 7) -> shape checks -> bin permissions.
// Output goes only to dist/. Tests, examples and scripts are not part of tsconfig.build.json.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeBuildDir, repoRoot } from "./lib/common.js";

/** Why the build must stop, or null when `src/version.ts` agrees with package.json. */
export function versionMismatch(
	packageJsonVersion: string,
	builtVersion: unknown,
): string | null {
	return builtVersion === packageJsonVersion
		? null
		: `src/version.ts (${String(builtVersion)}) != package.json (${packageJsonVersion})`;
}

/** Files an `exports` map points at (strings, possibly nested under conditions). */
export function exportTargets(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (value && typeof value === "object") {
		return Object.values(value).flatMap(exportTargets);
	}
	return [];
}

function step(label: string, cmd: string[], root: string): void {
	const result = Bun.spawnSync(cmd, {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (result.exitCode !== 0) throw new Error(`build: ${label} failed`);
}

export async function build(root: string): Promise<void> {
	step(
		"contexts check",
		[process.execPath, "scripts/generate-contexts.ts", "--check"],
		root,
	);
	removeBuildDir(root, "dist");
	step(
		"tsc",
		[join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.build.json"],
		root,
	);

	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		version: string;
		bin: Record<string, string>;
		exports: Record<string, unknown>;
	};
	const built = (await import(
		pathToFileURL(join(root, "dist/version.js")).href
	)) as {
		PACKAGE_VERSION?: unknown;
	};
	const mismatch = versionMismatch(pkg.version, built.PACKAGE_VERSION);
	if (mismatch) throw new Error(`build: ${mismatch}`);

	for (const bin of Object.values(pkg.bin)) {
		const file = join(root, bin);
		if (!existsSync(file)) throw new Error(`build: bin target missing: ${bin}`);
		if (!readFileSync(file, "utf8").startsWith("#!/usr/bin/env bun\n")) {
			throw new Error(`build: bin lacks the bun shebang: ${bin}`);
		}
		chmodSync(file, 0o755);
	}
	for (const target of exportTargets(pkg.exports)) {
		// The manifest is written by the next step (`bun run manifest`).
		if (target === "./distribution-manifest.json") continue;
		if (!existsSync(join(root, target))) {
			throw new Error(`build: export target missing: ${target}`);
		}
	}
	console.log("build: ok");
}

if (import.meta.main) {
	try {
		await build(repoRoot);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "build failed");
		process.exit(1);
	}
}
