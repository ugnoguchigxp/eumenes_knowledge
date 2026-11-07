# P0: SQLite 検索・引用範囲・検証用 writer の方式確認と測定

作成日: 2026-11-07

状態: P0 の判断資料（案）。決定ではなく承認を受ける案。製品コードは書いていない。spike は `p0/spikes/search/`。

**この文書の数値はすべて合成データ・乱数ベクトル・合成 Markdown の結果であり、実文書・実埋め込みモデル・日本語検索の品質を示さない。** FTS の表は「文字列としての機械的な一致」の性質であって意味検索ではない。全文検索だけで意味検索を満たしたとは判断しない（plan.md §3）。

## 1. 結論（承認を受ける案）

| 項目 | 案 |
| --- | --- |
| 保存 | `bun:sqlite` のみ。FTS5（`trigram`）と float32 BLOB を使う。ベクトル用 native 拡張は不要（この環境の `bun:sqlite` は `OMIT_LOAD_EXTENSION`） |
| 全文 | FTS5 `trigram` を字面一致の補助経路にする。3 文字未満は MATCH で引けない。本文・query を NFKC（+小文字化）して索引し、表記差を吸収する。意味検索の代替にしない |
| ベクトル | space key 列つきの float32 BLOB + JS 総当たり内積。メモリ常駐（space 単位）を既定、毎回 SELECT は小規模（約 1 万断片まで）のみ |
| 組合せ | RRF（順位のみ使用）。計算コストは無視できる。品質は未評価 |
| 引用範囲 | 固定した Markdown bytes（BOM 含む）上の UTF-8 byte `[start, end)` + sha256。UTF-16 index を保存・受渡しに使わない |
| 検証用 writer | Eumenes SqliteStore の意味論を 18 試験で再現できた（§7） |
| 規模案 | 1 space あたり 50,000 断片・次元 1024 以下（§8）。測定上は 100,000 まで動くが、予算は余裕を見て決める |

## 2. 環境・実行条件

| 項目 | 値 |
| --- | --- |
| マシン | `Darwin LMC-4326 25.6.0 ... RELEASE_ARM64_T8132 arm64`（macOS 26.6.2）、Apple M4、10 コア、メモリ 32 GiB（34359738368 B） |
| Bun | 1.4.4 |
| SQLite | `select sqlite_version()` = **3.51.0**（`bun:sqlite` 経由。macOS の Bun はシステムの SQLite を使う可能性があり、Linux 等の Bun では版が異なり得る。**他環境は未確認**） |
| FTS5 | `ENABLE_FTS5`、tokenizer `trigram`・`unicode61` とも使用可 |
| 依存 | なし（`bun:sqlite` / `bun:ffi` / `node:*` のみ。TypeScript は未導入のため型検査は未実施） |
| 測定の状態 | 開発機（ベクトル・FTS の表は単独実行。並行ジョブなし）、ページキャッシュは書込み直後で温かい。**cold cache は未測定**。単一プロセス・単一スレッド |
| 乱数 | 固定 seed の mulberry32。ベクトルは一様乱数 [-1,1] を L2 正規化 |

実行コマンド（`/Users/y.noguchi/Code/eumenes_knowledge/p0/spikes/search/` で。一時 DB は `SPIKE_TMP` または OS の一時ディレクトリに作り、各スクリプトが削除する）:

```text
bun test                                   # 試験 132 件
bun run src/fts-matrix.ts                  # §3.1 の表
FTS_N=10000,50000 bun run src/fts-scale.ts # §3.2
bun run src/vector-layout.ts               # §4.2
bun run src/vector-driver.ts               # §4.3（dim x N を子プロセスごとに測定）
bun run src/fusion-bench.ts                # §5
bun run src/chunk-perf.ts                  # §6.4
```

結果の生データは `spikes/search/results/*.json`。

## 3. 全文検索（FTS5 / LIKE / instr）

### 3.1 一致の性質（`fts-matrix.ts`、`fts.test.ts` 16 件で固定）

