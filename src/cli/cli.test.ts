import { expect, test } from "bun:test";
import { PACKAGE_VERSION } from "../version.js";
import { CLI_NOT_IMPLEMENTED_EXIT_CODE, runCli } from "./index.js";

const capture = () => {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: {
			stdout: (t: string) => void out.push(t),
			stderr: (t: string) => void err.push(t),
		},
	};
};

test("--version prints the package version on stdout and exits 0", async () => {
	const { out, err, io } = capture();
	expect(await runCli(["--version"], io)).toBe(0);
	expect(out.join("")).toBe(`eumenes-knowledge ${PACKAGE_VERSION}\n`);
	expect(err).toEqual([]);
});

test("anything else is 'not implemented in this version': stderr only, exit 2", async () => {
	for (const argv of [[], ["status"], ["search", "x"]]) {
		const { out, err, io } = capture();
		expect(await runCli(argv, io)).toBe(2);
		expect(CLI_NOT_IMPLEMENTED_EXIT_CODE).toBe(2);
		expect(out).toEqual([]);
		expect(err.join("")).toContain("未実装");
	}
});

test("importing the entry starts nothing (only bin.ts runs it)", async () => {
	const before = process.exitCode;
	await import("./index.js");
	expect(process.exitCode).toBe(before);
});
