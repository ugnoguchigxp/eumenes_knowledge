# Memgraph・FalkorDB・Kùzu は散文の文書からどう知識グラフを作るか（2026-11 時点）

調査日: 2026-11-10。対象は FalkorDB（GraphRAG-SDK）、Memgraph（AI Toolkit）、Kùzu（とその fork）。Neo4j は対象外。既存の報告書（`reports/LLM推論に頼らない知識グラフ.md`）で扱った LinearRAG・GraphRAG-Bench・GLiNER2 の一般論は繰り返さず、製品固有の事実に絞った。ベンダーの自己申告は、その旨を明記した。

## 1. FalkorDB: GraphRAG-SDK の辺の出どころ、必要なモデル、主張とベンチマーク、エージェントメモリの基盤としての使われ方

### Takeaway
GraphRAG-SDK は 2026-04 に 1.0 として作り直され、2026-08 時点で 1.3.0 である。散文から辺を作るのは**チャンクごとの LLM 抽出**で、文書をまたぐ同一視にも LLM の判定役を使う。LLM なしで辺ができるのは、CSV などの表を `TableMapping` で宣言して読み込む経路と、NER と DBpedia のカタログでオントロジーの下書きを作る経路だけである。GraphRAG-Bench で首位という主張は gpt-4o-mini を使った自己申告で、競合の値は再実行していない。

