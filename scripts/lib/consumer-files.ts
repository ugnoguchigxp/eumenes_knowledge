// Source text of the files verify-package.ts writes into the clean consumer. They are strings,
// not real files, because they import the package by name, which only resolves in the consumer.

/** Public entries: the package root and every subpath of `exports` that has a JS target. */
export type EntrySpec = { specifier: string; types: boolean };

export function entrySpecifiers(
	packageName: string,
	exportsMap: Record<string, unknown>,
): EntrySpec[] {
	return Object.entries(exportsMap).map(([key, value]) => ({
		specifier: key === "." ? packageName : `${packageName}/${key.slice(2)}`,
		types: typeof value === "object" && value !== null && "types" in value,
	}));
}

export const consumerTsconfig = `{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"lib": ["ES2022", "DOM"],
		"types": [],
		"strict": true,
		"noEmit": true,
		"skipLibCheck": false,
		"noUncheckedIndexedAccess": true,
		"verbatimModuleSyntax": true,
		"resolveJsonModule": true
	},
	"include": ["check-types.ts"]
}
`;

/** Type-level checks, run by tsc with skipLibCheck:false. Includes negative cases. */
export function consumerTypeCheckSource(packageName: string): string {
	const p = packageName;
	return `import {
	CONTRACT_VERSION,
	PACKAGE_VERSION,
	instruction,
	instructions,
	type Instruction,
	type KnowledgeStatus,
} from "${p}";
import {
	createKnowledgeClient,
	KnowledgeClientError,
	resolveConnection,
	type KnowledgeClient,
	type KnowledgeClientErrorCode,
} from "${p}/client";
import { migrations } from "${p}/sqlite";
import { runCli } from "${p}/cli";
import { runMcp } from "${p}/mcp";

export const contractVersion: number = CONTRACT_VERSION;
export const packageVersion: string = PACKAGE_VERSION;
export const all: readonly Instruction[] = instructions;
export const lookup: (id: string, version?: number) => Instruction = instruction;
export const sql: readonly string[] = migrations;
export const cli: Promise<number> = runCli(["--version"]);
export const mcp: Promise<number> = runMcp(["--version"]);

const client: KnowledgeClient = createKnowledgeClient({
	baseUrl: "http://127.0.0.1:1",
	token: "t".repeat(24),
	fetch: async () => new Response("{}"),
	timeoutMs: 1000,
	startingWaitMs: 0,
	sleep: async () => {},
});
export const status: Promise<KnowledgeStatus> = client.status();
export const code: KnowledgeClientErrorCode = new KnowledgeClientError("knowledge_timeout").code;
export const connection = resolveConnection({ env: {}, readTokenFile: () => "" });

// Negative cases: each line must be a type error, or the check fails.
// @ts-expect-error baseUrl must be a string
createKnowledgeClient({ baseUrl: 1, token: "x" });
// @ts-expect-error token is required
createKnowledgeClient({ baseUrl: "http://127.0.0.1:1" });
// @ts-expect-error not a known error code
export const badCode: KnowledgeClientErrorCode = "knowledge_nope";
// @ts-expect-error unpublished deep import
void import("${p}/dist/core/index.js");
// @ts-expect-error unpublished subpath
void import("${p}/core");
`;
}

/**
 * Runs in the consumer under bun and prints one JSON document describing what the installed
 * package really exports, so the verifier can compare it with the manifest.
 */
export function consumerRuntimeSource(
	packageName: string,
	entries: readonly EntrySpec[],
): string {
	const imports = entries
		.map(
			(entry, index) =>
				`const m${index} = await import(${JSON.stringify(entry.specifier)}${entry.specifier.endsWith(".json") ? ', { with: { type: "json" } }' : ""});`,
		)
		.join("\n");
	const keys = entries
		.map(
			(entry, index) =>
				`${JSON.stringify(entry.specifier)}: Object.keys(m${index}).sort(),`,
		)
		.join("\n\t");
	return `import { createHash } from "node:crypto";
${imports}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = await import(${JSON.stringify(packageName)});
const sqlite = await import(${JSON.stringify(`${packageName}/sqlite`)});
const client = await import(${JSON.stringify(`${packageName}/client`)});
const fakeStatus = {
	contractVersion: root.CONTRACT_VERSION,
	documents: { total: 0, current: 0, unverified: 0, stale: 0, unavailable: 0, excluded: 0, removed: 0 },
	lastScanAt: null,
	lastCompleteScanAt: null,
	complete: false,
	partialReasons: ["no_complete_scan"],
};
const api = client.createKnowledgeClient({
	baseUrl: "http://127.0.0.1:1",
	token: "t".repeat(24),
	fetch: async () => Response.json(fakeStatus),
});
const status = await api.status();
let clientError = null;
try {
	await client.createKnowledgeClient({
		baseUrl: "http://127.0.0.1:1",
		token: "t".repeat(24),
		fetch: async () => Response.json({ error: "unauthorized" }, { status: 401 }),
	}).status();
} catch (error) {
	clientError = error instanceof client.KnowledgeClientError ? error.code : String(error);
}
console.log(JSON.stringify({
	keys: {
	${keys}
	},
	contractVersion: root.CONTRACT_VERSION,
	packageVersion: root.PACKAGE_VERSION,
	instructionSetDigest: root.INSTRUCTION_SET_DIGEST,
	instructions: (root.instructions ?? []).map((i) => ({
		id: i.id,
		version: i.version,
		sha256: i.sha256,
		textSha256: sha256(i.text),
	})),
	migrations: (sqlite.migrations ?? []).map((sql) => (typeof sql === "string" ? sha256(sql) : null)),
	statusTotal: status.documents.total,
	clientError,
}));
`;
}