合成文書 d1〜d16（抜粋）: d1 `東京都の天気予報：晴れ時々くもり` / d2 `とうきょうタワーに行く` / d3 `トウキョウ駅 カタカナ表記` / d4 `ＡＢＣ　全角英数ＡＢＣ１２３` / d5 `ABC abc half-width 123` / d6 `ﾄｳｷｮｳ 半角カナの表記` / d7 `Hello World: C++ and C# programming, foo_bar, foo-bar, user@example.com` / d8 `京都府の観光と東京への移動` / d9 `ガイドライン`(NFC) / d11 `Résumé and café`(アクセントのみ) / d12 `東 京 都 (...)`(空白区切り) / d13 `ガイドライン`(NFD 分解形) / d14 `ONLY UPPER CASE: HELLO` / d15 `resume and cafe`(無アクセント) / d16 `ｶﾞｲﾄﾞﾗｲﾝ`(半角カナ)。全 28 クエリ × 11 方式の全表は `results/fts-matrix.json`。以下は主要行。`-` は 0 件。

| クエリ | trigram MATCH | trigram 両側 NFKC | unicode61 MATCH | unicode61 前方一致 `*` | LIKE | instr |
| --- | --- | --- | --- | --- | --- | --- |
| `東`（1字） | - | - | d12 | d1,d12 | d1,d8,d12 | d1,d8,d12 |
| `東京`（2字） | - | - | - | d1 | d1,d8 | d1,d8 |
| `京都`（2字） | - | - | - | d8 | d1,d8 | d1,d8 |
| `東京都` | d1 | d1 | - | d1 | d1 | d1 |
| `天気予報` | d1 | d1 | - | - | d1 | d1 |
| `都の天`（語の途中） | d1 | d1 | - | - | d1 | d1 |
| `abc` | d5 | d4,d5 | d5 | d5 | d5 | d5 |
| `hello`（文書は Hello / HELLO） | d7,d14 | d7,d14 | d7,d14 | d7,d14 | d7,d14 | - |
| `ＡＢＣ`（全角） | d4 | d4,d5 | d4 | d4 | d4 | d4 |
| `ａｂｃ`（全角小文字） | d4 | d4,d5 | d4 | d4 | - | - |
| `１２３`（全角数字） | d4 | d4,d5 | - | - | d4 | d4 |
| `123`（半角） | d5 | d4,d5 | d5 | d5 | d5 | d5 |
| `トウキ`（カナ） | d3 | d3,d6 | - | d3 | d3 | d3 |
| `ﾄｳｷ`（半角カナ） | d6 | d3,d6 | - | d6 | d6 | d6 |
| `ガイドライン`（NFC） | d9 | d9,d13,d16 | d9 | d9 | d9 | d9 |
| `ガイドライン`（NFD） | d13 | d9,d13,d16 | d13 | d13 | d13 | d13 |
| `resume` | d15 | d15 | d11,d15 | d11,d15 | d15 | d15 |
| `Résumé` | d11 | d11 | d11,d15 | d11,d15 | d11 | d11 |
| `C++` | d7 | d7 | d7 | d7,d11,d14,d15 | d7 | d7 |
| `C#`（2字） | - | - | d7 | d7,d11,d14,d15 | d7 | d7 |
| `foo_bar` / `foo-bar` / `user@example.com` | d7 | d7 | d7 | d7 | d7 | d7 |

確認できた性質:

- **trigram は 3 文字未満の MATCH が 0 件**（エラーにはならない）。`東京` `C#` `ab` も引けない。同じ語を LIKE / instr / FTS 表への LIKE は引ける（全走査、§3.2）。
- trigram は 3 文字以上なら**分かち書きなしで日本語の語の途中から**一致する（`都の天`）。unicode61 は空白のない日本語の連続を 1 token として扱い、`東京` `天気予報` に当たらない。`*` は token 先頭からのみで、部分一致ではない。
- trigram は ASCII の大文字小文字を既定で区別しない（`case_sensitive 1` で区別）。**全角/半角、NFC/NFD、半角カナ/全角カナは区別する**。アクセントは既定で区別（`remove_diacritics 1` で畳む）。unicode61 はアクセントを既定で畳む。
- 本文と query の**両側を NFKC（+小文字化）すると**全角/半角/半角カナ/NFD が同一視されるが、一致が増える（`abc` が d4 に当たる等）。どの程度の過剰一致を許すかは品質の判断で、**未評価**。
- LIKE は ASCII のみ大小同一視、instr は区別する。どちらも全角/半角は同一視しない。
- `detail=column` / `detail=none` は phrase query がエラー（`fts5: phrase queries are not supported (detail!=full)`）になり、trigram の部分一致に使えない。サイズ削減の手段にならない。
- 記号 `C++` `foo_bar` `foo-bar` `@` は、3 文字以上なら trigram でそのまま引ける。FTS5 の構文文字を避けるため query は `"..."` で囲み `"` を `""` に重ねる（`fts-matrix.ts`）。

