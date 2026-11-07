// chunker の処理時間（合成の約 9 MiB 日本語 Markdown）。docling の maxMarkdownBytes 本番 8 MiB 相当の規模感。
import { chunkMarkdown } from "./chunker.ts";
const rows: unknown[] = [];
for (const [mib, cap] of [[1, 2048], [8, 2048], [8, 256]] as const) {
	let md = "", i = 0;
	while (Buffer.byteLength(md) < mib * 2 ** 20) { md += `## 見出し${i}\n\n` + "これはテスト用の合成文章。".repeat(8) + "\n\n"; i++; }
	const t = performance.now();
	const r = chunkMarkdown(md, { maxBytes: cap });
	rows.push({ bytesMiB: +(r.bytes.length / 2 ** 20).toFixed(2), maxBytes: cap, headings: i, fragments: r.fragments.length, ms: +(performance.now() - t).toFixed(0) });
}
console.table(rows);
await Bun.write(new URL("../results/chunk-perf.json", import.meta.url), JSON.stringify(rows, null, 1));
