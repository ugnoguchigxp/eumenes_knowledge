import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rng } from "./stats.ts";
import { ResidentIndex, TopK, VECTOR_SCHEMA, VectorError, dot, ensureSpace, packVector, putVector, searchFromSql, unpackVector, vectorSpaceKey, type EmbeddingSpace } from "./vector-store.ts";

const dbs: Database[] = [];
function db() {
	const d = new Database(":memory:"); // 本番は :memory: 不可。ここは spike の単体試験のみ
	d.exec("PRAGMA foreign_keys=ON");
	d.exec(VECTOR_SCHEMA);
	dbs.push(d);
	return d;
}
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

const SP_A: EmbeddingSpace = { modelId: "m-a", revision: "1", artifactDigest: "sha256:aaa", dimension: 8 };
const SP_B: EmbeddingSpace = { ...SP_A, modelId: "m-b" };
const SP_A4: EmbeddingSpace = { ...SP_A, dimension: 4 };
const rand = rng(1);
const unit = (d: number) => { const v = Array.from({ length: d }, () => rand() * 2 - 1); const n = Math.hypot(...v); return v.map((x) => x / n); };

describe("space key", () => {
	test("モデル・版・digest・次元のどれかが違えば別 key。同じなら同じ", () => {
		const k = vectorSpaceKey(SP_A);
		expect(k).toMatch(/^[0-9a-f]{32}$/);
		expect(vectorSpaceKey({ ...SP_A })).toBe(k);
		expect(new Set([k, vectorSpaceKey(SP_B), vectorSpaceKey({ ...SP_A, revision: "2" }), vectorSpaceKey({ ...SP_A, artifactDigest: "sha256:bbb" }), vectorSpaceKey(SP_A4)]).size).toBe(5);
	});
	test("不正な space は拒否", () => {
		const d = db();
		expect(() => ensureSpace(d, { ...SP_A, dimension: 0 })).toThrow(VectorError);
		expect(() => ensureSpace(d, { ...SP_A, dimension: 1.5 })).toThrow(VectorError);
		expect(() => ensureSpace(d, { ...SP_A, modelId: "" })).toThrow(VectorError);
	});
});

describe("保存と次元不一致の拒否", () => {
	test("pack/unpack は float32 で往復し、4 byte 境界に乗らない BLOB でも読める", () => {
		const v = [0.5, -1.25, 3.0e-3, 7];
		const p = packVector(v);
		expect(p.byteLength).toBe(16);
		const shifted = new Uint8Array(new ArrayBuffer(17), 1, 16); // byteOffset=1
		shifted.set(p);
		expect(Array.from(unpackVector(shifted))).toEqual(Array.from(Float32Array.from(v)));
		expect(() => unpackVector(new Uint8Array(7))).toThrow("bad_blob");
	});
	test("次元違いのベクトルは保存を拒否し、行は残らない", () => {
		const d = db();
		const k = ensureSpace(d, SP_A);
		expect(() => putVector(d, k, 1, "x", unit(7))).toThrow(new VectorError("dimension_mismatch"));
		expect(() => putVector(d, k, 1, "x", unit(9))).toThrow(new VectorError("dimension_mismatch"));
		expect(() => putVector(d, k, 1, "x", [...unit(7), Number.NaN])).toThrow(new VectorError("non_finite"));
		expect(() => putVector(d, k, 1, "x", [...unit(7), Infinity])).toThrow(new VectorError("non_finite"));
		expect(() => putVector(d, "0".repeat(32), 1, "x", unit(8))).toThrow(new VectorError("unknown_space"));
		expect((d.query("SELECT count(*) c FROM passage_vectors").get() as { c: number }).c).toBe(0);
	});
	test("API を迂回した生 SQL でも、BLOB 長が dimension*4 でなければ CHECK が拒否する。未登録 space も外部キーが拒否する", () => {
		const d = db();
		const k = ensureSpace(d, SP_A);
		const ins = d.query("INSERT INTO passage_vectors(passage_id, space_key, dimension, text_digest, vector) VALUES (?,?,?,?,?)");
		expect(() => ins.run(1, k, 8, "x", new Uint8Array(31))).toThrow(/CHECK/i);
		expect(() => ins.run(1, k, 8, "x", new Uint8Array(33))).toThrow(/CHECK/i);
		expect(() => ins.run(1, "f".repeat(32), 8, "x", new Uint8Array(32))).toThrow(/FOREIGN KEY/i);
		ins.run(1, k, 8, "x", new Uint8Array(32)); // 正しい長さは通る
	});
	test("同じ (space, passage) の再投入は置換で重複しない", () => {
		const d = db();
		const k = ensureSpace(d, SP_A);
		putVector(d, k, 1, "d1", unit(8));
		putVector(d, k, 1, "d2", unit(8));
		const rows = d.query("SELECT text_digest FROM passage_vectors").all();
		expect(rows).toEqual([{ text_digest: "d2" }]);
	});
});