### 3.2 規模（`fts-scale.ts`、合成 CJK 乱数文字列。1 断片 600 文字≒1.8 KiB）

DB サイズは本文テーブル込み（FTS5 は既定で本文も保持）。構築は 1 transaction での INSERT + `optimize`。

| 断片数 | 本文計 | 本文のみ | trigram | unicode61 | trigram 構築 | unicode61 構築 |
| --- | --- | --- | --- | --- | --- | --- |
| 10,000 | 14.5 MiB | 19.6 MiB | 59.3 MiB | 36.8 MiB | 1.6 s | 0.35 s |
| 50,000 | 72.3 MiB | 97.9 MiB | 255.6 MiB | 167.6 MiB | 13.2 s | 2.4 s |

検索遅延（ms、p50 / p95。クエリは語彙の先頭 3〜6 字・200 件、2 字 100 件、1 字 30 件。語彙は偏りのある乱数で、実言語の分布ではない）:

| 方式 | 10,000 断片 | 50,000 断片 |
| --- | --- | --- |
| trigram MATCH 3 字以上（全件取得） | 0.03 / 0.34 | 0.13 / 2.26 |
| trigram MATCH 3 字以上 + `bm25` 上位 50 | 0.34 / 5.80 | 2.05 / 47.75 |
| trigram 表への `LIKE`（3 字以上、索引利用） | 0.90 / 18.62 | 4.33 / 82.01 |
| trigram 表への `LIKE`（2 字、全走査） | 16.0 / 17.3 | 78.0 / 90.3 |
| trigram 表への `LIKE`（1 字、全走査） | 12.3 / 15.0 | 58.8 / 72.8 |
| 通常表への `LIKE` 全走査（3 字以上） | 13.7 / 14.5 | 68.0 / 73.6 |
| 通常表への `instr` 全走査（3 字以上） | 19.5 / 20.4 | 101.1 / 114.9 |
| unicode61 前方一致 + bm25 上位 50 | 0.09 / 1.44 | 0.36 / 7.49 |

- trigram MATCH と `instr` の結果集合は 40 クエリで不一致 0 件（合成データ）。
- 索引部分は本文の約 2.2〜2.7 倍（総容量は本文の約 3.5〜4.1 倍）。表の値は 2 回目の単独実行。1 回目（他の測定が一部重なった）は 50,000 断片の bm25 上位 50 が 1.45 / 31 ms など差があり、p95 は実行ごとに ±50% 程度ぶれる。`content=` による外部 content 表で本文の二重保持を避ける構成は**未測定**。
- 当たり件数が多いクエリでは bm25 の並べ替えが支配し p95 が伸びる（50,000 断片で 48 ms）。LIMIT と期限で上限を持たせる。
- trigram の構築は 8 MiB の文書 1 件で約 1.5 秒（線形外挿。10,000→50,000 は 5 倍に対し 8.2 倍と超線形で、これは下限）。単一 writer の transaction を占有するため、文書単位または断片束単位で commit を分ける必要がある（§8）。

## 4. ベクトル検索（float32 BLOB + JS 総当たり内積）

### 4.1 保存形（`vector-store.ts`、`vector-store.test.ts` 11 件）

