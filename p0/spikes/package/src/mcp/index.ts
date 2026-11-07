import { PACKAGE_VERSION } from "../version.js";

/**
 * MCP entry (stub). The real MCP SDK import belongs here (and only here), so
 * importing core/sqlite/client never loads it.
 */
export async function runMcp(argv: readonly string[]): Promise<number> {
	if (argv.includes("--version")) {
		console.log(`eumenes-knowledge-mcp ${PACKAGE_VERSION}`);
		return 0;
	}
	console.log("eumenes-knowledge mcp stub: ok");
	return 0;
}
