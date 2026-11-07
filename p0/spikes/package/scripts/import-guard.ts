// Preloaded into a child bun process (`bun --preload`). Replaces every API that
// would open a connection, listen, spawn, schedule or write with an inert stub
// that RECORDS the attempt (the real call never happens). Reads are untouched.
// The report goes to $GUARD_REPORT as JSON on exit.
import fs from "node:fs";

const saved = { writeFileSync: fs.writeFileSync.bind(fs) };
import childProcess from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";

const violations: string[] = [];
const stub = (target: object, key: string, label: string) => {
	if (typeof (target as Record<string, unknown>)[key] !== "function") return;
	(target as Record<string, unknown>)[key] = () => {
		violations.push(label);
		return undefined;
	};
};

// Network and listeners.
for (const key of ["fetch", "WebSocket", "XMLHttpRequest"])
	stub(globalThis, key, key);
for (const key of ["serve", "listen", "connect", "udpSocket"])
	stub(Bun, key, `Bun.${key}`);
for (const key of ["createServer", "connect", "createConnection"])
	stub(net, key, `node:net.${key}`);
for (const key of ["request", "get", "createServer"]) {
	stub(http, key, `node:http.${key}`);
	stub(https, key, `node:https.${key}`);
}
for (const key of ["lookup", "resolve"]) stub(dns, key, `node:dns.${key}`);

// Timers.
for (const key of ["setInterval", "setTimeout", "setImmediate"])
	stub(globalThis, key, key);

// Processes.
for (const key of [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"fork",
]) {
	stub(childProcess, key, `node:child_process.${key}`);
}
stub(Bun, "spawn", "Bun.spawn");
stub(Bun, "spawnSync", "Bun.spawnSync");

// File writes / creation / deletion.
for (const key of [
	"writeFileSync",
	"appendFileSync",
	"mkdirSync",
	"rmSync",
	"unlinkSync",
	"renameSync",
	"copyFileSync",
	"createWriteStream",
	"writeFile",
	"mkdir",
	"rm",
])
	stub(fs, key, `node:fs.${key}`);
stub(Bun, "write", "Bun.write");

// Database: Bun 1.4.4 refuses to replace the builtin `bun:sqlite` (plugin
// `module()` throws, `onResolve` is not called), so a constructor cannot be
// trapped. Any actual use is recorded by patching the prototype; the import
// graph check in import-probe.ts bans a `bun:sqlite` import in the entries, and a
// file-backed database would also show up as a new file in the empty cwd.
const { Database } = await import("bun:sqlite");
for (const key of [
	"query",
	"prepare",
	"exec",
	"run",
	"transaction",
	"serialize",
]) {
	stub(Database.prototype, key, `bun:sqlite.Database#${key}`);
}

(globalThis as Record<string, unknown>).__importGuard = true;
const report = process.env.GUARD_REPORT;
process.on("exit", () => {
	// writeFileSync was stubbed for the package under test; use the saved original.
	if (report) saved.writeFileSync(report, JSON.stringify({ violations }));
});
