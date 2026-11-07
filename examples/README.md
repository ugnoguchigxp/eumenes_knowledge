# examples: Eumenes 環境のエミュレーター

Eumenes・実 Docling・実 LARM・製品 DB・秘密を使わずに、配布するパッケージの公開契約を通して処理を再現する検証環境です（plan.md §7）。examples 専用の検索・保存ロジックは持たず、パッケージと同じジョブ定義・SQL・API 契約・client を使います。合成資料だけを使う開発環境であり、本番の別データインスタンスではありません。

## 実行

```sh
bun run examples:verify   # examples の全試験。待受・子プロセス・一時ディレクトリが残らないことも検査する
bun test examples/scenarios   # 統合シナリオだけ
```

ネットワーク・TCP の待受は使いません。HTTP は Hono の `app.request()` で in-process に呼びます。一時 DB は OS の一時ディレクトリ（接頭辞 `eumenes-knowledge-example-`）に作り、試験の終わりに片付けます。個人の設定、Eumenes の data ディレクトリ、実文書は読みません。

## 構成

| 場所 | 本番で Eumenes が提供するもの | examples での再現 |
| --- | --- | --- |
| `host/store.ts` | SQLite と単一 writer | 一時ディレクトリ上の実 SQLite と直列 writer（Eumenes の SqliteStore と同じ意味論）。package の migration には `knowledge-package/0001` 形式の ID を付ける |
| `host/runner.ts` | queue・実行・時刻 | パッケージのジョブ定義を実行する最小の実行器。dedupe key の一意性、未完了ジョブの上限、settle の結果の扱い、再起動時の扱いを Eumenes の queue に合わせている（`p1.md` §5）。時計は注入し、実時間では待たない |
| `host/sync-requests.ts`、`host/app.ts` | 受付と認証付き公開 API | ホストの受付記録と Hono の API。Bearer トークンから principal と namespace を引く |
| `mocks/docling.ts`、`mocks/docling-source.ts` | Docling 文書の取得 | `larm.docling-files.v1` を模倣する mock と、それを `DocumentSourcePort` に変換する adapter（recovery を取り除く） |
| `mocks/inference.ts`、`mocks/embedding.ts` | LARM の推論・埋め込み | scenario ID と呼出し順で応答を選ぶ scripted mock。P1 では契約試験だけで、ジョブからは使わない |
| `fixtures/` | Docling の文書 | 合成の Markdown（日本語、BOM、CRLF、frontmatter、絵文字、結合文字）。bytes で読み、BOM を残す |
| `scenarios/` | — | 上を組み合わせた統合シナリオ（`p1.md` §6） |

## 実接続との違い

- mock の成功は、実 Docling・実 LARM との接続や、実モデルの意味理解・日本語の検索品質を示しません。結果は fixture、実接続、実モデルの品質、実利用の受入を分けて記録します（plan.md §7.3）。
- Docling mock の ETag の算出、エラーコードの細部、ライブラリ拡張（DELETE 以外）は mock の選択で、実 LARM との一致は確認していません。
- 実行器は Eumenes の queue の意味論の一部だけを持ちます。lease、資源枠、concurrency key、未登録 kind の猶予などはありません。
- 実接続モードは後段の opt-in 試験とし、mock の失敗を実接続への自動切替で隠しません。
