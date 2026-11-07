// 検証用 store。Eumenes の SqliteStore と同じ意味論（単一 writer・owner-only 権限・
// migration の checksum・直列化した同期 transaction・readonly の読み取り接続）だけを写す。
// Eumenes のコードは import しない。再現しないもの: pre-migration backup、migration の
// after 依存、reserved slot、maintenance。
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// OS のファイル lock（同じ DB を開く writer を 1 つに保つ）
// ---------------------------------------------------------------------------

const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;
let flockFn: ((fd: number, op: number) => number) | undefined;
function flock(fd: number, op: number): number {
	if (!flockFn) {
		const library =
			process.platform === "darwin"
				? "/usr/lib/libSystem.B.dylib"
				: process.platform === "linux"
					? "libc.so.6"
					: null;
		if (!library) throw new Error("flock_unsupported_platform");
		flockFn = dlopen(library, {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		}).symbols.flock;
	}
	return flockFn(fd, op);
}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export class WriterOwnedError extends Error {
	constructor() {
		super("database_writer_owned");
	}
}
export class WriterBusyError extends Error {
	constructor() {
		super("database_writer_queue_full");
	}
}
export const WRITER_PENDING_LIMIT = 64;

/** package の migration の ID 接頭辞。Eumenes の `<owner>/0001` と同じ形。 */
export const PACKAGE_MIGRATION_OWNER = "knowledge-package";
export const DATABASE_FILE_NAME = "knowledge.db";

type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

export type HostMigration = { id: string; sql: string };
export type ExampleStoreOptions = {
	/** package の SQL。順に `knowledge-package/0001` ... の ID を付ける。 */
	packageMigrations: readonly string[];
	/** ホストが持つ SQL。package の後に適用する。 */
	hostMigrations: readonly HostMigration[];
};

export interface ExampleStore {
	/** DB ファイルの絶対パス。 */
	readonly path: string;
	read<T>(operation: (db: Database) => T): T;
	readSnapshot<T>(operation: (db: Database) => SyncResult<T>): T;
	write<T>(operation: (db: Database) => SyncResult<T>): Promise<T>;
	/** 変更を伴う commit の後に呼ばれる。戻り値は解除関数。 */
	onCommit(listener: () => void): () => void;
	close(): Promise<void>;
}

function isThenable(value: unknown): boolean {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof (value as { then: unknown }).then === "function"
	);
}
const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

export function packageMigrationId(index: number): string {
	return `${PACKAGE_MIGRATION_OWNER}/${String(index + 1).padStart(4, "0")}`;
}

function collectMigrations(
	options: ExampleStoreOptions,
): { id: string; sql: string }[] {
	const all = [
		...options.packageMigrations.map((sql, i) => ({
			id: packageMigrationId(i),
			sql,
		})),
		...options.hostMigrations.map((m) => {
			if (m.id.length === 0 || m.id.startsWith(`${PACKAGE_MIGRATION_OWNER}/`))
				throw new Error("migration_invalid_id");
			return { id: m.id, sql: m.sql };
		}),
	];
	if (new Set(all.map((m) => m.id)).size !== all.length)
		throw new Error("migration_duplicate_id");
	return all;
}

// ---------------------------------------------------------------------------
// 開く
// ---------------------------------------------------------------------------

/**
 * `dir` の中に `knowledge.db` を作って開く。`:memory:` は拒否する。同じファイルを二重に開くと
 * `database_writer_owned`。
 */
