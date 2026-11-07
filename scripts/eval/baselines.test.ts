import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	LEDGER_SEARCH_SQL,
	createFtsTrigramBaseline,
	createLedgerSubstringBaseline,
	uniqueInOrder,
	type BaselineDocument,
} from "./baselines.js";

const enc = new TextEncoder();
const doc = (
	key: string,
	documentId: string,
	title: string,
	markdown: string,
): BaselineDocument => ({
	key,
	documentId,
	title,
	markdown,
	bytes: enc.encode(markdown),
});

describe("baseline 2: the ledger's substring search", () => {
	const documents = [
		doc("k/c", "wiki-c", "Cの題", "# Cの題\n\nRelease Notes と 水路の点検"),
		doc("k/a", "wiki-a", "Aの題", "# Aの題\n\n本文に点検の語がある"),
		doc("k/b", "wiki-b", "点検の手引き", "# 点検の手引き\n\n題にだけ語がある"),
		doc("k/d", "wiki-d", "Dの題", "# Dの題\n\n全角のＡＢＣ"),
	];
	const ledger = createLedgerSubstringBaseline(documents);

	test("matches the title or the body and orders by document id, not by relevance", () => {
		// wiki-b has the term in its title, wiki-a and wiki-c in the body: id order a, b, c.
		expect(ledger.search("点検", 10)).toEqual(["k/a", "k/b", "k/c"]);
	});

	test("the limit cuts the id-ordered list", () => {
		expect(ledger.search("点検", 2)).toEqual(["k/a", "k/b"]);
	});

	test("lower() folds ASCII letters only: the same rule as the ledger's SQLite", () => {
		expect(ledger.search("release notes", 10)).toEqual(["k/c"]);
		expect(ledger.search("RELEASE", 10)).toEqual(["k/c"]);
		// No NFKC: a half-width query does not find the full-width text, nor the reverse.
		expect(ledger.search("abc", 10)).toEqual([]);
		expect(ledger.search("ＡＢＣ", 10)).toEqual(["k/d"]);
		expect(ledger.search("ａｂｃ", 10)).toEqual([]);
	});

	test("finds a 2-character term, where a trigram index cannot", () => {
		expect(ledger.search("題に", 10)).toEqual(["k/b"]);
	});

	test("an unknown term gives nothing", () => {
		expect(ledger.search("ゾウの飼育", 10)).toEqual([]);
	});

	test("gives the same rows as the ledger's own statement run on the same table", () => {
		// The statement as written in Eumenes' searchDocuments, without the principal, scope and
		// exclusion filters (the evaluation has one reader and no exclusions) and with LIMIT 10.
		const db = new Database(":memory:");
		db.run("CREATE TABLE documents (id TEXT, title TEXT, content TEXT)");
		for (const d of documents)
			db.run("INSERT INTO documents VALUES (?, ?, ?)", [
				d.documentId,
				d.title,
				d.markdown,
			]);
		const original = db
			.query(
				`SELECT id FROM documents
 WHERE (instr(lower(title), lower(?3))>0 OR instr(lower(content), lower(?3))>0)
 ORDER BY id LIMIT 10 OFFSET 0`,
			)
			.all(null, null, "点検") as { id: string }[];
		const byId = new Map(documents.map((d) => [d.documentId, d.key]));
		expect(original.map((r) => byId.get(r.id))).toEqual(
			ledger.search("点検", 10),
		);
		db.close();
	});

	test("the statement keeps the ledger's match rule and ordering", () => {
		expect(LEDGER_SEARCH_SQL).toContain(
			"instr(lower(title), lower(?1))>0 OR instr(lower(content), lower(?1))>0",
		);
		expect(LEDGER_SEARCH_SQL).toContain("ORDER BY id");
	});

	// Reads Eumenes' source when it sits next to this repository; skipped otherwise.
	const eumenesSource = resolve(
		import.meta.dir,
		"../../../eumenes/api/domains/world/repository/documents.ts",
	);
	test.skipIf(!existsSync(eumenesSource))(
		"matches the match rule and ordering of Eumenes' searchDocuments",
		() => {
			const source = readFileSync(eumenesSource, "utf8");
			const start = source.indexOf("export function searchDocuments");
			const body = source.slice(
				start,
				source.indexOf("export function", start + 10),
			);
			expect(body).toContain("instr(lower(title), lower(?3))>0");
			expect(body).toContain("instr(lower(content), lower(?3))>0");
			expect(body).toContain("ORDER BY id");
		},
	);
});

describe("baseline 1: FTS trigram only", () => {
	const documents = [
		doc(
			"k/a",
			"wiki-a",
			"A",
			"# A\n\n水路の点検を毎月行う。点検の記録を残す。\n\n## 二つ目\n\n点検の結果を点検表に記入する。",
		),
		doc("k/b", "wiki-b", "B", "# B\n\nＰＯＳ－Ｘ７ の再起動"),
		doc("k/c", "wiki-c", "C", "# C\n\n点検の話はしない。関係のない本文。"),
	];
	const fts = createFtsTrigramBaseline(documents);

	test("finds a literal phrase of 3 or more characters and lists each document once", () => {
		// Two fragments of k/a hold the phrase; the document is listed once.
		expect(fts.search("点検の", 10).sort()).toEqual(["k/a", "k/c"]);
		expect(fts.search("点検表", 10)).toEqual(["k/a"]);
	});

	test("normalizes with NFKC and lower case on both sides", () => {
		expect(fts.search("pos-x7", 10)).toEqual(["k/b"]);
		expect(fts.search("ＰＯＳ－Ｘ７", 10)).toEqual(["k/b"]);
	});

	test("a query under 3 characters returns nothing (the trigram index cannot match it)", () => {
		expect(fts.search("点検", 10)).toEqual([]);
		expect(fts.search("A", 10)).toEqual([]);
	});

	test("the whole query is one phrase: words that are not adjacent do not match", () => {
		expect(fts.search("水路の 記入", 10)).toEqual([]);
	});

	test("a quote character in the query does not break the phrase", () => {
		expect(fts.search('点検"を', 10)).toEqual([]);
	});
});

test("uniqueInOrder keeps the first occurrence", () => {
	expect(uniqueInOrder(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
});
