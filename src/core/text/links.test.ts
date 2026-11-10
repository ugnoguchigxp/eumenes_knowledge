import { describe, expect, test } from "bun:test";
import {
	documentHref,
	documentPath,
	LINKS_PER_FRAGMENT,
	linkName,
	markdownLinks,
	resolveLink,
} from "./links.js";

describe("Markdown links to other documents (kg2.md §7.14)", () => {
	test("inline links and reference definitions to Markdown files, in order, each once", () => {
		const text = [
			'設計は [設計書](design.md) と [運用](<ops/run book.md> "運用") を見る。',
			"また [設計書](./design.md#目次) と [前の版](design.md?v=1)。",
			"",
			"[ref]: ../spec/api.markdown",
			"  [other]: <notes/a.md> 'title'",
		].join("\n");
		expect(markdownLinks(text)).toEqual([
			"design.md",
			"ops/run book.md",
			"./design.md",
			"../spec/api.markdown",
			"notes/a.md",
		]);
	});

	test("no image, URL, anchor or file that is not Markdown", () => {
		const text = [
			"![図](figure.md) [サイト](https://example.com/a.md) [x](mailto:a@b.md)",
			"[上](#heading) [コード](src/index.ts) [表](data.json) [//](//host/a.md)",
			"[フォルダ](docs/) [パス](file:///tmp/a.md)",
		].join("\n");
		expect(markdownLinks(text)).toEqual([]);
	});

	test("code holds no link: fenced blocks (the body's structure) and inline code spans", () => {
		const fence = "```md\n[x](in-code.md)\n```";
		const text = `${fence}\n\`[y](span.md)\` と \`\`[z](\`two\`.md)\`\` と [ok](ok.md)。`;
		expect(markdownLinks(text, [{ start: 0, end: fence.length }])).toEqual([
			"ok.md",
		]);
	});

	test("a link around an image (a badge) and an href with one pair of parentheses", () => {
		expect(
			markdownLinks("[![badge](x.png)](a.md) [a](b(1).md) ![図](c.md)"),
		).toEqual(["a.md", "b(1).md"]);
	});

	test("text made to slow a pattern is read in time linear in its length", () => {
		for (const text of [
			`x${"`".repeat(4000)}`,
			`[${"![a]".repeat(1000)}`,
			`[${"[a](b)".repeat(700)}`,
			`[${"![a](b)".repeat(600)}]`,
			"[".repeat(4000),
			`[a](${"(b)".repeat(1300)}`,
		]) {
			const t0 = performance.now();
			markdownLinks(text);
			expect(performance.now() - t0).toBeLessThan(50);
		}
		// A run of backticks pairs with the next run of its length; a run with none is text.
		expect(markdownLinks("`` [a](a.md) ` [b](b.md) ``")).toEqual([]);
		expect(markdownLinks("``` [a](a.md) `` [b](b.md)")).toEqual([
			"a.md",
			"b.md",
		]);
	});

	test("percent-encoded hrefs are decoded; the number per fragment is bounded", () => {
		expect(documentHref("%E8%A8%AD%E8%A8%88.md")).toBe("設計.md");
		expect(documentHref("100%.md")).toBe("100%.md");
		expect(documentHref("<a b.md>")).toBe("a b.md");
		expect(documentHref("a\0.md")).toBeNull();
		const many = Array.from(
			{ length: LINKS_PER_FRAGMENT + 5 },
			(_, i) => `[d](d${i}.md)`,
		).join(" ");
		expect(markdownLinks(many)).toHaveLength(LINKS_PER_FRAGMENT);
	});

	test("an href resolves against the linking document's folder, or the root with /", () => {
		expect(resolveLink("notes/1.md", "2.md")).toBe("notes/2.md");
		expect(resolveLink("notes/1.md", "./sub/2.md")).toBe("notes/sub/2.md");
		expect(resolveLink("spec/a/1.md", "../../docs/x.md")).toBe("docs/x.md");
		expect(resolveLink("spec/1.md", "/docs/x.md")).toBe("docs/x.md");
		expect(resolveLink("1.md", "x.md")).toBe("x.md");
		expect(resolveLink("/spec/./1.md", "x.md")).toBe("spec/x.md");
		// Out of the root: no document.
		expect(resolveLink("spec/1.md", "../../x.md")).toBeNull();
		expect(documentPath("./a//b.md")).toBe("a/b.md");
		expect(documentPath("..")).toBeNull();
		expect(linkName("Docs/Read Me.MD")).toBe("read me.md");
	});
});
