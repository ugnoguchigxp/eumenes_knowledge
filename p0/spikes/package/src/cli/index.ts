import { PACKAGE_VERSION } from "../version.js";

/** CLI entry (stub). Returns the exit code; never calls process.exit itself. */
export async function runCli(argv: readonly string[]): Promise<number> {
	if (argv.includes("--version")) {
		console.log(`eumenes-knowledge ${PACKAGE_VERSION}`);
		return 0;
	}
	console.log("eumenes-knowledge cli stub: ok");
	return 0;
}
