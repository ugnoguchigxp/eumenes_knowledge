import { describe, expect, test } from "bun:test";
import {
	RELATED_LIMITS,
	type AccessContext,
	type DocumentInput,
} from "../../contracts/index.js";
import { cleanupInTransaction } from "../../sqlite/index.js";
import { docId, makeDoc, rows } from "../harness.fixture.js";
import { makeLinkEnv, scanAndDrain, type LinkEnv } from "./link.fixture.js";
import { readRelated } from "./related.js";

const access = (...namespaces: string[]): AccessContext => ({
	principal: "tester",
	namespaces,
});
const deps = (env: LinkEnv) => ({
	read: <T>(op: (db: LinkEnv["db"]) => T): T => op(env.db),
	clock: env.clock,
	options: { verifiedWithinMs: 10 ** 12 },
});

/** Documents by number: a body, or a body with a path and a namespace. */
type Doc = string | { body: string; path?: string; namespace?: string };

async function store(docs: Record<number, Doc>): Promise<LinkEnv> {
	const env = makeLinkEnv({}, { extractor: "names" });
	put(env, docs);
	await scanAndDrain(env);
	return env;
}
function put(env: LinkEnv, docs: Record<number, Doc>): void {
	for (const [n, doc] of Object.entries(docs)) {
		const d = typeof doc === "string" ? { body: doc } : doc;
		const over: Partial<DocumentInput> = {};
		if (d.path) over.path = d.path;
		if (d.namespace) over.namespace = d.namespace;
		env.source.put(makeDoc(Number(n), d.body, over));
		if (d.namespace && !env.source.namespaces.includes(d.namespace))
			env.source.namespaces.push(d.namespace);
	}
}
const related = (env: LinkEnv, n: number, extra: object = {}, ns = ["wiki"]) =>
	readRelated(deps(env), access(...ns), { documentId: docId(n), ...extra });
const found = (r: ReturnType<typeof related>) =>
	r.results.map((x) => [x.documentId, x.routes, x.links]);

