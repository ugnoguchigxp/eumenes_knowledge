// BLOB の保存形による DB サイズ・走査速度の差（WITHOUT ROWID は大きい BLOB で溢れ页を多用する疑い）を実測する。
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ms, summarize } from "./stats.ts";

const N = 10_000;
const rows: unknown[] = [];
for (const dim of [384, 768, 1024]) {
	for (const [layout, ddl] of [
		["WITHOUT ROWID PK(space,id)", "CREATE TABLE v(space_key TEXT NOT NULL, passage_id INTEGER NOT NULL, dimension INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(space_key, passage_id)) WITHOUT ROWID"],
		["rowid + UNIQUE(space,id)", "CREATE TABLE v(vector_id INTEGER PRIMARY KEY, space_key TEXT NOT NULL, passage_id INTEGER NOT NULL, dimension INTEGER NOT NULL, vector BLOB NOT NULL, UNIQUE(space_key, passage_id))"],
	] as const) {
		for (const pageSize of [4096, 16384]) {
			const dir = mkdtempSync(join(process.env.SPIKE_TMP ?? tmpdir(), "lay-"));
			const f = join(dir, "x.db");
			const db = new Database(f, { create: true });
			db.exec(`PRAGMA page_size=${pageSize}`);
			db.exec("PRAGMA journal_mode=WAL");
			db.exec(ddl);
			const ins = db.query("INSERT INTO v(space_key, passage_id, dimension, vector) VALUES ('s', ?, ?, ?)");
			const blob = new Uint8Array(dim * 4).fill(7);
			db.transaction(() => { for (let i = 0; i < N; i++) ins.run(i, dim, blob); })();
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			const size = statSync(f).size;
			const s: number[] = [];
			for (let r = 0; r < 15; r++) { const t = performance.now(); let n = 0; for (const row of db.query("SELECT passage_id, vector FROM v WHERE space_key='s'").iterate() as Iterable<{ vector: Uint8Array }>) n += row.vector.byteLength; s.push(ms(t)); }
			rows.push({ dim, layout, pageSize, dbMiB: +(size / 2 ** 20).toFixed(1), rawMiB: +((N * dim * 4) / 2 ** 20).toFixed(1), overhead: +(size / (N * dim * 4)).toFixed(2), scanMs: summarize(s).p50.toFixed(1) });
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}
}
console.table(rows);
await Bun.write(new URL("../results/vector-layout.json", import.meta.url), JSON.stringify(rows, null, 1));