```sql
CREATE TABLE vector_spaces (space_key TEXT PRIMARY KEY, model_id TEXT NOT NULL,
  revision TEXT NOT NULL, artifact_digest TEXT NOT NULL, dimension INTEGER NOT NULL CHECK(dimension > 0));
CREATE TABLE passage_vectors (vector_id INTEGER PRIMARY KEY, passage_id INTEGER NOT NULL,
  space_key TEXT NOT NULL REFERENCES vector_spaces(space_key), dimension INTEGER NOT NULL,
  text_digest TEXT NOT NULL, vector BLOB NOT NULL,
  UNIQUE (space_key, passage_id), CHECK(length(vector) = dimension * 4));
```

- `space_key` = sha256(JSON[`modelId`, `revision`, `artifactDigest`, `dimension`]) の先頭 32 桁（eumenes_router の `vectorSpaceKey` と同じ構成）。
- 試験で確認: 次元違いの保存・query は `dimension_mismatch` で拒否（行は残らない）。NaN/Infinity は `non_finite`。未登録 space は `unknown_space`。API を迂回した生 SQL でも BLOB 長が `dimension*4` でなければ CHECK が、未登録 space は外部キーが拒否。同じ次元・別モデルの space が同居しても検索は `space_key` で絞るため混ざらない。同じ (space, passage) の再投入は置換で重複しない。
- **P0 で決める点**: LARM の `EmbeddingSpace` は `queryPrefix` / `passagePrefix` を持つが、`vectorSpaceKey` の入力には含まれない。prefix の変更を別 space とするか（キーへ含めるか）は未決。
- float32 は platform の byte order（本環境は little-endian）。big-endian は未確認で対象外。BLOB は 4 byte 境界に乗るとは限らないため unpack はコピーして view を作る。

### 4.2 BLOB の保存レイアウト（`vector-layout.ts`、10,000 行）

| 次元 | レイアウト | page 4096 | page 16384 |
| --- | --- | --- | --- |
| 384 | `WITHOUT ROWID` PK(space, id) | 3.05 倍 | 1.19 倍 |
| 384 | rowid + UNIQUE(space, id) | 1.35 倍 | 1.08 倍 |
| 768 | `WITHOUT ROWID` | 1.52 倍 | 1.07 倍 |
| 768 | rowid + UNIQUE | 1.34 倍 | 1.07 倍 |
| 1024 | `WITHOUT ROWID` | 1.14 倍 | 4.57 倍 |
| 1024 | rowid + UNIQUE | 1.13 倍 | 1.34 倍 |

（生の float32 に対する DB サイズの倍率。）`WITHOUT ROWID` は大きい BLOB が溢れ page を使い、次元と page size で倍率が不安定。**rowid 表 + UNIQUE を採用**（既定 page size 4096 で 1.13〜1.35 倍）。page size は DB 作成時にしか決まらずホスト所有のため、パッケージ側では固定しない。

### 4.3 遅延・サイズ・メモリ（`vector-driver.ts`、k=10 / 50）

Q = 1 点あたり 100 クエリ（常駐）。毎回 SELECT は N≤10,000 で 20 クエリ、N≥50,000 で **8 クエリ（p95 は実質最大値）**。遅延は ms、p50 / p95。k=10 と k=50 の差は誤差内で、`SELECT` 方式は k に依存しない。

