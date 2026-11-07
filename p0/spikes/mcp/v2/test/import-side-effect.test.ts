import { expect, test } from "bun:test";
import { root } from "./helpers";

// server モジュールを import するだけの子プロセス。stdin は開いたままにする。
// 待受や stdin 読取りが始まれば自力では終了しない。
test("server モジュールの import は副作用なしで即終了する", async () => {
	const proc = Bun.spawn(
		["bun", "-e", `const m = await import("./src/server.ts"); console.error("exports:" + Object.keys(m).sort().join(","));`],
		{ cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const timer = setTimeout(() => proc.kill(), 8000);
		const code = await proc.exited;
		clearTimeout(timer);
		expect(code).toBe(0);
		expect(await new Response(proc.stdout).text()).toBe("");
		expect(await new Response(proc.stderr).text()).toContain("exports:");
	} finally {
		proc.kill();
	}
});
