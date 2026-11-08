# 知識グラフの段（KG）

2026-11-08。P3 までの取り込みは、断片ごとの抽出（対象・関係・引用）と、文書をまたぐ同一視のリンクを SQLite に持つ。これはすでにグラフの形をしているが、グラフとして取り出す口がなく、実モデルで作ったこともない。本書の段では、合成の AI 調査資料を実モデル（LARM）で取り込み、ストアからグラフを取り出し、正解表と比べる。すべて examples の中で行い、../eumenes には触れない。

## 1. 範囲

| 番号 | 内容 |
| --- | --- |
| K1 | 素材: `examples/corpus/ai-memory/`（Claude Docs で書いた調査 4 文書。個人の文書は使わない）と正解表 `expected.json` |
| K2 | LARM 接続: `examples/larm/`。Eumenes の接続方法（agent-connection → claim → provider 呼出し → 解放）に合わせた `InferencePort`・`EmbeddingPort` |
| K3 | グラフの読み取り（`POST /api/knowledge/graph`）と、文書の中の同一視（指示 `link` v2） |
| K4 | 実行と評価: `scripts/kg-live.ts`。結果は `verification/kg-ai-memory/` |

## 2. グラフの読み取り

契約は `src/contracts/api.ts` の `graphRequestSchema`・`graphResponseSchema`。

- **範囲**: 呼出し側の namespace（ホストが認証から束縛）を `namespaces` で狭めたもの。`current` の公開版の言及だけを読む（上限 `GRAPH_LIMITS.maxMentions`、entity id 順。超えたら `mentions_truncated`）。
- **ノード**: 読んだ言及どうしの `same` リンク（両端が読んだ言及に含まれるもの）でつないだまとまり。範囲外の言及は橋にしない。`nodeId`・`edgeId` は返す順の通し番号（`n1`・`e1` …）で、その応答の中でだけ有効（内部の entity id や範囲外の量を出さない）。
  - **矛盾するリンクは使わない**: 範囲内の `different` の判断を「同じにしてはいけない組」として扱う。`same` のリンクは、正規化した名前が同じ組を先に、残りを後に、それぞれ entity id の順で適用し、つなぐと `different` の組が 1 つのノードに入るリンクは使わない（`linking_conflict`）。実モデルの試行で、同じ名前どうしで 7 回 `different` と答えた mem0 と eumenes_memory が、1 本の誤った `same` で 1 つのノードになったため（推移で誤りが広がる）。`unsure` は制約にしない。
  - 関連文書と要約のまとまりは、従来どおり `same` の連結成分のまま（本段では変えない）。グラフは、要約の `members_digest` がノードの言及と一致するときだけ要約を返すので、矛盾で分けたノードに別のまとまりの要約は付かない。
  - `label` は最も多く書かれた名前（同数は entity id の小さい方）。`names`・`types` は頻度順に重複なしで最大 `namesPerNode`。
  - `evidence` は最大 `evidencePerItem` 件。まず文書ごとに 1 件、残りを entity id 順で埋める。
  - `decidedBy` は成分の中の `same` リンクの由来（model・指示の版）を重複なしで。
  - `summary` は、保存された要約の `members_digest` が成分の言及の digest と一致し `ok` のときだけ。範囲外の言及を含む成分は digest が合わないので返らない。
- **辺**: 読んだ版の関係の言及を、端点の言及（同じ版・断片・local id）から成分へ写し、（2 つのノード、向き、正規化した関係名、否定、確かさ）でまとめる。向きのない関係はノードの順を正規化する。端点のどちらかが読んだ言及にない関係は捨てる。
  - `relation` は最も多く書かれた関係名。`keywords`・`conditions` は重複なし。`evidence` は関係の引用から最大 `evidencePerItem` 件。
- **並び**: ノードは言及数の多い順、文書数の多い順、`nodeId`。`maxNodes` で切ったら `nodes_truncated`。辺は返すノードの間のものだけで、言及数の多い順、`edgeId`。`maxEdges` で切ったら `edges_truncated`。
- **partial**: 関連文書と同じ状態の理由（`no_complete_scan`、`stale_documents` など）に、`linking_pending`（範囲内に同一視を比べ終えていない版がある）、`linking_unsure`、上の切り詰めを足す。

