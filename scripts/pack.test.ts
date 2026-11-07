import { expect, test } from "bun:test";
import { sha256 } from "./lib/common.js";
import { instructionSetDigest } from "./generate-contexts.js";
import { buildManifest } from "./manifest.js";
import { artifactName, buildVendorManifest } from "./pack.js";

test("artifactName carries the first 12 hex digits of the tgz sha256", () => {
	const sha = sha256("tgz");
	expect(artifactName("eumenes_knowledge", "0.1.0", sha)).toBe(
		`eumenes_knowledge-0.1.0-${sha.slice(0, 12)}.tgz`,
	);
});

test("the vendor manifest draft copies the identifying fields of the distribution manifest", () => {
	const manifest = buildManifest({
		package: { name: "eumenes_knowledge", version: "0.1.0", license: "MIT" },
		contractVersion: 1,
		instructions: { setDigest: instructionSetDigest([]), entries: [] },
		migrations: ["CREATE TABLE a (x)"],
		exports: ["."],
		bin: {},
		dependencies: {},
		source: {
			gitCommit: "a".repeat(40),
			dirty: true,
			files: { "src/a.ts": sha256("a") },
		},
		distributionFiles: { "dist/a.js": sha256("a") },
		toolchain: { bun: "1.4.4", typescript: "7.0.2" },
	});
	const tgz = sha256("tgz");
	const vendor = buildVendorManifest({
		manifest,
		artifact: artifactName("eumenes_knowledge", "0.1.0", tgz),
		tgzSha256: tgz,
		size: 1234,
	});
	expect(vendor.sha256).toBe(tgz);
	expect(vendor.size).toBe(1234);
	expect(vendor.contractVersion).toBe(1);
	expect(vendor.dbSchemaVersion).toBe(1);
	expect(vendor.migrations).toEqual(manifest.schema.migrations);
	expect(vendor.sourceDirty).toBe(true);
	expect(vendor.sourceGitCommit).toBe("a".repeat(40));
	expect(vendor.distributionDigest).toBe(manifest.distribution.digest);
	expect(vendor.sourceDigest).toBe(manifest.source.digest);
	expect(vendor.instructionSetDigest).toBe(manifest.instructions.setDigest);
	expect(vendor.lightrag).toEqual(manifest.lightrag);
});
