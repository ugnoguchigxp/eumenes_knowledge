// 1 つの (dim, N) を測る。親プロセス（vector-driver.ts）が組合せごとに起動する。
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ms, rng, summarize } from "./stats.ts";
import { ResidentIndex, VECTOR_SCHEMA, ensureSpace, packVector, searchFromSql, vectorSpaceKey } from "./vector-store.ts";

const dim = Number(process.argv[2]);
const N = Number(process.argv[3]);
const QUERIES_RES = Number(process.env.Q_RESIDENT ?? 100);
const QUERIES_SQL = Number(process.env.Q_SQL ?? (N >= 50_000 ? 8 : 20));

const rand = rng(dim * 1_000_003 + N);
function randomUnit(): Float32Array {
	const v = new Float32Array(dim);
	let n = 0;
	for (let i = 0; i < dim; i++) { const x = rand() * 2 - 1; v[i] = x; n += x * x; }
	n = Math.sqrt(n);
	for (let i = 0; i < dim; i++) v[i] = v[i]! / n;
	return v;
}
const rss = () => process.memoryUsage().rss;
const dir = mkdtempSync(join(process.env.SPIKE_TMP ?? tmpdir(), "vec-"));
const file = join(dir, "v.db");
const out: Record<string, unknown> = { dim, N };
try {
	const db = new Database(file, { create: true });
	db.exec("PRAGMA journal_mode=WAL");
	db.exec(VECTOR_SCHEMA);
	const key = ensureSpace(db, { modelId: "synthetic", revision: "r0", artifactDigest: "sha256:none", dimension: dim });
	const t0 = performance.now();
	const ins = db.query("INSERT INTO passage_vectors(passage_id, space_key, dimension, text_digest, vector) VALUES (?,?,?,?,?)");
	db.transaction(() => { for (let i = 0; i < N; i++) ins.run(i, key, dim, "d", packVector(randomUnit())); })();
	out.insertMs = +ms(t0).toFixed(0);
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	out.dbMiB = +(statSync(file).size / 2 ** 20).toFixed(1);
	out.rawVectorMiB = +((N * dim * 4) / 2 ** 20).toFixed(1);
	db.close();

	const ro = new Database(file, { readonly: true });
	const queries = Array.from({ length: Math.max(QUERIES_RES, QUERIES_SQL) }, randomUnit);
	Bun.gc(true);
	const rss0 = rss();
	// B: 常駐
	const tl = performance.now();
	const idx = ResidentIndex.load(ro, vectorSpaceKey({ modelId: "synthetic", revision: "r0", artifactDigest: "sha256:none", dimension: dim }));
	out.residentLoadMs = +ms(tl).toFixed(0);
	Bun.gc(true);
	out.residentRssDeltaMiB = +((rss() - rss0) / 2 ** 20).toFixed(0);
	out.residentMatrixMiB = +(idx.matrix.byteLength / 2 ** 20).toFixed(0);
	const res: Record<string, unknown> = {};
	for (const k of [10, 50]) {
		const s: number[] = [];
		for (let i = 0; i < 3; i++) idx.search(queries[i]!, k); // warm up
		for (let i = 0; i < QUERIES_RES; i++) { const t = performance.now(); idx.search(queries[i]!, k); s.push(ms(t)); }
		res[`resident k=${k}`] = summarize(s);
	}
	{ // 単純 dot（展開なし）との比較 k=10
		const s: number[] = [];
		const qn = Math.min(QUERIES_RES, 30);
		for (let i = 0; i < qn; i++) { const t = performance.now(); idx.search(queries[i]!, 10, false); s.push(ms(t)); }
		res["resident k=10 simple-dot(subarray)"] = summarize(s);
	}
	// A: 毎回 SELECT
	for (const k of [10, 50]) {
		const s: number[] = [];
		for (let i = 0; i < QUERIES_SQL; i++) { const t = performance.now(); searchFromSql(ro, idx.spaceKey, queries[i]!, k); s.push(ms(t)); }
		res[`select-each-time k=${k}`] = summarize(s);
	}
	// 一致確認（A と B の top-k id が同じ集合か）
	let same = 0;
	for (let i = 0; i < 5; i++) {
		const a = searchFromSql(ro, idx.spaceKey, queries[i]!, 10).map((h) => h.id).sort((x, y) => x - y).join();
		const b = idx.search(queries[i]!, 10).map((h) => h.id).sort((x, y) => x - y).join();
		if (a === b) same++;
	}
	out.abAgree = `${same}/5`;
	out.latencyMs = res;
	out.queries = { resident: QUERIES_RES, sql: QUERIES_SQL };
	out.peakRssMiB = +(rss() / 2 ** 20).toFixed(0);
	ro.close();
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log("RESULT " + JSON.stringify(out));
