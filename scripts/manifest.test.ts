import { expect, test } from "bun:test";
import { join } from "node:path";
import { instructionSetDigest } from "./generate-contexts.js";
import { sha256 } from "./lib/common.js";
import { withTempDir, writeTree } from "./lib/test-util.js";
import {
	assertThirdPartyNotices,
	buildManifest,
	collectDistributionFiles,
	collectSourceFiles,
	digestOfFiles,
	LIGHTRAG_REFERENCE,
	migrationId,
	renderManifest,
	type ManifestInput,
} from "./manifest.js";

const entries = [
	{ id: "a", version: 1, sha256: sha256("a1") },
	{ id: "b", version: 2, sha256: sha256("b2") },
];

const input = (over: Partial<ManifestInput> = {}): ManifestInput => ({
	package: { name: "eumenes_knowledge", version: "1.2.3", license: "MIT" },
	contractVersion: 1,
	instructions: { setDigest: instructionSetDigest(entries), entries },
	migrations: ["CREATE TABLE a (x)", "CREATE INDEX i ON a (x)"],
	exports: [".", "./sqlite"],
	bin: { z: "./z.js", a: "./a.js" },
	dependencies: { zod: "4.4.3" },
	source: {
		gitCommit: "c".repeat(40),
		dirty: false,
		files: { "src/b.ts": sha256("b"), "src/a.ts": sha256("a") },
	},
	distributionFiles: { "dist/b.js": sha256("b"), "dist/a.js": sha256("a") },
	toolchain: { bun: "1.4.4", typescript: "7.0.2" },
	...over,
});

test("the manifest records every item plan section 10 asks for", () => {
	const m = buildManifest(input());
	expect(m.package).toEqual({
		name: "eumenes_knowledge",
		version: "1.2.3",
		license: "MIT",
	});
	expect(m.contract.version).toBe(1);
	expect(m.instructions.setDigest).toBe(instructionSetDigest(entries));
	expect(m.instructions.entries).toEqual(entries);
	expect(m.schema.migrationCount).toBe(2);
	expect(m.schema.migrations).toEqual([
		{
			ordinal: 1,
			id: "knowledge-package/0001",
			sha256: sha256("CREATE TABLE a (x)"),
		},
		{
			ordinal: 2,
			id: "knowledge-package/0002",
			sha256: sha256("CREATE INDEX i ON a (x)"),
		},
	]);
	expect(m.source.gitCommit).toBe("c".repeat(40));
	expect(m.source.dirty).toBe(false);
	expect(m.source.fileCount).toBe(2);
	expect(m.distribution.files).toEqual({
		"dist/a.js": sha256("a"),
		"dist/b.js": sha256("b"),
	});
	expect(m.lightrag.status).toBe("no_ported_code");
	expect(m.lightrag.files).toEqual([]);
	expect(m.lightrag.referenceCommit).toBe(LIGHTRAG_REFERENCE.referenceCommit);
});

test("the manifest is deterministic: same input, same bytes; file order does not matter", () => {
	const a = renderManifest(buildManifest(input()));
	const b = renderManifest(
		buildManifest(
			input({
				distributionFiles: {
					"dist/a.js": sha256("a"),
					"dist/b.js": sha256("b"),
				},
				source: {
					gitCommit: "c".repeat(40),
					dirty: false,
					files: { "src/a.ts": sha256("a"), "src/b.ts": sha256("b") },
				},
			}),
		),
	);
	expect(a).toBe(b);
	expect(a.endsWith("\n")).toBe(true);
	expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps
});

test("digests change when a file, a migration or an instruction changes", () => {
	const base = buildManifest(input());
	const file = buildManifest(
		input({
			distributionFiles: {
				"dist/a.js": sha256("changed"),
				"dist/b.js": sha256("b"),
			},
		}),
	);
	expect(file.distribution.digest).not.toBe(base.distribution.digest);
	const sql = buildManifest(
		input({ migrations: ["CREATE TABLE a (x)", "CREATE INDEX j ON a (x)"] }),
	);
	expect(sql.schema.migrations[1]?.sha256).not.toBe(
		base.schema.migrations[1]?.sha256,
	);
	const src = buildManifest(
		input({
			source: {
				gitCommit: null,
				dirty: null,
				files: { "src/a.ts": sha256("x") },
			},
		}),
	);
	expect(src.source.digest).not.toBe(base.source.digest);
	expect(src.source.gitCommit).toBeNull();
});

