// Writes distribution-manifest.json at the repository root (it ships inside the package).
// Deterministic: no timestamps, sorted file lists, LF, tab indentation.
// `buildManifest` is pure; everything that touches the disk, git or the built dist is in `main`.
import {
	existsSync,
	lstatSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { instructionSetDigest } from "./generate-contexts.js";
import {
	posixRelative,
	repoRoot,
	runSync,
	sha256,
	walkFiles,
} from "./lib/common.js";

export const MANIFEST_FILE = "distribution-manifest.json";
export const MIGRATION_OWNER = "knowledge-package";

/** The upstream commit p0/lightrag.md pinned as the design reference. No upstream code is shipped yet. */
export const LIGHTRAG_REFERENCE = {
	upstream: "https://github.com/HKUDS/LightRAG",
	referenceCommit: "aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a",
	license: "MIT",
} as const;

/** One upstream file that was ported into dist (filled in from P2 on; see p0/distribution.md 7.1). */
export type LightragFile = {
	upstreamPath: string;
	upstreamCommit: string;
	upstreamBlobSha256: string;
	portedTo: string;
	change: "adapted" | "copied";
	noticeId: string;
};

export type ManifestInput = {
	package: { name: string; version: string; license: string };
	contractVersion: number;
	instructions: {
		setDigest: string;
		entries: readonly { id: string; version: number; sha256: string }[];
	};
	/** SQL strings in ordinal order (the `migrations` export of dist/sqlite). */
	migrations: readonly string[];
	exports: readonly string[];
	bin: Readonly<Record<string, string>>;
	dependencies: Readonly<Record<string, string>>;
	source: {
		gitCommit: string | null;
		dirty: boolean | null;
		/** Repo-relative path -> sha256 of every file that determines dist. */
		files: Readonly<Record<string, string>>;
	};
	/** Repo-relative path -> sha256 of every shipped file, this manifest excluded. */
	distributionFiles: Readonly<Record<string, string>>;
	toolchain: { bun: string; typescript: string };
	lightragFiles?: readonly LightragFile[];
};

export const SOURCE_DIGEST_SCOPE =
	"src/**, scripts/**, package.json, bun.lock, bunfig.toml, tsconfig*.json (sorted path+sha256)";
export const DISTRIBUTION_DIGEST_SCOPE =
	"files shipped by package.json `files` plus package.json and README.md (this manifest excluded)";

const sortedRecord = (record: Readonly<Record<string, string>>) =>
	Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);

/** sha256 of the sorted `path NUL sha256` lines joined by LF. */
export function digestOfFiles(files: Readonly<Record<string, string>>): string {
	return sha256(
		Object.entries(sortedRecord(files))
			.map(([path, hash]) => `${path}\0${hash}`)
			.join("\n"),
	);
}

/** Migration id, e.g. `knowledge-package/0001`. The host registers them under this owner. */
export const migrationId = (ordinal: number): string =>
	`${MIGRATION_OWNER}/${String(ordinal).padStart(4, "0")}`;

export function buildManifest(input: ManifestInput) {
	const expectedSetDigest = instructionSetDigest(input.instructions.entries);
	if (expectedSetDigest !== input.instructions.setDigest) {
		throw new Error(
			"manifest: instruction set digest does not match the instruction entries",
		);
	}
	for (const sql of input.migrations) {
		if (typeof sql !== "string") {
			throw new Error("manifest: every migration must be an SQL string");
		}
	}
	const lightragFiles = [...(input.lightragFiles ?? [])];
	const sourceFiles = sortedRecord(input.source.files);
	const distributionFiles = sortedRecord(input.distributionFiles);
	return {
		kind: "eumenes-knowledge-distribution",
		manifestVersion: 1,
		package: input.package,
		contract: { version: input.contractVersion },
		instructions: {
			setDigest: input.instructions.setDigest,
			entries: input.instructions.entries.map((entry) => ({
				id: entry.id,
				version: entry.version,
				sha256: entry.sha256,
			})),
		},
		schema: {
			migrationCount: input.migrations.length,
			// Same function as Eumenes' schema_migrations_v2.checksum: sha256 hex of the SQL string.
			migrations: input.migrations.map((sql, index) => ({
				ordinal: index + 1,
				id: migrationId(index + 1),
				sha256: sha256(sql),
			})),
		},
		exports: [...input.exports],
		bin: sortedRecord(input.bin),
		dependencies: sortedRecord(input.dependencies),
		source: {
			gitCommit: input.source.gitCommit,
			dirty: input.source.dirty,
			digest: digestOfFiles(sourceFiles),
			digestScope: SOURCE_DIGEST_SCOPE,
			fileCount: Object.keys(sourceFiles).length,
		},
		distribution: {
			digest: digestOfFiles(distributionFiles),
			digestScope: DISTRIBUTION_DIGEST_SCOPE,
			files: distributionFiles,
		},
		toolchain: input.toolchain,
		lightrag: {
			status: lightragFiles.length === 0 ? "no_ported_code" : "ported",
			upstream: LIGHTRAG_REFERENCE.upstream,
			referenceCommit: LIGHTRAG_REFERENCE.referenceCommit,
			license: LIGHTRAG_REFERENCE.license,
			files: lightragFiles,
		},
	};
}
export type DistributionManifest = ReturnType<typeof buildManifest>;

export const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

/**
 * Ported LightRAG code (status "ported" or a non-empty files[]) needs the MIT notice in the
 * package; fails when `<root>/THIRD_PARTY_NOTICES.md` is not a regular file. Not ported: no-op.
 */
