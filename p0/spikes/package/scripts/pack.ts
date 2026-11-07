// pack = `bun pm pack` (prepack builds + writes the manifest) -> rename with
// sha256 prefix -> write <tgz>.sha256 and a vendor manifest draft in out/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "out");
mkdirSync(out, { recursive: true });
const tmp = "pack-tmp.tgz";
const tmpPath = join(out, tmp);
const result = Bun.spawnSync(["bun", "pm", "pack", "--filename", tmpPath], {
	cwd: root,
	stdio: ["inherit", "inherit", "inherit"],
});
if (result.exitCode !== 0) throw new Error("bun pm pack failed");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(
	readFileSync(join(root, "distribution-manifest.json"), "utf8"),
);
const bytes = readFileSync(join(out, tmp));
const sha = createHash("sha256").update(bytes).digest("hex");
const artifact = `${pkg.name}-${pkg.version}-${sha.slice(0, 12)}.tgz`;
renameSync(join(out, tmp), join(out, artifact));
writeFileSync(join(out, `${artifact}.sha256`), `${sha}  ${artifact}\n`);

// Draft of Eumenes' vendor/knowledge/manifest.json (see distribution.md).
const vendor = {
	package: pkg.name,
	version: pkg.version,
	artifact,
	sha256: sha,
	size: bytes.length,
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
writeFileSync(
	join(out, "vendor-manifest.json"),
	`${JSON.stringify(vendor, null, "\t")}\n`,
);
console.log(`pack: ${artifact}\npack: sha256 ${sha}`);