test("migrations may be empty, and the instruction set may be empty", () => {
	const m = buildManifest(
		input({
			migrations: [],
			instructions: { setDigest: instructionSetDigest([]), entries: [] },
		}),
	);
	expect(m.schema.migrationCount).toBe(0);
	expect(m.instructions.entries).toEqual([]);
});

test("a stale instruction set digest or a non-string migration is refused", () => {
	expect(() =>
		buildManifest(
			input({ instructions: { setDigest: sha256("stale"), entries } }),
		),
	).toThrow("instruction set digest");
	expect(() =>
		buildManifest(input({ migrations: [{ sql: "x" } as unknown as string] })),
	).toThrow("SQL string");
});

test("ported LightRAG files switch the status and are recorded", () => {
	const file = {
		upstreamPath: "lightrag/prompt.py",
		upstreamCommit: LIGHTRAG_REFERENCE.referenceCommit,
		upstreamBlobSha256: sha256("x"),
		portedTo: "dist/core/prompt.js",
		change: "adapted" as const,
		noticeId: "lightrag-prompt",
	};
	const m = buildManifest(input({ lightragFiles: [file] }));
	expect(m.lightrag.status).toBe("ported");
	expect(m.lightrag.files).toEqual([file]);
});

test("assertThirdPartyNotices: not ported needs no file; ported needs a regular file", async () => {
	await withTempDir((root) => {
		const none = buildManifest(input()).lightrag;
		expect(() => assertThirdPartyNotices(root, none)).not.toThrow();
		const file = {
			upstreamPath: "lightrag/prompt.py",
			upstreamCommit: LIGHTRAG_REFERENCE.referenceCommit,
			upstreamBlobSha256: sha256("x"),
			portedTo: "dist/core/prompt.js",
			change: "adapted" as const,
			noticeId: "lightrag-prompt",
		};
		const ported = buildManifest(input({ lightragFiles: [file] })).lightrag;
		expect(() => assertThirdPartyNotices(root, ported)).toThrow(
			"THIRD_PARTY_NOTICES.md",
		);
		// status "ported" alone is enough, even with an empty files[]
		expect(() =>
			assertThirdPartyNotices(root, { status: "ported", files: [] }),
		).toThrow("THIRD_PARTY_NOTICES.md");
		writeTree(root, { "THIRD_PARTY_NOTICES.md": "MIT\n" });
		expect(() => assertThirdPartyNotices(root, ported)).not.toThrow();
	});
});

test("migrationId pads to four digits", () => {
	expect(migrationId(1)).toBe("knowledge-package/0001");
	expect(migrationId(12)).toBe("knowledge-package/0012");
});

test("digestOfFiles is the sha256 of sorted 'path NUL sha256' lines", () => {
	expect(digestOfFiles({ b: "2", a: "1" })).toBe(sha256("a\u00001\nb\u00002"));
});

test("collectSourceFiles and collectDistributionFiles read the disk with repo-relative paths", async () => {
	await withTempDir((root) => {
		writeTree(root, {
			"src/a.ts": "a",
			"scripts/s.ts": "s",
			"package.json": "{}",
			"bun.lock": "lock",
			"dist/index.js": "js",
			"dist/sub/x.d.ts": "d",
			LICENSE: "MIT",
			"distribution-manifest.json": "old manifest",
			"README.md": "readme",
			"p0/ignored.md": "no",
		});
		const source = collectSourceFiles(root);
		expect(Object.keys(source).sort()).toEqual([
			"bun.lock",
			"package.json",
			"scripts/s.ts",
			"src/a.ts",
		]);
		const dist = collectDistributionFiles(root, {
			files: [
				"dist",
				"LICENSE",
				"THIRD_PARTY_NOTICES.md",
				"distribution-manifest.json",
			],
		});
		expect(Object.keys(dist).sort()).toEqual([
			"LICENSE",
			"README.md",
			"dist/index.js",
			"dist/sub/x.d.ts",
			"package.json",
		]);
		expect(dist["LICENSE"]).toBe(sha256("MIT"));
		expect(join(root, "x")).toContain(root);
	});
});