export function openExampleStore(
	dir: string,
	options: ExampleStoreOptions,
): ExampleStore {
	if (dir === ":memory:" || dir.length === 0)
		throw new Error("persistent_database_path_required");
	const migrations = collectMigrations(options);
	const requested = resolve(dir);
	mkdirSync(requested, { recursive: true, mode: 0o700 });
	const canonical = join(realpathSync(requested), DATABASE_FILE_NAME);
	const lockFd = openSync(
		`${canonical}.owner.lock`,
		constants.O_CREAT | constants.O_RDWR,
		0o600,
	);
	fchmodSync(lockFd, 0o600);
	if (flock(lockFd, LOCK_EX_NB) !== 0) {
		closeSync(lockFd);
		throw new WriterOwnedError();
	}
	let writer: Database | undefined;
	let reader: Database | undefined;
	try {
		const w0 = (writer = new Database(canonical, { create: true }));
		w0.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		w0.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations_v2 (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		const applied = new Map(
			(
				w0.query("SELECT id, checksum FROM schema_migrations_v2").all() as {
					id: string;
					checksum: string;
				}[]
			).map((row) => [row.id, row.checksum]),
		);
		const known = new Set(migrations.map((m) => m.id));
		for (const id of applied.keys())
			if (!known.has(id)) throw new Error(`migration_unknown_applied:${id}`);
		for (const m of migrations) {
			const checksum = applied.get(m.id);
			if (checksum !== undefined && checksum !== sha256(m.sql))
				throw new Error(`migration_checksum_mismatch:${m.id}`);
		}
		for (const m of migrations) {
			if (applied.has(m.id)) continue;
			w0.transaction(() => {
				w0.exec(m.sql);
				w0.query(
					"INSERT INTO schema_migrations_v2 (id, checksum, applied_at) VALUES (?, ?, ?)",
				).run(m.id, sha256(m.sql), new Date().toISOString());
			})();
		}
		for (const file of [canonical, `${canonical}-wal`, `${canonical}-shm`])
			if (existsSync(file)) chmodSync(file, 0o600);
		reader = new Database(canonical, { readonly: true });
		reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
	} catch (error) {
		reader?.close();
		writer?.close();
		flock(lockFd, LOCK_UN);
		closeSync(lockFd);
		throw error;
	}
	const w = writer;
	const r = reader;
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;
	let closing = false;
	const listeners = new Set<() => void>();
	const changes = w.query<{ count: number }, []>(
		"SELECT total_changes() AS count",
	);
	function serialized<T>(operation: () => T): Promise<T> {
		if (closing) return Promise.reject(new Error("database_closing"));
		if (pending >= WRITER_PENDING_LIMIT)
			return Promise.reject(new WriterBusyError());
		pending++;
		const task = tail.then(operation);
		tail = task
			.catch(() => {})
			.finally(() => {
				pending--;
			});
		return task;
	}
	return {
		path: canonical,
		read: (operation) => {
			if (closing) throw new Error("database_closing");
			return operation(r);
		},
		readSnapshot: (operation) => {
			if (closing) throw new Error("database_closing");
			return r.transaction(() => {
				const value = operation(r);
				if (isThenable(value)) {
					void Promise.resolve(value).catch(() => {});
					throw new Error("async_snapshot_callback");
				}
				return value;
			})();
		},
		write: (operation) =>
			serialized(() => {
				const before = changes.get()?.count;
				const result = w.transaction(() => {
					const value = operation(w);
					if (isThenable(value)) {
						void Promise.resolve(value).catch(() => {});
						throw new Error("async_write_callback");
					}
					return value;
				})();
				if (changes.get()?.count !== before)
					for (const listener of listeners) {
						try {
							listener();
						} catch {
							// 通知の失敗で commit 済みの書込みを失敗にしない。
						}
					}
				return result;
			}),
		onCommit(listener) {
			if (closing) throw new Error("database_closing");
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async close() {
			if (closing) return;
			closing = true;
			await tail;
			listeners.clear();
			r.close();
			w.close();
			flock(lockFd, LOCK_UN);
			closeSync(lockFd);
		},
	};
}

// ---------------------------------------------------------------------------
// 一時ディレクトリ
// ---------------------------------------------------------------------------

export const EXAMPLE_TEMP_PREFIX = "eumenes-knowledge-example-";

/** `os.tmpdir()` 配下に固定接頭辞の一時ディレクトリを作り、実パスを返す。 */
export function createExampleTempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), EXAMPLE_TEMP_PREFIX)));
}

/**
 * `createExampleTempDir` が作った形のディレクトリだけを消す。絶対パスで、`os.tmpdir()` の直下で、
 * 固定接頭辞を持ち、symlink でないことを確かめてから消す。無ければ false、消せば true。
 * 条件に合わないパスは例外（何も消さない）。
 */
export function removeExampleTempDir(dir: string): boolean {
	if (!isAbsolute(dir)) throw new Error("temp_dir_not_absolute");
	const target = resolve(dir);
	if (!basename(target).startsWith(EXAMPLE_TEMP_PREFIX))
		throw new Error("temp_dir_prefix_mismatch");
	if (!existsSync(dirname(target))) return false;
	if (realpathSync(dirname(target)) !== realpathSync(tmpdir()))
		throw new Error("temp_dir_outside_tmpdir");
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(target);
	} catch {
		return false;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new Error("temp_dir_not_directory");
	rmSync(target, { recursive: true, force: true });
	return true;
}