| 次元 | N | DB (MiB) | 常駐 load (ms) | 常駐 RSS 増 (MiB) | 常駐 k=10 | 常駐 k=50 | 毎回 SELECT k=10 | 毎回 SELECT k=50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 384 | 1,000 | 2.0 | 3 | 2 | 0.12 / 0.14 | 0.12 / 0.13 | 0.92 / 1.19 | 0.93 / 1.19 |
| 384 | 10,000 | 20.1 | 10 | 15 | 1.07 / 1.14 | 1.08 / 1.12 | 12.7 / 14.9 | 12.8 / 14.1 |
| 384 | 50,000 | 100.3 | 45 | 75 | 5.27 / 5.57 | 5.30 / 8.79 | 63.0 / 66.1 | 61.8 / 66.2 |
| 384 | 100,000 | 200.7 | 79 | 149 | 10.9 / 11.4 | 11.9 / 20.2 | 171 / 227 | 161 / 201 |
| 768 | 1,000 | 4.0 | 6 | 3 | 0.27 / 0.28 | 0.31 / 0.32 | 2.07 / 5.21 | 1.89 / 2.10 |
| 768 | 10,000 | 39.6 | 21 | 31 | 2.72 / 3.45 | 2.60 / 2.96 | 23.8 / 29.8 | 22.4 / 26.0 |
| 768 | 50,000 | 198.2 | 81 | 149 | 13.4 / 16.2 | 13.0 / 16.8 | 114 / 131 | 118 / 217 |
| 768 | 100,000 | 396.5 | 160 | 295 | 25.9 / 28.0 | 26.9 / 29.0 | 230 / 261 | 220 / 309 |
| 1024 | 1,000 | 4.5 | 5 | 4 | 0.29 / 0.31 | 0.32 / 0.37 | 2.15 / 2.80 | 2.14 / 2.37 |
| 1024 | 10,000 | 44.4 | 18 | 40 | 3.21 / 3.66 | 3.38 / 3.69 | 23.1 / 26.8 | 23.0 / 38.3 |
| 1024 | 50,000 | 222.2 | 89 | 197 | 16.1 / 18.3 | 15.9 / 17.8 | 124 / 145 | 118 / 126 |
| 1024 | 100,000 | 444.4 | 178 | 394 | 35.0 / 37.8 | 32.0 / 35.0 | 241 / 315 | 253 / 269 |

- 常駐方式 = space 1 つ分を 1 本の `Float32Array`（N×dim）に詰め、4 並び展開の内積で走査。RSS 増は行列サイズ（N×dim×4）とほぼ同じ。ピーク RSS（行列 + SELECT 方式の一時領域を同一プロセスで測定）は 100,000×1024 で 899 MiB。
- 常駐方式の単純な内積（行ごとに `subarray` を作る）は上の約 2〜3 倍遅い（100,000×1024 で p50 72 ms）。実装差が大きいので、方式比較は実装込みで読む。
- 毎回 SELECT（`iterate` + コピー unpack + top-k）は常駐の約 8〜10 倍。N≥50,000 で 100 ms 超。
- 常駐と SELECT の top-10 の id 集合は各構成 5 クエリで一致（丸め順の違いによる僅かな差は試験で許容）。
- 挿入は 1 transaction で 100,000×1024 が 1.7 秒（DB 作成含む、埋め込み取得時間は含まない）。
- 常駐のキャッシュ無効化（版・失効・space 変更で再 load）と、複数プロセス・複数 reader での重複常駐は**未検討**。load は 100,000×1024 でも 178 ms と短いが、書込みの検知方法は P1 以降の設計課題。

## 5. 全文・ベクトル候補の組合せ（品質の主張なし）

`fusion-bench.ts` / `fusion.test.ts`（2 件）。順位の良し悪しは測っていない。

| 方式 | 計算コスト（測定） | 実装の単純さ・留意点 |
| --- | --- | --- |
| RRF `Σ 1/(60+rank)` | 2 リスト×50 件: p50 0.007 ms / ×200: 0.016 ms / ×1000: 0.073 ms | 順位だけを使うため bm25（負値・尺度なし）とコサイン類似度の尺度合わせが不要。定数 60 や重みの妥当性は未評価。実装は約 5 行 |
| 重み付きスコア和 | RRF と同程度 | bm25 と内積の正規化が必要で、クエリごとに尺度が変わる。尺度の決め方が品質判断になる |
| 全文候補をベクトルで再採点 | SQL から BLOB 50 件取得 + 内積: p50 0.09 ms / 200 件: 0.32 ms / 1000 件: 1.96 ms（768 次元） | 全文で当たらない意味的近傍は取りこぼす。全文の字面一致に引きずられる |
| ベクトル候補を全文で絞る | 全文 MATCH は 3 字以上のみ | 3 字未満の query や表記差では絞り込みが空になり得る |

合成コストは全経路で 1 ms 未満〜数 ms で、**検索 1 回の遅延は個々の候補取得（全文 bm25 の p95 と総当たり走査）が支配**する。候補数の上限は計算コストではなく、返却・文脈サイズで決める。

## 6. 引用 byte 範囲

### 6.1 方式（`chunker.ts` / `citation.ts` / `normalize-map.ts`）

