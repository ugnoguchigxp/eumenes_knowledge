# eumenes_knowledge

Eumenes に集約した Markdown 文書を、会話・制作・coding agent から同じ知識として使うための文書知識ライブラリです。文書の検索、対象と関係の抽出、関連文書の探索、引用根拠の取得を担います。

## 現在の状態

**開発中です。索引の作成と、検索・関連探索・根拠取得（P0〜P3）まで実装し、合成資料と mock による検証を通しています。** 続けて、取り込んだ結果をグラフとして取り出す口を足し、合成の調査資料を実モデル（LARM）で取り込んで確かめました（KG）。CLI・MCP（P4）と Eumenes への導入（P6）はまだです。

| 段階 | 状態 | 文書 |
| --- | --- | --- |
| P0 契約・採用範囲 | 確定（利用者が承認） | [p0.md](p0.md) |
| P1 配布骨格・examples ホスト | 実装済み・固定検証済み | [p1.md](p1.md) |
| P2 分割・抽出・ベクトル・根拠・失効 | 実装済み・固定検証済み | [p2.md](p2.md) |
| P3 検索・関連探索・根拠取得 | 実装済み・固定検証済み | [p3.md](p3.md) |
| KG グラフの読み取り・実モデルでの試行 | 実装済み。実モデルで 1 回実行した（examples の中だけ） | [kg.md](kg.md) |
| P4 CLI・MCP | 未着手（入口のスタブだけ） | — |
| P5 tgz 受入 | 配布の検査は通る。clean な commit からの受入は未実施 | — |
| P6 Eumenes 統合 | 未着手。examples で十分に検証してから着手する | — |

固定の検証は、すべて合成資料と scripted mock によるものです。実モデルでの実行は、合成の調査 4 文書で 1 回だけ行いました（LARM 経由。実 Docling は使っていません）。結果と見つかった問題は [kg.md](kg.md) §6 にあります。検索の意味の品質は、まだ確かめていません。

## できること（P3 まで）

- Docling の一覧を観測し、文書の登録簿に版（`markdownSha256`）と状態を記録します。recovery だけの変更では取り込み直しません。404・403・許可領域外は `unavailable` で、削除とは扱いません。
- 登録簿の `stale` の文書を 1 件ずつ取り込む連鎖ジョブで、次を行います。
  - 本文を見出し・段落・行・書記素の境界で、2,048 UTF-8 byte 以下の断片に分けます（重なりなし、本文全体を覆う）。
  - 断片ごとに LLM で対象・関係を抽出し、strict な schema で検証します。引用が断片の原文にそのまま現れるかを照合し、UTF-8 の byte 範囲と digest をコードが計算します。
  - 断片を埋め込み、全文索引（FTS5 trigram）とベクトル（float32）を作ります。
  - 見えない作業領域へ短い transaction で書き、再検査の後に公開版を切り替えます。旧版は片付けます。
- 取消・期限切れ・再起動・新版・接続の変更では、古い結果を適用しません。一時的な障害は待ち時間の後で取り込み直し、内容の不正は 3 回で `failed_documents` にします。
- 検索は、断片の全文索引（2 文字の query は部分一致の走査）・ベクトル・対象の言及・関係の 4 経路の候補を、順位だけで統合します（RRF）。得点は返さず、文書 ID・版・byte 範囲・引用 digest と、どの経路で何位だったかを返します。未処理・失敗・予算の打切りがあれば `complete: false` と理由を返します。
- 根拠取得で、回答に使う直前に引用の範囲が今も有効か（`valid`・`stale`・`unavailable`・`mismatch`・`not_available`）を確かめます。
- 文書をまたぐ同一視は、候補を機械的に絞り、同じかどうかを LLM が判断して由来付きで保存します。関連文書は、共有する実体ごとに両方の根拠と判断の由来を返します。範囲外の言及を橋にせず、範囲外の言及を含む要約は返しません。
- グラフの読み取り（`POST /api/knowledge/graph`）は、同一視で `same` とされた言及をノードに、関係の言及を辺にまとめて返します。`different` の判断と矛盾するリンクは使いません。ノードと辺には引用の根拠が付きます。
- 検索・根拠取得・関連文書・グラフは、ホストが認証から束縛した namespace だけを読みます（fail-closed）。
- ジョブは Eumenes の queue の `HandlerDefinition` と同じ形で export しています。examples のホストと、将来の Eumenes は同じ定義を実行します。

## Eumenes との関係

- 本番の索引・グラフ・取り込み状態は Eumenes の SQLite が所有します。単一 writer、queue、認証、LARM の接続は Eumenes のものを再利用します。パッケージは DB の接続や transaction を自分で作りません。
- Docling Desk が Markdown の正本です。パッケージは派生データ（索引）だけを持ち、正本に書き込みません。
- CLI と MCP は、Eumenes の認証付き API を呼ぶクライアントです。別の DB や索引は持ちません。
- 配布は、実行用 JavaScript と型定義を含む tgz です。

## 構成

