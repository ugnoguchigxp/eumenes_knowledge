# エージェント記憶・知識ベース製品はグラフ DB 上でグラフをどう作り、何に効いているか（Graphiti/Zep・Mem0・Cognee ほか）

調査日: 2026-11-10。凡例: 【2025-05】のように一次情報の日付を付ける。日付のない docs・README は 2026-11 時点の版を読んだもの。「（検索要約）」は検索結果の要約だけで本文を開いていない情報で、確度が低い。既存報告 `reports/LLM推論に頼らない知識グラフ.md` にある内容（Graphiti の MinHash/LSH 同一視の詳細、Cognee の同一視の閾値、LightRAG・LinearRAG・LazyGraphRAG など）は繰り返さない。

## Q1. Graphiti / Zep: episode から実体と辺をどう作り、LLM を何回呼び、どのモデルを勧め（警告し）、公表結果と独立の検証はどうか

### Takeaway
Graphiti は episode（会話の 1 発話や 1 文書）ごとに、実体抽出・振り返り・同一視・事実（辺）抽出・辺の重複判定・時刻抽出・矛盾による失効を、別々の LLM 呼び出しで行う。利用者の実測では 1 episode あたり約 22 回呼んでいる【2025-05】。公式は構造化出力に強い大きなモデルを使うよう繰り返し勧め、小さいモデルは「誤ったスキーマと取り込みの失敗」を起こすと明記している。公表結果（DMR 94.8%、LongMemEval で full-context 比 +15〜18 ポイント）はすべて Zep 社員による自社評価である。LoCoMo では Mem0 と Zep が互いの実装を誤りだと非難し合っていて、第三者による再現は確認できなかった。

