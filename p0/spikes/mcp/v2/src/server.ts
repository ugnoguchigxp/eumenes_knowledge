// import しても待受・stdio 読取り・副作用を起こさない。生成は createServer() を呼んだ時だけ。
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const searchInput = z.strictObject({
	query: z.string().min(1).max(200),
	limit: z.number().int().min(1).max(50).optional(),
});

/** 公開 API client の代役。実装では Eumenes の認証付き API を呼ぶ共通 client になる。 */
export type SearchApi = (
	input: z.output<typeof searchInput>,
) => Promise<{ hits: { documentId: string; score: number }[] }>;

/** tool エラーに出してよい安全なコードだけを通す。それ以外は固定コードへ丸める。 */
export function safeCode(error: unknown): string {
	const m = error instanceof Error ? error.message : "";
	return /^(knowledge_)[a-z_]+$/.test(m) ? m : "knowledge_operation_failed";
}

export function createServer(api: SearchApi): McpServer {
	const server = new McpServer(
		{ name: "spike-knowledge", version: "0.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.registerTool(
		"search",
		{
			description: "dummy search",
			inputSchema: searchInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => {
			try {
				const result = await api(input);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: safeCode(error) }],
				};
			}
		},
	);
	// 丸めを通さない比較用 tool（SDK 既定の例外処理の観察用）。製品には入れない。
	server.registerTool(
		"raw_throw",
		{ description: "observe SDK default error handling", inputSchema: z.strictObject({}) },
		async () => {
			throw new Error("secret-token-abc123 leaked");
		},
	);
	return server;
}

export const dummyApi: SearchApi = async ({ query, limit }) => {
	if (query === "boom") throw new Error("secret-token-abc123 upstream detail");
	if (query === "down") throw new Error("knowledge_unavailable");
	return {
		hits: Array.from({ length: limit ?? 3 }, (_, i) => ({
			documentId: `doc-${i}`,
			score: 1 / (i + 1),
		})),
	};
};