| 場所 | 内容 |
| --- | --- |
| `src/contracts/` | 文書・認可・ホストの port・ジョブ・API・抽出結果の契約（Zod） |
| `src/core/` | 分割（`text/`）、抽出の要求と検証（`extract/`）、検索と根拠取得（`search/`）、同一視・要約・関連文書（`link/`）、ジョブ（`jobs/`） |
| `src/sqlite/` | migration と transaction 内の操作、読み取り |
| `src/contexts/` | 版付きの指示資源（`extract` v1・v2、`link` v1・v2、`summarize` v1。ジョブは最も高い版を使う） |
| `src/client/` | Eumenes の公開 API の client と接続設定 |
| `src/cli/`、`src/mcp/` | P4 で実装する入口のスタブ |
| `examples/` | Eumenes の実行環境のエミュレーター（[examples/README.md](examples/README.md)）。`examples/larm/` は Eumenes と同じ手順の LARM 接続、`examples/corpus/ai-memory/` は実モデルの試行に使う合成の調査資料と正解表 |
| `scripts/` | build・manifest・pack・検証・比較評価（`eval:search`）、実モデルでの試行（`kg-live.ts`）とグラフを見るページの生成（`kg-view.ts`）のスクリプト |
| `verification/` | 比較評価の記録（fixture の結果。意味の品質を示さない）と、実モデルでの試行の記録（`kg-ai-memory/`） |
| `p0/` | P0 の調査資料と方式確認用の spike（製品コードではない） |

## 開発

```sh
bun install
bun run verify           # 指示資源の生成物・format・lint・型検査・全試験
bun run examples:verify  # examples の全試験（待受・子プロセス・一時ディレクトリが残らないことも検査）
bun run release          # build・manifest・tgz の作成（out/）
bun run verify:imports   # import しただけで DB・ネットワーク・タイマーなどが動かないことの検査
bun run verify:package   # tgz だけを clean な consumer に導入して検査
bun run eval:search      # 合成資料での検索の比較（本パッケージと 2 つの基準）を verification/ に記録
```

ネットワークの待受や外部サービスへの接続はしません。HTTP は in-process で呼び、一時 DB は OS の一時ディレクトリに作って片付けます。

実モデルでの試行だけは、LARM に接続します（手で実行するもので、上の検証には含みません）。

```sh
LARM_API_TOKEN=… KG_LARM_BASE_URL=… KG_LARM_PROFILE=… KG_LARM_AUDIENCE=… \
  bun scripts/kg-live.ts [--docs <拡張子なしの名前>,…] [--max-minutes 240]   # verification/kg-ai-memory/<時刻>-<profile>/ に graph.json と report.json
bun scripts/kg-view.ts verification/kg-ai-memory/<時刻>-<profile>   # 同じ場所に graph.html
```

4 文書の取り込みには約 4 時間かかりました（大半は同一視）。

## 技術スタック

| 分野 | 採用 |
| --- | --- |
| 実行環境 | Bun 1.4.4 |
| 言語 | TypeScript 7.0.2（ESM、`.d.ts` を同梱） |
| 契約 | Zod 4.4.3 |
| 保存・検索 | `bun:sqlite`（FTS5 trigram、float32 BLOB のベクトル）。native 拡張は使いません |
| HTTP | Hono（examples のホスト）、標準の Request/Response・fetch |
| MCP | `@modelcontextprotocol/server`（v2 系列、ローカル stdio。P4 で導入） |
| 検査 | `bun test`、`bun check`、`bun fmt`、oxlint |

## 文書

| ファイル | 内容 |
| --- | --- |
| [plan.md](plan.md) | 開発計画（目的、所有境界、段階 P0〜P6、受入条件） |
| [p0.md](p0.md) | P0 判断書（確定事項、契約、受入値、判断事項） |
| [p1.md](p1.md) | P1 の設計、Eumenes の queue との整合、実施結果 |
| [p2.md](p2.md) | P2 の設計（取り込みの連鎖、抽出、保存と失効）、実施結果 |
| [p3.md](p3.md) | P3 の設計（検索、根拠取得、比較評価、同一視・要約・関連文書）、実施結果 |
| [kg.md](kg.md) | KG の設計（グラフの読み取り、文書の中の同一視、指示 v2、LARM 接続）、実モデルでの結果と問題 |
| [p0/lightrag.md](p0/lightrag.md) | LightRAG の参照 commit の固定と移植範囲 |
| [p0/mcp-cli.md](p0/mcp-cli.md) | MCP SDK の選定と CLI/MCP の接続方式 |
| [p0/search-storage.md](p0/search-storage.md) | SQLite の全文・ベクトル検索、引用 byte 範囲、検証用 writer の測定 |
| [p0/distribution.md](p0/distribution.md) | tgz 配布・build・manifest と Eumenes 側の導入接点 |

## ライセンス

[MIT](LICENSE)。[LightRAG](https://github.com/HKUDS/LightRAG)（MIT）の抽出・要約の指示を翻案した部分を含みます。上流の著作権表示・ライセンス全文・翻案の対応は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。
