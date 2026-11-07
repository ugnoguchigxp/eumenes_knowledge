import { expect, test } from "bun:test";
import { exportTargets, versionMismatch } from "./build.js";

test("versionMismatch is null only when src/version.ts equals package.json", () => {
	expect(versionMismatch("1.0.0", "1.0.0")).toBeNull();
	expect(versionMismatch("1.0.0", "1.0.1")).toContain("!=");
	expect(versionMismatch("1.0.0", undefined)).toContain("!=");
});

test("exportTargets collects strings from nested export conditions", () => {
	expect(
		exportTargets({
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			"./package.json": "./package.json",
		}).sort(),
	).toEqual(["./dist/index.d.ts", "./dist/index.js", "./package.json"]);
});
