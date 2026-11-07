import { expect, test } from "bun:test";
import { PACKAGE_VERSION } from "../version.js";
import { MCP_NOT_IMPLEMENTED_EXIT_CODE, runMcp } from "./index.js";

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
	expect(await runMcp(["--version"], io)).toBe(0);
	expect(out.join("")).toBe(`eumenes-knowledge-mcp ${PACKAGE_VERSION}\n`);
	expect(err).toEqual([]);
});

test("anything else is 'not implemented in this version': stderr only (stdout is protocol-only), exit 3", async () => {
	for (const argv of [[], ["serve"]]) {
		const { out, err, io } = capture();
		expect(await runMcp(argv, io)).toBe(3);
		expect(MCP_NOT_IMPLEMENTED_EXIT_CODE).toBe(3);
		expect(out).toEqual([]);
		expect(err.join("")).toContain("未実装");
	}
});

test("importing the entry starts nothing (only bin.ts runs it)", async () => {
	const before = process.exitCode;
	await import("./index.js");
	expect(process.exitCode).toBe(before);
});
