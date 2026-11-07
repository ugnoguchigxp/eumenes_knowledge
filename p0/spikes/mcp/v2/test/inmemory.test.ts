import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, dummyApi } from "../src/server";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (closers.length) await closers.pop()!();
});

async function connect() {
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const server = createServer(dummyApi);
	const client = new Client({ name: "spike-client", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	closers.push(() => client.close(), () => server.close());
	return client;
}

describe("v2 in-memory", () => {
	test("tools/list は search と JSON Schema を返す", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		const search = tools.find((t) => t.name === "search")!;
		expect(search).toBeDefined();
		const schema = search.inputSchema as any;
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["query"]);
		expect(schema.properties.limit.maximum).toBe(50);
		expect(schema.additionalProperties).toBe(false);
	});

	test("正常な tools/call", async () => {
		const client = await connect();
		const r: any = await client.callTool({ name: "search", arguments: { query: "x", limit: 2 } });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.hits).toHaveLength(2);
	});

	test("schema 違反入力は拒否される（型違反・範囲外・未知キー・必須欠落）", async () => {
		const client = await connect();
		const bad = [
			{ query: 1 },
			{ query: "x", limit: 0 },
			{ query: "x", limit: 1.5 },
			{ query: "x", extra: true },
			{},
		];
		for (const args of bad) {
			const outcome = await client
				.callTool({ name: "search", arguments: args as any })
				.then((r: any) => ({ kind: "result", isError: r.isError, text: JSON.stringify(r.content) }))
				.catch((e: any) => ({ kind: "throw", code: e.code, name: e.name, text: String(e.message) }));
			console.log("v2 invalid", JSON.stringify(args), "=>", JSON.stringify(outcome));
			expect(outcome.kind === "throw" || (outcome as any).isError === true).toBe(true);
		}
	});

	test("server 側例外は安全なコードに丸められ、内部文言を含まない", async () => {
		const client = await connect();
		const r: any = await client.callTool({ name: "search", arguments: { query: "boom" } });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toBe("knowledge_operation_failed");
		expect(JSON.stringify(r)).not.toContain("secret-token");
		const down: any = await client.callTool({ name: "search", arguments: { query: "down" } });
		expect(down.isError).toBe(true);
		expect(down.content[0].text).toBe("knowledge_unavailable");
	});

	test("観察: 丸めない tool の例外は SDK 既定でどう見えるか", async () => {
		const client = await connect();
		const outcome = await client
			.callTool({ name: "raw_throw", arguments: {} })
			.then((r: any) => ({ kind: "result", isError: r.isError, text: JSON.stringify(r.content) }))
			.catch((e: any) => ({ kind: "throw", text: String(e.message) }));
		console.log("v2 raw_throw =>", JSON.stringify(outcome));
		expect(outcome).toBeDefined();
	});
});
