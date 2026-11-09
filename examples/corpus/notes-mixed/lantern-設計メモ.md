---
title: Lantern 設計メモ
aliases: [ランタン, Lantern Search]
tags: [lantern, 設計, draft]
---

# Lantern 設計メモ（書きかけ）

ざっくり構成。あとで清書する。

- lantern-api: 検索の口。TypeScript（Hono）。
- lantern-worker: 取り込み担当。夜間バッチもここ
- DB は Postgres 16。全文検索は pg_trgm + tsvector で足りる？？ → 日本語は pg_bigm のほうがいいかも（要調査）
- 認証は社内の SSO（情シス管理）に寄せる

## 取り込みの流れ

1. hikidashi-sync がひきだしの更新分を取ってくる
2. Markdown に変換（変換はひきだしの export を使う）
3. lantern-worker が分割して索引に書込む

```ts
export async function indexDocuments(docs: Doc[]): Promise<void> {
  for (const d of docs) await db.insert(fragments).values(split(d));
}
```

TODO: 書き込みの失敗をどう再試行するか。とりあえず 3 回。
TODO: インデックスの再構築は週末だけ？

## メモ

- Okafor さん曰く、"keep the index rebuild idempotent"。
- 品証の表、セル結合が多い。要確認
- ファイルは apps/lantern/src/index.ts と apps/lantern/src/worker.ts
