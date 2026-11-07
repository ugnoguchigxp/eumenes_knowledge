import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVerificationStore, WriterBusyError, WriterOwnedError, WRITER_PENDING_LIMIT, type VerificationStore } from "./verification-writer.ts";

const MIGRATIONS = [
	{ id: "t/0001", sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE tags (item_id INTEGER NOT NULL REFERENCES items(id), tag TEXT NOT NULL)" },
];
const dirs: string[] = [];
const stores: VerificationStore[] = [];
function fresh() {
	const dir = mkdtempSync(join(process.env.SPIKE_TMP ?? tmpdir(), "vw-"));
	dirs.push(dir);
	const file = join(dir, "sub", "k.db");
	const store = openVerificationStore(file, MIGRATIONS);
	stores.push(store);
	return { dir, file, store };
}
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const count = (s: VerificationStore, table = "items") => s.read((db) => (db.query(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c);

describe("開き方", () => {
	test(":memory: は拒否", () => expect(() => openVerificationStore(":memory:", MIGRATIONS)).toThrow("persistent_database_path_required"));
	test("一時ディレクトリ上のファイル DB を作り、WAL・foreign_keys・owner-only 権限", () => {
		const { file, store } = fresh();
		expect(existsSync(file)).toBe(true);
		expect(store.read((db) => (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode)).toBe("wal");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(`${file}.owner.lock`).mode & 0o777).toBe(0o600);
	});
	test("同じファイルを二重に開くと database_writer_owned（OS flock）。close 後は開ける", async () => {
		const { file, store } = fresh();
		expect(() => openVerificationStore(file, MIGRATIONS)).toThrow(WriterOwnedError);
		await store.close();
		const again = openVerificationStore(file, MIGRATIONS);
		stores.push(again);
		expect(count(again)).toBe(0);
	});
	test("migration は一度だけ適用、再オープンで冪等、変更された SQL は checksum 不一致、未知の適用済みは拒否", async () => {
		const { file, store } = fresh();
		await store.write((db) => { db.query("INSERT INTO items(name) VALUES ('a')").run(); });
		await store.close();
		const s2 = openVerificationStore(file, MIGRATIONS);
		expect(count(s2)).toBe(1);
		await s2.close();
		expect(() => openVerificationStore(file, [{ id: "t/0001", sql: MIGRATIONS[0]!.sql + " " }])).toThrow("migration_checksum_mismatch:t/0001");
		expect(() => openVerificationStore(file, [{ id: "t/other", sql: "SELECT 1" }])).toThrow("migration_unknown_applied:t/0001");
		// 失敗した open が lock を残さない
		const s3 = openVerificationStore(file, MIGRATIONS);
		stores.push(s3);
	});
	test("途中で失敗する migration は全体を巻き戻し、lock も解放する", () => {
		const dir = mkdtempSync(join(tmpdir(), "vw-"));
		dirs.push(dir);
		const file = join(dir, "m.db");
		const bad = [{ id: "t/bad", sql: "CREATE TABLE a(x); INSERT INTO nonexistent VALUES (1)" }];
		expect(() => openVerificationStore(file, bad)).toThrow();
		const ok = openVerificationStore(file, [{ id: "t/ok", sql: "CREATE TABLE a(x)" }]); // a が残っていれば CREATE で失敗する
		stores.push(ok);
	});
});

describe("write の意味論", () => {
	test("commit 済みの結果は read で読める", async () => {
		const { store } = fresh();
		const id = await store.write((db) => db.query("INSERT INTO items(name) VALUES ('x') RETURNING id").get() as { id: number });
		expect(id.id).toBe(1);
		expect(store.read((db) => db.query("SELECT name FROM items").all())).toEqual([{ name: "x" }]);
	});
	test("callback 内の未 commit の行は readonly 接続から見えない", async () => {
		const { store } = fresh();
		let seenInside = -1;
		await store.write((db) => {
			db.query("INSERT INTO items(name) VALUES ('uncommitted')").run();
			seenInside = count(store); // readonly reader
		});
		expect(seenInside).toBe(0);
		expect(count(store)).toBe(1);
	});
	test("例外で全体が巻き戻る（複数テーブル・複数行）。store はその後も使える", async () => {
		const { store } = fresh();
		await store.write((db) => { db.query("INSERT INTO items(name) VALUES ('kept')").run(); });
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
		await store.write((db) => { db.query("INSERT INTO items(name) VALUES ('after')").run(); });
		expect(count(store)).toBe(2);
	});
	test("制約違反（NOT NULL・外部キー）も巻き戻る", async () => {
		const { store } = fresh();
		await expect(store.write((db) => { db.query("INSERT INTO items(name) VALUES ('ok')").run(); db.query("INSERT INTO tags(item_id, tag) VALUES (999, 'x')").run(); })).rejects.toThrow();
		expect(count(store)).toBe(0);
		await expect(store.write((db) => { db.query("INSERT INTO items(name) VALUES (NULL)").run(); })).rejects.toThrow();
	});
	test("async callback は拒否してロールバック（Promise を返した時点の書込みも残らない）", async () => {
		const { store } = fresh();
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		try {
			// 型は SyncResult<T> で Promise を拒否するが、実行時の防御を確認するため any 経由
			const bad = store.write(((db: Database) => { db.query("INSERT INTO items(name) VALUES ('async')").run(); return Promise.reject(new Error("late")); }) as never);
			await expect(bad).rejects.toThrow("async_write_callback");
			await expect(store.write((async (db: Database) => { db.query("INSERT INTO items(name) VALUES ('async2')").run(); }) as never)).rejects.toThrow("async_write_callback");
			await expect(store.write((() => ({ then() {} })) as never)).rejects.toThrow("async_write_callback"); // thenable も拒否
			await new Promise((r) => setTimeout(r, 10));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(count(store)).toBe(0);
		expect(unhandled).toEqual([]); // 捨てた Promise の拒否が unhandled にならない
	});
	test("書込みは直列: 同時に投げた 30 件が投入順に 1 件ずつ実行され、カウンタが欠けない", async () => {
		const { store } = fresh();
		await store.write((db) => { db.exec("CREATE TABLE counter(n INTEGER); INSERT INTO counter VALUES (0)"); });
		const order: number[] = [];
		const ps = Array.from({ length: 30 }, (_, i) =>
			store.write((db) => {
				const n = (db.query("SELECT n FROM counter").get() as { n: number }).n;
				db.query("UPDATE counter SET n = ?").run(n + 1);
				order.push(i);
				return n + 1;
			}),
		);
		expect(await Promise.all(ps)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
		expect(order).toEqual(Array.from({ length: 30 }, (_, i) => i));
	});
	test("失敗した書込みの後ろに積まれた書込みは実行される（1 件の失敗が列を止めない）", async () => {
		const { store } = fresh();
		const p1 = store.write(() => { throw new Error("first fails"); });
		const p2 = store.write((db) => { db.query("INSERT INTO items(name) VALUES ('second')").run(); });
		await expect(p1).rejects.toThrow("first fails");
		await p2;
		expect(count(store)).toBe(1);
	});
	test(`待ち行列が ${WRITER_PENDING_LIMIT} を超えると database_writer_queue_full`, async () => {
		const { store } = fresh();
		const ps = Array.from({ length: WRITER_PENDING_LIMIT + 6 }, () => store.write((db) => { db.query("INSERT INTO items(name) VALUES ('q')").run(); }));
		const results = await Promise.allSettled(ps);
		const rejected = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
		expect(rejected.length).toBe(6);
		for (const x of rejected) expect(x.reason).toBeInstanceOf(WriterBusyError);
		expect(count(store)).toBe(WRITER_PENDING_LIMIT);
	});
	test("onCommit は変更を伴う commit だけ通知（rollback と何も変えない write では呼ばれない）。listener の例外は書込みを失敗にしない", async () => {
		const { store } = fresh();
		let n = 0;
		const off = store.onCommit(() => { n++; throw new Error("listener fails"); });
		await store.write((db) => { db.query("INSERT INTO items(name) VALUES ('a')").run(); });
		expect(n).toBe(1);
		await store.write((db) => { db.query("SELECT 1").get(); });
		await expect(store.write((db) => { db.query("INSERT INTO items(name) VALUES ('b')").run(); throw new Error("x"); })).rejects.toThrow();
		expect(n).toBe(1);
		off();
		await store.write((db) => { db.query("INSERT INTO items(name) VALUES ('c')").run(); });
		expect(n).toBe(1);
	});
});

describe("read / readonly 接続", () => {
	test("reader では書込みできない（read でも readSnapshot でも）", () => {
		const { store } = fresh();
		expect(() => store.read((db) => db.query("INSERT INTO items(name) VALUES ('x')").run())).toThrow(/readonly/i);
		expect(() => store.readSnapshot((db) => { db.query("INSERT INTO items(name) VALUES ('x')").run(); })).toThrow(/readonly/i);
		expect(count(store)).toBe(0);
	});
	test("readSnapshot は async callback を拒否", () => {
		const { store } = fresh();
		expect(() => store.readSnapshot((async () => 1) as never)).toThrow("async_snapshot_callback");
	});
	test("readSnapshot の中では複数 SELECT が 1 つの commit 済み状態を見る", async () => {
		const { store } = fresh();
		await store.write((db) => { db.query("INSERT INTO items(name) VALUES ('a')").run(); });
		const seen = store.readSnapshot((db) => [count(store), (db.query("SELECT count(*) c FROM items").get() as { c: number }).c]);
		expect(seen).toEqual([1, 1]);
	});
});

describe("close", () => {
	test("待機中の書込みを完了し、全接続と lock を閉じ、以後の操作を拒否する", async () => {
		const { file, store } = fresh();
		let w: Database | undefined, r: Database | undefined;
		const pending = store.write((db) => { w = db; db.query("INSERT INTO items(name) VALUES ('before-close')").run(); });
		r = store.read((db) => db);
		const closing = store.close();
		await expect(store.write((db) => { db.query("INSERT INTO items(name) VALUES ('late')").run(); })).rejects.toThrow("database_closing");
		await closing;
		await pending;
		expect(() => w!.query("SELECT 1")).toThrow(/closed/i);
		expect(() => r!.query("SELECT 1")).toThrow(/closed/i);
		expect(() => store.read((db) => db)).toThrow("database_closing");
		expect(() => store.onCommit(() => {})).toThrow("database_closing");
		await store.close(); // 二重 close は何もしない
		// lock が解放されており、commit 済みの内容が残っている
		const re = openVerificationStore(file, MIGRATIONS);
		stores.push(re);
		expect(re.read((db) => db.query("SELECT name FROM items").all())).toEqual([{ name: "before-close" }]);
	});
});
