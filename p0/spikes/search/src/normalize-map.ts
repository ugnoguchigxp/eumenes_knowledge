// spike: 検索用に NFKC + 小文字化した断片テキストから、元の Markdown の byte 範囲へ戻す。
// 方法: 書記素ごとに正規化し、{正規化後 UTF-16 区間 <-> 元 byte 区間} の対応表を持つ。
// 一致区間は書記素の境界へ外側に丸める（元範囲 >= 一致範囲）。
import { buildByteMap } from "./chunker.ts";

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
export const normalizeText = (s: string) => s.normalize("NFKC").toLowerCase();

export interface NormalizedFragment {
	normalized: string;
	/** 正規化後文字列の UTF-16 区間 [ns, ne) に対応する、元の byte 範囲（絶対値）。書記素単位に外側へ丸める。 */
	toOriginal(ns: number, ne: number): { start: number; end: number };
	/** 正規化済み query の全出現を元の byte 範囲に変換 */
	findAll(query: string): { start: number; end: number }[];
}

export function normalizeFragment(fragmentText: string, fragmentStartByte: number): NormalizedFragment {
	const map = buildByteMap(fragmentText);
	const nStart: number[] = [], oStart: number[] = [], oEnd: number[] = [];
	let normalized = "";
	for (const seg of graphemes.segment(fragmentText)) {
		nStart.push(normalized.length);
		oStart.push(fragmentStartByte + map[seg.index]!);
		oEnd.push(fragmentStartByte + map[seg.index + seg.segment.length]!);
		normalized += normalizeText(seg.segment);
	}
	const clusterAt = (idx: number) => {
		let lo = 0, hi = nStart.length - 1;
		while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nStart[mid]! <= idx) lo = mid; else hi = mid - 1; }
		return lo;
	};
	const toOriginal = (ns: number, ne: number) => {
		if (!(ns >= 0 && ne > ns && ne <= normalized.length)) throw new Error("normalized_range");
		return { start: oStart[clusterAt(ns)]!, end: oEnd[clusterAt(ne - 1)]! };
	};
	return {
		normalized,
		toOriginal,
		findAll(query) {
			const q = normalizeText(query);
			const out: { start: number; end: number }[] = [];
			if (!q) return out;
			for (let i = normalized.indexOf(q); i >= 0; i = normalized.indexOf(q, i + 1)) out.push(toOriginal(i, i + q.length));
			return out;
		},
	};
}