- 入力は bytes を正とする。UTF-8 を `fatal: true, ignoreBOM: true` でデコードし、BOM（EF BB BF）を**除去せず**先頭断片に含める。範囲は bytes 上の `[start, end)`。UTF-16 index→byte offset の対応表（サロゲートペアの 2 つ目は境界にしない）から求める。
- 分割: frontmatter（先頭 `---` から閉じ `---` / `...` まで）→ 前置き → ATX 見出し（`#`〜`######`）で節に分け、フェンスコード内の `#` は見出しにしない。節が上限以内ならそのまま 1 断片、超える場合は ブロック（段落・フェンスコード・表）→ 行 → 文（`Intl.Segmenter` sentence）→ 書記素（`Intl.Segmenter` grapheme）の順に細かくし、`maxBytes` 以内に詰め直す。**断片は隙間・重なりなしで本文全体を覆い、連結すると原文に戻る**。CRLF は 1 書記素のため `\r` と `\n` の間では切らない。
- 書記素 1 個が上限を超える場合（結合文字 80 個など）のみ code point 境界で切り、`brokeGrapheme: true` を付ける。
- 引用 = `{start, end, sha256}`。`verifyCitation` は 範囲外・逆順・非整数 → `range`、先頭/末尾が UTF-8 継続 byte（文字の途中）→ `utf8_boundary`、digest 不一致 → `digest` で拒否する。
- 検索用の正規化テキスト（書記素ごとに NFKC + `toLowerCase`）から元の範囲へは、書記素単位の対応表（正規化後 UTF-16 区間 ↔ 元 byte 区間）で戻す。一致区間は**書記素の境界へ外側に丸める**（元の範囲は一致より広がり得る）。対応表は保存せず、取得時に断片（上限以内）から計算する（2 KiB 弱の断片で p50 0.08 ms / p95 0.13 ms）。

### 6.2 試験結果（`chunker.test.ts` 85 件、全 pass）

- LF / CRLF / LF+BOM / CRLF+BOM × 上限 64・100・256・4096 byte の全組合せで、全断片について `Buffer.from(md,"utf8").subarray(start,end).toString("utf8") === 断片` と sha256 の一致、本文全体の被覆、上限遵守、書記素境界（ZWJ 家族絵文字 25 byte・旗・肌色修飾・結合文字 é / が の分解形・全角/半角カナ）を確認。
- 見出し構造（frontmatter / 前置き / 第1章 / 1.1 / 1.2 / 第2章 / 2.0.1）に沿って分割され、フェンス内（``` と ~~~）の `#` は見出しにならず、表は上限内なら 1 断片に残る。
- **UTF-16 index と byte offset の取り違えの検出**: (a) fixture は byte 長が UTF-16 長の 1.4 倍超、(b) `md.slice(start,end)` では一致しない断片が存在、(c) UTF-16 index で作った引用は `verifyCitation` が拒否、(d) UTF-16 index を byte として保持する不具合 chunker を模擬すると独立検証が失敗を報告する。
- **BOM**: `TextDecoder` 既定と `Bun.file().text()` は BOM を除去する（実測）。除去後の文字列から作ると全 offset が 3 ずれ、文書 digest も変わる。`readFileSync(p,"utf8")` と `ignoreBOM: true` は残す。bytes から作れば範囲はずれない。**読み込みは bytes（`arrayBuffer()`）を正とする契約が必要**。
- 正規化: 全角数字 `１２３`→`123` で元の 9 byte に戻る、半角カナ濁点 `ｶﾞｲﾄﾞ`（縮む）、`㌔`→`キロ`・`㈱`→`(株)`・`ﬁ`→`fi`・`①`→`1`（広がる）、NFD の `が` を NFC で引ける、ZWJ 絵文字・サロゲートを含む断片でも byte がずれない、全断片×全位置の性質試験（戻した範囲を同じ手順で正規化すると部分文字列を含む）。
- 不正 UTF-8 / 64 byte 未満の上限 / 空文書 / frontmatter のみ / 閉じない `---` も確認。

### 6.3 限界（未対応・未確認）

