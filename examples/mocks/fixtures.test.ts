import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	decodeMarkdownBytes,
	fixtureNames,
	generateLargeMarkdown,
	loadFixtureDocuments,
	readFixtureBytes,
	readFixtureMarkdown,
	toCrlf,
	withBom,
} from "../fixtures/index.js";

const sha = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");

describe("fixtures", () => {
	test("every fixture decodes strictly and re-encodes to the same bytes", async () => {
		for (const name of fixtureNames) {
			const bytes = await readFixtureBytes(name);
			const text = await readFixtureMarkdown(name);
			expect(sha(Buffer.from(text, "utf8"))).toBe(sha(bytes));
		}
	});

	test("BOM variants keep the BOM; the default decoders would lose it", async () => {
		const bytes = await readFixtureBytes("canal-guide-bom");
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const text = await readFixtureMarkdown("canal-guide-bom");
		expect(text.startsWith("﻿")).toBe(true);
		expect(new TextDecoder().decode(bytes).startsWith("﻿")).toBe(false);
		expect(
			(
				await Bun.file(
					new URL("../fixtures/canal-guide.bom.md", import.meta.url),
				).text()
			).startsWith("﻿"),
		).toBe(false);
		expect(Buffer.byteLength(text)).toBe(bytes.byteLength);
	});

	test("CRLF variants keep CRLF; the LF file has none", async () => {
		const lf = await readFixtureMarkdown("canal-guide");
		expect(lf).not.toContain("\r");
		const crlf = await readFixtureMarkdown("canal-guide-crlf");
		expect(crlf).toContain("\r\n");
		expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
		expect(crlf).toBe(toCrlf(lf));
		expect(await readFixtureMarkdown("canal-guide-bom")).toBe(withBom(lf));
		expect(await readFixtureMarkdown("canal-guide-bom-crlf")).toBe(
			withBom(toCrlf(lf)),
		);
	});

	test("the guide has the structures the examples need", async () => {
		const text = await readFixtureMarkdown("canal-guide");
		expect(text.startsWith("---\n")).toBe(true);
		expect(text).toContain("](https://example.com/");
		expect(text).toContain("```ts");
		expect(text).toContain("| --- |");
		expect(text).toContain("\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}");
		expect(text).toContain("が");
		expect(text).toContain("é");
	});

	test("namespaces differ across documents and paths are unique", async () => {
		const docs = await loadFixtureDocuments();
		expect(new Set(docs.map((d) => d.namespace)).size).toBeGreaterThanOrEqual(
			3,
		);
		expect(new Set(docs.map((d) => `${d.namespace}/${d.path}`)).size).toBe(
			docs.length,
		);
	});

	test("decodeMarkdownBytes is strict about invalid UTF-8", () => {
		expect(() =>
			decodeMarkdownBytes(new Uint8Array([0xff, 0xfe, 0x41])),
		).toThrow();
	});

	test("generateLargeMarkdown is deterministic and reaches the size", () => {
		const a = generateLargeMarkdown({ targetBytes: 50_000 });
		expect(a).toBe(generateLargeMarkdown({ targetBytes: 50_000 }));
		expect(Buffer.byteLength(a)).toBeGreaterThanOrEqual(50_000);
		expect(Buffer.byteLength(a)).toBeLessThan(52_000);
		const crlf = generateLargeMarkdown({
			targetBytes: 5_000,
			lineEnding: "\r\n",
			bom: true,
		});
		expect(crlf.startsWith("﻿")).toBe(true);
		expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
		expect(new Set(a.split("\n## ")).size).toBe(a.split("\n## ").length);
	});
});
