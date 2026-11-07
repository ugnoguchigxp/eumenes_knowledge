import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { alive, root, waitDead } from "./helpers";

test("stdio 入口: tools/list・tools/call のあと子プロセスが残らない", async () => {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["src/stdio-main.ts"],
		cwd: root,
		env: { PATH: process.env.PATH ?? "" }, // 秘密を子へ渡さない
		stderr: "pipe",
	});
	const client = new Client({ name: "spike-client", version: "0.0.0" });
	let pid: number | null = null;
	try {
		await client.connect(transport);
		pid = transport.pid;
		expect(pid).toBeGreaterThan(0);
		expect(alive(pid!)).toBe(true);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("search");
		const r: any = await client.callTool({ name: "search", arguments: { query: "x", limit: 2 } });
		expect(r.structuredContent.hits).toHaveLength(2);
		const bad: any = await client.callTool({ name: "search", arguments: { query: "boom" } });
		expect(bad.isError).toBe(true);
	} finally {
		const t0 = performance.now();
		await client.close();
		console.log("v1 stdio close ms:", Math.round(performance.now() - t0));
		if (pid) {
			const dead = await waitDead(pid);
			if (!dead) process.kill(pid, "SIGKILL"); // 自分で起動した子だけ
			expect(dead).toBe(true);
		}
	}
});

test("stdio 入口: stdin を閉じると server が自発的に終了する", async () => {
	const proc = Bun.spawn(["bun", "src/stdio-main.ts"], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await Bun.sleep(300);
		expect(proc.killed).toBe(false);
		proc.stdin.end();
		const timer = setTimeout(() => proc.kill(), 5000);
		const code = await proc.exited;
		clearTimeout(timer);
		expect(proc.signalCode).toBeNull();
		expect(code).toBe(0);
	} finally {
		proc.kill();
	}
});