## 3. 文書の中の同一視

- 候補に、同じ文書の同じ版の**別の断片**の言及を加える（同じ断片の言及は 1 回の抽出の中で区別されたものなので候補にしない）。ほかの文書の候補と同じ規則（正規化した名前の一致を先に、次に言及の全文索引）で、上限も同じ。
- 指示を `link` v2 にする。v1 は「別々の文書から取り出された言及」を前提に書かれているため。v2 は「別々の文書、または同じ文書の別の箇所」と書き、目的に「同じ実体を 1 つのノードにまとめる」を加える。判断の規則は v1 と同じ。v1 は資源として残す。
- 関連文書は、従来どおりほかの文書だけを返す（文書の中のリンクで自分自身を関連文書にしない）。起点の言及は、版をまたぐ `same` リンクを持つものだけにする（文書の中のリンクが起点の上限を使い切らないように）。要約の対象は従来どおり 2 文書以上にまたがるまとまり。
- v1 で比べ終えた版は、文書の中の候補を問われないまま `done` に残る（指示の版が上がっても比べ直す仕組みはない）。既存の運用 DB はまだないので移行は作らない。P6 で運用中の DB に入れるときは、`link` v2 未満で `done` の版を `partial` に戻す移行を作る（判断済みの組は問い直さない）。
- 同じ名前の言及は、組をすべて比べ終えるまで問い続ける（n 件で約 n²/2 組）。文書の中の候補を加えたことで、よく出る実体ほど同一視の呼出しが増える。

## 3a. 抽出の指示 v2

実モデルの試行で、見出しや一般語（「文書の一覧」「結論」「関連の図」「各行」「主題」「施策 1」など）が対象として多く取り出された。指示 `extract` v2 は、v1 に次の規則だけを足す（LightRAG の翻案であることは変わらない）。

- 文書の構成そのもの（見出し・節・表・図・行・列・一覧・番号付きの項目、「結論」「要約」「出典」のような見出し語）は、その名で実質的な内容を指していない限り対象にしない。
- 文脈がないと意味が定まらない一般語は対象にしない。固有名や、製品・手法・指標・制度・数値の名前、断片が実際に論じている概念を優先する。

出力の上限は、LARM の llm が `outputLimit: remaining-context` なので、実行では 16,384 token にする（4,096 では抽出が途中で切れた）。切れた応答は `output_truncated` として失敗に数える。

## 4. LARM 接続（examples）

Eumenes の `api/domains/larm/service/{provider-connection,playground-provider,chat-request}.ts` に合わせる。examples の外へは出さない（P6 では Eumenes の LARM 接続をそのまま使う）。

1. catalog: `GET /v3/agent-profiles?profile=<profile>`（`contractVersion: agent-connection.v3`）から `llm`（`openai.chat-completions.v1`）と `embedding`（`larm.embedding.v1`、`embeddingSpace` 付き）を選ぶ。
2. 接続: `POST /v1/agent-connections`（`Idempotency-Key`、`Prefer: wait=1`、`providers: [name]`、`allowFallback: false`、`deploymentPolicy: existing-only`、`expectedCatalogRevision`）。`ready` かつ provider が `claimable`・`readiness: ready` になるまで GET で待つ。
3. claim: `POST /v1/agent-connections/{id}/claim`（llm は `openai-provider-v1`、埋め込みは `larm-embedding-provider-v1`）。provider の URL は LARM のホスト（または明示した追加ホスト）に限る。
4. 呼出し: llm は `chat/completions`（`temperature: 0`、出力 schema があれば `response_format: json_schema strict`、推論は既定で off）。埋め込みは `/v1/embed`（`priority`: passage は `low`、query は `normal`）。
5. 解放: 成否にかかわらず `DELETE /v1/agent-connections/{id}`。

