import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createExampleTempDir,
	EXAMPLE_TEMP_PREFIX,
	openExampleStore,
	removeExampleTempDir,
	WRITER_PENDING_LIMIT,
	WriterBusyError,
	WriterOwnedError,
	type ExampleStore,
	type ExampleStoreOptions,
} from "./store.js";

const PACKAGE_SQL = [
	"CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE tags (item_id INTEGER NOT NULL REFERENCES items(id), tag TEXT NOT NULL)",
];
const OPTIONS: ExampleStoreOptions = {
	packageMigrations: PACKAGE_SQL,
	hostMigrations: [
		{ id: "example-host/0001-extra", sql: "CREATE TABLE extra (x INTEGER)" },
	],
};
const dirs: string[] = [];
const stores: ExampleStore[] = [];

function fresh(options: ExampleStoreOptions = OPTIONS) {
	const dir = createExampleTempDir();
	dirs.push(dir);
	const store = openExampleStore(dir, options);
	stores.push(store);
	return { dir, store };
}
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0)) removeExampleTempDir(dir);
});
const count = (store: ExampleStore, table = "items") =>
	store.read(
		(db) =>
			(db.query(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c,
	);

describe("開き方", () => {
	test(":memory: は拒否", () => {
		expect(() => openExampleStore(":memory:", OPTIONS)).toThrow(
			"persistent_database_path_required",
		);
	});

	test("WAL・foreign_keys・owner-only 権限で、package と host の migration を順に適用する", () => {
		const { store } = fresh();
		expect(
			store.read(
				(db) =>
					(db.query("PRAGMA journal_mode").get() as { journal_mode: string })
						.journal_mode,
			),
		).toBe("wal");
		expect(statSync(store.path).mode & 0o777).toBe(0o600);
		expect(statSync(`${store.path}.owner.lock`).mode & 0o777).toBe(0o600);
		const ids = store.read((db) =>
			(
				db
					.query("SELECT id, checksum FROM schema_migrations_v2 ORDER BY rowid")
					.all() as { id: string; checksum: string }[]
			).map((r) => r.id),
		);
		expect(ids).toEqual(["knowledge-package/0001", "example-host/0001-extra"]);
		const checksums = store.read(
			(db) =>
				db.query("SELECT checksum FROM schema_migrations_v2").all() as {
					checksum: string;
				}[],
		);
		for (const row of checksums) expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
	});

	test("host の migration が package の ID 空間を使うことは拒否する", () => {
		const dir = createExampleTempDir();
		dirs.push(dir);
		expect(() =>
			openExampleStore(dir, {
				packageMigrations: [],
				hostMigrations: [{ id: "knowledge-package/0001", sql: "SELECT 1" }],
			}),
		).toThrow("migration_invalid_id");
	});

	test("同じ DB を二重に開くと database_writer_owned。close 後は開ける", async () => {
		const { dir, store } = fresh();
		expect(() => openExampleStore(dir, OPTIONS)).toThrow(WriterOwnedError);
		await store.close();
		const again = openExampleStore(dir, OPTIONS);
		stores.push(again);
		expect(count(again)).toBe(0);
	});

	test("migration は一度だけ適用し、変更された SQL は checksum 不一致、未知の適用済みは拒否する", async () => {
		const { dir, store } = fresh();
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('a')").run();
		});
		await store.close();
		const again = openExampleStore(dir, OPTIONS);
		expect(count(again)).toBe(1);
		await again.close();
		expect(() =>
			openExampleStore(dir, {
				...OPTIONS,
				packageMigrations: [`${PACKAGE_SQL[0]} `],
			}),
		).toThrow("migration_checksum_mismatch:knowledge-package/0001");
		expect(() =>
			openExampleStore(dir, { ...OPTIONS, packageMigrations: [] }),
		).toThrow("migration_unknown_applied:knowledge-package/0001");
		// 失敗した open が lock を残さない
		stores.push(openExampleStore(dir, OPTIONS));
	});

	test("途中で失敗する migration は全体を巻き戻し、lock も解放する", () => {
		const dir = createExampleTempDir();
		dirs.push(dir);
		expect(() =>
			openExampleStore(dir, {
				packageMigrations: [
					"CREATE TABLE a(x); INSERT INTO nonexistent VALUES (1)",
				],
				hostMigrations: [],
			}),
		).toThrow();
		stores.push(
			openExampleStore(dir, {
				packageMigrations: ["CREATE TABLE a(x)"],
				hostMigrations: [],
			}),
		);
	});
});

