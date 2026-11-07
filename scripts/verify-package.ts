// verify:package = install ONLY the packed tgz into a clean consumer and check it the way Eumenes
// will (modelled on api/application/vendor.test.ts):
//   tgz <-> vendor manifest <-> bun.lock <-> installed files <-> distribution-manifest.json,
//   every public import at runtime, the types with skipLibCheck:false (positive and negative),
//   the bins, tarball shape, import graph inside dist, and the import side-effect probe on the
//   installed copy.
// The consumer lives in a fresh OS temp directory (prefix below) and is removed on exit.
// Needs `out/` from `bun run release`. `bun install --offline` resolves zod from the local bun
// cache; if 4.4.3 is not cached the install step fails (no network is used).
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	posixRelative,
	removeTempDir,
	repoRoot,
	runSync,
	sha256,
	walkFiles,
} from "./lib/common.js";
import {
	consumerRuntimeSource,
	consumerTsconfig,
	consumerTypeCheckSource,
	entrySpecifiers,
} from "./lib/consumer-files.js";
import { checkDistImports, checkTarEntries } from "./lib/package-checks.js";
import { digestOfFiles, migrationId } from "./manifest.js";

export const CONSUMER_TMP_PREFIX = "eumenes-knowledge-consumer-";
const VENDOR_DIR = "vendor/knowledge";

type Json = any; // Parsed JSON read from artifacts under test; every use is guarded by a check.

class Checks {
	count = 0;
	failures: string[] = [];
	check(label: string, ok: boolean, detail = ""): void {
		this.count += 1;
		if (!ok) this.failures.push(detail ? `${label}: ${detail}` : label);
	}
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));
const clip = (text: string, max = 800) =>
	text.length > max ? `${text.slice(0, max)}...` : text;

export function verifyPackage(root: string): {
	count: number;
	failures: string[];
} {
	const c = new Checks();
	const outDir = join(root, "out");
	const draftPath = join(outDir, "vendor-manifest.json");
	if (!existsSync(draftPath)) {
		c.check(
			"out/vendor-manifest.json exists (run `bun run release` first)",
			false,
		);
		return c;
	}
	const vendor = readJson(draftPath);
	const name: string = vendor.package;
	const artifactPath = join(outDir, vendor.artifact);
	if (!existsSync(artifactPath)) {
		c.check(`tgz exists: out/${vendor.artifact}`, false);
		return c;
	}
	const artifact = readFileSync(artifactPath);

	const tmp = mkdtempSync(join(tmpdir(), CONSUMER_TMP_PREFIX));
	const onSignal = () => {
		removeTempDir(tmp, CONSUMER_TMP_PREFIX);
		process.exit(130);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		runInConsumer(root, tmp, { c, vendor, name, artifact, artifactPath });
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		removeTempDir(tmp, CONSUMER_TMP_PREFIX);
	}
	return c;
}

