// release = build -> manifest -> `bun pm pack` into out/ -> sha256 name, `.sha256`, and a draft
// of Eumenes' vendor/knowledge/manifest.json. (Named `release`, not `pack`, because npm runs
// a `prepack` hook for `pack`; there is none here, the steps are explicit.)
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { repoRoot, sha256 } from "./lib/common.js";
import {
	assertThirdPartyNotices,
	type DistributionManifest,
} from "./manifest.js";

export type VendorManifest = ReturnType<typeof buildVendorManifest>;

export const artifactName = (
	name: string,
	version: string,
	tgzSha256: string,
) => `${name}-${version}-${tgzSha256.slice(0, 12)}.tgz`;

/** Draft of Eumenes' `vendor/knowledge/manifest.json` (p0/distribution.md 7.2). Pure. */
export function buildVendorManifest(input: {
	manifest: DistributionManifest;
	artifact: string;
	tgzSha256: string;
	size: number;
}) {
	const { manifest } = input;
	return {
		package: manifest.package.name,
		version: manifest.package.version,
		artifact: input.artifact,
		sha256: input.tgzSha256,
		size: input.size,
		contractVersion: manifest.contract.version,
		instructionSetDigest: manifest.instructions.setDigest,
		dbSchemaVersion: manifest.schema.migrationCount,
		migrations: manifest.schema.migrations,
		sourceGitCommit: manifest.source.gitCommit,
		sourceDirty: manifest.source.dirty,
		sourceDigest: manifest.source.digest,
		distributionDigest: manifest.distribution.digest,
		lightrag: manifest.lightrag,
	};
}

function step(label: string, cmd: string[]): void {
	const result = Bun.spawnSync(cmd, {
		cwd: repoRoot,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (result.exitCode !== 0) throw new Error(`release: ${label} failed`);
}

export function release(root: string): { artifact: string; sha256: string } {
	step("build", [process.execPath, "scripts/build.ts"]);
	step("manifest", [process.execPath, "scripts/manifest.ts"]);

	const manifest = JSON.parse(
		readFileSync(join(root, "distribution-manifest.json"), "utf8"),
	) as DistributionManifest;
	assertThirdPartyNotices(root, manifest.lightrag);

	const out = join(root, "out");
	mkdirSync(out, { recursive: true });
	const tmpPath = join(out, "pack-tmp.tgz");
	if (existsSync(tmpPath)) rmSync(tmpPath);
	step("bun pm pack", [process.execPath, "pm", "pack", "--filename", tmpPath]);

	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		name: string;
		version: string;
	};
	const bytes = readFileSync(tmpPath);
	const tgzSha256 = sha256(bytes);
	const artifact = artifactName(pkg.name, pkg.version, tgzSha256);
	renameSync(tmpPath, join(out, artifact));
	writeFileSync(join(out, `${artifact}.sha256`), `${tgzSha256}  ${artifact}\n`);
	writeFileSync(
		join(out, "vendor-manifest.json"),
		`${JSON.stringify(
			buildVendorManifest({
				manifest,
				artifact,
				tgzSha256,
				size: bytes.length,
			}),
			null,
			"\t",
		)}\n`,
	);
	if (manifest.source.dirty !== false) {
		console.log(
			"release: source is dirty or not under git; P5 acceptance needs a clean commit",
		);
	}
	console.log(`release: out/${artifact}`);
	console.log(`release: sha256 ${tgzSha256}`);
	return { artifact, sha256: tgzSha256 };
}

if (import.meta.main) {
	try {
		release(repoRoot);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "release failed");
		process.exit(1);
	}
}