- Setext 見出し（`===`）、HTML ブロック、リスト内に 4 字以上インデントされたフェンス、引用ブロック内の見出しは扱っていない（誤検出または未分割。リスト内フェンス内の `#` を見出しと誤る可能性がある）。
- 単独の `\r` は改行として扱う（CommonMark 準拠）。
- 書記素をまたぐ正規化（書記素境界を越えて合成される例）は網羅していない。サンプル性質試験のみ。
- `toLowerCase` は完全な case folding ではない。
- 1 行が上限を超えるとリンクの途中でも切る（文・書記素単位）。
- Docling の `markdownSha256` が BOM を含む bytes の digest かは未確認。

### 6.4 処理時間（`chunk-perf.ts`、合成日本語 Markdown）

| 文書サイズ | maxBytes | 見出し数 | 断片数 | 時間 |
| --- | --- | --- | --- | --- |
| 1 MiB | 2048 | 3,162 | 3,162 | 7 ms |
| 8 MiB（本番上限相当） | 2048 | 25,225 | 25,225 | 28 ms |
| 8 MiB | 256 | 25,225 | 50,450 | 90 ms |

（初版は節ごとに全行を走査する O(n²) で 8 MiB が約 8.6 秒かかったため、行の二分探索に直した。再現条件は節が上限超えのとき。）

## 7. 検証用 writer（`verification-writer.ts`、`verification-writer.test.ts` 18 件、全 pass）

Eumenes の `api/infrastructure/sqlite/index.ts` を読んで意味論だけを再現した（import していない）。

| 意味論 | 確認 |
| --- | --- |
| 一時ディレクトリ上のファイル DB。`:memory:` 拒否。WAL、`foreign_keys=ON`、DB と lock は 0600 | pass |
| OS lock（`flock`、`bun:ffi`）: 同じファイルの二重オープンは `database_writer_owned`。close 後は開ける。失敗した open は lock を残さない | pass |
| migration: 一度だけ適用、再オープンで冪等、SQL 変更は checksum 不一致、未知の適用済みは拒否、途中失敗は巻き戻し | pass |
| 書込みの直列化: 同時 30 件が投入順に 1 件ずつ、カウンタに欠けなし。失敗した書込みの後ろは実行される | pass |
| 待ち行列上限（64）超過は `database_writer_queue_full`（試験: 70 件投入で 6 件拒否、64 件 commit） | pass |
| 同期 transaction callback: `async` 関数・Promise・thenable を返すと `async_write_callback` で拒否し、それまでの書込みを巻き戻す。捨てた Promise の拒否は unhandled にならない | pass |
| 例外・制約違反（NOT NULL・外部キー）で複数テーブル・複数行が全体巻き戻り。以後も使える | pass |
| commit 済みだけが reader から読める（callback 内の未 commit 行は readonly 接続から見えない） | pass |
| readonly 接続: `read` / `readSnapshot` ともに書込みは readonly エラー。`readSnapshot` は async callback を拒否 | pass |
| `onCommit`: 変更を伴う commit のみ通知。rollback・変更なしでは呼ばれず、listener の例外は書込みを失敗にしない | pass |
| close: 待機中の書込みを完了、以後の write / read / onCommit は `database_closing`、writer / reader の両接続が閉じていること（閉じた接続の使用が例外）、lock 解放、二重 close は何もしない、再オープンで commit 済み内容が残る | pass |

再現していないもの: pre-migration backup、migration の `after` 依存、`reserved` スロット、`maintenance`、親ディレクトリ権限の警告、別プロセスからの lock 競合（同一プロセス内の別 fd で確認。`flock` は open file description 単位なので同じ挙動だが、別プロセスは未確認）、Linux の `flock`（`libc.so.6` 経路は未確認）。

## 8. 規模・予算の初期案（P0 で承認を受ける案）

根拠は §3〜§6 の測定（開発機 M4・合成データ）。他のホスト性能は未確認のため、遅延は**測定値の約 3 倍を上限とする余裕**を置く判断とする。

### 8.1 対象規模

