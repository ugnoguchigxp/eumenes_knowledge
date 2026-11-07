// FTS5 の「機械的な一致」の性質を回帰試験として固定する（意味検索の評価ではない）。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildMethods } from "./fts-matrix.ts";

const db = new Database(":memory:");
const methods = Object.fromEntries(buildMethods(db).map((m) => [m.name, m.run]));
const run = (m: string, q: string) => methods[m]!(q);

test("環境: FTS5 と trigram / unicode61 が使える", () => {
	expect((db.query("select sqlite_version() v").get() as { v: string }).v).toMatch(/^3\./);
});

describe("trigram", () => {
	test("3 文字未満（1・2 文字）の MATCH は何も返さない（エラーにもならない）", () => {
		for (const q of ["東", "う", "A", "東京", "京都", "ab", "C#"]) expect(run("tri MATCH", q)).toEqual([]);
	});
	test("同じ 1・2 文字でも LIKE / instr / FTS 表への LIKE は引ける（全走査）", () => {
		expect(run("LIKE", "東京")).toEqual(["d1", "d8"]);
		expect(run("instr", "東京")).toEqual(["d1", "d8"]);
		expect(run("tri LIKE(FTS表)", "東京")).toEqual(["d1", "d8"]);
	});
	test("3 文字以上の日本語は分かち書きなしで部分一致する（語の途中から）", () => {
		expect(run("tri MATCH", "東京都")).toEqual(["d1"]);
		expect(run("tri MATCH", "天気予報")).toEqual(["d1"]);
		expect(run("tri MATCH", "都の天")).toEqual(["d1"]);
	});
	test("ASCII の大文字小文字は既定で区別しない。case_sensitive 1 で区別する。instr は区別する", () => {
		expect(run("tri MATCH", "hello")).toEqual(["d7", "d14"]);
		expect(run("tri case_sensitive", "hello")).toEqual([]);
		expect(run("instr", "hello")).toEqual([]);
	});
	test("全角と半角は別物（NFKC しないと引けない）。全角英字の大小は畳まれる", () => {
		expect(run("tri MATCH", "ＡＢＣ")).toEqual(["d4"]);
		expect(run("tri MATCH", "ａｂｃ")).toEqual(["d4"]);
		expect(run("tri MATCH", "abc")).toEqual(["d5"]);
		expect(run("tri MATCH", "123")).toEqual(["d5"]);
		expect(run("tri MATCH", "１２３")).toEqual(["d4"]);
	});
	test("本文・query の両側を NFKC すると 全角/半角/半角カナ が同一視される（過剰一致も増える）", () => {
		expect(run("tri MATCH 両側NFKC", "abc")).toEqual(["d4", "d5"]);
		expect(run("tri MATCH 両側NFKC", "トウキ")).toEqual(["d3", "d6"]);
		expect(run("tri MATCH 両側NFKC", "ガイドライン")).toEqual(["d9", "d13", "d16"]);
	});
	test("NFC と NFD は別物（NFKC しないと引けない）", () => {
		expect(run("tri MATCH", "ガイドライン")).toEqual(["d9"]);
		expect(run("tri MATCH", "ガイドライン".normalize("NFD"))).toEqual(["d13"]);
	});
	test("アクセントは既定で区別、remove_diacritics 1 で畳む", () => {
		expect(run("tri MATCH", "resume")).toEqual(["d15"]);
		expect(run("tri remove_diacritics", "resume")).toEqual(["d11", "d15"]);
	});
	test("記号: C++ foo_bar foo-bar メール は 3 文字以上なら一致。C# は 2 文字なので trigram では引けない", () => {
		for (const q of ["C++", "foo_bar", "foo-bar", "user@example.com"]) expect(run("tri MATCH", q)).toEqual(["d7"]);
		expect(run("tri MATCH", "C#")).toEqual([]);
	});
	test("detail=none / column では phrase query（= 部分一致の問い合わせ）がエラー", () => {
		const d = new Database(":memory:");
		d.exec("create virtual table f using fts5(body, tokenize='trigram', detail=none)");
		d.exec("insert into f values ('abcdef')");
		expect(() => d.query("select * from f where f match ?").all('"abcd"')).toThrow(/phrase queries are not supported/);
		d.close();
	});
});

describe("unicode61", () => {
	test("空白のない日本語の連続は 1 token。語の途中や先頭以外の部分には当たらない", () => {
		expect(run("unicode61 MATCH", "東京")).toEqual([]);
		expect(run("unicode61 MATCH", "東京都")).toEqual([]);
		expect(run("unicode61 MATCH", "天気予報")).toEqual([]);
		expect(run("unicode61 MATCH", "東")).toEqual(["d12"]); // 空白区切りの文書だけ
	});
	test("prefix(*) は token の先頭からしか当たらない（部分一致ではない）", () => {
		expect(run("unicode61 prefix*", "東京")).toEqual(["d1"]); // d8 の「…と東京への…」は token 途中なので外れる
		expect(run("unicode61 prefix*", "京都")).toEqual(["d8"]);
		expect(run("unicode61 prefix*", "天気")).toEqual([]);
	});
	test("英数字は単語単位で引け、大小・アクセントは既定で畳まれる", () => {
		expect(run("unicode61 MATCH", "hello")).toEqual(["d7", "d14"]);
		expect(run("unicode61 MATCH", "resume")).toEqual(["d11", "d15"]);
	});
	test("記号は token 区切りとして捨てられる（C# は C と同じ扱い）", () => {
		expect(run("unicode61 MATCH", "C#")).toEqual(["d7"]);
		expect(run("unicode61 prefix*", "C#")).toEqual(["d7", "d11", "d14", "d15"]); // 'C' prefix: Card / case / cafe など
	});
});

describe("LIKE / instr", () => {
	test("LIKE は ASCII のみ大小同一視、instr は区別。どちらも全角/半角・NFC/NFD は同一視しない", () => {
		expect(run("LIKE", "hello")).toEqual(["d7", "d14"]);
		expect(run("instr", "hello")).toEqual([]);
		expect(run("LIKE", "abc")).toEqual(["d5"]);
		expect(run("LIKE", "ａｂｃ")).toEqual([]);
	});
});
