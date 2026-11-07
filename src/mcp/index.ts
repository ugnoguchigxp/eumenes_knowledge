import { PACKAGE_VERSION } from "../version.js";

/** Where the entry writes. Injected so tests and hosts do not touch the real streams. */
export type McpIo = {
	stdout(text: string): void;
	stderr(text: string): void;
};

/** Exit code for "this version cannot do that" (the stub's answer for everything but --version). */
export const MCP_NOT_IMPLEMENTED_EXIT_CODE = 3;

const defaultIo: McpIo = {
	stdout: (text) => void process.stdout.write(text),
	stderr: (text) => void process.stderr.write(text),
};

/**
 * MCP entry (stub until P4). Importing this module starts nothing; only `bin.ts` calls it.
 * The MCP SDK, when it arrives, is imported here and nowhere else, and stdout stays reserved
 * for the protocol. Returns the exit code and never calls `process.exit`.
 */
export async function runMcp(
	argv: readonly string[],
	io: McpIo = defaultIo,
): Promise<number> {
	if (argv.includes("--version")) {
		io.stdout(`eumenes-knowledge-mcp ${PACKAGE_VERSION}\n`);
		return 0;
	}
	io.stderr(
		"eumenes-knowledge-mcp: この版では未実装です (not implemented in this version)\n",
	);
	return MCP_NOT_IMPLEMENTED_EXIT_CODE;
}
