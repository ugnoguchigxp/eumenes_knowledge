// 全文・ベクトル候補の合成方式の「計算コスト」だけを測る。順位の良し悪し（品質）は測らない。
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ms, rng, summarize } from "./stats.ts";
import { ResidentIndex, VECTOR_SCHEMA, dot, ensureSpace, packVector, unpackVector } from "./vector-store.ts";

/** Reciprocal Rank Fusion: score(d) = Σ 1/(c + rank_i(d))。順位だけを使うので score の尺度合わせが不要。 */
export function rrf(lists: number[][], c = 60, limit = 50): { id: number; score: number }[] {
	const m = new Map<number, number>();
	for (const list of lists) list.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (c + i + 1)));
	return [...m].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}

if (import.meta.main) {
	const rand = rng(3);
	const out: Record<string, unknown> = {};
	for (const size of [50, 200, 1000]) {
		const a = Array.from({ length: size }, () => Math.floor(rand() * 100000));
		const b = Array.from({ length: size }, () => Math.floor(rand() * 100000));
		const s: number[] = [];
		for (let i = 0; i < 300; i++) { const t = performance.now(); rrf([a, b], 60, 50); s.push(ms(t)); }
		out[`RRF 2 lists x ${size}`] = summarize(s);
	}
	// FTS 候補を SQLite の BLOB から取り直してベクトル再採点（FTS→vector rerank）。dim 768, N 10,000。
	const dir = mkdtempSync(join(process.env.SPIKE_TMP ?? tmpdir(), "fus-"));
	try {
		const db = new Database(join(dir, "f.db"), { create: true });
		db.exec(VECTOR_SCHEMA);
		const dim = 768, N = 10_000;
		const key = ensureSpace(db, { modelId: "synthetic", revision: "r0", artifactDigest: "sha256:none", dimension: dim });
		const ins = db.query("INSERT INTO passage_vectors(passage_id, space_key, dimension, text_digest, vector) VALUES (?,?,?,?,?)");
		const vec = () => { const v = new Float32Array(dim); let n = 0; for (let i = 0; i < dim; i++) { v[i] = rand() * 2 - 1; n += v[i]! ** 2; } n = Math.sqrt(n); for (let i = 0; i < dim; i++) v[i] = v[i]! / n; return v; };
		db.transaction(() => { for (let i = 0; i < N; i++) ins.run(i, key, dim, "d", packVector(vec())); })();
		const q = vec();
		for (const cand of [50, 200, 1000]) {
			const ids = Array.from({ length: cand }, () => Math.floor(rand() * N));
			const s: number[] = [];
			const stmt = db.query(`SELECT passage_id, vector FROM passage_vectors WHERE space_key = ? AND passage_id IN (${ids.map(() => "?").join(",")})`);
			for (let i = 0; i < 100; i++) { const t = performance.now(); const rows = stmt.all(key, ...ids) as { passage_id: number; vector: Uint8Array }[]; rows.map((r) => ({ id: r.passage_id, s: dot(unpackVector(r.vector), q) })).sort((x, y) => y.s - x.s); s.push(ms(t)); }
			out[`SQL から ${cand} 件の BLOB を取得して dot (dim ${dim})`] = summarize(s);
		}
		const idx = ResidentIndex.load(db, key);
		out["常駐 index 全件 top-50 (N=10,000, dim 768) 参考"] = summarize(Array.from({ length: 50 }, () => { const t = performance.now(); idx.search(q, 50); return ms(t); }));
		db.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
	console.log(JSON.stringify(out, null, 1));
	await Bun.write(new URL("../results/fusion-bench.json", import.meta.url), JSON.stringify(out, null, 1));
}
