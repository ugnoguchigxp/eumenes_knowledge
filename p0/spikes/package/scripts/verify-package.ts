// Consumer-side check of an installed tarball, modelled on Eumenes'
// api/application/vendor.test.ts. usage:
//   bun scripts/verify-package.ts <consumerRoot> [vendorDir=vendor/knowledge]
// consumerRoot has package.json, bun.lock, <vendorDir>/manifest.json + the tgz,
// and node_modules/eumenes_knowledge installed from that tgz.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const consumer = resolve(process.argv[2] ?? ".");
const vendorDir = process.argv[3] ?? "vendor/knowledge";
const name = "eumenes_knowledge";
const installed = join(consumer, "node_modules", name);

const failures: string[] = [];
let checks = 0;
const check = (label: string, ok: boolean, detail = "") => {
	checks += 1;
	if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const read = (path: string) => readFileSync(path);
const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
const json = (path: string) => JSON.parse(read(path).toString());
const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);

// 1. host-side vendor manifest <-> tgz <-> package.json <-> bun.lock
const vendor = json(join(consumer, vendorDir, "manifest.json"));
const artifactPath = join(consumer, vendorDir, vendor.artifact);
const artifact = read(artifactPath);
check("vendor.package", vendor.package === name);
check("tgz sha256 == vendor manifest", sha256(artifact) === vendor.sha256);
check("tgz size == vendor manifest", artifact.length === vendor.size);
check(
	".sha256 file == vendor manifest",
	read(`${artifactPath}.sha256`).toString().split(/\s+/)[0] === vendor.sha256,
);
check(
	"artifact name carries sha256 prefix",
	vendor.artifact.includes(vendor.sha256.slice(0, 12)),
);
const hostPkg = json(join(consumer, "package.json"));
check(
	"package.json dependency is file:vendor/...",
	hostPkg.dependencies?.[name] === `file:${vendorDir}/${vendor.artifact}`,
	String(hostPkg.dependencies?.[name]),
);
const lock = read(join(consumer, "bun.lock")).toString();
check(
	"bun.lock names the tgz",
	lock.includes(`${name}@${vendorDir}/${vendor.artifact}`),
);
check(
	"bun.lock integrity == sha512(tgz)",
	lock.includes(
		`sha512-${createHash("sha512").update(artifact).digest("base64")}`,
	),
);

// 2. installed package <-> its own distribution manifest
const pkg = json(join(installed, "package.json"));
const dist = json(join(installed, "distribution-manifest.json"));
check("installed version == vendor", pkg.version === vendor.version);
check("manifest version == package.json", dist.package.version === pkg.version);
const listed = new Set(Object.keys(dist.distribution.files));
for (const [path, expected] of Object.entries(
	dist.distribution.files as Record<string, string>,
)) {
	const file = join(installed, path);
	check(`file present ${path}`, existsSync(file));
	if (existsSync(file))
		check(`file sha256 ${path}`, sha256(read(file)) === expected);
}
const present = walk(installed)
	.map((f) => relative(installed, f).split("\\").join("/"))
	.filter((f) => f !== "distribution-manifest.json" && f !== ".bun-tag");
check(
	"no unlisted file in installed copy",
	present.every((f) => listed.has(f)),
	present.filter((f) => !listed.has(f)).join(","),
);
check(
	"distribution.digest recomputes",
	sha256(
		Object.entries(dist.distribution.files as Record<string, string>)
			.map(([p, h]) => `${p}\0${h}`)
			.join("\n"),
	) === dist.distribution.digest,
);
check(
	"vendor.distributionDigest == manifest",
	vendor.distributionDigest === dist.distribution.digest,
);
check(
	"vendor.sourceDigest == manifest",
	vendor.sourceDigest === dist.source.digest,
);
check(
	"vendor.sourceGitCommit == manifest",
	vendor.sourceGitCommit === dist.source.gitCommit,
);
check(
	"vendor.contractVersion == manifest",
	vendor.contractVersion === dist.contract.version,
);
check(
	"vendor.instructionSetDigest == manifest",
	vendor.instructionSetDigest === dist.instructions.setDigest,
);
check(
	"vendor.migrations == manifest",
	JSON.stringify(vendor.migrations) === JSON.stringify(dist.schema.migrations),
);

