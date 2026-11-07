// FTS5 / LIKE / instr の「機械的な一致」の性質を合成テキストで確かめる。意味検索の評価ではない。
import { Database } from "bun:sqlite";

export const DOCS: Record<string, string> = {
	d1: "東京都の天気予報：晴れ時々くもり",
	d2: "とうきょうタワーに行く",
	d3: "トウキョウ駅 カタカナ表記",
	d4: "ＡＢＣ　全角英数ＡＢＣ１２３",
	d5: "ABC abc half-width 123",
	d6: "ﾄｳｷｮｳ 半角カナの表記",
	d7: "Hello World: C++ and C# programming, foo_bar, foo-bar, user@example.com",
	d8: "京都府の観光と東京への移動",
	d9: "ガイドライン（NFC・全角）",
	d10: "データベース設計と機械学習",
	d11: "Résumé and café (accented only)",
	d12: "東 京 都 (空白区切りの1文字語)",
	d13: "ガイドライン".normalize("NFD") + "（NFD分解形）",
	d14: "ONLY UPPER CASE: HELLO",
	d15: "resume and cafe (plain only)",
	d16: "ｶﾞｲﾄﾞﾗｲﾝ（半角カナ濁点つき）",
};

export const QUERIES: { label: string; q: string }[] = [
	{ label: "1字 漢字", q: "東" },
	{ label: "1字 かな", q: "う" },
	{ label: "1字 ASCII", q: "A" },
	{ label: "2字 漢字", q: "東京" },
	{ label: "2字 漢字(都市)", q: "京都" },
	{ label: "2字 ASCII", q: "ab" },
	{ label: "3字 漢字", q: "東京都" },
	{ label: "3字 ASCII 小文字", q: "abc" },
	{ label: "3字 ASCII 大文字", q: "ABC" },
	{ label: "3字 全角英字", q: "ＡＢＣ" },
	{ label: "3字 全角小文字", q: "ａｂｃ" },
	{ label: "3字 かな", q: "とうき" },
	{ label: "3字 カナ", q: "トウキ" },
	{ label: "半角カナ 3字", q: "ﾄｳｷ" },
	{ label: "6字 カナ(ガイドライン)", q: "ガイドライン" },
	{ label: "6字 カナ NFD", q: "ガイドライン".normalize("NFD") },
	{ label: "大小 hello(文書はHello/HELLO)", q: "hello" },
	{ label: "大小 HELLO", q: "HELLO" },
	{ label: "長め 漢字かな混在", q: "天気予報" },
	{ label: "漢字+かな 3字跨ぎ", q: "都の天" },
	{ label: "記号 C++", q: "C++" },
	{ label: "記号 C#", q: "C#" },
	{ label: "記号 foo_bar", q: "foo_bar" },
	{ label: "記号 foo-bar", q: "foo-bar" },
	{ label: "記号 メール", q: "user@example.com" },
	{ label: "全角数字", q: "１２３" },
	{ label: "半角数字(全角文書側)", q: "123" },
	{ label: "アクセント有 Résumé", q: "Résumé" },
	{ label: "アクセント無 resume", q: "resume" },
	{ label: "アクセント café", q: "café" },
	{ label: "アクセント無 cafe", q: "cafe" },
];

const phrase = (q: string) => `"${q.replaceAll('"', '""')}"`;
const nfkc = (s: string) => s.normalize("NFKC");

type Method = { name: string; run: (q: string) => string[] };