function runInConsumer(
	root: string,
	tmp: string,
	ctx: {
		c: Checks;
		vendor: Json;
		name: string;
		artifact: Buffer;
		artifactPath: string;
	},
): void {
	const { c, vendor, name, artifact, artifactPath } = ctx;
	const rootPkg = readJson(join(root, "package.json"));

	// 1. Lay out the consumer like Eumenes: vendor/knowledge/{tgz, tgz.sha256, manifest.json}.
	const vendorDir = join(tmp, VENDOR_DIR);
	mkdirSync(vendorDir, { recursive: true });
	copyFileSync(artifactPath, join(vendorDir, vendor.artifact));
	copyFileSync(
		`${artifactPath}.sha256`,
		join(vendorDir, `${vendor.artifact}.sha256`),
	);
	copyFileSync(
		join(root, "out/vendor-manifest.json"),
		join(vendorDir, "manifest.json"),
	);
	writeFileSync(
		join(tmp, "package.json"),
		`${JSON.stringify(
			{
				name: "eumenes-knowledge-consumer",
				private: true,
				type: "module",
				dependencies: {
					[name]: `file:${VENDOR_DIR}/${vendor.artifact}`,
					zod: rootPkg.dependencies.zod,
				},
			},
			null,
			"\t",
		)}\n`,
	);
	const install = runSync([process.execPath, "install", "--offline"], {
		cwd: tmp,
	});
	c.check(
		"bun install --offline from the tgz (zod must be in the local bun cache)",
		install.exitCode === 0,
		clip(`${install.stdout}${install.stderr}`),
	);
	const installed = join(tmp, "node_modules", name);
	if (install.exitCode !== 0 || !existsSync(installed)) return;

	// 2. vendor manifest <-> tgz <-> package.json <-> bun.lock
	c.check("vendor.package", vendor.package === name);
	c.check("tgz sha256 == vendor manifest", sha256(artifact) === vendor.sha256);
	c.check("tgz size == vendor manifest", artifact.length === vendor.size);
	c.check(
		".sha256 file == vendor manifest",
		readFileSync(`${artifactPath}.sha256`, "utf8").split(/\s+/)[0] ===
			vendor.sha256,
	);
	c.check(
		"artifact name carries the sha256 prefix",
		vendor.artifact.includes(vendor.sha256.slice(0, 12)),
	);
	const hostPkg = readJson(join(tmp, "package.json"));
	c.check(
		"consumer dependency is file:vendor/...",
		hostPkg.dependencies?.[name] === `file:${VENDOR_DIR}/${vendor.artifact}`,
	);
	const lock = readFileSync(join(tmp, "bun.lock"), "utf8");
	c.check(
		"bun.lock names the tgz",
		lock.includes(`${name}@${VENDOR_DIR}/${vendor.artifact}`),
	);
	c.check(
		"bun.lock integrity == sha512(tgz)",
		lock.includes(
			`sha512-${createHash("sha512").update(artifact).digest("base64")}`,
		),
	);

	// 3. installed package <-> its own distribution manifest
	const pkg = readJson(join(installed, "package.json"));
	const dist = readJson(join(installed, "distribution-manifest.json"));
	c.check("installed version == vendor", pkg.version === vendor.version);
	c.check(
		"manifest version == package.json",
		dist.package.version === pkg.version,
	);
	const files = dist.distribution.files as Record<string, string>;
	for (const [path, expected] of Object.entries(files)) {
		const file = join(installed, path);
		const ok = existsSync(file);
		c.check(`file present ${path}`, ok);
		if (ok)
			c.check(`file sha256 ${path}`, sha256(readFileSync(file)) === expected);
	}
	const present = walkFiles(installed)
		.map((file) => posixRelative(installed, file))
		.filter(
			(file) => file !== "distribution-manifest.json" && file !== ".bun-tag",
		);
	const unlisted = present.filter((file) => !(file in files));
	c.check(
		"no unlisted file in the installed copy",
		unlisted.length === 0,
		unlisted.join(","),
	);
	c.check(
		"distribution.digest recomputes",
		digestOfFiles(files) === dist.distribution.digest,
	);
	c.check(
		"vendor.distributionDigest == manifest",
		vendor.distributionDigest === dist.distribution.digest,
	);
	c.check(
		"vendor.sourceDigest == manifest",
		vendor.sourceDigest === dist.source.digest,
	);
	c.check(
		"vendor.sourceGitCommit == manifest",
		vendor.sourceGitCommit === dist.source.gitCommit,
	);
	c.check(
		"vendor.sourceDirty == manifest",
		vendor.sourceDirty === dist.source.dirty,
	);
	c.check(
		"vendor.contractVersion == manifest",
		vendor.contractVersion === dist.contract.version,
	);
	c.check(
		"vendor.instructionSetDigest == manifest",
		vendor.instructionSetDigest === dist.instructions.setDigest,
	);
	c.check(
		"vendor.dbSchemaVersion == manifest",
		vendor.dbSchemaVersion === dist.schema.migrationCount,
	);
	c.check(
		"vendor.migrations == manifest",
		JSON.stringify(vendor.migrations) ===
			JSON.stringify(dist.schema.migrations),
	);
	c.check(
		"vendor.lightrag == manifest",
		JSON.stringify(vendor.lightrag) === JSON.stringify(dist.lightrag),
	);
	(dist.schema.migrations as Json[]).forEach((m, index) => {
		c.check(
			`migration id ${index + 1}`,
			m.ordinal === index + 1 &&
				m.id === migrationId(index + 1) &&
				/^[0-9a-f]{64}$/.test(m.sha256),
		);
	});
	c.check(
		"manifest exports/bin/dependencies == package.json",
		JSON.stringify(dist.exports) === JSON.stringify(Object.keys(pkg.exports)) &&
			JSON.stringify(dist.bin) ===
				JSON.stringify(Object.fromEntries(Object.entries(pkg.bin).sort())) &&
			JSON.stringify(dist.dependencies) ===
				JSON.stringify(
					Object.fromEntries(Object.entries(pkg.dependencies).sort()),
				),
	);

	// 4. tarball shape; no lifecycle scripts; no escaping or undeclared imports
	const tar = runSync(["tar", "-tzf", artifactPath], { cwd: tmp });
	const entries = tar.stdout.trim().split("\n").filter(Boolean);
	const tarProblems = checkTarEntries(entries);
	c.check(
		"tarball holds only declared files (no source, tests, examples, p0)",
		tar.exitCode === 0 && tarProblems.length === 0,
		tarProblems.join("; "),
	);
	for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
		c.check(`no ${hook} script`, !(pkg.scripts && hook in pkg.scripts));
	}
	c.check("no trustedDependencies", pkg.trustedDependencies === undefined);
	c.check("sideEffects false", pkg.sideEffects === false);
	c.check("type module", pkg.type === "module");
	const distRoot = join(installed, "dist");
	const modules = walkFiles(distRoot)
		.filter((file) => file.endsWith(".js"))
		.map((path) => ({ path, source: readFileSync(path, "utf8") }));
	const importProblems = checkDistImports(modules, {
		distRoot,
		declared: new Set(Object.keys(pkg.dependencies ?? {})),
		exists: existsSync,
	});
	c.check(
		`dist imports stay inside dist and are declared (${modules.length} modules)`,
		importProblems.length === 0,
		importProblems.join("; "),
	);
	const targets: string[] = [];
	const collect = (value: unknown) => {
		if (typeof value === "string") targets.push(value);
		else if (value && typeof value === "object")
			Object.values(value).forEach(collect);
	};
	collect(pkg.exports);
	collect(pkg.bin);
	for (const target of targets) {
		c.check(
			`exports/bin target exists ${target}`,
			existsSync(join(installed, target)),
		);
	}
	for (const bin of Object.values(pkg.bin as Record<string, string>)) {
		const file = join(installed, bin);
		c.check(
			`bin is executable with a bun shebang ${bin}`,
			existsSync(file) &&
				(statSync(file).mode & 0o111) !== 0 &&
				readFileSync(file, "utf8").startsWith("#!/usr/bin/env bun\n"),
		);
	}

	// 5. every public import at runtime (consumer process), compared with the manifest
	const entriesSpec = entrySpecifiers(name, pkg.exports);
	writeFileSync(
		join(tmp, "check-exports.mjs"),
		consumerRuntimeSource(name, entriesSpec),
	);
	const runtime = runSync([process.execPath, "check-exports.mjs"], {
		cwd: tmp,
	});
	let seen: Json = null;
	try {
		seen = JSON.parse(runtime.stdout.trim().split("\n").pop() ?? "");
	} catch {
		seen = null;
	}
	c.check(
		"every public import loads in the consumer",
		runtime.exitCode === 0 && seen !== null,
		clip(`${runtime.stdout}${runtime.stderr}`),
	);
	if (seen !== null) {
		const required: Record<string, string[]> = {
			[name]: [
				"CONTRACT_VERSION",
				"PACKAGE_VERSION",
				"INSTRUCTION_SET_DIGEST",
				"instructions",
				"instruction",
			],
			[`${name}/client`]: [
				"createKnowledgeClient",
				"KnowledgeClientError",
				"resolveConnection",
			],
			[`${name}/sqlite`]: ["migrations"],
			[`${name}/cli`]: ["runCli"],
			[`${name}/mcp`]: ["runMcp"],
		};
		for (const [specifier, names] of Object.entries(required)) {
			const keys: string[] = seen.keys[specifier] ?? [];
			const missing = names.filter((key) => !keys.includes(key));
			c.check(
				`${specifier} exports ${names.join(", ")}`,
				missing.length === 0,
				`missing ${missing.join(", ")}`,
			);
		}
		c.check(
			"CONTRACT_VERSION == manifest",
			seen.contractVersion === dist.contract.version,
		);
		c.check(
			"PACKAGE_VERSION == package.json",
			seen.packageVersion === pkg.version,
		);
		c.check(
			"INSTRUCTION_SET_DIGEST == manifest",
			seen.instructionSetDigest === dist.instructions.setDigest,
		);
		c.check(
			"instruction entries == manifest",
			JSON.stringify(
				seen.instructions.map(({ id, version, sha256: hash }: Json) => ({
					id,
					version,
					sha256: hash,
				})),
			) === JSON.stringify(dist.instructions.entries),
		);
		c.check(
			"instruction text hashes to its sha256",
			seen.instructions.every((i: Json) => i.textSha256 === i.sha256),
		);
		c.check(
			"migration checksums == manifest",
			JSON.stringify(seen.migrations) ===
				JSON.stringify(dist.schema.migrations.map((m: Json) => m.sha256)),
		);
		c.check("client parses a status answer", seen.statusTotal === 0);
		c.check(
			"client maps 401 to knowledge_auth_failed",
			seen.clientError === "knowledge_auth_failed",
		);
	}

	// LightRAG provenance: every ported file needs its notice and a source comment (empty in P1).
	for (const file of dist.lightrag.files as Json[]) {
		const ported = join(installed, file.portedTo);
		const notices = join(installed, "THIRD_PARTY_NOTICES.md");
		c.check(
			`lightrag ${file.upstreamPath} is attributed`,
			existsSync(ported) &&
				readFileSync(ported, "utf8").includes(file.upstreamCommit) &&
				existsSync(notices) &&
				readFileSync(notices, "utf8").includes(file.noticeId),
		);
	}

	// 6. types as the consumer sees them (skipLibCheck:false, positive and negative cases)
	writeFileSync(join(tmp, "tsconfig.json"), consumerTsconfig);
	writeFileSync(join(tmp, "check-types.ts"), consumerTypeCheckSource(name));
	const tsc = runSync(
		[join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json"],
		{ cwd: tmp },
	);
	c.check(
		"consumer type check passes (skipLibCheck false; negative cases fail as expected)",
		tsc.exitCode === 0,
		clip(`${tsc.stdout}${tsc.stderr}`),
	);

	// 7. bins
	const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
	for (const [bin, label] of [
		["eumenes-knowledge", "eumenes-knowledge"],
		["eumenes-knowledge-mcp", "eumenes-knowledge-mcp"],
	] as const) {
		const run = Bun.spawnSync(
			[join(tmp, "node_modules/.bin", bin), "--version"],
			{
				cwd: tmp,
				env: cleanEnv,
				stdin: "ignore",
				timeout: 20_000,
			},
		);
		c.check(
			`${bin} --version exits 0 and prints ${pkg.version}`,
			run.exitCode === 0 &&
				run.stdout.toString().trim() === `${label} ${pkg.version}`,
			clip(`${run.stdout}${run.stderr}`),
		);
	}

	// 8. import side effects on the installed copy
	const probe = runSync(
		[process.execPath, join(root, "scripts/import-probe.ts"), installed],
		{ cwd: root },
	);
	c.check(
		"import-probe passes on the installed copy",
		probe.exitCode === 0,
		clip(probe.stdout),
	);
}

if (import.meta.main) {
	const result = verifyPackage(repoRoot);
	for (const failure of result.failures) console.log(`FAIL  ${failure}`);
	console.log(
		`${result.failures.length === 0 ? "PASS" : "FAIL"}  verify-package: ${result.count} checks, ${result.failures.length} failure(s)`,
	);
	process.exit(result.failures.length === 0 ? 0 : 1);
}