### Cited Findings
**episode の処理手順（Zep 論文 arXiv 2501.13956【2025-01】）**
- 実体抽出には、現在のメッセージに加えて直前 **n=4** 件（2 往復分）を文脈として渡す。話者は常に最初の実体として抽出する。そのあと Reflexion 風の振り返り（LLM）で、幻覚を減らし抽出漏れを補う — [Zep paper](https://arxiv.org/html/2501.13956)
- 同一視の手順: 実体名を 1024 次元で埋め込み、既存ノードの cosine と名前・要約の全文検索で候補を出し、LLM が重複かどうか・既存の UUID・最も完全な名前を返す。グラフへの書き込みは LLM に生成させず、事前定義の Cypher で行う（スキーマの一貫性と幻覚の抑制のため） — [Zep paper](https://arxiv.org/html/2501.13956)
- 事実（辺）の抽出: 実体の組の間の事実を、全大文字の関係型と詳しい説明文で抽出する。辺の重複判定も LLM だが、検索の範囲は同じ実体の組の間の辺に限る。時刻抽出（LLM）は `valid_at`/`invalid_at` を ISO 8601 で埋め、相対的な日付は基準時刻から解決する。書かれていなければ null のままにする。辺の失効（LLM）は、時間が重なって矛盾する古い辺の `invalid_at` を新しい辺の `valid_at` に設定する。新しい情報を優先する — [Zep paper](https://arxiv.org/html/2501.13956)
- コミュニティはラベル伝播で検出し、隣接ノードの多数決で動的に広げる。要約は map-reduce 風の反復要約（LLM）で作る。定期的な全面再計算はなお必要 — [Zep paper](https://arxiv.org/html/2501.13956)
- 検索は cosine・BM25（Neo4j の Lucene）・n ホップの BFS で行い、RRF・MMR・episode 言及数・ノード距離・cross-encoder で再順位付けする。LLM を使うのは cross-encoder だけで、これが最も高価 — [Zep paper](https://arxiv.org/html/2501.13956)
- 実験で使ったモデル: グラフ構築は gpt-4o-mini-2024-07-18、埋め込みと再順位付けは BGE-m3 — [Zep paper](https://arxiv.org/html/2501.13956)
- 古い辺は削除せず失効の印を付ける（`edge_operations.py:569-571`）。辺は valid time と transaction time の両方を持つ二時制（`edges.py:271-279`）。調べた版は Graphiti v0.29.1【2026-05】 — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)

**LLM の呼び出し回数と費用**
- issue #467【2025-05-10】: 150〜250 語の会話 40 件で、既定の OpenAI モデルを使って約 $0.80（1 episode あたり平均 $0.018139）。内訳は、実体の属性抽出 4.53 回/episode（費用の 74.7%）、新しい実体の分類 4.53 回（20.0%）、事実の三つ組抽出 1 回（15.9%）、実体ノード抽出 1 回、辺の重複判定 7 回、矛盾検出 4 回で、合計で **約 22 回/episode**。メンテナ（2025-05-22）は「token 使用量を大きく改善した」と答え、分類器役の「small model」（Zep の実装では `gpt-4.1-nano`）を導入したと述べた。issue は 2026-09-28 に completed で閉じられた — [issue #467](https://github.com/getzep/graphiti/issues/467)
- Zep 自身の工学ブログ: 一時期、episode の処理が 60 秒まで遅くなり LLM 費用が膨らんだ。その後、文脈の圧縮とプロンプトの最適化で token を 50% 減らしたという（マネージド版の話。検索要約） — [Zep blog](https://blog.getzep.com/scaling-agent-memory-zep-30x)
- issue #2074（2026-10 頃。検索要約）: 実体型をすべて除外しても `add_episode` が辺抽出を呼び、1 episode に 1 回の無駄な呼び出しが出る — [issue #2074](https://github.com/getzep/graphiti/issues/2074)

**モデルの推奨と警告**
- README: Graphiti は構造化出力を持つ OpenAI・Anthropic・Gemini で最もよく動く。「Using other services may result in incorrect output schemas and ingestion failures. This is particularly problematic when using smaller models.」OpenAI 互換エンドポイントでは `OpenAIGenericClient` を使う。`structured_output_mode` は既定が `json_schema` で、スキーマを受け付けても強制しない一部のサーバでは `json_object` を勧める — [Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)
- LLM 設定の公式文書: Ollama には「avoid smaller local models as they may not accurately extract data」。OpenAI 互換にも「avoid smaller models」。ところが Ollama の例は `deepseek-r1:7b` と `nomic-embed-text` を使い、`model` と `small_model` に同じモデルを入れている。最小の大きさは示していない — [Graphiti LLM configuration](https://help.getzep.com/graphiti/configuration/llm-configuration)
- メンテナの回答（issue #912、2025-10-30）: 「We strongly recommend using larger models capable of outputting well-formed JSON.」 — [issue #912](https://github.com/getzep/graphiti/issues/912)
- 並列度: README は既定の `SEMAPHORE_LIMIT` を 10 とし、429 が出たら下げる、ローカルのサーバでは低く保つよう勧める — [Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)。一方、検索要約には「graphiti-core の既定は 20」とあり、版によって違う可能性がある（未確認）
- 対応するバックエンド: Neo4j 5.26、FalkorDB 1.1.2、Amazon Neptune。**Kùzu は deprecated**（「the upstream Kuzu project is no longer maintained」）で、将来の版で削除される — [Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)

**公表結果（いずれも Zep の自社評価、Zep paper【2025-01】）**
- DMR: gpt-4-turbo で Zep 94.8%、MemGPT 93.4%、full-conversation 94.4%。gpt-4o-mini では Zep 98.2%、full-conversation 98.0%。著者自身も、DMR は 1 会話が約 60 メッセージで文脈窓に収まり、単発の事実検索しか問わず、全文投入でも高得点が出るので記憶の評価には不十分だと認めている — [Zep paper](https://arxiv.org/html/2501.13956)
- LongMemEval_s: gpt-4o-mini で full-context 55.4% → Zep 63.8%、gpt-4o で 60.2% → 71.2%。応答の遅延は 31.3 秒 → 3.20 秒、28.9 秒 → 2.58 秒。文脈は 115k → 1.6k token。種類別では、single-session-assistant が悪化（4o-mini 81.8 → 75.0、4o 94.6 → 80.4）。knowledge-update も 4o-mini では 76.9 → 74.4 に下がった。伸びたのは preference（20.0 → 56.7、4o）、temporal-reasoning（45.1 → 62.4）、multi-session（44.3 → 57.9）。Zep の計測は Boston のノート PC から AWS us-west-2 のサービスへ投げたもので、遅延の比較は同条件ではない — [Zep paper](https://arxiv.org/html/2501.13956)
- README の主張: 問い合わせの遅延は「Typically sub-second」、Zep（マネージド版）は「sub-200ms」 — [Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)

**独立の批判と再現**
- Mem0 の論文【2025-04】は LoCoMo で Zep を J=65.99 と測り、Mem0g（68.44）より下に置いた。同じ表で full-context は 72.90 で、どの記憶システムよりも高い — [Mem0 paper](https://arxiv.org/html/2504.19413)
- Zep の反論【2025-05-06】: Mem0 の実装には誤りが 3 つあると主張する。(1) 2 人の話者の両方に user の役割を割り当てた、(2) 時刻を `created_at` に入れずメッセージ本文に付けた、(3) 検索を並列でなく逐次に回して遅延を水増しした。Zep 側の再計算は **75.14% ± 0.17**。そのうえで、LoCoMo は 1 会話が 16k〜26k token で文脈窓に収まり、カテゴリ 5 は正解がなく使えないと批判した — [Zep blog](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- Mem0 側の再反論: Zep の 75.14 は adversarial カテゴリを含めて計算しており、カテゴリ 1〜4 だけで計算し直すと 58.44 ± 0.20 だという（Zep の GitHub issue #5 での発言。検索要約で、本文は未確認） — [検索結果の二次記事](https://atlan.com/know/zep-vs-mem0/)
- 「arXiv 2512.13564 が LongMemEval で Zep を 63.8% と独立に再現した」という二次記事がある。しかし 2512.13564 の abstract は 47 人の著者によるサーベイ「Memory in the Age of AI Agents」で、Zep の再現には触れていない。63.8% は Zep 自身の gpt-4o-mini の値と同じなので、取り違えの可能性が高い — [arXiv 2512.13564](https://arxiv.org/abs/2512.13564)、二次記事は [vectorize.io](https://vectorize.io/articles/mem0-vs-zep)
- コードを読んだ第三者【2026-05-28】は、ベンダーの得点はそれぞれ別の judge とモデルを使っていて比べられないと指摘している。モデルの交換だけで LoCoMo が約 10 ポイント動いた — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- Zep の自己ホスト版 Community Edition は deprecated になり、利用者は Zep Cloud か Graphiti に誘導されている。時期は「2025-04」と「2026 年初め」とで二次情報が食い違い、公式の通知ページ（help.getzep.com/ce-deprecation-notice）は 2026-11-10 の時点で 404 だった — [検索要約: awesome.ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Fgetzep%2Fzep)

### Inferences
- 22 回/episode は、150〜250 語の短い会話での値である。設計メモ 1 本を 1 episode にすると、実体と辺の数に比例して属性抽出・分類・重複判定の回数が増える。400 本では少なくとも数千〜1 万回規模の呼び出しになる見込み（推論。設計メモでの実測はない）。
- LongMemEval で伸びたのは、時刻・好み・セッション横断の集約という「会話の履歴」に固有の種類である。single-session-assistant では悪化した。設計メモの知識ベースのように「文書に書いてあることを引く」用途に近いのは single-session 系で、そこではグラフの利得が出ていないか、マイナスである。
- 得点の上積みの多くは、全文投入（115k token）と比べたときの文脈の圧縮から来ている。原文の断片を引くハイブリッド検索との比較は、Zep の論文にはない。

### Gaps
- Zep・Graphiti の LongMemEval・LoCoMo を第三者が再現した一次資料は見つからなかった（上の 63.8% の主張は根拠が確認できない）。
- 小さいローカルモデル（≤8B）で Graphiti を通しで動かしたときの、抽出の成功率と所要時間の体系的な計測は見つからなかった。
- README の要約に、同一視の判定を外部の decision model に送るという趣旨の記述が出てきたが、原文で確かめられていない。採用する前に README の原文を確認する必要がある。
- 日本語のテキストで Graphiti を評価した公開結果は見つからなかった。

## Q2. Mem0 のグラフ記憶（Mem0g）はどう辺を作り、何を得て何を払い、その後どうなったか

### Takeaway
Mem0g は LLM（GPT-4o-mini の function calling）で実体と三つ組を抽出し、Neo4j に入れていた。自社の LoCoMo での上積みは J で **+1.56 ポイント**（66.88 → 68.44）にとどまり、その代わりに検索は約 3 倍遅く、保存する token は約 2 倍になった。single-hop と multi-hop では下がっている。そして 2026-04-14 の SDK 刷新（Python v2.0.0 / TypeScript v3.0.0、「v3 アルゴリズム」）で、**OSS から外部グラフストアとグラフ記憶をすべて削除**した。OSS での代替は spaCy による実体の抽出と、実体を共有する記憶を検索で押し上げる仕組み（LLM を使わない）である。グラフ記憶は有償の Platform 機能として残っている。

### Cited Findings
- 構築の手順（Mem0 paper【2025-04】）: entity extractor（LLM）が実体と型を、relationship generator（LLM）が `lives_in` のようなラベル付き三つ組を出す。始点と終点の実体を埋め込み、類似度が閾値 t を超える既存ノードがあれば再利用する。conflict detector が衝突しうる既存の関係を探し、update resolver（LLM）が古くなった関係に無効の印を付ける（削除はしない）。抽出と更新は GPT-4o-mini の function calling で、DB は Neo4j。t の値と、1 更新あたりの LLM 呼び出し数は書かれていない — [Mem0 paper](https://arxiv.org/html/2504.19413)
- LoCoMo の J（Mem0 → Mem0g）: single-hop 67.13 → 65.71、multi-hop 51.15 → 47.19、open-domain 72.93 → 75.71、temporal 55.51 → 58.13、全体 66.88 → 68.44。full-context は 72.90、最良の RAG（k=2、256 token の断片）は 60.97 — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 遅延（秒）: 検索 p50 は Mem0 0.148 / Mem0g 0.476、p95 は 0.200 / 0.657。全体 p50 は 0.708 / 1.091、p95 は 1.440 / 2.590。保存する記憶は 1 会話あたり Mem0 約 7k token、Mem0g 約 14k token、Zep は 600k token 超（元の会話は約 26k token）。1 問で取り出す token は Mem0 1,764、Mem0g 3,616、Zep 3,911 — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 著者自身の評価: single-hop では「relational structure provides limited utility」、multi-hop ではグラフは「does not provide performance gains」。効いたのは temporal と open-domain だとしている — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 撤去の経緯（公式 changelog）: 2026-03-21 に Apache AGE を 4 つ目のグラフバックエンド（Neo4j・Memgraph・Kùzu・AGE）として追加した。そのわずか 3 週間後の 2026-04-14、「Mem0 SDK v2.0.0 / v3.0.0（new memory algorithm）」で「external graph stores removed from OSS」となった。同じ項に「Graph memory is now built in. Entities are extracted, embedded, and linked across memories, with no external graph store required」とある — [Mem0 changelog](https://docs.mem0.ai/changelog/highlights)
- 移行ガイド: 「Graph memory is removed from the open-source SDK」「not being replaced by an OSS equivalent」。グラフは Platform で常時有効の機能になった。`enable_graph`・`graph_store`・各ドライバ（Neo4j、Memgraph、Kùzu、Apache AGE、Neptune）など約 4,000 行を削除し、検索結果の `relations` も返さなくなった。撤去の理由は明記されていない — [Mem0 migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3)
- 新しいアルゴリズム: 追加は LLM 1 回だけ（以前は「事実の抽出」と「ADD/UPDATE/DELETE の判定」の 2 回）。ADD のみで、古い事実も残して順位付けは検索側に任せる。重複は MD5 で除く。実体の抽出は「third scoring signal in hybrid search」として、意味の近さ・BM25 と融合する。spaCy（`mem0ai[nlp]`、`python -m spacy download en_core_web_sm`）がないと、実体の抽出も BM25 の見出し語化も無効になる。英語以外の言語には触れていない — [Mem0 migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3)
- コードを読んだ第三者【2026-05-28】によれば、撤去は commit `a488e190`（PR #4805、2026-04-14 マージ）である。実体は `{collection}_entities` の行に `linked_memory_ids` を持つハブと放射の形で、型付きの辺ではない。実体による押し上げは `memory_count_weight = 1.0 / (1.0 + 0.001 * ((num_linked - 1) ** 2))`（`memory/main.py:1487-1489`）で、どこにでも出る実体を弱める。この著者の見立ては「Mem0 dropped its graph after the paper's results」で、グラフの利得は「thin」だったというもの — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- 自社公表の新しい得点: LoCoMo 71.4 → 91.6、LongMemEval 67.8 → 93.4、BEAM（1M token）64.1。方法の記載はなく、独立の検証もない — [Mem0 changelog](https://docs.mem0.ai/changelog/highlights)
- Memgraph の文書は、Mem0 2.0 で OSS からグラフ記憶が消えたので、Memgraph でグラフを使いたければ 1.x を入れるよう案内している（検索要約） — [Memgraph docs](https://memgraph.com/docs/ai-ecosystem/integrations/mem0)
- Platform のグラフ記憶は Pro プラン（$249/月）限定だという二次記事がある（公式の料金ページでは未確認） — [atlan.com](https://atlan.com/know/mem0-alternatives/)

### Inferences
- 業界で最も使われている記憶ライブラリの一つが、OSS では「LLM による型付き三つ組のグラフ」を捨てて、「LLM を使わない実体の共有を検索の第三の信号にする」形へ移った。これは、既存報告の「関係名ではなく共有ノードでつなぐ」という結論と同じ方向である。ただし、新しい得点の伸びはアルゴリズム全体の変更（ADD のみ、ハイブリッド検索）と混ざっていて、グラフを外した効果だけを切り出した結果はない。
- `en_core_web_sm` は英語のモデルなので、Mem0 OSS の実体の連結を日本語の文書にそのまま使っても、ほとんど働かないと考えられる（推論。日本語の設定は文書にない）。

### Gaps
- Mem0 自身が OSS からグラフを外した理由（費用、保守、得点、商用の差別化のどれか）を述べた一次資料は見つからなかった。
- 新しい得点（LoCoMo 91.6 など）の評価条件と、第三者による再現は見つからなかった。
- Platform のグラフ記憶が内部で何をしているか（LLM の三つ組か、実体の連結か）は公開されていない。

## Q3. Cognee と、その他の主要な製品（Letta、LangMem、Microsoft）はグラフを使うか、辺をどう作るか、効果の証拠はあるか

### Takeaway
Cognee は文書を断片に切り、断片ごとに LLM 1 回で実体と関係を抽出してグラフにする。LLM を使わない経路（断片の索引と、GLiNER による抽出）を公式に持っているのが特徴である。効果の証拠は自社の小さな HotPotQA の部分集合（24 問）だけで、自社は調整済み、相手は未調整という条件だった。Letta、LangMem、Microsoft Foundry の記憶はどれもグラフを使わない。Letta は、ファイルを検索するだけのエージェントが LoCoMo で Mem0g を上回ったと報告している。

### Cited Findings
**Cognee**
- `cognify` は 2 つのパイプラインで動く。まず `indexing_pipeline`（LLM なし）が文書の分類・断片化・断片の索引と埋め込みを行い、この時点で `CHUNKS`・`CHUNKS_LEXICAL`・`RAG_COMPLETION`・`HYBRID_COMPLETION` の検索が使える。次の `cognify_pipeline` は、Extract graph（LLM）、Summarize text（既定では抽出したグラフから組み立てるので LLM なし。`summary_method="llm"` で 1 回追加）、埋め込み、の順に進む。既定は「1 LLM call per chunk」 — [Cognee cognify docs](https://docs.cognee.ai/core-concepts/main-operations/cognify)
- LLM を使わない抽出: `GRAPH_EXTRACTOR=gliner_demo` で、抽出と要約をローカルの GLiNER のデモモデルで行い、LLM を一切呼ばない。既定の `auto` は、使える LLM の鍵がなければ自動でこれを選ぶ — [Cognee cognify docs](https://docs.cognee.ai/core-concepts/main-operations/cognify)
- ノードの同一性は `name` から作る（小文字化、空白をアンダースコアに、アポストロフィを除去）。同じ断片の中の同名ノードは別のまま残り、端点がその断片のノードにない辺は捨てる。増分処理: 完了した項目は飛ばし、`add()` は内容のハッシュで重複を除く。同じパスのファイルが変わると `DocumentUpdateRequiredError` を出す。矛盾の検査は cognify から外れ、improve の `review_conflicts` に移った — [Cognee cognify docs](https://docs.cognee.ai/core-concepts/main-operations/cognify)
- 既定のストア（v1.1.0、2026-05）: グラフは Kùzu ベース（Neo4j、Neptune、Postgres も可）、ベクトルは LanceDB、関係 DB は SQLite か Postgres。`DocumentChunk` の型付きフィールド（`is_part_of`、`contains`）がそのまま辺になる。構造化データの取り込み（dlt）では外部キーから辺を作る — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- ローカルモデル: Ollama の既定は `llama3.1:8b`（4bit で VRAM 約 6 GB）。資源が少なければ `llama3.2:3b`、中くらいなら `qwen2.5:14b`。「very small or weak models may return malformed JSON or lower-quality graphs」「A light model produces noisy or incomplete graphs on your data」。問題のあるモデルの一覧に当たると警告を出すが、助言にとどまり実行は止めない。失敗は「`InstructorRetryException` errors or empty graphs」として現れる。`num_ctx` を超えたプロンプトは HTTP 500 になる — [Cognee LLM providers](https://docs.cognee.ai/setup-configuration/llm-providers)
- 自社の評価（検索要約。本文は未確認）: HotPotQA の 24 問の部分集合を、各システム 45 回ずつ繰り返した。相手は Mem0、Graphiti、LightRAG。Cognee は調整済みで Graphiti は未調整だったことを、記事自身が認めている。Cognee の調整後の正答は学習分割 0.815、hold-out 0.715、未調整の全 HotPotQA では 0.476。2025 年版の比較では、Graphiti を自分たちで動かせず、Graphiti 側から提供された数値を使った — [Cognee benchmarks](https://www.cognee.ai/knowledge-graph-memory-benchmarks)、[Cognee 2025 eval](https://cognee.ai/blog/deep-dives/ai-memory-tools-evaluation)

**Letta（旧 MemGPT）**
- グラフはない。文脈内の memory block、アーカイブ記憶（ベクトル検索）、会話履歴、任意のファイルシステムの 4 層で、書き込みはモデルが道具（`core_memory_replace` など）を呼んで文字列を置き換える形で行う。同一視も矛盾の検出もない。sleeptime エージェントが、ターンの合間に block をまとめ直す — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- Letta のブログ【2025-08-12】: gpt-4o-mini のエージェントに会話の履歴をファイルとして置き、`search_files` などの道具だけを与えたところ、LoCoMo で **74.0%** になった。Mem0 が報告した最良のグラフ版（68.5%）を上回る。主張は「Knowledge graphs may also come at the cost of being more difficult for the LLM (agent) to understand」「current memory benchmarks may not be very meaningful」。Mem0 の論文が MemGPT を LoCoMo で動かしたとした点については、データを流し込む方法が分からず、Mem0 に問い合わせても返事がなかったとしている — [Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory)

**LangMem（LangChain）**
- グラフは使わない。semantic（collection か profile）、episodic、procedural の 3 種類の記憶を持つ。保存は LangGraph の `BaseStore` で、get・意味検索・メタデータの絞り込みで引く。抽出と統合は LLM で、会話の途中で書く hot path（遅延が増えると明記）と、会話のあとに書く background がある — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- Mem0 の論文の LoCoMo では、LangMem は J=58.10、全体の p50 は 18.53 秒、p95 は 60.40 秒だった（Mem0 による計測） — [Mem0 paper](https://arxiv.org/html/2504.19413)

**Microsoft**
- Foundry Agent Service の Memory（preview、文書の日付は 2026-06-02）: 管理された memory store に「items」として保存する。種類は user profile、chat summary、procedural の 3 つ。抽出、LLM による統合（重複の併合と矛盾の解消）、検索の 3 段で動く。グラフへの言及はない。Azure OpenAI の chat と embedding のデプロイが必須で、1 スコープあたり最大 10,000 記憶。組織の文書を土台にするなら Foundry IQ の知識ベースを、利用者の文書なら file search を使うよう、役割を分けている — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory)
- 提供開始は 2025-11-25 の Foundry のブログ（検索要約） — [Foundry devblog](https://devblogs.microsoft.com/foundry/introducing-memory-in-foundry-agent-service/)。GraphRAG の OSS が maintenance mode であることは既存報告で扱った。

**独立の研究（ベンダー外、または別ベンダー）**
- 2026-06 の研究（13 構成、385 件）: 記憶のパイプラインのどこに LLM を置くかで、どの「忘却」の失敗を救えるかが決まる。決定的な処理だけでは語彙と時間の種類は扱えるが、正規化に失敗する（識別子の難読化で 5%、**言語横断で 0%**）。書き込み時の LLM は正規化で 100% になるが、意図を汲んだ削除では 0%。変更時のフックは全体で 91.7〜93.2%（385 件の実行で約 $0.17、1 件 2.3 秒。決定的な処理は 64〜191 ms）。本番の失敗の多くは想起ではなく忘却の失敗なのに、既存のベンチマークは想起しか測っていない、とも指摘している — [arXiv 2606.15903](https://arxiv.org/abs/2606.15903)
- xmemory の論文（2026-04、v3 は 2026-08）は自社システムの評価で、「schema-grounded」な書き込み時の抽出を主張している。end-to-end の記憶ベンチマークで自社 97.10% F1、第三者のベースラインは 80.16〜87.24%。検索要約によれば、ベースラインは Cognee 約 86.2、Mem0 のグラフ版 86.1、Zep 80.2 だが、abstract では名前を確認できなかった — [arXiv 2604.27906](https://arxiv.org/abs/2604.27906)

### Inferences
- グラフを積極的に作る製品（Graphiti、Cognee）と作らない製品（Letta、LangMem、Foundry、Mem0 OSS v3）が並んでいて、作らない側が LoCoMo で同等以上の自己申告をしている。会話記憶のベンチマークでは、グラフの寄与ははっきりしない。
- Cognee の既定のグラフストアが Kùzu ベースだという点は、Graphiti の README がいう「upstream Kuzu はもう保守されていない」と合わせると、長期運用の危険になりうる（推論。Cognee 側の対応は未確認）。

### Gaps
- Cognee の効果を独立に評価した一次資料は見つからなかった。GLiNER 経路で作ったグラフと LLM 経路のグラフを比べた結果もない。
- Microsoft Research の記憶の研究（Foundry 以外）で、グラフを使うものの現状は調べきれなかった。

## Q4. ローカルモデルで動かした実務者の報告（抽出の失敗、費用、遅延）と、グラフをやめて素のベクトル・キーワード検索に戻った例

### Takeaway
報告の大半は Graphiti の GitHub issue で、症状は共通している。ローカルや OpenAI 互換のモデルは、JSON スキーマをそのまま繰り返すか、必須のフィールドを落とし、Pydantic の検証で落ちる。エピソードは黙って捨てられ、辺が 0 本になる。メンテナの答えは「もっと大きいモデルを」しかない。グラフをやめた最も明確な例は Mem0 OSS 自身（2026-04）で、ほかのチームの「グラフをやめた」事後報告は見つからなかった。

### Cited Findings
- issue #912【2025-09-17】、2026-11 の時点で未解決: Ollama の `deepseek-r1:7b`（Graphiti 0.20.4、Neo4j 5.26、bge-m3）で `ExtractedEntities` の必須フィールドが欠けた。同じ症状は Llama 3.1、`deepseek-r1:70b`、llama4（いずれも Ollama）、ローカルの GLM-4.7-Flash でも報告されている。OpenRouter 経由の GPT-4o-mini・Gemini でも `EdgeDuplicate` の欠落が出た。主な失敗の形: (a) モデルが JSON スキーマ（`$defs`、`'type': 'object'`）をそのまま返す、(b) 箇条書きの平文を返して「Invalid JSON」になる、(c) 単純な episode は通るが、実体が多い複雑な episode が辺の重複判定で落ちる。deepseek-chat では約 50 件に 1 件が失敗し、MCP のキューがそれを捨てて辺が 0 本のまま、HTTP 200 を返した — [issue #912](https://github.com/getzep/graphiti/issues/912)
- PR #1774（ネイティブの Ollama 対応。検索要約）: `json_object` モードでは、ローカルモデルが注入されたスキーマを埋めずに繰り返し、ほぼすべての抽出の呼び出しで検証エラーになった。`json_schema` モード（Ollama の文法制約つき復号）に替えて直したという — [PR #1774](https://github.com/getzep/graphiti/pull/1774)
- issue #1707（検索要約）: `add_memory` が成功を返したのに episode が捨てられる。10 件の一括投入で 40% が落ちた — [issue #1707](https://github.com/getzep/graphiti/issues/1707)。issue #1746（検索要約）: Responses API しかない OpenAI 互換のゲートウェイでは、構造化の抽出が使えない。文書にある `structured_output_mode` が MCP サーバでは実装されていない — [issue #1746](https://github.com/getzep/graphiti/issues/1746)。issue #1204: LaTeX のバックスラッシュを含む実体で JSON の解析に失敗する — [issue #1204](https://github.com/getzep/graphiti/issues/1204)。issue #1171: 前のメッセージに代名詞で出てきた実体を取り落とし、誤った辺を作る — [issue #1171](https://github.com/getzep/graphiti/issues/1171)
- issue #1299【2026-03-05】、未解決でメンテナの返答なし: 「LLM による抽出は、決定的な連結より遅く、高く、信頼性も低い」として、LLM 抽出なしで `add_episode` する選択肢を求めている。👍 は 4 件 — [issue #1299](https://github.com/getzep/graphiti/issues/1299)
- 第三者の Graphiti 構成の known issues: ローカルの端点は `OpenAIGenericClient` の json_object モードに回され、信頼性は「Variable」。「For local LLMs (Ollama), validation errors may still occur」。信頼できると試されたのはクラウドの提供元（OpenRouter、Together、Fireworks）だけ — [madeinoz67 known issues](https://madeinoz67.github.io/madeinoz-knowledge-system/troubleshooting/known-issues.html)
- 日本語の事例: Graphiti の上にローカル RAG を組んだ日本の公開リポジトリ（local-RAG-backend）は、Ollama を埋め込みだけに使い、LLM にはクラウドの OpenAI を使っている。README は、ローカル LLM を使うと出力の形式で問題が出ると注記している（検索要約） — [local-RAG-backend](https://glama.ai/mcp/servers/@suwa-sh/local-RAG-backend/tree/c1ce2a864706ef09b0775c007a4be49b0650235f)
- Cognee のローカル運用は Q3 で挙げた。弱いモデルでは `InstructorRetryException` か空のグラフになる — [Cognee LLM providers](https://docs.cognee.ai/setup-configuration/llm-providers)
- グラフをやめた例: Mem0 OSS は 2026-04-14 に外部グラフストアとグラフ記憶を削除し、OSS の代替は提供しないとした — [Mem0 migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3)。Letta は最初からグラフを作らず、ファイル検索で LoCoMo 74.0% を出した — [Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory)。第三者の総括は「The graph also charges up front」で、書き込みのたびに LLM の費用を払い、それが回収されるのは辿る問い合わせか履歴の問い合わせだけだという — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- 逆方向の主張（ベクトルだけからハイブリッドへ移った、グラフ DB はベクトル DB より挿入が 10 倍以上遅い、など）は DEV Community の個人の投稿やベンダーのブログばかりで、数値は検証できない（検索要約） — [FalkorDB blog](https://www.falkordb.com/blog/ai-agent-memory-retrieval-architecture/)、[DEV](https://dev.to/priyeshdave6/why-we-ditched-vectors-and-graphs-for-sql-in-agent-memory-systems-4pja)

### Inferences
- 失敗は「抽出の質が少し落ちる」という連続的なものではない。スキーマの検証で落ちて episode ごと消え、しかも成功が返る、という不連続で気づきにくいものである。弱いローカル LLM で運用するなら、検証で落ちた単位を記録して、やり直しの列に入れる仕組みが要る（推論）。
- 7B 級でも失敗が報告され、公式の例の 7B を公式の警告自身が戒めている。同じ系統の設計を「弱いローカル LLM」で動かす前提は、製品の作り手自身が支持していない。

### Gaps
- ローカルモデルの大きさ別に、Graphiti や Cognee の抽出の成功率・所要時間・グラフの質を比べた体系的な報告は見つからなかった。
- 企業のチームが、本番でグラフ記憶をやめてベクトル・キーワード検索に戻した事後報告（postmortem）は見つからなかった。
- 日本語の文書でこれらの製品を完全にローカルで動かした実地の報告は見つからなかった。

## Q5. これらのシステムのどの部分が、有能な LLM なしで働くか（episode と時刻の構造、文書のリンク、明示のメタデータ）

### Takeaway
LLM なしで働くのは、どの製品でも「原文の保存、時刻の記録、断片の索引、検索と再順位付け、グラフの走査」の側である。逆に「辺（事実・関係）を作る」「いつから有効かを読む」「矛盾で失効させる」は、Graphiti でも Mem0g でも LLM の仕事である。LLM なしで辺を作る公式の経路は、Cognee の GLiNER 抽出・構造化データの外部キー・断片の構造の辺、Mem0 v3 の spaCy による実体の共有、Graphiti の `add_triplet`（自分で作った三つ組の投入）に限られる。著者が書いた Markdown のリンクを辺として取り込む機能は、どの製品の文書にも見当たらなかった。

### Cited Findings
- Graphiti で LLM を使わない部分: episode（生データ）はそのまま保存され、すべての実体と関係が由来の episode にたどれる — [Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)。DB への書き込みは事前定義の Cypher。検索は cosine・BM25・BFS と、RRF・MMR・ノード距離・episode 言及数による再順位付け（cross-encoder だけが LLM）。コミュニティの検出はラベル伝播 — [Zep paper](https://arxiv.org/html/2501.13956)。同一視には MinHash/LSH の決定的な早道があり、LLM はそのあとの後備えにだけ使う — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- Graphiti で LLM が要る部分: 実体と事実の抽出、曖昧な同一視、`valid_at`/`invalid_at` の抽出、矛盾による失効、コミュニティの要約 — [Zep paper](https://arxiv.org/html/2501.13956)
- Graphiti の `add_triplet(source_node, edge, target_node)` は、自分で作った `EntityNode`/`EntityEdge` を入れられ、既存のノードや辺との重複除去を試みる。ただ、その重複除去が LLM を呼ぶか、既存の事実を失効させうるかは、文書に書かれていない — [Graphiti add_triplet docs](https://help.getzep.com/graphiti/working-with-data/adding-fact-triples)
- Mem0 v3 OSS: 追加ごとに事実抽出の LLM を 1 回呼ぶ。一方、実体の抽出（spaCy）、BM25、ベクトル、実体による押し上げ、MD5 による重複除去には LLM が要らない — [Mem0 migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3)、[codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- Cognee: `indexing_pipeline`（断片、埋め込み、字句の索引）、GLiNER による抽出（`gliner_demo`）、グラフから組み立てる要約（既定）、名前を正規化した同一性、内容のハッシュによる増分処理には LLM が要らない — [Cognee cognify docs](https://docs.cognee.ai/core-concepts/main-operations/cognify)。断片の型付きフィールド（`is_part_of`、`contains`）が辺になり、dlt の外部キーから辺を作る — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)
- 決定的な処理の限界: 語彙と時間の種類は扱えるが、正規化（同じものの言い換え）では、識別子の難読化で 5%、言語横断で 0% だった — [arXiv 2606.15903](https://arxiv.org/abs/2606.15903)
- 時刻の構造: Graphiti の二時制の時刻のうち、transaction time（`created_at`/`expired_at`）は取り込みのたびに機械的に付く。valid time（`valid_at`/`invalid_at`）は本文から LLM が読む — [codepointer.dev](https://codepointer.dev/p/agent-memory-systems-and-knowledge)、[Zep paper](https://arxiv.org/html/2501.13956)

### Inferences
- この利用者のように、400 本の日本語の設計メモを弱いローカル LLM か LLM なしで扱う場合、これらの製品から借りられるのは次の 4 つである。(1) 原文の episode と由来を保存し、すべての派生をそこにたどれる設計（Graphiti）。(2) 取り込み時刻と文書の日付による機械的な時刻（transaction time）。(3) 実体の共有を、検索の加点や共起による連結に使う形（Mem0 v3。ただし spaCy の英語モデルは日本語に置き換えが必要）。(4) 断片の索引を先に作り、グラフは後から足す二段構え（Cognee）。辺を LLM で作る部分は、製品の作り手自身が強いモデルを前提にしているので、借りても再現できない見込みが高い（推論）。
- 文書の Markdown リンクや front matter といった、著者が書いた明示の構造を辺にする機能は、会話記憶を想定したこれらの製品にはない。このチームが KG2 F で始めた「著者が書いた Markdown のリンクで文書をつなぐ」方向は、製品群が持たない層を補うものになる（推論）。
- 言語横断の正規化（日本語名と英語名）は、決定的な処理では 0% という結果がある。日英が混ざる設計メモでは、ここだけは別名の辞書、人の判断、または埋め込みが要る（推論。既存報告の結論と一致する）。

### Gaps
- Cognee の GLiNER 経路を日本語で使ったときの品質（多言語の GLiNER モデルを指定できるか）は文書から分からなかった。
- Graphiti の `add_triplet` の重複除去と失効の内部動作（LLM を呼ぶか）は文書に書かれておらず、コードの確認が要る。
- 設計文書のような「文書の知識ベース」（会話でないもの）で、これらの製品のグラフが原文の断片への検索に勝つかを評価した公開結果は見つからなかった。ここで挙げたベンチマーク（DMR、LoCoMo、LongMemEval、HotPotQA）はすべて会話か英語の QA である。