export function buildMethods(db: Database): Method[] {
	const ids = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
	db.exec("create table docs(id text primary key, body text)");
	const ins = db.query("insert into docs values (?,?)");
	for (const [id, body] of Object.entries(DOCS)) ins.run(id, body);
	db.exec(`create virtual table f_tri using fts5(id unindexed, body, tokenize='trigram')`);
	db.exec(`create virtual table f_tri_cs using fts5(id unindexed, body, tokenize='trigram case_sensitive 1')`);
	db.exec(`create virtual table f_tri_rd using fts5(id unindexed, body, tokenize='trigram remove_diacritics 1')`);
	db.exec(`create virtual table f_uni using fts5(id unindexed, body, tokenize='unicode61')`);
	db.exec(`create virtual table f_uni_rd0 using fts5(id unindexed, body, tokenize='unicode61 remove_diacritics 0')`);
	db.exec(`create virtual table f_tri_n using fts5(id unindexed, body, tokenize='trigram')`); // NFKC 済み本文
	db.exec(`create virtual table f_uni_n using fts5(id unindexed, body, tokenize='unicode61')`); // NFKC 済み本文
	for (const [id, body] of Object.entries(DOCS)) {
		for (const t of ["f_tri", "f_tri_cs", "f_tri_rd", "f_uni", "f_uni_rd0"]) db.query(`insert into ${t}(id, body) values (?,?)`).run(id, body);
		for (const t of ["f_tri_n", "f_uni_n"]) db.query(`insert into ${t}(id, body) values (?,?)`).run(id, nfkc(body));
	}
	const match = (t: string, q: string) => {
		try {
			return ids(db.query(`select id from ${t} where ${t} match ?`).all(phrase(q)));
		} catch (e) {
			return [`ERR:${(e as Error).message}`];
		}
	};
	return [
		{ name: "tri MATCH", run: (q) => match("f_tri", q) },
		{ name: "tri MATCH 両側NFKC", run: (q) => match("f_tri_n", nfkc(q)) },
		{ name: "tri case_sensitive", run: (q) => match("f_tri_cs", q) },
		{ name: "tri remove_diacritics", run: (q) => match("f_tri_rd", q) },
		{ name: "tri LIKE(FTS表)", run: (q) => ids(db.query(`select id from f_tri where body like ? escape '\\'`).all(`%${q.replace(/[%_\\]/g, "\\$&")}%`)) },
		{ name: "unicode61 MATCH", run: (q) => match("f_uni", q) },
		{ name: "unicode61 prefix*", run: (q) => { try { return ids(db.query(`select id from f_uni where f_uni match ?`).all(`${phrase(q)} *`)); } catch (e) { return [`ERR`]; } } },
		{ name: "unicode61 両側NFKC", run: (q) => match("f_uni_n", nfkc(q)) },
		{ name: "LIKE", run: (q) => ids(db.query(`select id from docs where body like ? escape '\\'`).all(`%${q.replace(/[%_\\]/g, "\\$&")}%`)) },
		{ name: "instr", run: (q) => ids(db.query(`select id from docs where instr(body, ?) > 0`).all(q)) },
		{ name: "instr 両側NFKC+lower", run: (q) => ids(db.query(`select id from docs where instr(lower(?2), lower(?1)) > 0`).all(nfkc(q), "") ) },
	];
}

if (import.meta.main) {
	const db = new Database(":memory:");
	const methods = buildMethods(db);
	// instr NFKC+lower は JS 側で実施（SQL に NFKC 関数が無いため、本文も JS 側で正規化して instr）
	const nfkcDocs = Object.entries(DOCS).map(([id, b]) => [id, nfkc(b).toLowerCase()] as const);
	methods[methods.length - 1] = {
		name: "instr 両側NFKC+lower(JS正規化)",
		run: (q) => nfkcDocs.filter(([, b]) => b.includes(nfkc(q).toLowerCase())).map(([id]) => id),
	};
	console.log("sqlite_version", (db.query("select sqlite_version() v").get() as { v: string }).v);
	console.log("\n## documents");
	for (const [id, b] of Object.entries(DOCS)) console.log(`- ${id}: ${JSON.stringify(b)}  (NFKC: ${JSON.stringify(nfkc(b))})`);
	const out: Record<string, Record<string, string[]>> = {};
	const header = ["クエリ", "q", ...methods.map((m) => m.name)];
	console.log("\n| " + header.join(" | ") + " |\n|" + header.map(() => "---").join("|") + "|");
	for (const { label, q } of QUERIES) {
		const row: string[] = [];
		out[label] = {};
		for (const m of methods) {
			const r = m.run(q);
			out[label][m.name] = r;
			row.push(r.length ? r.join(",") : "-");
		}
		console.log(`| ${label} | \`${q}\` | ${row.join(" | ")} |`);
	}
	await Bun.write(new URL("../results/fts-matrix.json", import.meta.url), JSON.stringify({ docs: DOCS, out }, null, 1));
}
