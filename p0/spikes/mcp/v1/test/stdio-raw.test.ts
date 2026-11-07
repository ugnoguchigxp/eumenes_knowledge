import { expect, test } from "bun:test";
import { root } from "./helpers";

// 既存の coding agent 等が使う旧 era の initialize（protocolVersion を指定）を生 JSON-RPC で送る。
async function exchange(protocolVersion: string) {
	const proc = Bun.spawn(["bun", "src/stdio-main.ts"], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + "\n");
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
		});
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "x", limit: 1 } } });
		await proc.stdin.flush();
		const lines: any[] = [];
		const reader = proc.stdout.getReader();
		const dec = new TextDecoder();
		let buf = "";
		const deadline = Date.now() + 5000;
		while (lines.length < 3 && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value);
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line.trim()) lines.push(JSON.parse(line)); // stdout に JSON-RPC 以外が出ていれば throw
			}
		}
		return lines;
	} finally {
		proc.stdin.end();
		proc.kill();
		await proc.exited;
	}
}

for (const v of ["2024-11-05", "2025-06-18", "2025-11-25"]) {
	test(`旧 era の生 initialize (${v}) に応答する`, async () => {
		const lines = await exchange(v);
		console.log("v1 negotiated", v, "=>", lines[0]?.result?.protocolVersion);
		expect(lines).toHaveLength(3);
		expect(lines[0].id).toBe(1);
		expect(lines[1].result.tools.map((t: any) => t.name)).toContain("search");
		expect(lines[2].result.structuredContent.hits).toHaveLength(1);
	});
}