接続先は環境変数で渡す（`LARM_API_TOKEN`、`KG_LARM_BASE_URL`、`KG_LARM_PROFILE`、`KG_LARM_AUDIENCE`）。試験は in-process の偽 LARM だけを使い、ネットワークに出ない。

## 5. 担当

| 範囲 | 担当 |
| --- | --- |
| `src/contracts/**`、本書、`examples/corpus/**`、`scripts/kg-live.ts`・`kg-view.ts`・`kg-view/`、`verification/kg-ai-memory/**`、README | 監督者 |
| `examples/larm/**` | 担当 A |
| `src/sqlite/links.ts`・`links.test.ts`、`src/contexts/**`、`src/core/link/request.ts`・`request.test.ts`、`src/core/jobs/link-next.ts` とその試験、`src/core/link/related.test.ts`、`examples/scenarios/related.test.ts` | 担当 B1 |
| `src/sqlite/graph.ts`・`graph.test.ts`、`src/sqlite/index.ts`、`src/core/link/graph.ts`・`graph.test.ts`、`src/core/link/index.ts`、`src/core/index.ts`、`src/index.ts`、`src/client/**`、`examples/host/**`、`examples/scenarios/harness.ts`・`graph.test.ts` | 担当 B2 |

## 6. 結果

### 6.1 条件

- 2026-11-07 23:15 から 239.1 分（UTC）。LARM の profile `lfm2.5`。llm は `ornith1.5-strix`（推論 off、出力の上限 16,384 token）、埋め込みは `multilingual-e5-small`（384 次元）。
- 素材は 4 文書で 59,978 byte、断片は 76 件。
  - 実行の後、`eumenes-memory-evaluation.md` の「参照した資料」にあった手元の絶対パス 2 か所を、相対パス（`../eumenes_memory`、`../eumenes`）に替えた（38 byte 減る）。
  - 記録はそれより前の本文（sha256 `d49818c2…`、commit `6d65b04` の版）に対するもの。この文書の引用 423 件のうち、byte 18,383 以降にかかる 27 件は、今の本文では位置がずれる。ほかの 3 文書は変えていない。
- 記録は `verification/kg-ai-memory/20261107T231544-lfm2.5/` にある。`graph.json` はグラフ API の応答そのもの、`report.json` は数と評価、`graph.html` は見るためのページ（`bun scripts/kg-view.ts <dir>` で作る）。
- 1 回だけの実行で、品質の基準値ではない。

### 6.2 1 文書の試行で見つけて直したこと

| 起きたこと | 直したこと |
| --- | --- |
| 抽出の答えが 4,096 token で切れた | 出力の上限を 16,384 にした。切れた答えは `output_truncated` で失敗にする（§3a） |
| mem0 と eumenes_memory が、誤った `same` 1 本で 1 つのノードになった | `different` の判断と矛盾するリンクを使わないようにした（§2、`linking_conflict`） |
| 見出しや一般語が対象として多く取り出された | 抽出の指示を v2 にした（§3a） |

### 6.3 数

| 段 | 呼出し | 失敗 | 時間 | 1 回あたり | 入力 / 出力 token |
| --- | --- | --- | --- | --- | --- |
| 抽出 | 76 | 0 | 66 分 | 52 秒 | 194,172 / 213,767 |
| 同一視 | 1,546 | 0 | 172 分 | 6.7 秒 | 2,643,475 / 239,274 |
| 要約 | 4 | 0 | 0.4 分 | 5.3 秒 | 4,095 / 428 |

- **抽出**: 対象の言及は 920 件、関係の言及は 600 件。答えから検証で落とした項目は 322 件で、内訳は次のとおり。
  - 引用が断片の原文にない: 116
  - 根拠の引用が 1 つも残らない項目: 110
  - 端点の対象が落ちた関係: 96
- **同一視**: 判断は 12,516 組。`same` 2,638、`different` 9,571、`unsure` 307。
- **グラフ**: ノードは 516 件。
  - 言及 1 件だけのノード: 387
  - 言及 2 件以上のノード: 129
  - 2 文書以上にまたがるノード: 71
  - 要約付きのノード: 4
