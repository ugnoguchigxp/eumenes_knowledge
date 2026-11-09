// The local judging page of kg-heldout.ts: one self-contained HTML file a person opens from disk
// (never published: it holds sentences of their own notes). Every text is put in with
// textContent; the data is embedded as JSON with `<` escaped, so no note can close the script.

export type JudgeItem =
	| {
			id: string;
			kind: "name";
			name: string;
			sentence: string;
	  }
	| {
			id: string;
			kind: "edge";
			source: string;
			target: string;
			sentence: string;
	  };

export const NAME_CHOICES = ["proper", "not_proper", "unsure"] as const;
export const EDGE_CHOICES = ["A", "B", "C", "unsure"] as const;

/** JSON safe inside a `<script>` element: no `<`, and no line separators JavaScript rejects. */
export const scriptJson = (value: unknown): string =>
	JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replaceAll(String.fromCharCode(0x2028), "\\u2028")
		.replaceAll(String.fromCharCode(0x2029), "\\u2029");

export function judgePage(
	sampleDigest: string,
	items: readonly JudgeItem[],
): string {
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>名前と辺の判定</title>
<style>
:root { --bg: #fbfbf9; --fg: #1d1d1b; --muted: #6b6b66; --line: #deded8; --mark: #fff1a8; --pick: #2f5fd0; --pick-fg: #ffffff; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #a3a39d; --line: #34342f; --mark: #5a4d00; --pick: #7aa2ff; --pick-fg: #0d0d0c; --card: #1f1f1d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Hiragino Sans", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 96px; }
h1 { font-size: 1.3rem; margin: 0 0 8px; }
h2 { font-size: 1.05rem; margin: 32px 0 8px; }
p, li { color: var(--muted); }
.item { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
.head { font-weight: 600; margin-bottom: 4px; }
.sentence { white-space: pre-wrap; overflow-wrap: anywhere; }
mark { background: var(--mark); color: inherit; padding: 0 2px; border-radius: 2px; }
.choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
button { font: inherit; font-size: 0.9rem; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
button[aria-pressed="true"] { background: var(--pick); border-color: var(--pick); color: var(--pick-fg); }
.bar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--card); border-top: 1px solid var(--line); padding: 10px 16px; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; }
textarea { width: 100%; min-height: 120px; margin-top: 12px; font: 12px/1.4 ui-monospace, monospace; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; }
</style>
</head>
<body>
<main>
<h1>名前と辺の判定</h1>
<p>手元のメモから無作為に抜いた名前と辺です。このページはどこにも送られません。判定は、このブラウザの中にだけ残ります。終わったら「結果を書き出す」を押し、出たファイル（または下の欄の文字）を Claude に渡してください。</p>
<h2>名前（日本語だけで書かれ、固有名とされたもの）</h2>
<ul>
<li>固有名: 人・組織・場所・製品・計画などの名前</li>
<li>固有名でない: 一般の語、語の切れ方がおかしいもの</li>
</ul>
<div id="names"></div>
<h2>辺（同じ文に出た 2 つの固有名）</h2>
<ul>
<li>A: 文が 2 つのあいだの関係を述べている</li>
<li>B: 並べて触れているだけ</li>
<li>C: 誤り（名前が違う、雑音）</li>
</ul>
<div id="edges"></div>
<textarea id="out" readonly hidden></textarea>
</main>
<div class="bar"><span id="progress"></span><button id="export" type="button">結果を書き出す</button></div>
<script>
const DIGEST = ${scriptJson(sampleDigest)};
const ITEMS = ${scriptJson(items)};
const LABELS = {
	name: [["proper", "固有名"], ["not_proper", "固有名でない"], ["unsure", "分からない"]],
	edge: [["A", "A 関係を述べている"], ["B", "B 並べているだけ"], ["C", "C 誤り"], ["unsure", "分からない"]],
};
const KEY = "kg-heldout:" + DIGEST;
let judgments = {};
try { judgments = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { judgments = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(judgments)); } catch {} };

function highlighted(sentence, words) {
	const span = document.createElement("div");
	span.className = "sentence";
	let rest = sentence;
	while (rest.length > 0) {
		let at = -1, word = "";
		for (const w of words) {
			const i = w ? rest.indexOf(w) : -1;
			if (i >= 0 && (at < 0 || i < at)) { at = i; word = w; }
		}
		if (at < 0) { span.append(rest); break; }
		span.append(rest.slice(0, at));
		const m = document.createElement("mark");
		m.textContent = word;
		span.append(m);
		rest = rest.slice(at + word.length);
	}
	return span;
}

function render() {
	for (const item of ITEMS) {
		const box = document.createElement("div");
		box.className = "item";
		const head = document.createElement("div");
		head.className = "head";
		head.textContent = item.kind === "name" ? item.name : item.source + " — " + item.target;
		box.append(head, highlighted(item.sentence, item.kind === "name" ? [item.name] : [item.source, item.target]));
		const choices = document.createElement("div");
		choices.className = "choices";
		for (const [value, label] of LABELS[item.kind]) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = label;
			b.setAttribute("aria-pressed", String(judgments[item.id] === value));
			b.addEventListener("click", () => {
				judgments[item.id] = value;
				save();
				for (const other of choices.children) other.setAttribute("aria-pressed", String(other === b));
				progress();
			});
			choices.append(b);
		}
		box.append(choices);
		document.getElementById(item.kind === "name" ? "names" : "edges").append(box);
	}
	progress();
}

function progress() {
	const done = ITEMS.filter((i) => judgments[i.id]).length;
	document.getElementById("progress").textContent = done + " / " + ITEMS.length + " 件を判定";
}

document.getElementById("export").addEventListener("click", () => {
	const text = JSON.stringify({ sampleDigest: DIGEST, judgments }, null, 1);
	const out = document.getElementById("out");
	out.hidden = false;
	out.value = text;
	try {
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
		a.download = "judgments.json";
		a.click();
	} catch {}
});

render();
</script>
</body>
</html>
`;
}