describe("space を混ぜない検索", () => {
	function seed() {
		const d = db();
		const ka = ensureSpace(d, SP_A), kb = ensureSpace(d, SP_B), k4 = ensureSpace(d, SP_A4);
		const va = Array.from({ length: 20 }, () => unit(8)), vb = Array.from({ length: 20 }, () => unit(8)), v4 = Array.from({ length: 20 }, () => unit(4));
		va.forEach((v, i) => putVector(d, ka, i, "a", v));
		vb.forEach((v, i) => putVector(d, kb, 100 + i, "b", v)); // 同じ次元・別モデル。passage id も別
		v4.forEach((v, i) => putVector(d, k4, 200 + i, "c", v));
		return { d, ka, kb, k4, va, vb, v4 };
	}
	test("space A の query は A の行しか返さない（同じ次元の B があっても混ざらない）", () => {
		const { d, ka, kb, va, vb } = seed();
		const hitsA = searchFromSql(d, ka, vb[3]!, 50).map((h) => h.id);
		expect(hitsA.length).toBe(20);
		expect(hitsA.every((id) => id < 100)).toBe(true);
		const hitsB = searchFromSql(d, kb, va[3]!, 50).map((h) => h.id);
		expect(hitsB.every((id) => id >= 100 && id < 200)).toBe(true);
	});
	test("query の次元が space と違えば拒否。未知の space も拒否", () => {
		const { d, ka, k4 } = seed();
		expect(() => searchFromSql(d, ka, unit(4), 5)).toThrow(new VectorError("dimension_mismatch"));
		expect(() => searchFromSql(d, k4, unit(8), 5)).toThrow(new VectorError("dimension_mismatch"));
		expect(() => searchFromSql(d, "e".repeat(32), unit(8), 5)).toThrow(new VectorError("unknown_space"));
		expect(() => ResidentIndex.load(d, "e".repeat(32))).toThrow(new VectorError("unknown_space"));
		expect(() => ResidentIndex.load(d, ka).search(unit(5), 3)).toThrow(new VectorError("dimension_mismatch"));
	});
	test("top-k は全件ソートと一致し、SQL 方式と常駐方式の結果が同じ。k > 件数でも全件", () => {
		const { d, ka, va } = seed();
		const q = unit(8);
		const expected = va.map((v, i) => ({ id: i, score: dot(Float32Array.from(v), Float32Array.from(q)) })).sort((x, y) => y.score - x.score);
		const sql = searchFromSql(d, ka, q, 5);
		const res = ResidentIndex.load(d, ka).search(q, 5);
		expect(sql.map((h) => h.id)).toEqual(expected.slice(0, 5).map((h) => h.id));
		expect(res.map((h) => h.id)).toEqual(expected.slice(0, 5).map((h) => h.id));
		for (let i = 0; i < 5; i++) expect(Math.abs(res[i]!.score - sql[i]!.score)).toBeLessThan(1e-5); // 展開 dot と単純 dot は丸め順が違い得る
		expect(searchFromSql(d, ka, q, 1000).length).toBe(20);
	});
	test("TopK: 同点でも件数 k を超えない・降順", () => {
		const t = new TopK(3);
		[0.1, 0.9, 0.5, 0.9, 0.2, 0.9, 0.95].forEach((s, i) => t.push(i, s));
		expect(t.scores).toEqual([0.95, 0.9, 0.9]);
		expect(t.ids.length).toBe(3);
	});
	test("ある space の行を消しても別 space は残る（space 単位の失効）", () => {
		const { d, ka, kb } = seed();
		d.query("DELETE FROM passage_vectors WHERE space_key = ?").run(ka);
		expect(searchFromSql(d, ka, unit(8), 5)).toEqual([]);
		expect(searchFromSql(d, kb, unit(8), 5).length).toBe(5);
	});
});