- **関係**: 599 件。ノードの組にまとめると 509 組で、2 文書以上に出る組は 13 組。1 つのノードの中で閉じる関係は 17 件。
- **partial**: `linking_unsure` と `linking_conflict`。
- **引用**: グラフが返した引用 1,338 件は、根拠 API ですべて `valid` だった。

### 6.4 正解表との比較

- **実体**: 32 件のうち 31 件が見つかった。
  - 見つからなかった `eumenes-memory-host` は、「eumenes-memory-host 0.1.0」という名前でだけ取り出されていた。評価は別名との完全一致で数えるので、見つからない扱いになる。しかもそのノードには、「Eumenes」「CLI」「memory ドメイン」の言及が混ざっていた。
- **複数の文書に出る実体**: 18 件のうち 15 件が、1 つのノードにまとまった。
  - 残る 3 件は、mem0 OSS（「OSS」と「mem0 OSS」の 2 ノードに分かれた）、mem0 Platform（3 ノード）、eumenes_knowledge（3 文書のうち 2 文書だけ）。
- **関係**: 17 件のうち 15 件で、端点のノードの間に辺がある。
  - 辺がなかった 2 件は「OSS から外部のグラフ DB への対応を外した」と「quality-80 の評価」。どちらも端点のノードはある。
- **混ぜてはいけない組**（mem0 と Mem0g など 7 組）を同じノードに入れた例は 0 件。

### 6.5 わかった問題

1. **誤った `same` が推移で広がり、寄せ集めのノードができる。** 目立つのは次のノード。
   - 「Python v2.0.0」（言及 16 件）: 旧方式・遅延・基本版・この文書・mem0・mem0 の Platform・施策 1 が入っている。
   - 「本体」（言及 12 件）: Eumenes・git status・弱点とリスクが入っている。
   - そのほか: 「0.0.4」に SQLite が、「出典」に fail closed が、「時間推論」に「約7,000 token」が、「減衰」に「5 月」が入っている。

   モデルが `same` と答えやすいのは、次のような組だった。
   - 名前を含む句や列挙（「3 つの信号の融合、時間推論、減衰の仕組み」と「時間推論」）
   - それを紹介する記事や文書
   - それが加わった時期、版、部分

   §2 の矛盾の規則は、同じまとまりの中に直接の `different` があるときしか働かない。このため、こうした連鎖は止まらない。
2. **見出しや一般語の抽出は減ったが、まだ残る。** 「この文書」「施策 1」「やること 2」「弱点とリスク」、記事の題名などが対象として取り出されている。
3. **関係名が自由文なので、API の辺はほとんどまとまらない。** 辺は（ノードの組、向き、関係名、否定、確かさ）でまとめるが、関係の言及 600 件が 599 本の辺になった。同じ組を述べた関係も、言い方が違えば別の辺になる。見るためのページは、ノードの組で 1 本の線にまとめて描き、関係名は詳細の欄に並べている。
4. **同一視の費用が大きい。** 時間の 72%、入力 token の 93% を同一視が使った。判断した組の 76% は `different` だった。原因は、同じ名前の言及を総当たりで比べること（§3）と、文書の中の候補を加えたことの 2 つ。実文書の量では、このままでは回らない。

### 6.6 次に試すこと（未実施）

- **同一視の指示 v3**: 次のものは `different` と答えるよう、規則と例を加える。
  - 名前を含む句や列挙
  - それを紹介する記事や文書
  - それが加わった時期、版、部分
- **同一視の呼出しを減らす**: 新しい言及は、すでにあるノードごとに代表の言及とだけ比べる（そのノードで `same` が出たら残りを問わない）。同じ文書の中で正規化した名前が同じ組をどう扱うかは、別に決める。
- **辺のまとめ方**: グラフ API で、ノードの組でまとめる読み方を選べるようにするか、関係名を正規化する。
- **評価を増やす**: 正解表の 2 つ以上の実体を含むノードの数と、ノードあたりの名前の数を加え、寄せ集めのノードを数として見る。