describe("write の意味論", () => {
	test("commit 済みの結果は read で読める", async () => {
		const { store } = fresh();
		const row = await store.write(
			(db) =>
				db.query("INSERT INTO items(name) VALUES ('x') RETURNING id").get() as {
					id: number;
				},
		);
		expect(row.id).toBe(1);
		expect(
			store.read((db) => db.query("SELECT name FROM items").all()),
		).toEqual([{ name: "x" }]);
	});

	test("callback 内の未 commit の行は readonly 接続から見えない", async () => {
		const { store } = fresh();
		let seenInside = -1;
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('uncommitted')").run();
			seenInside = count(store);
		});
		expect(seenInside).toBe(0);
		expect(count(store)).toBe(1);
	});

	test("例外で全体が巻き戻り、store はその後も使える", async () => {
		const { store } = fresh();
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('kept')").run();
		});
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items(name) VALUES ('a')").run();
				db.query("INSERT INTO tags(item_id, tag) VALUES (1, 't')").run();
				db.query("INSERT INTO items(name) VALUES ('b')").run();
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(count(store)).toBe(1);
		expect(count(store, "tags")).toBe(0);
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('after')").run();
		});
		expect(count(store)).toBe(2);
	});

	test("制約違反（NOT NULL・外部キー）も巻き戻る", async () => {
		const { store } = fresh();
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items(name) VALUES ('ok')").run();
				db.query("INSERT INTO tags(item_id, tag) VALUES (999, 'x')").run();
			}),
		).rejects.toThrow();
		expect(count(store)).toBe(0);
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items(name) VALUES (NULL)").run();
			}),
		).rejects.toThrow();
	});

	test("Promise を返す callback は拒否して巻き戻し、捨てた Promise は unhandled にならない", async () => {
		const { store } = fresh();
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				store.write(((db: Database) => {
					db.query("INSERT INTO items(name) VALUES ('async')").run();
					return Promise.reject(new Error("late"));
				}) as never),
			).rejects.toThrow("async_write_callback");
			await expect(
				store.write((async (db: Database) => {
					db.query("INSERT INTO items(name) VALUES ('async2')").run();
				}) as never),
			).rejects.toThrow("async_write_callback");
			// 実行時の防御を確認するため、意図的に thenable を返す。
			// oxlint-disable-next-line unicorn/no-thenable
			const thenable = () => ({ then() {} });
			await expect(store.write(thenable as never)).rejects.toThrow(
				"async_write_callback",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(count(store)).toBe(0);
		expect(unhandled).toEqual([]);
	});

	test("書込みは直列: 同時に投げた 30 件が投入順に 1 件ずつ実行される", async () => {
		const { store } = fresh();
		await store.write((db) => {
			db.exec(
				"CREATE TABLE counter(n INTEGER); INSERT INTO counter VALUES (0)",
			);
		});
		const order: number[] = [];
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, i) =>
				store.write((db) => {
					const n = (db.query("SELECT n FROM counter").get() as { n: number })
						.n;
					db.query("UPDATE counter SET n = ?").run(n + 1);
					order.push(i);
					return n + 1;
				}),
			),
		);
		expect(results).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
		expect(order).toEqual(Array.from({ length: 30 }, (_, i) => i));
	});

	test("失敗した書込みの後ろの書込みは実行される", async () => {
		const { store } = fresh();
		const first = store.write(() => {
			throw new Error("first fails");
		});
		const second = store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('second')").run();
		});
		await expect(first).rejects.toThrow("first fails");
		await second;
		expect(count(store)).toBe(1);
	});

	test(`待ち行列が ${WRITER_PENDING_LIMIT} を超えると database_writer_queue_full`, async () => {
		const { store } = fresh();
		const results = await Promise.allSettled(
			Array.from({ length: WRITER_PENDING_LIMIT + 6 }, () =>
				store.write((db) => {
					db.query("INSERT INTO items(name) VALUES ('q')").run();
				}),
			),
		);
		const rejected = results.filter(
			(x): x is PromiseRejectedResult => x.status === "rejected",
		);
		expect(rejected.length).toBe(6);
		for (const x of rejected) expect(x.reason).toBeInstanceOf(WriterBusyError);
		expect(count(store)).toBe(WRITER_PENDING_LIMIT);
	});

	test("onCommit は変更を伴う commit だけ通知し、listener の例外は書込みを失敗にしない", async () => {
		const { store } = fresh();
		let n = 0;
		const off = store.onCommit(() => {
			n++;
			throw new Error("listener fails");
		});
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('a')").run();
		});
		expect(n).toBe(1);
		await store.write((db) => {
			db.query("SELECT 1").get();
		});
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items(name) VALUES ('b')").run();
				throw new Error("x");
			}),
		).rejects.toThrow();
		expect(n).toBe(1);
		off();
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('c')").run();
		});
		expect(n).toBe(1);
	});
});

