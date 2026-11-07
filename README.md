# eumenes_knowledge

Eumenes に集約した Markdown 文書を、会話・制作・coding agent から同じ知識として使うための文書知識ライブラリです。文書の検索、対象と関係の抽出、関連文書の探索、引用根拠の取得を担います。

## 現在の状態

**計画段階です。ライブラリ本体、examples、CLI、MCP はまだ実装していません。**

- 開発計画（[plan.md](plan.md)）を作成済みです。
- P0（契約・採用範囲の確定）の判断書（[p0.md](p0.md)）は、受入値と判断事項が承認待ちです。
- `p0/spikes/` にあるのは、方式を確かめるための検証用コードです。製品コードではなく、そのまま配布物には入れません。
- Eumenes への導入は、examples（mock のホスト）と clean な tgz 導入で十分に検証した後に行います。

## 目指すもの

以下は計画の内容で、実装済みの機能ではありません。

- Docling Desk が正本として持つ Markdown 文書を取り込み、断片・対象・関係の索引を作ります。
- 検索結果は、文書ID・版・本文 digest・UTF-8 の byte 範囲・引用 digest を返します。検索の完全性、未処理の範囲、失効の状態も返します。
- 文書の新版、利用除外、権限の変更、取り下げに応じて、索引上の根拠を失効させます。古い推論結果は採用しません。
- 意味の判断（対象の解釈、関係の分類、同一性）は LLM が行います。コードは schema、引用の一致、版、認可、transaction、実行制御を担います。
- [LightRAG](https://github.com/HKUDS/LightRAG) の抽出指示と検索経路の一部を、TypeScript へ選んで移植します。そのまま梱包はしません。

## Eumenes との関係

- 本番の索引・グラフ・取り込み状態は Eumenes の SQLite が所有します。単一 writer、queue、認証、LARM の接続は Eumenes のものを再利用します。
- Eumenes はこのパッケージをライブラリとして直接使います。CLI と MCP は、Eumenes の認証付き API を呼ぶクライアントです。別の DB や索引は持ちません。
- 配布は、実行用 JavaScript と型定義を含む tgz です。

## 技術スタック（予定）

| 分野 | 採用 |
| --- | --- |
| 実行環境 | Bun 1.4.4 |
| 言語 | TypeScript 7.0.2（ESM、`.d.ts` を同梱） |
| 契約 | Zod 4.4.3 |
| 保存・検索 | `bun:sqlite`（FTS5 trigram、float32 BLOB のベクトル）。native 拡張は使いません |
| HTTP | Hono、標準の Request/Response・fetch |
| MCP | `@modelcontextprotocol/server`（v2 系列、ローカル stdio） |
| 検査 | `bun test`、`bun check`、`bun fmt`、oxlint |

## 文書

| ファイル | 内容 |
| --- | --- |
| [plan.md](plan.md) | 開発計画（目的、所有境界、段階 P0〜P6、受入条件） |
| [p0.md](p0.md) | P0 判断書（確定事項、契約案、受入値の案、承認待ちの判断事項） |
| [p0/lightrag.md](p0/lightrag.md) | LightRAG の参照 commit の固定と移植範囲 |
| [p0/mcp-cli.md](p0/mcp-cli.md) | MCP SDK の選定と CLI/MCP の接続方式 |
| [p0/search-storage.md](p0/search-storage.md) | SQLite の全文・ベクトル検索、引用 byte 範囲、検証用 writer の測定 |
| [p0/distribution.md](p0/distribution.md) | tgz 配布・build・manifest と Eumenes 側の導入接点 |

## 検証用 spike の実行

いずれも合成データだけを使い、ネットワークの待受や外部サービスへの接続はしません。結果は実モデル・実文書の品質を示しません。

```sh
# 全文・ベクトル検索、引用範囲、検証用 writer（依存なし）
cd p0/spikes/search && bun test

# MCP SDK（v2 / v1）
cd p0/spikes/mcp/v2 && bun install && bun test
cd p0/spikes/mcp/v1 && bun install && bun test

# 配布構成（型検査・lint・試験・import 副作用の検査・tgz の作成）
cd p0/spikes/package && bun install
bun run typecheck && bun run lint && bun test && bun run verify:imports
bun run release
```

配布構成の clean consumer への導入と照合の手順は、[p0/distribution.md](p0/distribution.md) §11 を参照してください。

## ライセンス

[MIT](LICENSE)。LightRAG（MIT）に由来するコードや指示を移植する段階で、上流の著作権表示とライセンス全文を `THIRD_PARTY_NOTICES` として追加します。