describe("related documents by the links the author wrote (kg2.md §7.14)", () => {
	test("a link relates two documents either way and ranks before shared names", async () => {
		// notes/1.md links to 2; 3 shares a name with 1 and links nowhere.
		const env = await store({
			1: "# 設計\n\nLantern の作業は [こちら](2.md) を見る。\n",
			2: "# 手順\n\n別の話。\n",
			3: "# 記録\n\nLantern の記録。\n",
		});
		const one = related(env, 1);
		expect(found(one)).toEqual([
			[docId(2), ["links"], ["to"]],
			[docId(3), ["entities"], []],
		]);
		const two = related(env, 2);
		expect(found(two)).toEqual([[docId(1), ["links"], ["from"]]]);
		// The pair of fragments: the first fragment of the document linked to, and the fragment
		// that holds the link.
		const [pair] = two.results[0]?.passages ?? [];
		expect(pair?.routes).toEqual(["links"]);
		const quote = (n: number, p: { byteStart: number; byteEnd: number }) =>
			rows(
				env.db,
				`SELECT f.text FROM knowledge_fragments f JOIN knowledge_documents d
 ON d.published_version_id = f.version_id WHERE d.document_id = ? AND f.byte_start = ? AND f.byte_end = ?`,
				docId(n),
				p.byteStart,
				p.byteEnd,
			)[0]?.text as string;
		expect(quote(1, pair?.related as never)).toContain("[こちら](2.md)");
		expect(pair?.document.fragmentOrdinal).toBe(0);
		// Two documents that link to each other: both directions, one result.
		const both = await store({
			1: "[B](2.md) へ。",
			2: "[A](1.md) へ。",
		});
		expect(found(related(both, 1))).toEqual([
			[docId(2), ["links"], ["to", "from"]],
		]);
	});

	test("an index's links rank after shared names, before the embedding alone", async () => {
		// 1 links to 2 and to 20 other paths: an index. 3 shares a name with 1.
		const index = [
			"# 目次",
			"",
			"[こちら](2.md)",
			...Array.from(
				{ length: RELATED_LIMITS.indexLinks },
				(_, i) => `[x](x${i}.md)`,
			),
			"",
			"Lantern の目次。",
		].join("\n");
		const env = await store({
			1: index,
			2: "# 手順\n\n別の話。\n",
			3: "Lantern の記録。\n",
		});
		expect(found(related(env, 1))).toEqual([
			[docId(3), ["entities"], []],
			[docId(2), ["links"], ["to"]],
		]);
		// From 2's side the link is the index's too.
		const env2 = await store({
			1: index,
			2: "# 手順\n\n手順 Zircon。\n",
			4: "Zircon の話。\n",
		});
		expect(found(related(env2, 2))).toEqual([
			[docId(4), ["entities"], []],
			[docId(1), ["links"], ["from"]],
		]);
	});

	test("links resolve against the documents' paths as they are now", async () => {
		const env = await store({
			1: { body: "[B](../b/2.md) を見る。", path: "a/1.md" },
			2: { body: "B の話。", path: "b/2.md" },
			3: { body: "C の話。", path: "/root.md" },
			4: { body: "[R](/root.md) と [R2](../root.md)。", path: "a/4.md" },
		});
		expect(found(related(env, 1))).toEqual([[docId(2), ["links"], ["to"]]]);
		// A path with a leading slash is found by a link from the root, or relative to it.
		expect(found(related(env, 3))).toEqual([[docId(4), ["links"], ["from"]]]);
		// 1 moves (its body is the same, so it is not read again): its link now names c/b/2.md.
		put(env, { 1: { body: "[B](../b/2.md) を見る。", path: "c/d/1.md" } });
		await scanAndDrain(env);
		expect(
			rows(
				env.db,
				"SELECT path FROM knowledge_documents WHERE document_id = ?",
				docId(1),
			),
		).toEqual([{ path: "c/d/1.md" }]);
		expect(found(related(env, 1))).toEqual([]);
		expect(found(related(env, 2))).toEqual([]);
	});

	test("no link from code, across namespaces, to the document itself, or when the route is not asked", async () => {
		const env = await store({
			1: "```\n[B](2.md)\n```\n`[B](2.md)` と [自分](1.md)。\n",
			2: "B の話。",
			5: { body: "[B](2.md) へ。", namespace: "other" },
			6: { body: "[A](1.md) へ。" },
		});
		// (Hrefs are names too: 1 and 6 share the name 1.md, which the entities route finds.)
		const linked = (r: ReturnType<typeof related>) =>
			r.results
				.filter((x) => x.links.length > 0)
				.map((x) => [x.documentId, x.links]);
		expect(linked(related(env, 1))).toEqual([[docId(6), ["from"]]]);
		// 5 is in another namespace: its link names notes/2.md there, not here.
		expect(linked(related(env, 2, {}, ["wiki", "other"]))).toEqual([]);
		const without = related(env, 1, { routes: ["entities", "embedding"] });
		expect(linked(without)).toEqual([]);
		expect(without.results.some((x) => x.routes.includes("links"))).toBe(false);
		expect(found(related(env, 1, { routes: ["links"] }))).toEqual([
			[docId(6), ["links"], ["from"]],
		]);
	});

	test("links to files of the same name in other folders do not hide the links to this one", async () => {
		// 1 links to more README.md files of other folders than the links used; 3, ingested later,
		// links to 2's.
		const many = Array.from(
			{ length: RELATED_LIMITS.linksToDocument + 5 },
			(_, i) => `[r](d${i}/README.md)`,
		).join("\n");
		const env = await store({
			1: many,
			2: { body: "Z の話。", path: "notes/z/README.md" },
			3: "[Z](z/README.md) へ。",
		});
		const r = related(env, 2);
		expect(
			r.results.filter((x) => x.links.length > 0).map((x) => x.documentId),
		).toEqual([docId(3)]);
		expect(r.partialReasons).not.toContain("response_truncated");
	});

	test("links are written with the fragments, again on re-extraction, and go with their version", async () => {
		const env = await store({ 1: "[B](2.md) と [C](sub/3.md#a)。", 2: "B。" });
		const links = () =>
			rows(
				env.db,
				"SELECT version_id, fragment_ordinal, href, target_name FROM knowledge_document_links ORDER BY version_id, href",
			);
		const first = links();
		expect(first.map((r) => [r.href, r.target_name])).toEqual([
			["2.md", "2.md"],
			["sub/3.md", "3.md"],
		]);
		// A new body: a new version, and the old version's links go with the cleanup.
		put(env, { 1: "[D](4.md)。" });
		await scanAndDrain(env);
		while (cleanupInTransaction(env.db, 1000, { now: env.clock.now() }).more);
		const second = links();
		expect(second.map((r) => r.href)).toEqual(["4.md"]);
		expect(second[0]?.version_id).not.toBe(first[0]?.version_id);
	});
});
