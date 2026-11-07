// spike: examples ホスト用「検証用 writer」。Eumenes の SqliteStore と同じ"意味論"を再現する最小実装。
// Eumenes のコードは import していない（api/infrastructure/sqlite/index.ts を読んで意味論だけを写した）。
// 再現しない物: pre-migration backup、migration の after 依存、reserved slot、maintenance、権限 chmod の警告。
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, mkdirSync, openSync, realpathSync, chmodSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;
let flockFn: ((fd: number, op: number) => number) | undefined;
function flock(fd: number, op: number): number {
	if (!flockFn) {
		const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;
		if (!path) throw new Error("flock_unsupported_platform");
		flockFn = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
	}
	return flockFn(fd, op);
}

export class WriterOwnedError extends Error { constructor() { super("database_writer_owned"); } }
export class WriterBusyError extends Error { constructor() { super("database_writer_queue_full"); } }
export const WRITER_PENDING_LIMIT = 64;

type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;
export interface Migration { id: string; sql: string }
export interface VerificationStore {
	read<T>(operation: (db: Database) => T): T;
	readSnapshot<T>(operation: (db: Database) => SyncResult<T>): T;
	write<T>(operation: (db: Database) => SyncResult<T>): Promise<T>;
	onCommit(listener: () => void): () => void;
	close(): Promise<void>;
}

function isThenable(value: unknown): boolean {
	return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof (value as { then: unknown }).then === "function";
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function openVerificationStore(filename: string, migrations: readonly Migration[]): VerificationStore {
	if (filename === ":memory:") throw new Error("persistent_database_path_required");
	const requested = resolve(filename);
	mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
	const canonical = join(realpathSync(dirname(requested)), basename(requested));
	const lockFd = openSync(`${canonical}.owner.lock`, constants.O_CREAT | constants.O_RDWR, 0o600);
	fchmodSync(lockFd, 0o600);
	if (flock(lockFd, LOCK_EX_NB) !== 0) { closeSync(lockFd); throw new WriterOwnedError(); }
	let writer: Database | undefined, reader: Database | undefined;
	try {
		const w0 = (writer = new Database(canonical, { create: true }));
		w0.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
		w0.exec("CREATE TABLE IF NOT EXISTS schema_migrations_v2 (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
		const applied = new Map((w0.query("SELECT id, checksum FROM schema_migrations_v2").all() as { id: string; checksum: string }[]).map((x) => [x.id, x.checksum]));
		const known = new Set(migrations.map((m) => m.id));
		if (known.size !== migrations.length) throw new Error("migration_duplicate_id");
		for (const id of applied.keys()) if (!known.has(id)) throw new Error(`migration_unknown_applied:${id}`);
		for (const m of migrations) { const c = applied.get(m.id); if (c !== undefined && c !== sha256(m.sql)) throw new Error(`migration_checksum_mismatch:${m.id}`); }
		for (const m of migrations) {
			if (applied.has(m.id)) continue;
			w0.transaction(() => {
				w0.exec(m.sql);
				w0.query("INSERT INTO schema_migrations_v2 (id, checksum, applied_at) VALUES (?, ?, ?)").run(m.id, sha256(m.sql), new Date().toISOString());
			})();
		}
		for (const f of [canonical, `${canonical}-wal`, `${canonical}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
		reader = new Database(canonical, { readonly: true });
		reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
	} catch (error) {
		reader?.close(); writer?.close(); flock(lockFd, LOCK_UN); closeSync(lockFd);
		throw error;
	}
	const w = writer, r = reader;
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0, closing = false;
	const listeners = new Set<() => void>();
	const changes = w.query<{ count: number }, []>("SELECT total_changes() AS count");
	function serialized<T>(operation: () => T): Promise<T> {
		if (closing) return Promise.reject(new Error("database_closing"));
		if (pending >= WRITER_PENDING_LIMIT) return Promise.reject(new WriterBusyError());
		pending++;
		const task = tail.then(operation);
		tail = task.catch(() => {}).finally(() => { pending--; });
		return task;
	}
	return {
		read: (operation) => { if (closing) throw new Error("database_closing"); return operation(r); },
		readSnapshot: (operation) => {
			if (closing) throw new Error("database_closing");
			return r.transaction(() => {
				const value = operation(r);
				if (isThenable(value)) { void Promise.resolve(value).catch(() => {}); throw new Error("async_snapshot_callback"); }
				return value;
			})();
		},
		write: (operation) =>
			serialized(() => {
				const before = changes.get()?.count;
				const result = w.transaction(() => {
					const value = operation(w);
					if (isThenable(value)) { void Promise.resolve(value).catch(() => {}); throw new Error("async_write_callback"); }
					return value;
				})();
				if (changes.get()?.count !== before) for (const l of listeners) { try { l(); } catch { /* 通知失敗で commit 済みの書込みを失敗にしない */ } }
				return result;
			}),
		onCommit(listener) {
			if (closing) throw new Error("database_closing");
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		async close() {
			if (closing) return;
			closing = true;
			await tail;
			listeners.clear();
			r.close(); w.close();
			flock(lockFd, LOCK_UN); closeSync(lockFd);
		},
	};
}