| 項目 | 案 | 根拠 |
| --- | --- | --- |
| 1 space あたりの断片数 | **50,000 以下**（測定は 100,000 まで可） | 常駐総当たり 50,000×1024 で p95 18 ms、RSS 増 197 MiB。100,000×1024 で p95 38 ms、394 MiB。FTS は 50,000 断片で trigram DB 256 MiB |
| 次元 | **1024 以下**（384 / 768 / 1024 を測定） | 次元に比例（1024 は 384 の約 3.2 倍の遅延） |
| 1 断片の上限 | **2,048 UTF-8 byte**（案）。64 以上で設定可能 | §6.4。平均 600 文字≒1.8 KiB で FTS を測定 |
| 文書数・サイズ | Docling の markdown 上限は本番 8 MiB。2 KiB 上限で 1 件あたり最大約 4,000〜5,500 断片（充填率 70〜100% 仮定）。50,000 断片は **8 MiB 級で約 10 件、または 100 KiB 級で約 700 件**の目安（平均充填 1.5 KiB の仮定） | 実文書の分布は**未確認** |
| 常駐の使い分け | 約 10,000 断片まで毎回 SELECT 可（p95 約 30〜40 ms）。それ以上は常駐 | §4.3 |
| 超過時 | 上限を超える space は取込みを拒否するか、検索結果へ「索引容量超過・partial」を返す。黙って切り捨てない | plan.md §5.1（完全性を返す） |

### 8.2 検索 1 回あたりの上限

| 項目 | 案 | 根拠 |
| --- | --- | --- |
| 全文候補 | bm25 上位 **200** 件以内、期限つき（例 100 ms） | 50,000 断片で bm25 上位 50 が p95 48 ms。件数が増えると当たり件数に比例して悪化し得る |
| ベクトル候補 | top-k **200** 以内（k=10〜50 で遅延差なし） | 走査コストが支配で k に依存しない |
| 3 字未満の query | trigram MATCH 不可。LIKE 全走査は 50,000 断片で p95 約 70〜90 ms。断片数が上限内のときのみ字面一致として許可し、意味検索ではないと明示するか、拒否して理由を返す | §3.2 |
| 統合後の返却 | **最大 50 件**（既定 10〜20）。各ヒットの原文は断片の上限（2,048 byte）まで。1 応答の本文は**約 100 KiB 以内** | 計算コストではなく文脈サイズと引用の読みやすさによる判断（測定根拠なし） |
| 検索 1 回の遅延目標 | 常駐ベクトル p95 20 ms + 全文 p95 50〜90 ms + 統合 1 ms 未満 ≒ **p95 150 ms 以内**（開発機。余裕を含め本番は 3 倍の 500 ms を上限案） | §3.2・§4.3・§5 の合計 |

### 8.3 取込み側（書込み）

- 8 MiB 文書の trigram 索引追加は約 1.5 秒、ベクトル 5,500 件（1024 次元）の INSERT は約 0.1 秒（外挿）。単一 writer の transaction が秒単位になるため、**文書あたり 1 transaction ではなく断片束（例 約 2 MiB）ごと、または再検査後に分割 commit** を検討する。plan.md §5.2 の「全体を巻き戻す」と両立する単位は P0 で決める。
- 埋め込みの 1 回 64 件（Eumenes の provider）で、50,000 断片は 約 782 呼び出し。LARM の遅延・費用は**未測定**。

## 9. 未確認・限界

- 実文書、実埋め込みモデル、実際の日本語の語彙分布、実クエリでの検索品質・再現率は**未評価**。合成ベクトルの成功は実モデル品質の証明ではない。
- 他の OS・Bun 版・SQLite 版、cold cache、複数プロセス・並行 reader 下の遅延、WAL が大きいときの影響は未測定。
- FTS の外部 content 表（本文二重保持の回避）、`unicode61` と形態素解析を組み合わせた分かち書きは未測定。形態素解析器は導入していない。
- ベクトルの近似索引（HNSW 等）は対象外（初期規模では総当たりで足りる前提。100,000 超は別途）。
- 常駐キャッシュの無効化方式、複数プロセスでの整合は未検討。
- 検証用 writer の別プロセス lock 競合、Linux の `flock` は未確認。
- 型検査（TypeScript）・lint・format は未実施（導入していない）。
- Docling の digest が BOM を含む bytes を対象にするか、Setext 見出し等の扱い、書記素をまたぐ正規化の網羅は未確認（§6.3）。
