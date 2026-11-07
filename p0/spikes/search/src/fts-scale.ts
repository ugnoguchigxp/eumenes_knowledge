// FTS5 の規模感: DB サイズ・索引構築時間・検索遅延。合成 CJK 乱数文字列。実言語の分布は反映しない。
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ms, rng, summarize } from "./stats.ts";

const SCRATCH = process.env.SPIKE_TMP ?? tmpdir();
const kana = [...Array(83)].map((_, i) => String.fromCodePoint(0x3041 + i));
const kata = [...Array(86)].map((_, i) => String.fromCodePoint(0x30a1 + i));
const kanji = [...Array(600)].map((_, i) => String.fromCodePoint(0x4e00 + i * 7));
const pools = [kana, kata, kanji, kanji];

export function makeVocab(rand: () => number, size: number): string[] {
	const v: string[] = [];
	for (let i = 0; i < size; i++) {
		const len = 2 + Math.floor(rand() * 4);
		let w = "";
		const pool = pools[Math.floor(rand() * pools.length)]!;
		for (let j = 0; j < len; j++) w += pool[Math.floor(rand() * pool.length)];
		if (rand() < 0.15) w = "abcdefghijklmnopqrstuvwxyz".slice(0, 3 + Math.floor(rand() * 6)).split("").sort(() => rand() - 0.5).join("");
		v.push(w);
	}
	return v;
}
export function makeFragment(rand: () => number, vocab: string[], chars: number): string {
	let t = "";
	while (t.length < chars) t += vocab[Math.floor(rand() ** 2 * vocab.length)] + (rand() < 0.12 ? "。" : rand() < 0.1 ? " " : "");
	return t;
}