### Cited Findings
**版と構成**
- README の沿革: 「2026-04: Version 1.0 is released with a new set of benchmarks based on a year's worth of research and customer PoCs」。旧版を使い続けるなら `graphrag-sdk==0.8.2` に固定する。FalkorDB サーバーは 4.20 以上が必要 — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)
- 0.8.2 は 2026-01-15 に公開された。0.8.x の例は Q&A 用モデルに `OllamaGenerativeModel(model_name="llama3:8b")` を使う — [PyPI graphrag-sdk](https://pypi.org/project/graphrag_sdk)（検索結果の要約経由）
- 0.8.1 の説明には、Ollama のモデルは Q&A の段（「after the knowledge graph has been created」）にしか向かないとある。つまり旧版では、ローカルモデルの役割は抽出ではなく問い合わせだった — [PyPI graphrag_sdk 0.8.1](https://pypi.org/project/graphrag_sdk/0.8.1/)（検索結果の要約経由。ページは直接は確認していない）
- Ollama への対応は 0.2.0 で入った — [FalkorDB blog](https://falkordb.com/?p=7726)（検索結果の要約経由）

**取り込みの流れ（v1.x）と LLM を使う段**
- README のパイプライン表:「Extract entities & relations」は LLM を使う。「Resolve entities within a document (exact match)」は使わない。「Deduplicate new entities across documents (LLM judge)」は使う。「Embed & index」は埋め込みモデルを使う — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)
- オントロジーは任意で、`GraphSchema` に対象の型と関係の型（許可するパターン付き）を書く。「The ontology constrains what can be extracted」— [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)
- 対象から元のチャンクへは `MENTIONED_IN` の辺が張られ、`return_context=True` で検索の経路を返す。差分更新は SHA-256 で変化のない文書を飛ばし、文書を消すとその文書にしか出てこなかった対象も消える（v1.1.0） — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)
- `finalize()` は前回以降に足された対象だけを見て、ベクトル索引で名前の近い既存の対象と比べ、「asks an LLM judge to decide which candidates are the same entity」。統合では説明文をすべて残し、ほかの名前は別名として記録し、関係は残る側の対象に付け替える — [FalkorDB docs: GraphRAG-SDK](https://docs.falkordb.com/genai-tools/graphrag-sdk.html)
- Text-to-Cypher は既定で切ってある。有効にすると 1 問につき最大 3 回の LLM 呼び出しが増える — [FalkorDB docs: GraphRAG-SDK](https://docs.falkordb.com/genai-tools/graphrag-sdk.html)
- Markdown は文書構造を保つ取り込み例があり、見出しのパンくずを残す。ただし拡張子が `.md` のファイルはテキストの経路に入り、モデルで抽出される — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK), [Structured Ingestion](https://docs.falkordb.com/graphrag/structured-ingestion.md)

**文書からのオントロジー検出**
- `Ontology.from_sources` の既定は `method="llm"` である。文書ごとに `sample_chunks_per_doc` 個のチャンクを抜き出し、文書の要約を 1 回作って各チャンクのプロンプトの先頭に付ける。LLM はチャンクごとに型を構造化出力で提案し、不正な出力はエラーを添えて `max_retries` まで再試行する。提案はラベルで統合し、最後に 1 回の呼び出しで同義語と向きの逆転をまとめる（「Without this, drafts accumulate synonyms across calls」） — [Ontology Discovery](https://docs.falkordb.com/graphrag/ontology-discovery.md)
- 呼び出し回数は `D × (S + 1) + 1`（D は文書数、S は文書あたりの抜き出しチャンク数）。10 文書・S=3 なら 41 回。再試行があればさらに増える — [Ontology Discovery](https://docs.falkordb.com/graphrag/ontology-discovery.md)
- `method="grounded"` は LLM を 1 回も呼ばない。NER で言及を見つけ、`DBpediaCatalog` などのカタログに型を問い合わせ、スキーマもカタログから取る。どの型が出るかはコーパスで決まるが、カタログにある型しか出てこない — [Ontology Discovery](https://docs.falkordb.com/graphrag/ontology-discovery.md)
- 検出結果は下書きである（「Review ontology.json by hand at this point」）。新しい文書には `suggest_schema_extensions` で追加分だけを提案し、「Nothing is applied to the graph — you review and apply」— [Ontology Discovery](https://docs.falkordb.com/graphrag/ontology-discovery.md)

**LLM なしの構造化データの取り込み**
- `.csv`・`.tsv`・`.psv`・`.tab` は決定的なレコードの経路に入る。`TableMapping` で `label`・`key`・`name`・`properties`・`links`（外部キー）を宣言すると、「Each record becomes one entity, plus an edge for every column that points at something else」。この経路では「No model is called at any point on this path」— [Structured Ingestion](https://docs.falkordb.com/graphrag/structured-ingestion.md)
- 対応を宣言しなかった表には、SDK が「one model call for the whole table, never one per row」で対応を提案する — [Structured Ingestion](https://docs.falkordb.com/graphrag/structured-ingestion.md)
- 表の行と文から取った対象は名前で結合する。「An entity's id is derived from its name in exactly the same way whether it came from a row or a sentence」。表記が違う場合（「Maya Ellison」と「M. Ellison」）は別のノードのまま `probable_duplicates` に出る。JSON は構造化の形式に含まれず、テキストの経路に入る。front matter を対応付ける方法は書かれていない — [Structured Ingestion](https://docs.falkordb.com/graphrag/structured-ingestion.md)

**対応する LLM**
- 「Any LLM or embedder reachable through LiteLLM」を使え、OpenAI・Anthropic・Google・ローカルのモデルを含む — [FalkorDB docs: GraphRAG-SDK](https://docs.falkordb.com/genai-tools/graphrag-sdk.html)
- Providers のページは LiteLLM を推奨の既定とし、OpenRouter もある。Ollama・vLLM は「Custom `LLMInterface` wrapping Ollama, vLLM, etc.」と表に名前があるだけで、設定方法の説明はない。ローカルの埋め込みには sentence-transformers を包む自前の `Embedder` を勧めている。既定の `invoke_with_model` は `invoke()` の出力を JSON として Pydantic に解析する。抽出と Q&A で必要なモデルの大きさの指針はない — [Providers](https://docs.falkordb.com/graphrag/providers.md)
- README の例は `LiteLLM(model="openai/gpt-5.5")` である — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)

**ベンチマークと主張**
- GraphRAG-Bench（ICLR 2026）を GraphRAG-SDK 1.3.0 で回し、2026-08 に採点した。Medical は平均 76.87（事実検索 74.50、複雑な推論 76.47、文脈の要約 82.29、創作 74.21）、Novel は平均 66.09（65.49・59.26・75.42・64.21）。総合の 71.48 は 2 つの平均を FalkorDB が自分で平均したもので、リーダーボードは各データセットを別々に順位付けしている — [Benchmark](https://docs.falkordb.com/graphrag/benchmark.md), [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)
- 比較相手（リーダーボードの値で、再実行はしていない）。Novel / Medical の順に、RAG（再順位付けつき）48.35 / 62.43、HippoRAG2 56.48 / 64.85、LightRAG 45.09 / 62.59、MS-GraphRAG（local）50.93 / 45.16、G-reasoner 58.94 / 73.30、AutoPrunedRetriever-llm 63.72 / 67.00。「Competitor numbers were not re-run by us」— [Benchmark](https://docs.falkordb.com/graphrag/benchmark.md), [Accuracy Benchmark](https://docs.falkordb.com/graphrag/graphrag-accuracy-benchmark.md)
- 条件: グラフの構築と生成は `gpt-4o-mini`（Azure OpenAI、temperature 0.7）、埋め込みは `text-embedding-3-large`（1024 次元）、判定役は `gpt-4o-mini`。SDK の既定から外した設定は `enable_cypher=True`（Cypher を使った回答は Medical の 22%、Novel の 29%）と、埋め込みの 1024 次元（既定は 256）。オントロジーはコーパスごとに作り（Medical は対象 10 種・関係 13 種、Novel は 8 種・13 種）、質問と根拠の欄は読んでいないとしている。再現用の一式は「available on request」で、公開されていない — [Benchmark](https://docs.falkordb.com/graphrag/benchmark.md)
- 索引の時間: Medical（510 チャンク）が約 1.5 時間、Novel（20 文書・約 2,500 チャンク）が約 4 時間。24 コアの機械で測り、時間の大半は抽出の API 呼び出しだった。token 数と費用は書かれていない — [Benchmark](https://docs.falkordb.com/graphrag/benchmark.md)
- 本人たちが書いている限界: 「Two datasets in two domains do not generalize to every workload」、LLM の判定は回すたびに「will not be bit-identical」、「No retrieval architecture eliminates hallucinations」— [Accuracy Benchmark](https://docs.falkordb.com/graphrag/graphrag-accuracy-benchmark.md)
- 以前の主張（2025-04-07 のブログ）: 2023 年の Diffbot KG-LM ベンチマーク（43 問）を引き、KG なしの LLM 16.7% に対し GraphRAG 56.2%（3.4 倍）とした。「Metrics & KPIs」と「Strategic Planning」の 2 分類では、ベクトル RAG の正答率が 0% だったとしている。「FalkorDB's 2025 SDK pushed GraphRAG to 90%+ accuracy」は 2025 年第 1 四半期の社内試験で、方法は公開されていない — [FalkorDB blog](https://www.falkordb.com/blog/graphrag-accuracy-diffbot-falkordb/)
- 数値の食い違い: README のミラー（github.ddaodan.workers.dev）には 63.73 / 75.73 / 69.73 という別の値が載っているという検索要約があった。一次資料では確かめられていない。旧版の README の値だった可能性がある — [検索結果の要約](https://github.ddaodan.workers.dev/FalkorDB/GraphRAG-SDK)。現行の README と docs はどちらも 66.09 / 76.87 / 71.48 である — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)

**エージェントメモリの基盤として**
- Graphiti（Zep）は FalkorDB を正式な基盤の 1 つにしている。`pip install graphiti-core[falkordb]` で入れ、`FalkorDriver` を `Graphiti(graph_driver=...)` に渡す — [Zep blog](https://www.getzep.com/blog/graphiti-knowledge-graphs-falkordb-support/)（検索結果の要約経由）
- Graphiti の README は、新しいプロジェクトには Neo4j か FalkorDB を勧めている。また「Graphiti depends on structured (JSON) output for entity/edge extraction and deduplication」とし、「Graphiti works best with LLM services that support Structured Output (such as OpenAI, Anthropic, and Gemini)… Using other services may result in incorrect output schemas and ingestion failures. This is particularly problematic when using smaller models」「Very small models frequently emit JSON that doesn't match the requested schema」と書く。ローカルのサーバーには `OpenAIGenericClient` を使い、「Prefer the most capable model you can run」、`SEMAPHORE_LIMIT` は低く保つよう勧めている — [Graphiti README](https://github.com/getzep/graphiti)
- FalkorDB の docs には「Agentic Memory」の節があり、Graphiti の MCP サーバー（実験的）と Mem0 の解説がある。エージェントごとに別のグラフを持たせ、計算資源は共有するというテナント分離を売りにしている（ベンダーの主張） — [FalkorDB docs: Agentic Memory](https://docs.falkordb.com/agentic-memory/), [Graphiti MCP server](https://docs.falkordb.com/agentic-memory/graphiti-mcp-server.md)
- FalkorDB の FAQ は、GraphRAG 向けの連携先に Graphiti・Cognee・LangChain・LlamaIndex・GraphRAG-SDK を挙げている — [FalkorDB FAQ](https://www.falkordb.com/news-updates/data-retrieval-graphrag-ai-agents)（検索結果の要約経由）。ただし Cognee 自身のグラフストアの文書（Ladybug のページ）には FalkorDB が出てこない — [Cognee docs: Ladybug](https://docs.cognee.ai/guides/ladybug)
- ライセンスは SSPLv1 で、OSI が承認したオープンソースのライセンスではない、という第三者の指摘がある — [Atlan](https://atlan.com/know/ai-agent/knowledge-graph/falkordb-graph-database-for-graphrag/)（検索結果の要約経由）

### Inferences
- 400 文書に `method="llm"` のオントロジー検出をかけると、S=3 で `400×4+1 = 1,601` 回の呼び出しになる。ここに、チャンクごとの抽出と finalize での判定が加わる。既存の報告にある、2 KB の断片 1 つに約 52 秒かかるローカルモデルでは、検出だけで約 23 時間かかる計算になる（1,601 × 52 秒。プロンプトの長さの違いは無視した粗い見積もり）。
- 公式の索引時間（510 チャンクで 1.5 時間、API の gpt-4o-mini、24 コア）からも、品質の主張は「gpt-4o-mini 級のモデルと JSON の構造化出力が安定していること」を前提にしている。弱いローカルモデルで同じ精度が出る根拠はない。既定の JSON 解析と、Graphiti の小さいモデルへの警告もこれを裏づける。
- GraphRAG-Bench の SDK の事実検索（Novel 65.49）は、既存の報告で引いた論文の再順位付けつき RAG の事実検索 60.92 を上回る。ただし SDK の側は Cypher を有効にし、埋め込みの次元も変えた自己申告の値なので、同じ条件の比較ではない。
- LLM なしで使えそうなのは、`TableMapping`（front matter を CSV に書き出せば、文書の属性やリンクを決定的に辺にできる）と、名前の id を作る規則による表と文の結合である。`grounded` によるオントロジー検出は DBpedia の型に縛られるので、社内の設計メモの概念（モジュール名、設計判断）にはほぼ当たらないと考えられる。

### Gaps
- v1.x で Ollama などのローカルモデルを抽出に使った例や、品質の報告は見つからなかった。0.8.x の「Q&A のみ」という注意書きが v1.x で取り下げられたのかも確認できなかった。
- 抽出の段で使う関係抽出のプロンプトや、日本語の扱い（チャンク分割の `SentenceTokenCapChunking` が日本語の文境界を扱えるか）の記述はなかった。
- GraphRAG-Bench に token 数と費用の数値はなく、再現の一式も非公開。
- Cognee が FalkorDB を今も正式に対応しているかは、一次資料では確認できなかった。

## 2. Memgraph: GenAI/GraphRAG の道具、LLM が要る段、公開された指針と評価

### Takeaway
Memgraph の AI Toolkit（2025-11 発表）の `unstructured2graph` は、当初は LightRAG による LLM 抽出だった。2026 時点では、**既定がローカルの GLiNER2（`fastino/gliner2.5-base-v1`）で、LLM も API キーも要らない**。ただし既定のオントロジーには関係の型がない。そのため既定で張られる辺は、対象とチャンクを結ぶ `MENTIONED_IN` と、チャンクを順につなぐ `NEXT` だけである。型付きの関係は、関係の型を書いたオントロジーを与えれば GLiNER2 でも取れ、LightRAG なら LLM で取れる。品質の評価は公開されていない。

### Cited Findings
**AI Toolkit の構成**
- 2025-11-11 に SQL2Graph・Unstructured2Graph を含む「AI Graph Toolkit」を発表した。GitHub と Memgraph Cloud で使える — [Business Wire](https://www.businesswire.com/news/home/20251111832729/en), [Memgraph blog](https://memgraph.com/blog/unstructured-text-to-entity-graphs-rag-tool)
- README にあるパッケージ: `context-graph`（coding agent の永続メモリで、セッション・ツール呼び出し・明示的な記憶を保存）、`unstructured2graph`、`agents/sql2graph`（MySQL・PostgreSQL からグラフへ移行）、`integrations/langchain-memgraph`（グラフストア・QA chain・エージェント用の道具）、`integrations/mcp-memgraph`（MCP サーバー）、`integrations/lightrag-memgraph`（LightRAG のストレージ）、`memgraph-toolbox`、`hygm`（グラフの対象と関係の型を定義し検証） — [memgraph/ai-toolkit](https://github.com/memgraph/ai-toolkit)

**unstructured2graph の変遷（2025-11 → 2026）**
- 2025-11-11 のブログ: 解析は `unstructured`、抽出は LightRAG で、LightRAG が「ontology generation and LLM-driven extraction」を担う。spaCy などの従来の NLP にも触れるが、領域固有の設定は難しいとして LLM を選んでいる。著者らの試験では GPT-4o Mini で 1 文書あたり約 10 秒かかり、何度か LLM を呼ぶ。数千ページなら「time-consuming and potentially expensive」になる。精度の数値はない — [Memgraph blog (2025-11-11)](https://memgraph.com/blog/unstructured-text-to-entity-graphs-rag-tool)
- 2026 時点の README: 「Its default backend, GLiNER2, runs locally without an LLM API key」「LightRAG is available as an LLM-based alternative」— [memgraph/ai-toolkit](https://github.com/memgraph/ai-toolkit)
- サブフォルダの README: 既定のチェックポイントは `fastino/gliner2.5-base-v1`（初回に自動で取得）、「Free, fully offline after the model download」。LightRAG は「needs `OPENAI_API_KEY` (or another configured LLM)」— [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph)
- オントロジーは YAML で、`entity_types`（`label`・`description`・任意の `identity`: `global`・`chunk`・`span`）と `relation_types`（任意の `start_labels`・`end_labels`）を書く。「It extracts on gliner2's joint path, where each relation type's `start_labels`/`end_labels` constrain decoding」。期間・数量・金額・日付などの値の型は、別に値だけを取る段で処理する。同梱の既定は LightRAG の語彙（Person、Organization、Location、Event など）に合わせてある — [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph)
- 作られる辺: 対象は、それを言及するすべてのチャンクと `MENTIONED_IN` で結ばれる。関係は `:works_for` のようにラベルを型とする Cypher の辺になり、`chunk`・`confidence`・`valid_at`・`source_id`・`role`・`text` を持つ。`link_chunks=True` ならチャンク間に `NEXT` が張られる。同一視のあとに残った自己ループは捨てる — [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph)
- 同一視: GLiNER2 は identity の種類と正規化した文字列で対象をまとめる。別名の正規化は LightRAG の LLM にしかない — [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph)
- 設定: `entity_confidence_threshold`、`relation_confidence_threshold`、`chunk_size=384`、`chunk_overlap=64`、`mention_resolver`、`candidate_cap=4096`、`model_name`。窓の取り方は「one window per segment, splitting only a segment longer than `chunk_size` words」— [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph)
- 公式 docs: 「Its default local model extracts entities; with an LLM, it also extracts relationships」(knowledge graph creation の概要)。個別のページでは、既定のオントロジーには関係の型がなく、関係を取るには対象と関係の型を書いた独自のオントロジーが要るとしている。LightRAG は「An LLM extracts entities and any relationships it finds, and merges mentions of the same entity across chunks」「Each chunk costs at least one LLM call」— [Knowledge graph creation](https://memgraph.com/docs/ai-ecosystem/knowledge-graph-creation), [Unstructured2Graph](https://memgraph.com/docs/ai-ecosystem/knowledge-graph-creation/unstructured2graph-agent)
- 入力は Unstructured で解析し、「PDFs, URLs, HTML, Markdown, DOCX, and more」に対応する。PDF と DOCX には `all-docs` の追加が要る。PyTorch も入る — [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph), [Unstructured2Graph](https://memgraph.com/docs/ai-ecosystem/knowledge-graph-creation/unstructured2graph-agent)
- 既定のチェックポイント `fastino/gliner2.5-base-v1` は 194M パラメータ、Apache-2.0 で、モデルカードには「Language: English」とある。多言語の兄弟は `fastino/gliner2.5-multi-v1`（287M、mDeBERTa-v3-base） — [HF: gliner2.5-base-v1](https://huggingface.co/fastino/gliner2.5-base-v1)

**SQL2Graph（構造化データ）**
- 「proposes a graph model and migrates the data」。対応付けは「either by rules or with an LLM, and you review the model before it migrates the data」。CSV・JSON・Parquet・Cypher のファイル、Neo4j、ストリームには別の取り込み経路がある。文書については、自前のパイプラインが「gives you the most control over accuracy, which matters in production」としている — [Knowledge graph creation](https://memgraph.com/docs/ai-ecosystem/knowledge-graph-creation)

**検索側（GraphRAG）と指針**
- 「Vector search finds the entities a question is about, and graph traversal follows their relationships to the facts connected to them」。検索全体を 1 つの Cypher で走らせる「Atomic GraphRAG」を掲げ、質問の型で分ける。分析的な質問は Text2Cypher、1 つの対象のまわりは局所グラフ検索、全体は query-focused summarization。どれを使うかは Agentic GraphRAG のエージェントが選ぶ。例のアプリは「runs vector search, deep path traversals, community detection and PageRank」— [Memgraph docs: GraphRAG](https://memgraph.com/docs/ai-ecosystem/graph-rag)
- 前提条件として「a running Memgraph with MAGE, your data and an LLM API key」を挙げる一方、1 コマンドで動く例は「no API key」で動く。ベンチマークや品質の数値は公開されておらず、根拠は数値のない 2 件の顧客事例（Precina Health、Cedars-Sinai）だけである。ローカルや小さいモデルへの言及はない — [Memgraph docs: GraphRAG](https://memgraph.com/docs/ai-ecosystem/graph-rag)
- LLM の選択は利用者に任せている（「the large language model of your choice」）。スキーマに領域の情報を足すと、生成される Cypher と検索の質が上がるとしている — [Prerequisites](https://memgraph.com/docs/ai-ecosystem/graph-rag/prerequisites), [Atomic Pipelines](https://memgraph.com/docs/ai-ecosystem/graph-rag/atomic-pipelines)（検索結果の要約経由）
- 参照アーキテクチャ: 「Every node keeps a reference back to its source」。LLM が作るクエリに備えて、読み取り専用の権限を強く勧めている — [Memgraph in GraphRAG use cases](https://memgraph.com/docs/deployment/workloads/memgraph-in-graphrag)（検索結果の要約経由）
- Cognee では Memgraph はコミュニティのアダプタで、cognee-community のリポジトリにあり、本体のリリース試験の対象外である — [Cognee docs: Ladybug](https://docs.cognee.ai/guides/ladybug)

### Inferences
- 3 製品のうち、**散文から LLM なしで辺を作る経路を既定にしているのは Memgraph だけ**である。その中身は、既存の報告が勧める「対象とチャンクの型なし二部グラフ（`MENTIONED_IN`）＋チャンクの並び（`NEXT`）」とほぼ同じ形をしている。製品の既定が同じ結論に落ちた例として使える。
- ただし既定のモデルは英語専用である。窓の分割も「words」で数えるので、空白のない日本語では 1 つの段落が 1 語に見え、窓が分かれない可能性がある（コードは見ていない推論）。`model_name` に `gliner2.5-multi-v1` を渡せるかは、引数があることしか確認できていない。
- 同一視は「identity の種類＋正規化した文字列」の完全一致なので、日本語の表記ゆれ（全角と半角、送り仮名、カタカナと英語）は既存の報告のとおり自前の正規化が要る。
- `context-graph`（coding agent のメモリ）があるので、Memgraph が狙う用途は今回の「エージェントが蓄積した知識を検索で再利用する」に近い。ただし評価の公開はない。

### Gaps
- GLiNER2 を使う経路の抽出品質・速度（CPU で何文書/分か）は、Memgraph 側に数値がない。
- Memgraph の MAGE に、spaCy などを使った NLP や規則で抽出するモジュールがあるかは見つからなかった。
- `langchain-memgraph` が LLMGraphTransformer 前提かどうか、LlamaIndex 連携での抽出方式は、一次資料で確認していない。
- SQL2Graph の「rules」の中身（外部キーから辺を作るのか）は詳しく読んでいない。
- GLiNER2 を使う経路に切り替えた正確な日付（どのリリースか）は確認できなかった。

## 3. Kùzu: 知識グラフ・GraphRAG との連携と、2025〜2026 年のプロジェクトの状況

### Takeaway
Kùzu 本体は 2025-10-10 にアーカイブされ、最終版は v0.11.3 である。Apple が 2025-10 に Kùzu Inc. の買収で合意したことが、EU の DMA の届出から 2026-02 に報じられた。Kùzu は、文書からグラフを作る道具を自分では持たず、LlamaIndex・LangChain・BAML など外部の LLM 抽出の保存先だった。fork は LadybugDB（最も活発。Cognee の既定）、RyuGraph（Predictable Labs）、Bighorn（Kineviz）の 3 つ。Graphiti は Kuzu の driver を非推奨にした。

### Cited Findings
**アーカイブと買収**
- GitHub には「This repository was archived by the owner on Oct 10, 2025. It is now read-only.」とある。README は v0.11.3 を最新とし、「Kuzu is working on something new!」と書く。文書とブログは kuzudb.github.io/docs と /blog に移った。v0.11.3 は「bundles many (but not all) of the extensions」— [kuzudb/kuzu](https://github.com/kuzudb/kuzu)
- The Register（2025-10-14）: 「KuzuDB says so long and thanks for all the commits, marooning community」。Kùzu Inc. からの公式説明はなかった。買収は利用者の推測として扱っている。Kineviz が fork の Bighorn を作り、創業者は「We are looking for like-minded individuals and companies to maintain and develop KuzuDB together」と呼びかけた — [The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/)
- Apple は 2025-10-09（EU の一覧では 10.10）に、子会社を通じて Kùzu の全株式を取得し、一部の社員を雇う契約を結んだ。DMA の届出から明らかになり、AppleInsider が最初に報じた — [BetaKit](https://betakit.com/apple-strikes-deal-to-acquire-canadian-database-software-startup-kuzu/), [MacRumors (2026-02-11)](https://www.macrumors.com/2026/02/11/apple-acquires-new-database-app/), [AppleInsider (2026-02-11)](https://appleinsider.com/articles/26/02/11/faster-more-flexible-databases-could-be-coming-to-filemaker-or-iwork)（検索結果の要約経由）
- Waterloo 大学（2026-02-24）は、Apple が 2025-10 に全株式の取得と一部の雇用で合意したと BetaKit を引いて報じた。Kùzu は Semih Salihoğlu 教授の研究室から 2023 年に会社になった。OSS の今後には触れていない — [University of Waterloo](https://uwaterloo.ca/computer-science/news/waterloo-based-graph-database-start-up-kuzu-acquired-apple)
- PyPI の `kuzu` は「No new releases are expected」としている — [PyPI kuzu](https://pypi.org/project/kuzu/)（検索結果の要約経由）

**fork と後継**
- LadybugDB: サイトの題は「The KuzuDB Successor」で、2026 時点で v0.22.1（lakehouse の機能は「new in 0.22.0」）。拡張に `fts`・`vector` があり、ontobug（OWL・SHACL・RDF を Cypher の property graph に入れる）、エージェント向けの `ladybug-fs`（「A filesystem view of the graph for agents」）、「LadybugDB for Edge Agent AI memory」という Leanpub の本がある — [LadybugDB](https://ladybugdb-web.pages.dev/)
- LadybugDB のブログ（2026-03-01）: 「Since Kuzu was officially archived in October 2025, our team forked the repository」。v0.15 を「biggest milestone yet」とし、Arrow・DuckDB・Parquet の接続、subgraph に対応した。運営の主体や資金の出どころは書かれていない — [Ladybug blog](https://9904c494.ladybug-blog.pages.dev/post/ladybug-spreading-its-wings/)
- LlamaIndex には `llama-index-graph-stores-ladybug` がある — [PyPI](https://pypi.org/project/llama-index-graph-stores-ladybug/)（検索結果の要約経由）
- RyuGraph: Predictable Labs が以前から社内で使っていた fork を MIT で公開した。版は 25.9.x。公式の拡張サーバーはない — [RyuGraph docs](https://docs.ryugraph.io), [Predictable Labs blog](https://blog.ryugraph.io/posts/introducing-predictable-labs-and-ryugraph)（検索結果の要約経由）
- Bighorn（Kineviz）の 2026 年の活動は確認できなかった — [The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/)
- 周辺も止まった: `kuzudb-mcp-server` は 2025-10-21 にアーカイブ、Godot 向けの KuzuGD は 2025-12-16 にアーカイブ — [検索結果の要約](https://glama.ai/mcp/servers/@jordanburke/kuzudb-mcp-server/tree)

**エージェントメモリ・GraphRAG の基盤としての扱い**
- Cognee は既定のグラフストアを Ladybug に替えた。「**Ladybug** (`ladybug`, also accepted as `kuzu`) — Local file-based graph database (default)」「Ladybug was previously called Kuzu」。`kuzu` という指定と `KUZU_*` の環境変数はそのまま使え、既存の `cognee_graph_kuzu` があればそれを使い続ける。いつ切り替えたかは書かれていない — [Cognee docs: Ladybug](https://docs.cognee.ai/guides/ladybug)
- Graphiti: 「Kuzu is **deprecated** and will be removed in a future release — the upstream Kuzu project is no longer maintained」。driver は `DeprecationWarning` を出しつつ残っている — [Graphiti README](https://github.com/getzep/graphiti)
- Kuzu から LadybugDB への移行で、パッケージ名・API・拡張は変える必要がある、という第三者の記事がある（2026-08-12） — [OneUptime](https://oneuptime.com/blog/post/2026-08-12-kuzu-to-ladybugdb-packages-apis-extensions-database-files/view)（検索結果の要約経由）

**Kùzu で文書からグラフを作る経路（すべて外部の LLM 抽出）**
- LlamaIndex の `KuzuPropertyGraphStore`（`llama-index-graph-stores-kuzu`）は、関係のスキーマとベクトル索引を持つ property graph の保存先である。古い `KuzuGraphStore` もある — [LlamaIndex: Property graph kuzu](https://developers.llamaindex.ai/python/examples/property_graph/property_graph_kuzu)（検索結果の要約経由）
- LangChain の `langchain-kuzu`（0.4.2）の `KuzuGraph` は、graph document を Kùzu に入れ、Text2Cypher の QA chain を持つ。LLMGraphTransformer がある `langchain-experimental` はもう保守されていない — [PyPI langchain-kuzu](https://pypi.org/project/langchain-kuzu/), [LangChain docs](https://docs.langchain.com/oss/python/integrations/graphs/kuzu_db.md)（検索結果の要約経由）
- Kùzu 公式の BAML のデモ（アーカイブ済み、2025-10-10）: スキーマを先に決め、BAML で LLM に JSON を出させて Kùzu に入れ、Text2Cypher で GraphRAG にする。2025-03 の抽出の比較は商用のモデルだけである。表の画像では gpt-4o-mini が完全一致 170・欠落 2・幻覚の疑い 2（$0.0008）、gpt-4o が 174（35 倍の費用）、claude-3.5-sonnet が 173、gemini-2.0-flash が 158（欠落 12・幻覚の疑い 8）。臨床メモのテキストでは、4 モデルとも 19 件すべて完全一致だった。オープンなモデルやローカルのモデルは試していない — [kuzudb/baml-kuzu-demo](https://github.com/kuzudb/baml-kuzu-demo)
- BAML の fuzzy parsing で、小さい量子化モデルの抽出の成功率が約 25% から 99% 超に上がった、という第三者の記事がある（Medium、会員限定） — [Level Up Coding](https://levelup.gitconnected.com/improving-langchain-knowledge-graph-extraction-with-baml-fuzzy-parsing-a2413b2a4613)（検索結果の要約経由。本文は未確認）
- Kùzu の旧ブログには「Fully In-Browser Graph RAG with Kuzu-Wasm」「Towards agentic Graph RAG: Enhancing graph retrieval with vector search」などの記事があった — [Kuzu blog tags](https://blog.kuzudb.com/tags/graph)（検索結果の要約経由。blog.kuzudb.com は 2026-11-10 時点で名前解決できず、kuzudb.github.io/blog の該当記事も 404 だった）

### Inferences
- 今回の目的に Kùzu そのものを新しく選ぶ理由はない。組み込み型で Cypher を使うという同じ性質が要るなら、LadybugDB が事実上の後継である。ただし運営の主体と資金が公開されておらず、Cognee 以外の採用の規模も確かめられないので、長期の保守は賭けになる。
- Kùzu の系譜から得られる教訓は、「保存先の DB は抽出の質を決めない」ということである。Kùzu の例はどれも、商用 LLM の構造化出力に頼っていた。

### Gaps
- Apple が OSS の Kùzu について公式に何か述べたかは見つからなかった（Apple は買収について普通は発表しない）。
- `llama-index-graph-stores-kuzu` と `langchain-kuzu` が 2026 年も保守されているか、Ladybug 版に置き換わったのかは確認できなかった。
- RyuGraph と Bighorn の 2026 年の開発状況（最終コミット、リリース）は確認できなかった。
- Kùzu の BAML の記事の本文（小さいモデルについての指針があったか）は、ブログが消えていて読めなかった。

## 4. 3 製品を通して: 強い LLM なしで役に立つ辺を作る経路はあるか、小さいモデルやローカルのモデルについて何を言っているか

### Takeaway
LLM なしの経路は 3 つある。(a) **構造化データの決定的な取り込み**（FalkorDB の `TableMapping`、Memgraph の SQL2Graph の規則による対応付け、Kùzu 系の CSV・Parquet・Arrow）、(b) **小さい専用エンコーダによる抽出**（Memgraph の GLiNER2 が既定。既定では対象とチャンクの二部グラフ）、(c) **NER とカタログによるオントロジーの下書き**（FalkorDB の `grounded`）。散文から型付きの関係を作る経路は、3 製品とも gpt-4o-mini 級の API モデルを前提にして評価していて、小さいローカル LLM での品質を公表した製品はない。

### Cited Findings
- FalkorDB: 表の宣言による取り込みでは「No model is called at any point on this path」— [Structured Ingestion](https://docs.falkordb.com/graphrag/structured-ingestion.md)。`method="grounded"` のオントロジー検出は LLM の呼び出しが 0 回 — [Ontology Discovery](https://docs.falkordb.com/graphrag/ontology-discovery.md)。ただし散文の抽出と、文書をまたぐ重複の判定は LLM を使う — [GraphRAG-SDK README](https://github.com/FalkorDB/GraphRAG-SDK)
- FalkorDB の 0.8.x では、Ollama は「Q&A の段だけ」とされていた — [PyPI graphrag_sdk 0.8.1](https://pypi.org/project/graphrag_sdk/0.8.1/)（検索結果の要約経由）。v1.x の Providers のページは、ローカルのモデルを自前の `LLMInterface` で包む方法の名前を挙げるだけで、指針はない — [Providers](https://docs.falkordb.com/graphrag/providers.md)
- Memgraph: GLiNER2 が既定で「`GLiNER2Backend` needs no API key — it runs entirely locally」— [unstructured2graph README](https://github.com/memgraph/ai-toolkit/tree/main/unstructured2graph)。SQL2Graph は「either by rules or with an LLM」— [Knowledge graph creation](https://memgraph.com/docs/ai-ecosystem/knowledge-graph-creation)
- LadybugDB は Arrow・DuckDB・Parquet を変換せずに接続して問い合わせられる — [Ladybug blog](https://9904c494.ladybug-blog.pages.dev/post/ladybug-spreading-its-wings/)
- 小さいモデルへの警告ではっきりしているのは Graphiti である。「This is particularly problematic when using smaller models」「Very small models frequently emit JSON that doesn't match the requested schema」「Prefer the most capable model you can run」— [Graphiti README](https://github.com/getzep/graphiti)
- 評価のモデル: FalkorDB の GraphRAG-Bench の値は gpt-4o-mini — [Benchmark](https://docs.falkordb.com/graphrag/benchmark.md)。Memgraph の唯一の数値（1 文書約 10 秒）も GPT-4o Mini — [Memgraph blog](https://memgraph.com/blog/unstructured-text-to-entity-graphs-rag-tool)。Kùzu の抽出の比較も商用の 4 モデルだけ — [baml-kuzu-demo](https://github.com/kuzudb/baml-kuzu-demo)

### Inferences
- 約 400 本の日本語 Markdown の設計メモには、次の組み合わせが製品の設計とも一致する。(1) front matter・リンク・見出しなど、人が書いた構造を表の形で決定的に入れる（FalkorDB の `TableMapping` と同じ考え方）。(2) 本文からは言及とチャンクの二部グラフだけを作る（Memgraph の既定と同じ形）。(3) 型付きの関係は、必要な所だけ後から付ける。どの製品も、弱いローカル LLM で散文から関係を作り、エージェントの検索に効いたという証拠を出していない。
- 3 製品のどれかを DB として採用しても、抽出の問題は解決しない。抽出はアプリ側（または上に載せる SDK）の仕事で、DB は保存と探索を担うだけである。今回の規模（400 文書）なら、Memgraph（メモリ上のサーバー）や FalkorDB（Redis 系のサーバー）を立てる運用の重さに見合う性能上の利点は小さい（推論）。
- Memgraph の GLiNER2 の経路を日本語に流用するなら、`gliner2.5-multi-v1` への差し替え、日本語の文や窓の分割、Sudachi などの正規化キーによる同一視の 3 つを自分で足す必要がある（既存の報告の結論と同じ）。

### Gaps
- 3 製品とも、ローカルの 7B 以下の LLM で抽出したときの品質と速度を公表していない。
- FalkorDB の `grounded` で使う NER の実装（spaCy か GLiNER か）と、日本語への対応は書かれていない。

## 5. 日本語での利用や評価

### Takeaway
3 製品とその fork について、**日本語の文書で知識グラフを作った評価や公式の日本語の解説は見つからなかった**。日本語で見つかるのは、製品の一般的な紹介と GraphRAG の概念の解説だけである。

### Cited Findings
- FalkorDB の日本語のページは、Hostinger や stork.ai の製品紹介（Redis 上に作られ、OpenCypher で問い合わせる）にとどまり、日本語の公式文書は見当たらなかった — [Hostinger JP](https://www.hostinger.com/jp/applications/falkordb), [stork.ai JP](https://www.stork.ai/ja/falkordb)（検索結果の要約経由）
- Memgraph と Kùzu を日本語で検索しても、日本語のページは出てこなかった。GraphRAG の日本語の解説（WEEL、AI PICKS など）は Microsoft の実装や Neo4j を使った一般論で、AI PICKS は日本語特有の固有表現の揺れが幻覚の原因になると指摘している — [WEEL](https://weel.co.jp/media/tech/about-graphrag/), [AI PICKS](https://aipicks.jp/glossary/graphrag)（検索結果の要約経由）
- Memgraph の既定の抽出モデル `fastino/gliner2.5-base-v1` は「Language: English」— [HF](https://huggingface.co/fastino/gliner2.5-base-v1)。FalkorDB と Memgraph の docs には、言語への対応の記述がない — [FalkorDB docs](https://docs.falkordb.com/genai-tools/graphrag-sdk.html), [Memgraph Unstructured2Graph](https://memgraph.com/docs/ai-ecosystem/knowledge-graph-creation/unstructured2graph-agent)
- GraphRAG-Bench（FalkorDB の主張の根拠）の Medical と Novel は英語のデータである — [Benchmark](https://docs.falkordb.com/graphrag/benchmark.md)

### Inferences
- 製品の主張と数値は、そのまま日本語の設計メモに当てはめられない。日本語に効くかどうかは、自分の 400 本で測るしかない。とくに FalkorDB の名前から id を作る規則（表と文を名前で結合）と、Memgraph の正規化した文字列での同一視は、日本語の表記ゆれで取りこぼす可能性が高い。

### Gaps
- Zenn や Qiita に絞った検索（サイトを 1 つずつ指定）はしていない。日本語の個人の試用記事がある可能性は残る。
- `gliner2.5-multi-v1` の日本語の精度の公開値は見つからなかった（既存の報告でも見つかっていない）。