describe("read / readonly 接続", () => {
	test("reader では書込みできない（read でも readSnapshot でも）", () => {
		const { store } = fresh();
		expect(() =>
			store.read((db) =>
				db.query("INSERT INTO items(name) VALUES ('x')").run(),
			),
		).toThrow(/readonly/i);
		expect(() =>
			store.readSnapshot((db) => {
				db.query("INSERT INTO items(name) VALUES ('x')").run();
			}),
		).toThrow(/readonly/i);
		expect(count(store)).toBe(0);
	});

	test("readSnapshot は Promise を返す callback を拒否する", () => {
		const { store } = fresh();
		expect(() => store.readSnapshot((async () => 1) as never)).toThrow(
			"async_snapshot_callback",
		);
	});

	test("readSnapshot の中では commit 済みの 1 つの状態を見る", async () => {
		const { store } = fresh();
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('a')").run();
		});
		const seen = store.readSnapshot((db) => [
			count(store),
			(db.query("SELECT count(*) c FROM items").get() as { c: number }).c,
		]);
		expect(seen).toEqual([1, 1]);
	});
});

describe("close", () => {
	test("待機中の書込みを完了し、全接続と lock を閉じ、以後の操作を拒否する", async () => {
		const { dir, store } = fresh();
		let w: Database | undefined;
		const pending = store.write((db) => {
			w = db;
			db.query("INSERT INTO items(name) VALUES ('before-close')").run();
		});
		const r = store.read((db) => db);
		const closing = store.close();
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items(name) VALUES ('late')").run();
			}),
		).rejects.toThrow("database_closing");
		await closing;
		await pending;
		expect(() => w?.query("SELECT 1")).toThrow(/closed/i);
		expect(() => r.query("SELECT 1")).toThrow(/closed/i);
		expect(() => store.read((db) => db)).toThrow("database_closing");
		expect(() => store.onCommit(() => {})).toThrow("database_closing");
		await store.close();
		const reopened = openExampleStore(dir, OPTIONS);
		stores.push(reopened);
		expect(
			reopened.read((db) => db.query("SELECT name FROM items").all()),
		).toEqual([{ name: "before-close" }]);
	});
});

describe("一時ディレクトリ", () => {
	test("tmpdir 配下に固定接頭辞で作り、絶対パスで片付ける", () => {
		const dir = createExampleTempDir();
		expect(dir.startsWith("/")).toBe(true);
		expect(dir.includes(EXAMPLE_TEMP_PREFIX)).toBe(true);
		expect(existsSync(dir)).toBe(true);
		expect(removeExampleTempDir(dir)).toBe(true);
		expect(existsSync(dir)).toBe(false);
		expect(removeExampleTempDir(dir)).toBe(false);
	});

	test("接頭辞・場所・種類が違うものは消さずに拒否する", () => {
		expect(() => removeExampleTempDir("relative-dir")).toThrow(
			"temp_dir_not_absolute",
		);
		expect(() => removeExampleTempDir(join(tmpdir(), "other-dir"))).toThrow(
			"temp_dir_prefix_mismatch",
		);
		const outer = createExampleTempDir();
		dirs.push(outer);
		const nested = join(outer, `${EXAMPLE_TEMP_PREFIX}nested`);
		mkdirSync(nested);
		expect(() => removeExampleTempDir(nested)).toThrow(
			"temp_dir_outside_tmpdir",
		);
		expect(existsSync(nested)).toBe(true);
		// symlink は辿らず、拒否する
		const target = createExampleTempDir();
		dirs.push(target);
		const link = join(tmpdir(), `${EXAMPLE_TEMP_PREFIX}link-${process.pid}`);
		symlinkSync(target, link);
		try {
			expect(() => removeExampleTempDir(link)).toThrow(
				"temp_dir_not_directory",
			);
			expect(existsSync(target)).toBe(true);
		} finally {
			unlinkSync(link);
		}
	});
});
