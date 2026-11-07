// spike: space key 列つきの float32 BLOB 保存 + JS 総当たり内積。製品コードではない。
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface EmbeddingSpace {
	modelId: string;
	revision: string;
	artifactDigest: string;
	dimension: number;
}

/** Eumenes eumenes_router の vectorSpaceKey と同じ構成: sha256(JSON[modelId, revision, artifactDigest, dimension]) 先頭32桁。 */
export function vectorSpaceKey(s: EmbeddingSpace): string {
	return createHash("sha256")
		.update(JSON.stringify([s.modelId, s.revision, s.artifactDigest, s.dimension]))
		.digest("hex")
		.slice(0, 32);
}

export class VectorError extends Error {
	constructor(public readonly code: "invalid_space" | "unknown_space" | "dimension_mismatch" | "non_finite" | "bad_blob") {
		super(code);
	}
}

/** float32 little-endian（Apple Silicon / x86 はともに LE。BE 環境は未確認で対象外）。 */
export function packVector(values: ArrayLike<number>): Uint8Array {
	return new Uint8Array(new Float32Array(values as ArrayLike<number>).buffer);
}
/** BLOB は 4 byte 境界に載るとは限らないのでコピーして view を作る（Eumenes と同じ）。 */
export function unpackVector(blob: Uint8Array): Float32Array {
	if (blob.byteLength % 4 !== 0) throw new VectorError("bad_blob");
	const copy = new Uint8Array(blob);
	return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
	return s;
}
/** 4 並び展開。結果は丸め順の違いで dot と末尾桁が僅かに異なり得る。 */
export function dot4(a: Float32Array, aOff: number, b: Float32Array, n: number): number {
	let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
	for (let i = 0; i < n; i += 4) {
		s0 += a[aOff + i]! * b[i]!;
		s1 += a[aOff + i + 1]! * b[i + 1]!;
		s2 += a[aOff + i + 2]! * b[i + 2]!;
		s3 += a[aOff + i + 3]! * b[i + 3]!;
	}
	return s0 + s1 + s2 + s3;
}

export const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS vector_spaces (
 space_key TEXT PRIMARY KEY,
 model_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 artifact_digest TEXT NOT NULL,
 dimension INTEGER NOT NULL CHECK(dimension > 0)
);
CREATE TABLE IF NOT EXISTS passage_vectors (
 vector_id INTEGER PRIMARY KEY,
 passage_id INTEGER NOT NULL,
 space_key TEXT NOT NULL REFERENCES vector_spaces(space_key),
 dimension INTEGER NOT NULL,
 text_digest TEXT NOT NULL,
 vector BLOB NOT NULL,
 UNIQUE (space_key, passage_id),
 CHECK(length(vector) = dimension * 4)
);
`;

export function ensureSpace(db: Database, space: EmbeddingSpace): string {
	if (!Number.isInteger(space.dimension) || space.dimension < 1 || !space.modelId || !space.revision || !space.artifactDigest)
		throw new VectorError("invalid_space");
	const key = vectorSpaceKey(space);
	db.query("INSERT OR IGNORE INTO vector_spaces(space_key, model_id, revision, artifact_digest, dimension) VALUES (?,?,?,?,?)").run(
		key, space.modelId, space.revision, space.artifactDigest, space.dimension,
	);
	return key;
}
function spaceDimension(db: Database, key: string): number {
	const row = db.query("SELECT dimension FROM vector_spaces WHERE space_key = ?").get(key) as { dimension: number } | null;
	if (!row) throw new VectorError("unknown_space");
	return row.dimension;
}
export function assertVector(values: ArrayLike<number>, dimension: number) {
	if (values.length !== dimension) throw new VectorError("dimension_mismatch");
	for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) throw new VectorError("non_finite");
}
/** 同期。ホスト transaction 内で呼ぶ想定。 */
export function putVector(db: Database, key: string, passageId: number, textDigest: string, values: ArrayLike<number>) {
	const dim = spaceDimension(db, key);
	assertVector(values, dim);
	db.query("INSERT OR REPLACE INTO passage_vectors(passage_id, space_key, dimension, text_digest, vector) VALUES (?,?,?,?,?)").run(
		passageId, key, dim, textDigest, packVector(values),
	);
}

export interface Hit { id: number; score: number }
/** 小さい k 用: 昇順に保つ配列で挿入。 */
export class TopK {
	readonly ids: number[] = [];
	readonly scores: number[] = [];
	min = -Infinity;
	constructor(readonly k: number) {}
	push(id: number, score: number) {
		if (this.ids.length === this.k && score <= this.min) return;
		let i = this.ids.length;
		this.ids.push(id); this.scores.push(score);
		while (i > 0 && this.scores[i - 1]! < score) { this.ids[i] = this.ids[i - 1]!; this.scores[i] = this.scores[i - 1]!; i--; }
		this.ids[i] = id; this.scores[i] = score;
		if (this.ids.length > this.k) { this.ids.pop(); this.scores.pop(); }
		this.min = this.ids.length === this.k ? this.scores[this.k - 1]! : -Infinity;
	}
	hits(): Hit[] { return this.ids.map((id, i) => ({ id, score: this.scores[i]! })); }
}

/** 方式A: 毎回 SELECT（同じ space_key だけ）して unpack。 */
export function searchFromSql(db: Database, key: string, query: ArrayLike<number>, k: number): Hit[] {
	const dim = spaceDimension(db, key);
	assertVector(query, dim);
	const q = Float32Array.from(query);
	const top = new TopK(k);
	for (const row of db.query("SELECT passage_id, vector FROM passage_vectors WHERE space_key = ?").iterate(key) as Iterable<{ passage_id: number; vector: Uint8Array }>) {
		top.push(row.passage_id, dot(unpackVector(row.vector), q));
	}
	return top.hits();
}

/** 方式B: メモリ常駐。space 1 つ分を 1 本の Float32Array に詰める。 */
export class ResidentIndex {
	constructor(readonly spaceKey: string, readonly dimension: number, readonly ids: Int32Array, readonly matrix: Float32Array) {}
	get size() { return this.ids.length; }
	static load(db: Database, key: string): ResidentIndex {
		const dim = spaceDimension(db, key);
		const n = (db.query("SELECT count(*) c FROM passage_vectors WHERE space_key = ?").get(key) as { c: number }).c;
		const ids = new Int32Array(n);
		const matrix = new Float32Array(n * dim);
		const view = new Uint8Array(matrix.buffer);
		let i = 0;
		for (const row of db.query("SELECT passage_id, vector FROM passage_vectors WHERE space_key = ?").iterate(key) as Iterable<{ passage_id: number; vector: Uint8Array }>) {
			if (row.vector.byteLength !== dim * 4) throw new VectorError("bad_blob");
			ids[i] = row.passage_id;
			view.set(row.vector, i * dim * 4);
			i++;
		}
		return new ResidentIndex(key, dim, ids, matrix);
	}
	search(query: ArrayLike<number>, k: number, unroll = true): Hit[] {
		assertVector(query, this.dimension);
		const q = Float32Array.from(query);
		const top = new TopK(k);
		const d = this.dimension;
		if (unroll && d % 4 === 0) for (let r = 0; r < this.ids.length; r++) top.push(this.ids[r]!, dot4(this.matrix, r * d, q, d));
		else for (let r = 0; r < this.ids.length; r++) top.push(this.ids[r]!, dot(this.matrix.subarray(r * d, (r + 1) * d), q));
		return top.hits();
	}
}
