import { readFile } from "node:fs/promises";

/**
 * Synthetic Markdown for the examples. Nothing here names a real person, organization or
 * document. The files are read as bytes and decoded with the BOM kept: `Bun.file().text()` and a
 * default `TextDecoder` drop a leading BOM, which would shift every byte offset by 3 and change
 * the document digest (p0/search-storage.md section 6).
 */

export type FixtureName =
	| "canal-guide"
	| "canal-guide-crlf"
	| "canal-guide-bom"
	| "canal-guide-bom-crlf"
	| "shop-log"
	| "reading-memo";

export type FixtureEntry = {
	/** File name in this directory. */
	file: string;
	/** Docling namespace and path the example host registers the document under. */
	namespace: string;
	path: string;
	title: string;
};

export const fixtureCatalog: Readonly<Record<FixtureName, FixtureEntry>> = {
	"canal-guide": {
		file: "canal-guide.md",
		namespace: "notes",
		path: "guides/canal-guide.md",
		title: "星見町の水路管理の手引き",
	},
	"canal-guide-crlf": {
		file: "canal-guide.crlf.md",
		namespace: "notes",
		path: "guides/canal-guide-crlf.md",
		title: "星見町の水路管理の手引き（CRLF）",
	},
	"canal-guide-bom": {
		file: "canal-guide.bom.md",
		namespace: "notes",
		path: "guides/canal-guide-bom.md",
		title: "星見町の水路管理の手引き（BOM）",
	},
	"canal-guide-bom-crlf": {
		file: "canal-guide.bom-crlf.md",
		namespace: "notes",
		path: "guides/canal-guide-bom-crlf.md",
		title: "星見町の水路管理の手引き（BOM・CRLF）",
	},
	"shop-log": {
		file: "shop-log.md",
		namespace: "work",
		path: "logs/shop-log.md",
		title: "架空商店 週次ふりかえり",
	},
	"reading-memo": {
		file: "reading-memo.md",
		namespace: "personal",
		path: "memo/reading-memo.md",
		title: "読書メモ（合成）",
	},
};

export const fixtureNames = Object.keys(fixtureCatalog) as FixtureName[];

/** Decodes UTF-8 bytes strictly and keeps a leading BOM as U+FEFF. */
export function decodeMarkdownBytes(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
		bytes,
	);
}

export async function readFixtureBytes(name: FixtureName): Promise<Uint8Array> {
	const buffer = await readFile(
		new URL(`./${fixtureCatalog[name].file}`, import.meta.url),
	);
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The Markdown of a fixture with its BOM and line endings exactly as stored. */
export async function readFixtureMarkdown(name: FixtureName): Promise<string> {
	return decodeMarkdownBytes(await readFixtureBytes(name));
}

export type FixtureDocument = FixtureEntry & {
	name: FixtureName;
	markdown: string;
};

export async function loadFixtureDocuments(
	names: readonly FixtureName[] = fixtureNames,
): Promise<FixtureDocument[]> {
	return Promise.all(
		names.map(async (name) => ({
			name,
			...fixtureCatalog[name],
			markdown: await readFixtureMarkdown(name),
		})),
	);
}

export function toCrlf(text: string): string {
	return text.replace(/\r?\n/g, "\r\n");
}

export function withBom(text: string): string {
	return text.startsWith("﻿") ? text : `﻿${text}`;
}

export type LargeMarkdownOptions = {
	/** The result has at least this many UTF-8 bytes (and fewer than that plus one section). */
	targetBytes: number;
	lineEnding?: "\n" | "\r\n";
	bom?: boolean;
};

/**
 * A deterministic, synthetic Markdown document of a given size. Every section differs from the
 * others (its index is part of the text), so nothing deduplicates. The text is Japanese with
 * headings, a list, a link, a table and a code block per section.
 */
export function generateLargeMarkdown(options: LargeMarkdownOptions): string {
	const eol = options.lineEnding ?? "\n";
	const parts: string[] = [];
	let bytes = 0;
	const push = (text: string) => {
		parts.push(text);
		bytes += Buffer.byteLength(text);
	};
	if (options.bom) push("﻿");
	push(["# 合成の大きな文書", "", "試験用に生成した文書です。", ""].join(eol));
	for (let i = 1; bytes < options.targetBytes; i++) {
		push(
			[
				`## 第${i}節 水位の記録`,
				"",
				`第${i}節では、地点${i % 17}の水位を ${30 + (i % 41)} cm と記録した。観測は ${i % 24} 時に行った。`,
				"",
				`- 項目A-${i}: 異常なし`,
				`- 項目B-${i}: [台帳](./registry.md#row-${i})を参照`,
				"",
				"| 地点 | 水位(cm) |",
				"| --- | ---: |",
				`| ${i % 17} | ${30 + (i % 41)} |`,
				"",
				"```text",
				`section=${i} checksum=${(i * 2654435761) % 4294967296}`,
				"```",
				"",
			].join(eol),
		);
		parts.push(eol);
		bytes += eol.length;
	}
	return parts.join("");
}