// 3. the real exports agree with the manifest (import by installed path)
const main = await import(pathToFileURL(join(installed, "dist/index.js")).href);
const sqlite = await import(
	pathToFileURL(join(installed, "dist/sqlite/index.js")).href
);
check("CONTRACT_VERSION", main.CONTRACT_VERSION === dist.contract.version);
check("PACKAGE_VERSION", main.PACKAGE_VERSION === pkg.version);
check(
	"INSTRUCTION_SET_DIGEST",
	main.INSTRUCTION_SET_DIGEST === dist.instructions.setDigest,
);
check(
	"instruction entries",
	JSON.stringify(
		main.instructions.map(
			(i: { id: string; version: number; sha256: string }) => ({
				id: i.id,
				version: i.version,
				sha256: i.sha256,
			}),
		),
	) === JSON.stringify(dist.instructions.entries),
);
check(
	"instruction text sha256",
	main.instructions.every(
		(i: { text: string; sha256: string }) => sha256(i.text) === i.sha256,
	),
);
check(
	"migration checksums",
	JSON.stringify(
		(sqlite.migrations as string[]).map((sql, i) => ({
			ordinal: i + 1,
			id: String(i + 1).padStart(4, "0"),
			sha256: sha256(sql),
		})),
	) === JSON.stringify(dist.schema.migrations),
);

// 4. tarball shape: nothing but the declared files; no lifecycle scripts; no escaping or undeclared imports
const tar = Bun.spawnSync(["tar", "-tzf", artifactPath])
	.stdout.toString()
	.trim()
	.split("\n");
const allowedTop =
	/^package\/(dist\/.+|package\.json|LICENSE|THIRD_PARTY_NOTICES\.md|distribution-manifest\.json)$/;
check(
	"tarball contains only allowed paths",
	tar.every((p) => allowedTop.test(p)),
	tar.filter((p) => !allowedTop.test(p)).join(","),
);
check(
	"tarball has no src/examples/test/mock/spike",
	!tar.some((p) =>
		/\/(src|examples|scripts|out|spikes?)\/|\.test\.|mock|fixture/i.test(p),
	),
);
for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
	check(`no ${hook} script`, !(pkg.scripts && hook in pkg.scripts));
}
check("no trustedDependencies", pkg.trustedDependencies === undefined);
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
for (const file of walk(join(installed, "dist")).filter((f) =>
	f.endsWith(".js"),
)) {
	const source = read(file).toString();
	for (const m of source.matchAll(
		/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g,
	)) {
		const spec = m[1] as string;
		const label = relative(installed, file);
		if (spec.startsWith(".")) {
			const target = resolve(dirname(file), spec);
			check(
				`relative import stays in dist ${label} -> ${spec}`,
				target.startsWith(join(installed, "dist") + "/") && existsSync(target),
			);
		} else if (!spec.startsWith("node:") && !spec.startsWith("bun:")) {
			const bare = spec.startsWith("@")
				? spec.split("/").slice(0, 2).join("/")
				: (spec.split("/")[0] as string);
			check(`declared dependency ${label} -> ${spec}`, declared.has(bare));
		}
	}
}
for (const key of ["exports", "bin"] as const) {
	const targets = Object.values(pkg[key]).flatMap((v) =>
		typeof v === "string" ? [v] : Object.values(v as Record<string, string>),
	);
	for (const t of targets)
		check(`${key} target exists ${t}`, existsSync(join(installed, t)));
}
check("sideEffects false", pkg.sideEffects === false);
check("type module", pkg.type === "module");

for (const f of failures) console.log(`FAIL  ${f}`);
console.log(
	`${failures.length === 0 ? "PASS" : "FAIL"}  verify-package: ${checks} checks, ${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