export function assertThirdPartyNotices(
	root: string,
	lightrag: Pick<DistributionManifest["lightrag"], "status" | "files">,
): void {
	if (lightrag.status !== "ported" && lightrag.files.length === 0) return;
	const stat = lstatSync(join(root, THIRD_PARTY_NOTICES_FILE), {
		throwIfNoEntry: false,
	});
	if (stat === undefined || !stat.isFile()) {
		throw new Error(
			`manifest: LightRAG code is ported but ${THIRD_PARTY_NOTICES_FILE} is missing at the repository root`,
		);
	}
}

export const renderManifest = (manifest: DistributionManifest): string =>
	`${JSON.stringify(manifest, null, "\t")}\n`;

// --- disk and git ------------------------------------------------------------------------------

type PackageJson = {
	name: string;
	version: string;
	license: string;
	files: string[];
	exports: Record<string, unknown>;
	bin: Record<string, string>;
	dependencies: Record<string, string>;
};

/** Files that determine dist: sources, scripts and the configuration around them. */
export function collectSourceFiles(root: string): Record<string, string> {
	const paths = [
		...walkFiles(join(root, "src")),
		...walkFiles(join(root, "scripts")),
		...[
			"package.json",
			"bun.lock",
			"bunfig.toml",
			"tsconfig.json",
			"tsconfig.build.json",
		]
			.map((name) => join(root, name))
			.filter((path) => existsSync(path)),
	];
	return hashAll(root, paths);
}

/** Files the tgz ships (package.json `files`, plus package.json), minus the manifest itself. */
export function collectDistributionFiles(
	root: string,
	pkg: Pick<PackageJson, "files">,
): Record<string, string> {
	// package.json and the README are packed whether or not `files` lists them.
	const paths = new Set<string>(
		["package.json", "README.md"]
			.map((name) => join(root, name))
			.filter((path) => existsSync(path)),
	);
	for (const entry of pkg.files) {
		if (entry === MANIFEST_FILE) continue;
		const full = join(root, entry);
		if (!existsSync(full)) continue;
		if (statSync(full).isDirectory()) {
			for (const file of walkFiles(full)) paths.add(file);
		} else {
			paths.add(full);
		}
	}
	return hashAll(root, [...paths]);
}

function hashAll(
	root: string,
	paths: readonly string[],
): Record<string, string> {
	return Object.fromEntries(
		paths.map((path) => [
			posixRelative(root, path),
			sha256(readFileSync(path)),
		]),
	);
}

function readGit(root: string): {
	commit: string | null;
	dirty: boolean | null;
} {
	const head = runSync(["git", "rev-parse", "HEAD"], { cwd: root });
	if (head.exitCode !== 0) return { commit: null, dirty: null };
	// The manifest itself is generated by this script, so it never counts as a change.
	const status = runSync(
		["git", "status", "--porcelain", "--", ".", `:(exclude)${MANIFEST_FILE}`],
		{ cwd: root },
	);
	return {
		commit: head.stdout.trim(),
		dirty: status.exitCode === 0 ? status.stdout.trim() !== "" : null,
	};
}

async function importDist<T>(root: string, file: string): Promise<T> {
	const path = join(root, file);
	if (!existsSync(path)) {
		throw new Error(
			`manifest: ${file} is missing; run \`bun run build\` first`,
		);
	}
	return (await import(pathToFileURL(path).href)) as T;
}

export async function writeManifest(
	root: string,
): Promise<DistributionManifest> {
	const pkg = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as PackageJson;
	const version = await importDist<{ CONTRACT_VERSION: number }>(
		root,
		"dist/contracts/version.js",
	);
	const contexts = await importDist<{
		INSTRUCTION_SET_DIGEST: string;
		instructions: readonly { id: string; version: number; sha256: string }[];
	}>(root, "dist/contexts/index.js");
	const sqlite = await importDist<{ migrations: readonly string[] }>(
		root,
		"dist/sqlite/index.js",
	);
	const git = readGit(root);
	const manifest = buildManifest({
		package: { name: pkg.name, version: pkg.version, license: pkg.license },
		contractVersion: version.CONTRACT_VERSION,
		instructions: {
			setDigest: contexts.INSTRUCTION_SET_DIGEST,
			entries: contexts.instructions,
		},
		migrations: sqlite.migrations,
		exports: Object.keys(pkg.exports),
		bin: pkg.bin,
		dependencies: pkg.dependencies,
		source: {
			gitCommit: git.commit,
			dirty: git.dirty,
			files: collectSourceFiles(root),
		},
		distributionFiles: collectDistributionFiles(root, pkg),
		toolchain: {
			bun: Bun.version,
			typescript: runSync([join(root, "node_modules/.bin/tsc"), "--version"], {
				cwd: root,
			})
				.stdout.trim()
				.replace(/^Version /, ""),
		},
	});
	assertThirdPartyNotices(root, manifest.lightrag);
	writeFileSync(join(root, MANIFEST_FILE), renderManifest(manifest));
	return manifest;
}

if (import.meta.main) {
	try {
		const manifest = await writeManifest(repoRoot);
		console.log(
			`manifest: distribution.digest=${manifest.distribution.digest}`,
		);
		console.log(
			`manifest: ${manifest.schema.migrationCount} migration(s), ${manifest.instructions.entries.length} instruction(s)`,
		);
		if (manifest.source.dirty !== false) {
			console.log(
				"manifest: source is dirty or not under git; P5 acceptance needs a clean commit",
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : "manifest failed");
		process.exit(1);
	}
}