const run = async (N: number) => {
	const dir = mkdtempSync(join(SCRATCH, "fts-"));
	const rand = rng(42);
	const vocab = makeVocab(rand, 5000);
	const CH = 600;
	const frags: string[] = [];
	for (let i = 0; i < N; i++) frags.push(makeFragment(rand, vocab, CH));
	const bytes = frags.reduce((a, f) => a + Buffer.byteLength(f), 0);
	const res: Record<string, unknown> = { N, avgChars: CH, textMiB: +(bytes / 2 ** 20).toFixed(1) };
	const variants: [string, string][] = [
		["base", ""],
		["trigram", "tokenize='trigram'"],
		["trigram detail=column", "tokenize='trigram', detail=column"],
		["trigram detail=none", "tokenize='trigram', detail=none"],
		["unicode61", "tokenize='unicode61'"],
	];
	const sizes: Record<string, number> = {};
	const build: Record<string, number> = {};
	for (const [name, opts] of variants) {
		const file = join(dir, name.replace(/\W+/g, "_") + ".db");
		const db = new Database(file, { create: true });
		db.exec("pragma journal_mode=WAL");
		const t0 = performance.now();
		if (name === "base") db.exec("create table f(id integer primary key, body text)");
		else db.exec(`create virtual table f using fts5(body, ${opts})`);
		const ins = db.query("insert into f(body) values (?)");
		db.transaction(() => { for (const f of frags) ins.run(f); })();
		build[name] = ms(t0);
		db.exec("pragma wal_checkpoint(truncate)");
		if (name !== "base") db.exec("insert into f(f) values('optimize')");
		db.exec("pragma wal_checkpoint(truncate)");
		sizes[name] = statSync(file).size;
		if (name === "base") {
			// substring scan baselines
			const qs = [...Array(100)].map(() => vocab[Math.floor(rand() * vocab.length)]!).filter((w) => w.length >= 3);
			const q2 = [...Array(100)].map(() => vocab[Math.floor(rand() ** 2 * vocab.length)]!.slice(0, 2));
			const q1 = [...Array(30)].map(() => vocab[Math.floor(rand() * vocab.length)]![0]!);
			const time = (qs: string[], sql: string, wrap = (q: string) => q) => { const s: number[] = []; for (const q of qs) { const t = performance.now(); db.query(sql).all(wrap(q)); s.push(ms(t)); } return summarize(s); };
			res["LIKE scan 3+字"] = time(qs.slice(0, 50), "select id from f where body like ?", (q) => `%${q}%`);
			res["instr scan 3+字"] = time(qs.slice(0, 50), "select id from f where instr(body, ?) > 0");
		}
		db.close();
	}
	res.dbBytes = sizes;
	res.buildMs = build;

	// 検索遅延
	const q3: string[] = [], q2: string[] = [], q1: string[] = [];
	const r2 = rng(7);
	for (let i = 0; q3.length < 200; i++) {
		const w = vocab[Math.floor(r2() ** 2 * vocab.length)]!;
		if (w.length >= 3) q3.push(w.slice(0, 3 + Math.floor(r2() * (w.length - 2))));
	}
	for (let i = 0; i < 100; i++) q2.push(vocab[Math.floor(r2() ** 2 * vocab.length)]!.slice(0, 2));
	for (let i = 0; i < 30; i++) q1.push(vocab[Math.floor(r2() ** 2 * vocab.length)]![0]!);
	const phrase = (q: string) => `"${q.replaceAll('"', '""')}"`;
	const tri = new Database(join(dir, "trigram.db"), { readonly: true });
	const uni = new Database(join(dir, "unicode61.db"), { readonly: true });
	const timeQ = (db: Database, qs: string[], sql: string, wrap: (q: string) => string) => {
		const s: number[] = []; let rows = 0;
		for (const q of qs) { const t = performance.now(); rows += db.query(sql).all(wrap(q)).length; s.push(ms(t)); }
		return { ...summarize(s), avgRows: +(rows / qs.length).toFixed(1) };
	};
	res["tri MATCH 3+字 全件"] = timeQ(tri, q3, "select rowid from f where f match ?", phrase);
	res["tri MATCH 3+字 bm25 top50"] = timeQ(tri, q3, "select rowid from f where f match ? order by bm25(f) limit 50", phrase);
	res["tri LIKE 3+字(索引利用)"] = timeQ(tri, q3.slice(0, 100), "select rowid from f where body like ?", (q) => `%${q}%`);
	res["tri LIKE 2字(全走査)"] = timeQ(tri, q2.slice(0, 30), "select rowid from f where body like ?", (q) => `%${q}%`);
	res["tri LIKE 1字(全走査)"] = timeQ(tri, q1.slice(0, 10), "select rowid from f where body like ?", (q) => `%${q}%`);
	res["uni61 MATCH prefix 3+字"] = timeQ(uni, q3, "select rowid from f where f match ? order by bm25(f) limit 50", (q) => `${phrase(q)} *`);
	// 正しさ: trigram 結果集合が instr 全走査と一致するか
	const base = new Database(join(dir, "base.db"), { readonly: true });
	let mismatches = 0;
	for (const q of q3.slice(0, 40)) {
		const a = new Set((tri.query("select rowid r from f where f match ?").all(phrase(q)) as { r: number }[]).map((x) => x.r));
		const b = new Set((base.query("select id r from f where instr(body, ?) > 0").all(q) as { r: number }[]).map((x) => x.r));
		if (a.size !== b.size || [...a].some((x) => !b.has(x))) mismatches++;
	}
	res["tri MATCH vs instr 結果集合の不一致(40クエリ中)"] = mismatches;
	// detail=none の phrase 一致
	for (const v of ["trigram detail=column", "trigram detail=none"]) {
		const d = new Database(join(dir, v.replace(/\W+/g, "_") + ".db"), { readonly: true });
		let mm = 0;
		for (const q of q3.slice(0, 40)) {
			let a: Set<number>;
			try { a = new Set((d.query("select rowid r from f where f match ?").all(phrase(q)) as { r: number }[]).map((x) => x.r)); } catch { mm = -1; break; }
			const b = new Set((base.query("select id r from f where instr(body, ?) > 0").all(q) as { r: number }[]).map((x) => x.r));
			if (a.size !== b.size || [...a].some((x) => !b.has(x))) mm++;
		}
		res[`${v} 結果集合の不一致(40クエリ中, -1=エラー)`] = mm;
		d.close();
	}
	tri.close(); uni.close(); base.close();
	rmSync(dir, { recursive: true, force: true });
	return res;
};

if (import.meta.main) {
	const Ns = (process.env.FTS_N ?? "10000,50000").split(",").map(Number);
	const all = [];
	for (const N of Ns) { const r = await run(N); console.log(JSON.stringify(r, null, 1)); all.push(r); }
	await Bun.write(new URL("../results/fts-scale.json", import.meta.url), JSON.stringify(all, null, 1));
}
