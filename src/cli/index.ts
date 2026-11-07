import { PACKAGE_VERSION } from "../version.js";

/** Where the entry writes. Injected so tests and hosts do not touch the real streams. */
export type CliIo = {
	stdout(text: string): void;
	stderr(text: string): void;
};

/** Exit code for "this version cannot do that" (the stub's answer for everything but --version). */
export const CLI_NOT_IMPLEMENTED_EXIT_CODE = 2;

const defaultIo: CliIo = {
	stdout: (text) => void process.stdout.write(text),
	stderr: (text) => void process.stderr.write(text),
};

/**
 * CLI entry (stub until P4). Importing this module starts nothing; only `bin.ts` calls it.
 * Returns the exit code and never calls `process.exit`.
 */
export async function runCli(
	argv: readonly string[],
	io: CliIo = defaultIo,
): Promise<number> {
	if (argv.includes("--version")) {
		io.stdout(`eumenes-knowledge ${PACKAGE_VERSION}\n`);
		return 0;
	}
	io.stderr(
		"eumenes-knowledge: この版では未実装です (not implemented in this version)\n",
	);
	return CLI_NOT_IMPLEMENTED_EXIT_CODE;
}
