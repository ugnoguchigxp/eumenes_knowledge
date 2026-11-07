// build = generate contexts (check) -> tsc (TypeScript 7) -> shape checks.
// Output only goes to dist/. Mocks/examples/tests are not in tsconfig.build.json.
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const run = (cmd: string[]) => {
	const result = Bun.spawnSync(cmd, {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (result.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
};

run(["bun", "scripts/generate-contexts.ts", "--check"]);
rmSync(join(root, "dist"), { recursive: true, force: true });
run([join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.build.json"]);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { PACKAGE_VERSION } = await import(join(root, "dist/version.js"));
if (PACKAGE_VERSION !== pkg.version) {
	throw new Error(
		`src/version.ts (${PACKAGE_VERSION}) != package.json (${pkg.version})`,
	);
}
for (const bin of Object.values(pkg.bin as Record<string, string>)) {
	chmodSync(join(root, bin), 0o755);
}
console.log("build: ok");
