# 評価用の合成資料（eval:search）

`bun run eval:search`（`scripts/eval-search.ts`）が使う fixture。架空の題材の日本語 Markdown で、実在の人物・組織・文書は無い。結果は意味の品質を示さない（p3.md §6）。

| 場所 | 内容 |
| --- | --- |
| `corpus/<namespace>/<path>.md` | 既知の組の資料（質問の作成時に見ていた資料） |
| `corpus-unseen/<namespace>/<path>.md` | 未見の組の資料（語句・対象・場面を変えたもの）。質問と一緒に分けて持つ |
| `extraction.json` | 抽出の台本。文書キー（`<namespace>/<path>`）ごとに対象と関係。引用は `chunkMarkdown` で得た断片の原文から取る。推論の mock は呼出し順で応答を選ぶので、評価の側が断片の順に並べて渡す |
| `questions.json` | 質問。`expected` は正解の文書キー（空なら正解なし）、`kind` は質問の種類、`set` は `seen` / `unseen` |
| `manifest.json` | 資料・台本・質問それぞれの版と digest（既知の組・未見の組の digest も別に持つ） |

質問の種類: `verbatim`（語句がそのまま本文にある）、`variant_width`（全角半角・大文字小文字）、`variant_orthography`（台本だけが持つ別の書き方）、`entity_name`（対象の名前）、`relation`（台本の関係の語句）、`short2`（2 文字）、`semantic`（言い換え。意味を持つ埋め込みが要る）、`no_answer`（正解なし）。

fixture を変えたら `bun scripts/eval/update-manifest.ts` で `manifest.json` を作り直す（digest が変わった入力の版が 1 上がる）。`bun test scripts/eval` が、manifest・台本の引用・質問の正解の整合を確かめる。
