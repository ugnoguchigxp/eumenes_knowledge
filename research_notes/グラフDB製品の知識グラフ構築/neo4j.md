# Neo4j と公式ツールは、散文の文書から知識グラフの辺をどう作るか（2026-11 時点）

調査日: 2026-11-10。一次情報（Neo4j の公式ドキュメント、Neo4j Labs のページ、GitHub の README・Releases・Issues、論文）を優先した。検索結果の要約だけに頼った箇所は「（検索要約のみ）」と書いた。GitHub Releases のページは日付に年が出ないため、年は並び順と内容から推定し「（年は推定）」と書いた。2025 年以前の情報には日付を付けた。既存レポート（LinearRAG、GLiNER/GLiREL、係り受け規則、共起グラフ、LazyGraphRAG）と重なる内容は扱っていない。

---

## 1. Neo4j LLM Knowledge Graph Builder（neo4j-labs/llm-graph-builder）: パイプライン、対応 LLM、抽出方法、スキーマ、小型・ローカルモデル

### Takeaway
LLM Graph Builder の辺は 2 種類ある。LLM を使わずに作る「文書→チャンク、チャンク→次のチャンク、チャンク同士の類似（kNN の `SIMILAR`）」と、LangChain の LLMGraphTransformer（または有料 API の Diffbot）で作るエンティティ間の辺である。後者には構造化出力（tool calling/JSON）をきちんと返せる LLM が要る。Ollama は手順上は使えるが、本番の既定は OpenAI と Diffbot だけである。小さいローカルモデルで抽出に失敗する Issue が複数あり、Neo4j 側は抽出品質の数値を公開していない。公式ページは「英語の長文で最もよく動く」と書いている。

### Cited Findings
**パイプライン（Labs のページ "How it works"）**
- 手順は次のとおり。(1) アップロードした原典を `Document` ノードとして保存する。(2) 種類ごとに LangChain loader で読み込む。(3) チャンクに分け、チャンクを文書と、チャンク同士を互いにつなぐ。(4) 類似度の高いチャンク同士に `SIMILAR` 関係を張り、kNN グラフを作る。(5) 埋め込みをチャンクとベクトル索引に保存する。(6) llm-graph-transformer か diffbot-graph-transformer でエンティティと関係を抽出し、元のチャンクにつなぐ — [Neo4j Labs: LLM Knowledge Graph Builder](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)
- 抽出には「Neo4j が LangChain に寄贈した llm-graph-transformer module」を使う、と書かれている — [Neo4j Labs](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)
- 品質についての記述は 2 点ある。"best results for files with long-form text in English"、"less well suited for tabular data like Excel or CSV or images/diagrams/slides"。ノード型と関係型を設定すると品質が上がる、とも書かれている。費用・レート制限・Ollama の設定はこのページにない — [Neo4j Labs](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)
- 質問応答の方式として GraphRAG、Vector、Text2Cypher を挙げている — [Neo4j Labs](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)

**対応 LLM とローカル実行（README）**
- README は 11 のプロバイダを挙げる。OpenAI, Gemini, Diffbot, Azure OpenAI, Anthropic, Fireworks, Groq, Amazon Bedrock, Ollama, Deepseek, OpenAI 互換の base URL のモデルである。このうち OpenAI, Gemini, Diffbot 以外には "(dev deployed version)" と付いている。docker-compose の既定で有効なのは OpenAI と Diffbot だけである — [README](https://github.com/neo4j-labs/llm-graph-builder)
- Ollama を使う手順は次のとおり。`ollama/ollama` の Docker イメージを動かしてモデルを pull し（例は llama3）、`LLM_MODEL_CONFIG_ollama_<model_name>` に `model_name,model_local_url` を設定し、UI でモデルを選ぶ。ほかのローカル実行環境は説明がない — [README](https://github.com/neo4j-labs/llm-graph-builder)
- Labs ページの対応モデル一覧は OpenAI, Gemini, Llama3, Diffbot, Claude, Qwen で、README の一覧と一致しない — [Neo4j Labs](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/) / [README](https://github.com/neo4j-labs/llm-graph-builder)

**チャンク・埋め込み・後処理の設定（README の環境変数）**
- チャンク分割の設定は `VITE_TOKENS_PER_CHUNK`（既定 100）、`VITE_CHUNK_OVERLAP`（20）、`MAX_TOKEN_CHUNK_SIZE`（10000、「ファイル内容を処理する最大トークン数」）、`VITE_CHUNK_TO_COMBINE`（1、並列処理で結合するチャンク数）。`VITE_CHUNK_SIZE`（5242880）はアップロードの分割単位で、テキストの分割とは別物 — [README](https://github.com/neo4j-labs/llm-graph-builder)
- 埋め込みは `IS_EMBEDDING`（既定 true）。エンティティごとの埋め込み `ENTITY_EMBEDDING` は既定 False。埋め込みのプロバイダは OpenAI, Gemini, Amazon Titan, Sentence Transformers で、指定しなければ Sentence Transformer — [README](https://github.com/neo4j-labs/llm-graph-builder)。既定の SentenceTransformer は 384 次元のベクトルを出す — [Neo4j blog, 2025-03-10](https://neo4j.com/blog/developer/knowledge-graph-extraction-challenges/)
- 後処理のグラフ整理には LLM を使う。`GRAPH_CLEANUP_MODEL` の既定は `openai_gpt_5_mini`。重複検出のパラメータは `DUPLICATE_TEXT_DISTANCE`（5）、`DUPLICATE_SCORE_VALUE`（0.97）、`KNN_MIN_SCORE`（0.8）、`EFFECTIVE_SEARCH_RATIO`（1） — [README](https://github.com/neo4j-labs/llm-graph-builder)
- チャットモードの既定は 7 つ。vector, graph_vector, graph, fulltext, graph_vector_fulltext, entity_vector, global_vector — [README](https://github.com/neo4j-labs/llm-graph-builder)

**スキーマと後処理（Neo4j 開発者ブログ、Kaustubh Darekar、2025-03-10。構造化データ上の著者名は別人で、署名と食い違う）**
- 事前のスキーマ定義を障害とみなしている。"Defining a graph schema (node labels, relationship types, properties) beforehand can be a bottleneck." そのため、入力テキストからスキーマを推定する方式をとる。抽出するノード型と関係型を利用者が絞ると雑音が減る — [Knowledge graph extraction and challenges](https://neo4j.com/blog/developer/knowledge-graph-extraction-challenges/)
- 重複エンティティの統合は、抽出の後に "graph enhancement" 画面で手作業で行う。schema consolidation では LLM が冗長・不整合なラベルと関係型をまとめる（任意） — [同上](https://neo4j.com/blog/developer/knowledge-graph-extraction-challenges/)
- チャンクについては "chunks that are too large get too broad and vague" とあり、LLM の入力窓にも収める必要がある — [同上](https://neo4j.com/blog/developer/knowledge-graph-extraction-challenges/)
- 規則ベースは "Traditional rule-based or pattern-based approaches for information extraction are brittle and struggle to handle the variability and ambiguity..." と退けている。精度・再現率・ベンチマークの数値は一つもなく、「higher accuracy and robustness」とだけ主張している — [同上](https://neo4j.com/blog/developer/knowledge-graph-extraction-challenges/)
- 2025 年最初のリリースで、コミュニティ要約とそれ用の local/global retriever、複数の retriever を並列に走らせて評価する機能、カスタムのプロンプト指示が入った。コミュニティ要約には Graph Data Science を有効にした Neo4j が要る（検索要約のみ） — [LLM knowledge graph builder—First release of 2025](https://neo4j.com/blog/developer/knowledge-graph-builder-first/)

**リリース（年は推定）**
- v0.8.7（7 月 23 日、最新。2026 年と推定）で、"discontinued langchain-experimental and langchain-community packages" を置き換えた。LLMGraphTransformer はもともと `langchain_experimental` にあった。v0.8.4（1 月 15 日、2026 年と推定）では Gemini 2.5 Flash が既定になり、抽出・チャット・後処理のトークン使用量をユーザーごとに記録するようになった。v0.8.2（5 月 19 日、2025 年と推定）では "chatollama not working" を直した。リリースノートで Ollama に触れているのはここだけである — [Releases](https://github.com/neo4j-labs/llm-graph-builder/releases)

**小型・ローカルモデルの Issue**
- Issue を "ollama" で検索すると 47 件ある。主なもの: #1294 ローカルの Qwen3:14b で AttributeError（2025-07-29 クローズ）、#1285 `'ChatOllama' object has no attribute 'model_name'`（2025-05-14 クローズ）、#1293 AWS 上の Ollama LLaMA 3 が遅い（オープン）、#1238 Docker+Ollama のデプロイ失敗 — [Issues: ollama](https://github.com/neo4j-labs/llm-graph-builder/issues?q=ollama)
- #1123 "Use ollama and deepseek-r1:1.5b can't generate graph"（2025-02-24 報告）では、中国語の PDF を deepseek-r1:1.5b で処理したところ、LLM が関係型に文字列ではなく入れ子の dict を返し、pydantic の "Input should be a valid string" で失敗した。別の利用者は「チャンクのノードはできたが、その先のグラフができない」と報告している。コラボレーターの回答は "Currently, the DeepSeek LLM model is not producing structured output as expected when used with LLM Graph Builder"、続いて "This is problem with LLMGraphTransformer for certain llms like deepseek which fails to give structured output in schema specified. We are yet to find solution on this."（2025-04-10）。代わりに勧められたのはホスト型の `deepseek-chat` と、Ollama の llama3 の設定例だけだった。2026-01-02 に "completed" でクローズされたが、解決を説明するコメントはない — [Issue #1123](https://github.com/neo4j-labs/llm-graph-builder/issues/1123)

### Inferences
- LLM を使わずにこのツールで得られる辺は、`Document`–`Chunk`、チャンクの順序、埋め込みの kNN による `SIMILAR` の 3 種類である。エンティティ間の辺と後処理（cleanup、schema consolidation、コミュニティ要約）は LLM か Diffbot に依存する。LLM なしで使うと、これは「ベクトル検索＋近傍チャンク」の器でしかない。
- 弱いローカル LLM の場合、問題は精度より前に、スキーマどおりの構造化出力を返せるかどうかである。#1123 のように失敗したチャンクはグラフにならない。Neo4j はモデル別の成功率を公開していないので、約 400 件の日本語ノートで使うなら、自前の小さな検査（成功したチャンクの割合、文書をまたぐ辺の数）が最初に必要になる。
- 対応モデル一覧に GPT-5.x、Claude 4.5/4.7 などのホスト型モデルが次々に追加されている一方、Ollama は "dev deployed version" の扱いのままである。開発の重心はホスト型の大型モデルにあるとみられる。

### Gaps
- `graph`、`entity_vector`、`global_vector` の各チャットモードが内部で何を使うか（Text2Cypher なのか、抽出エンティティなのか、コミュニティなのか）は、今回読んだページでは確かめられなかった。
- Diffbot が LLM を使っているか、日本語に対応しているかは確認していない。README の環境変数表で `DIFFBOT_API_KEY` が "mandatory" と書かれている理由もわからない。
- 重複検出のパラメータ（`DUPLICATE_TEXT_DISTANCE` など）が具体的にどの処理で使われるかは、README の表だけでは確定できない。
- langchain-experimental をやめた後、LLMGraphTransformer がどのパッケージに移ったかは確認していない。

---

## 2. neo4j-graphrag-python（SimpleKGPipeline, LexicalGraphBuilder, 抽出器, エンティティ解決, retriever）: どの工程に LLM が要るか

### Takeaway
公式 Python パッケージの KG builder で LLM が要るのは、エンティティ・関係の抽出（`LLMEntityRelationExtractor`）と、テキストからのスキーマ自動抽出（`SchemaFromTextExtractor`）の 2 か所だけである。読み込み・分割・埋め込み・lexical graph（Document→Chunk、`NEXT_CHUNK`）・書き込み・エンティティ解決（完全一致、RapidFuzz、spaCy の静的埋め込み）は LLM なしで動く。ただし、LLM を使わない抽出器は同梱されていない。検索側では、Vector、VectorCypher、Hybrid、HybridCypher の各 retriever は埋め込みモデルだけで動き、LLM が要るのは Text2Cypher と ToolsRetriever である。KG builder はいまも "experimental" で、構造化出力は OpenAI、Vertex、Anthropic に限られる。

### Cited Findings
**KG builder の部品と LLM の要否（User Guide: Knowledge Graph Builder）**
- 部品は次のとおり。data loader（`PdfLoader`。カスタマイズの節に `MarkdownLoader`）、text splitter（`FixedSizeSplitter` と、LangChain・LlamaIndex のアダプタ）、chunk embedder（`TextChunkEmbedder`。LLM ではなく `Embedder` を使う）、lexical graph builder、schema builder（手書きの `SchemaBuilder` と、LLM を使う `SchemaFromTextExtractor`）、entity and relation extractor（`LLMEntityRelationExtractor`）、graph pruner（スキーマで掃除する）、KG writer（`Neo4jWriter`）、entity resolver — [User Guide: KG Builder](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)
- spaCy や規則ベースのエンティティ抽出器の記述はない。spaCy が出てくるのは `SpaCySemanticMatchResolver` だけ、RapidFuzz は `FuzzyMatchResolver` だけである。抽出器は自前のサブクラスにすれば任意の方式にできる — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)
- 注意書きは "This feature is still experimental. API changes and bug fixes are expected." — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)

**Lexical graph**
- `Document`（`path` プロパティ）、`Chunk`（`text` と、計算すれば埋め込み）、`NEXT_CHUNK`（文書内で次のチャンクへ）、`FROM_DOCUMENT`（チャンクから文書へ）、抽出エンティティからチャンクへのリンクがある。ただし、同じページの `LexicalGraphConfig` の例では `PART_OF_DOCUMENT`、`PART_OF_CHUNK`、埋め込みプロパティ `embeddings` が使われていて、本文の名前と一致しない。クエリを書く前に実際の名前を確かめる必要がある。`create_lexical_graph=False` でチャンクのノードがなければ、writer はチャンクへの関係を作らない — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)
- Neo4j が運営する GraphRAG Pattern Catalog では、「Lexical Graph」パターンの作り方を "Split documents into chunks and use an embedding model to embed the text content of the chunks" と説明し、チャンクを `PART_OF` で文書につなぐ。LLM には触れていない。このパターンは "Basic Retrievers" で使う、とある — [graphrag.com: Lexical Graph](https://graphrag.com/reference/knowledge-graph/lexical-graph/)

**スキーマ**
- 手書きのスキーマでは、ノード型、関係型、`(source, relationship, target)` のパターンを定義する。自動抽出では、`SchemaFromTextExtractor` がテキストから一度だけスキーマを作り、それで全チャンクの抽出を導く。`schema` 引数は `"EXTRACTED"` か `None`（既定）で自動抽出、`"FREE"` か空でスキーマなし。`additional_node_types` などで、定義外の要素を残すかどうかを決める。ページ自身が、スキーマは "does not impose strict constraints" で、LLM がラベルやプロパティを足しうると書いている — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)

**エンティティ解決（LLM 不要）**
- `SimpleKGPipeline` では既定で解決が走る（`perform_entity_resolution=False` で止める）。`SinglePropertyExactMatchResolver` はラベルが同じで `name` が完全一致するノードを統合する。`FuzzyMatchResolver` は RapidFuzz（Levenshtein）で、ラベルが同じで名前が似たノードを統合する（速いが精度は落ちうる）。`SpaCySemanticMatchResolver` は spaCy の静的埋め込みのコサイン類似度で統合する（品質が高い、とされる）。どれも writer が作ったノードを置き換える。`filter_query` で対象から除外できる — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)

**失敗時の挙動と構造化出力**
- 構造化出力（`use_structured_output=True`）は `OpenAILLM`、`VertexAILLM`、`AnthropicLLM` だけで動き、ほかのプロバイダでは `ValueError` になる — [User Guide: KG Builder](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)。RAG の User Guide では、`response_format` を使うと "Other LLM providers will raise *NotImplementedError*"。例外の型が 2 つのページで食い違う — [User Guide: RAG](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- 既定では、抽出に失敗したチャンクは捨てられ、成功したチャンクだけが保存される: "By default, if the extraction fails for one chunk, it will be ignored and the non-failing chunks will be saved." `on_error=OnError.RAISE` にすると、一つの失敗でパイプライン全体が失敗し、何も保存されない。チャンクは LLM のトークン上限に収める必要がある。費用やレート制限の指針はない — [User Guide: KG Builder](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)

**Retriever と LLM・embedder の要否（User Guide: RAG）**
- `VectorRetriever`: LLM 不要。テキストの質問には embedder が要る（`query_vector` を直接渡すこともできる）。Neo4j のベクトル索引を使う — [User Guide: RAG](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- `VectorCypherRetriever`: LLM 不要。ベクトル索引で当たった `node` から、利用者が書いた `retrieval_query`（Cypher）でグラフをたどる — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- `HybridRetriever` / `HybridCypherRetriever`: LLM 不要。ベクトル索引と全文索引を併用する（Cypher 版はさらに `retrieval_query` でたどる）。hybrid 系はフィルタに対応しない — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- `Text2CypherRetriever`: `llm` が必須で、スキーマと質問から LLM が Cypher を作って実行する。"the Text2Cypher retriever does not require any embedder." — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- `ToolsRetriever`: "ToolsRetriever requires an LLM instance to function." — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- 外部ベクトル DB の retriever（Weaviate, Pinecone, Qdrant）は、外部の ID と Neo4j の ID を突き合わせ、`retrieval_query` も使える — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)
- LLM クラスは OpenAI, AzureOpenAI, VertexAI（Gemini）, Anthropic, MistralAI, Cohere, `OllamaLLM`、LangChain のチャットモデル（例 `ChatOllama`）、自作の `LLMBase`。`OllamaLLM` は "Assuming Ollama is running on the default address 127.0.0.1:11434" とある。embedder には `SentenceTransformerEmbeddings`（既定 `all-MiniLM-L6-v2`）と `OllamaEmbeddings` がある — [同上](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)

**リリース（年は推定。1.19.0 で "Neo4j 2026" に触れているので、1.14 以降は 2026 年と推定）**
- 1.23.0（10 月 28 日）: スキーマ抽出で、各ノード型を一度だけ定義するよう LLM に指示するようになった。ラベルが重複したノード型は統合し、`GraphSchema` は重複ラベルを拒否する。1.22.0（10 月 1 日）: スキーマ抽出を「つながったグラフ」が出やすいよう調整した。ParquetWriter の非 ASCII ラベルを修正した。1.19.0（8 月 26 日）: `AnthropicLLM` の構造化出力、Cypher 25 のベクトル `SEARCH` に対応した。2.0 に向けて部品を experimental から移し始めた。1.18.0（6 月 24 日）: 関係型を一度だけ定義するよう LLM に指示し、重複した関係型を自動で調停するようになった。1.17.0（5 月 27 日）: "Fixed an infinite loop in FixedSizeSplitter on text without whitespace"。1.15.0（4 月 23 日）: Markdown ファイルへの対応、トークン使用量の記録 — [Releases](https://github.com/neo4j/neo4j-graphrag-python/releases)

### Inferences
- LLM を使わない構成でこのパッケージから得られるのは、lexical graph（Document–Chunk–`NEXT_CHUNK`）、埋め込み、全文索引、そして利用者が自前で書き込んだ辺（Markdown のリンクなど）を `VectorCypherRetriever` の `retrieval_query` でたどる検索である。KG2 F でやった「Markdown のリンクで文書をつなぐ」は、Neo4j の流儀では「lexical graph に明示的な辺を足し、Cypher retriever でたどる」に当たる。そのうえで Neo4j 製品の中で LLM なしに完結するのは、検索側だけである。
- エンティティ解決が LLM 不要でも、統合する相手のエンティティを作るのは LLM の抽出器である。抽出器を自作しない限り、解決器だけを使う意味はない。
- Ollama は構造化出力の対象外なので、弱いローカル LLM ではプロンプトで JSON を出させることになる。既定では失敗したチャンクが黙って捨てられるので、抽出の歩留まりを測らない限り、グラフの穴は見えない。
- 1.18〜1.23 の修正の多く（型の重複定義の抑止、重複した関係型の調停、つながったグラフへの誘導）は、LLM が出すスキーマや関係型が散らばる問題への対策である。既存レポートが指摘する「関係名が断片ごとに散る」問題は、公式パッケージでも 2026 年まで改修が続く課題になっている。

### Gaps
- `SpaCySemanticMatchResolver` の既定の spaCy モデル名と、日本語モデル（`ja_core_news_*` など）を指定できるかは確認していない。
- `LexicalGraphConfig` の既定の関係型の名前（`FROM_DOCUMENT` か `PART_OF_DOCUMENT` か）は、ドキュメント内で食い違ったまま確定できなかった。ソースコードの確認が必要。
- KG builder が 2026-11 時点でも experimental かどうかは、Releases からは判断できない。User Guide には experimental の注意書きが残っている。

---

## 3. LangChain LLMGraphTransformer / LlamaIndex PropertyGraphIndex（Neo4j と組み合わせた場合）: 何が辺を作るか

### Takeaway
LangChain の LLMGraphTransformer は、LLM の tool calling（使えないときはプロンプトと few-shot）で、エンティティと関係を辺として出す。`include_source=True` を付けると、抽出エンティティから元の Document への `MENTIONS` 辺が加わる。LlamaIndex の PropertyGraphIndex は、既定で `SimpleLLMPathExtractor`（LLM）と `ImplicitPathExtractor`（LLM も埋め込みも不要）の 2 つを使う。後者は、パーサが付けたノード間の関係（`node.relationships`）をそのまま辺にする。どちらもエンティティ間の辺は LLM 頼みで、作者自身が「スキーマを与えても実行ごとに結果が変わる」「能力の低いモデルは指示に従えない」と書いている。

### Cited Findings
**LLMGraphTransformer（Tomaz Bratanic "Building Knowledge Graphs with LLM Graph Transformer"。ミラーで読んだ。ミラーには日付がない）**
- 既定は tool-based モードで、LLM の構造化出力や function calling に `Node`、`Relationship`、`Property` の Pydantic クラスを渡す。モデルが tool に対応しないとき、または `ignore_tool_usage=True` のときは prompt-based モードに落ち、few-shot の例と独自のパーサで JSON にする。prompt-based では関係しか取らないので孤立ノードは出ず、"we do not allow extraction any properties" — [Bratanic（ミラー）](https://readmedium.com/building-knowledge-graphs-with-llm-graph-transformer-a91045c49b59)
- `allowed_nodes` と `allowed_relationships` でラベルと型を絞れる。関係は `(source, type, target)` の 3 つ組でも指定できる。`strict_mode` は既定 True で、スキーマ外の出力を後処理で消す。作者は LLM が "can sometimes take creative liberties" と書き、能力の低いモデルは指示に正確に従えないから strict mode がある、と説明している — [同上](https://readmedium.com/building-knowledge-graphs-with-llm-graph-transformer-a91045c49b59)
- 非決定性について。スキーマなしで同じ Marie Curie の段落を繰り返し処理すると、関係型も詳しさも実行ごとに違った。`allowed_nodes` を足すとノードは安定したが一部は揺れ、`allowed_relationships`、さらに 3 つ組のパターンを足すと安定性は上がった。それでも完全には決定的にならなかった。例の出力は 5 ノード・4 関係で、そのうち `WON` の辺が重複していた — [同上](https://readmedium.com/building-knowledge-graphs-with-llm-graph-transformer-a91045c49b59)
- `baseEntityLabel=True` で全エンティティに共通の `__Entity__` ラベルを付ける。`include_source=True` で元文書を取り込み、`MENTIONS` でエンティティにつなぐ。同一視は、プロンプトで "use the most complete identifier consistently" と指示するだけで、効果は測られていない — [同上](https://readmedium.com/building-knowledge-graphs-with-llm-graph-transformer-a91045c49b59)
- LLM Graph Builder の Issue では、LLMGraphTransformer が一部の LLM でスキーマどおりの構造化出力を得られないことを、メンテナ側が認めている（2025-04） — [Issue #1123](https://github.com/neo4j-labs/llm-graph-builder/issues/1123)

**LlamaIndex PropertyGraphIndex**
- 抽出器は 4 つある。`SimpleLLMPathExtractor`（LLM。1 ホップの `(entity1, relation, entity2)`）、`ImplicitPathExtractor`（LLM 不要。各ノードの `node.relationships` から辺を作る）、`DynamicLLMPathExtractor`（LLM。エンティティ型付き。許可する型は誘導するだけで強制しない）、`SchemaLLMPathExtractor`（LLM。許可したエンティティ・関係・接続のスキーマに制約する）。"If not provided, the defaults are `SimpleLLMPathExtractor` and `ImplicitPathExtractor`." `ImplicitPathExtractor` は "This extractor does not need an LLM or embedding model to run." — [LlamaIndex: Property Graph Index guide](https://developers.llamaindex.ai/python/framework/module_guides/indexing/lpg_index_guide/)
- retriever は 4 つある。`LLMSynonymRetriever`（既定。LLM が質問からキーワードと同義語を作る）、`VectorContextRetriever`（既定。埋め込みのみで LLM 不要）、`TextToCypherRetriever`（LLM。"Executing arbitrary cypher has its risks" と警告がある）、`CypherTemplateRetriever`（LLM は固定の Cypher テンプレートの引数を埋めるだけ） — [同上](https://developers.llamaindex.ai/python/framework/module_guides/indexing/lpg_index_guide/)
- `SchemaLLMPathExtractor` は既定で LLM API のエラーを握りつぶす（`raise_on_error=False`）。`Neo4jPropertyGraphStore` は埋め込みを自前で保存・検索できる。小型・ローカルモデルについての注意はない。"Advanced Usage with Neo4j and local models" という例へのリンクがあるだけ — [同上](https://developers.llamaindex.ai/python/framework/module_guides/indexing/lpg_index_guide/)

**独立評価（抽出品質）**
- CEUR-WS Vol-4085 paper 49 は、LLMGraphTransformer、KGGen、GT2KG を、計算機科学の論文要旨 3 本で正解データと比べた。適合率は GT2KG が最も高く、再現率は LLMGraphTransformer が勝った。F1 は LLMGraphTransformer（Gemini Flash）と KGGen（Gemini Pro）が最も高かった（検索要約のみ。PDF は圧縮されていて本文と数値を取り出せなかった。PDF のリンク注記から、著者の多くは国立情報学研究所の所属とみられる） — [CEUR-WS Vol-4085 paper49](https://ceur-ws.org/Vol-4085/paper49.pdf)

### Inferences
- 3 つのツールで、辺の出どころを並べると次のとおり。

| 辺 | 作るもの | LLM |
|---|---|---|
| Document→Chunk（`FROM_DOCUMENT`/`PART_OF`）、Chunk→Chunk（`NEXT_CHUNK`） | 分割器・lexical graph builder | 不要 |
| Chunk↔Chunk `SIMILAR`（kNN） | 埋め込みの類似度（LLM Graph Builder） | 不要（埋め込みモデル） |
| パーサ由来の関係（LlamaIndex `ImplicitPathExtractor`） | `node.relationships` | 不要 |
| エンティティ→Chunk/Document（`MENTIONS` など） | 抽出器が出したエンティティを元につなぐ | エンティティ抽出に必要 |
| エンティティ↔エンティティ（型付き関係） | LLMGraphTransformer / `LLMEntityRelationExtractor` / `*LLMPathExtractor` / Diffbot | 必要（Diffbot は外部 API） |
| エンティティの統合 | 完全一致・RapidFuzz・spaCy 埋め込み（neo4j-graphrag）、LLM の cleanup（LLM Graph Builder） | 前者は不要、後者は必要 |
| コミュニティ（Leiden）と要約 | GDS のアルゴリズムと LLM の要約 | 検出は不要、要約は必要 |

- 文書をまたぐ辺をエンティティ経由で作る道は、どの製品でも LLM の抽出器に通じている。LLM を使わずに文書をまたぐ辺は、埋め込みの kNN（`SIMILAR`）か、利用者が自前で書き込む明示的な辺（リンク、タグ、見出しの階層）しかない。
- 作者自身が、GPT-4o でも実行ごとに関係型が揺れると書いている。弱いローカル LLM では、関係型の散らばりと抜けがさらに大きくなると考えるのが自然である（測定値はない）。

### Gaps
- LangChain の公式 API リファレンスは新しいドメインへのリダイレクトで読めず、`ignore_tool_usage` などの引数名を一次情報で確かめていない。
- CEUR の論文の数値（適合率・再現率・F1）は取り出せなかった。
- Bratanic の記事の元の掲載先と日付（2024 年後半と思われる）を確かめていない。

---

## 4. 抽出品質・費用・検索の改善についての評価と、グラフが割に合わない場合の指針

### Takeaway
Neo4j の公式ドキュメントとブログに、抽出品質や検索の改善を測った数値はなかった。Neo4j と WhyHow の共同記事（2024-06）も定性的な比較だけである。独立した系統的な評価（Han et al., 2025）では、LLM で抽出した三つ組のグラフ（LlamaIndex 実装の KG-GraphRAG）は、どのデータセットでも普通の RAG に負けた。答えのエンティティは、GPT-4o-mini で作ったグラフに約 66% しか入っておらず、構築時間は RAG の約 57 倍だった。マイクロソフト式のコミュニティ GraphRAG（Local）が勝つのは多段の質問だけで、単発の詳細な質問と要約では RAG が勝つか互角である。GraphRAG-Bench（2025〜2026）も、GraphRAG は実務の多くのタスクで素の RAG に劣ると書いている。

### Cited Findings
**Han et al. "RAG vs. GraphRAG: A Systematic Evaluation and Key Insights"（arXiv 2502.11371 v2）**
- 比べた方式は次のとおり。KG-GraphRAG（LlamaIndex の LLM 抽出の三つ組。三つ組のみ／三つ組＋本文）、Community-GraphRAG（Microsoft、Local と Global）、HippoRAG2、基準の RAG（約 256 token のチャンクを上位 10 件、text-embedding-ada-002）。生成は Llama-3.1-8B/70B-Instruct。グラフの構築には費用の理由で GPT-4o-mini を使った — [arXiv 2502.11371v2](https://arxiv.org/html/2502.11371v2)
- 8B での主な結果: NQ の F1 は RAG 64.78、Community-Local 63.01、KG 三つ組＋本文 50.27、HippoRAG2 61.03。HotpotQA の F1 は 60.04 / 61.66 / 42.60 / 63.01。MultiHop-RAG 全体の正解率は 67.02 / 69.01 / 48.51 / 70.27。NovelQA の平均は 57.12 / 53.03 / 37.80 / 56.54。70B の MultiHop-RAG では RAG 65.77、Community-Local 71.17、時間関係の質問では 25.73 対 49.06 — [同上](https://arxiv.org/html/2502.11371v2)
- 著者の結論は "RAG excels on detailed single-hop queries"、GraphRAG（Community-Local）は "excels on multi-hop queries"。Community-Global は "tends to hallucinate" — [同上](https://arxiv.org/html/2502.11371v2)
- 要約（ROUGE-2 F1、8B）: QMSum は RAG 6.32 対 Community-Local 5.64、ODSum-story は 9.81 対 8.49、ODSum-meeting は 8.77 対 8.02、SQuALITY はほぼ同じ（10.08 対 10.10）。原文のチャンクを返す RAG と HippoRAG2 が "generally performs well" — [同上](https://arxiv.org/html/2502.11371v2)
- グラフの網羅性: "only around 65.8% of answer entities exist in the constructed KG for the Hotpot dataset and 65.5% for the NQ dataset." 答えが取得内容に入っている割合は、KG 三つ組のみで 0.392（HotpotQA）/ 0.3218（NQ）、RAG で 0.886 / 0.867 — [同上](https://arxiv.org/html/2502.11371v2)
- 費用（MultiHop-RAG）: 構築時間は RAG 135、KG-GraphRAG 7702、Community-GraphRAG 5560（単位はページに書かれていない）。取得トークン数の平均は RAG 3631 対 Community 9770、ODSum-story では 2279 対 10244 — [同上](https://arxiv.org/html/2502.11371v2)
- GPT-4o で抽出すると GraphRAG は "generally improves" が、RAG と GraphRAG の比較の結論は変わらない。両方の取得結果を連結する Integration は、最良の方式を 6.4% 上回る（その分トークンと遅延が増える）。質問ごとに振り分ける Selection は 1.1%。LLM-as-a-Judge は、提示の順番だけで "completely opposite decisions" をする — [同上](https://arxiv.org/html/2502.11371v2)

**GraphRAG-Bench "When to use Graphs in RAG"（arXiv 2506.05690。v1 2025-06-06、v3 2026-02-22）**
- 要旨: "recent studies report that GraphRAG frequently underperforms vanilla RAG on many real-world tasks." 課題は fact retrieval、complex reasoning、contextual summarization、creative generation。要旨のページに数値はない — [arXiv 2506.05690](https://arxiv.org/abs/2506.05690)

**Neo4j 自身が出した比較・主張**
- Neo4j と WhyHow.AI の "Knowledge Graph vs. Vector RAG"（Chia Jeng Yang、2024-06-05）。Apple の決算説明会の文字起こし 3 本で、9 エンティティ型・8 関係・8 パターンのスキーマを先に決めて WhyHow SDK でグラフを作り、FAISS＋OpenAI 埋め込み＋Cohere の再順位付け＋GPT-4 と比べた。正式なベンチマークはなく、指標もない。網羅性の例では、グラフが 25 項目、ベクトル検索が 3 項目を返した。ただしグラフ側の 25 項目には "product"、"revenue" などの雑音と重複が含まれる（この点は取得したページの要約による指摘で、記事自体は触れていない）。記事は "There are, however, limitations of a graph-only search." "Such simplification and abstraction of information bears the risk of losing some of the underlying context." と認め、ハイブリッドを勧めている — [Neo4j developer blog](https://neo4j.com/developer-blog/knowledge-graph-vs-vector-rag/)
- LLM Graph Builder の抽出の記事（2025-03-10）には、精度・再現率・ベンチマークの数値が一つもない — [Neo4j blog](https://neo4j.com/blog/developer/knowledge-graph-extraction-challenges/)。neo4j-graphrag-python の KG builder のガイドにも、費用・レート制限の指針はない — [User Guide: KG Builder](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html)
- 販売側の数字: Neo4j の GraphRAG Manifesto 周辺では「data.world が 43 の業務質問で精度 3 倍」と引用される。Neo4j の講演は検索精度 20〜35% 改善をうたい、Lettria（Neo4j と Qdrant の顧客）は 20〜25% の精度向上を報告している（いずれも検索要約のみ。原典は未確認） — [Neo4j: GraphRAG Manifesto](https://neo4j.com/?p=331042), [NODES 2025 session](https://neo4j.com/nodes-2025/agenda/enhancing-retrieval-augmented-generation-with-graphrag-patterns-in-neo4j/), [Qdrant: Lettria case study](https://qdrant.tech/blog/case-study-lettria-v2/)
- 独立した実践者の分析（MLOps Community）では、Neo4j の GraphRAG は faithfulness だけを上げ（0.54 対 FAISS の 0.18）、ほかの RAGAS 指標は上がらなかった（検索要約のみ） — [MLOps Community: GraphRAG Analysis Part 2](https://home.mlops.community/public/blogs/graphrag-analysis-part-2-graph-creation-and-retrieval-vs-vector-database-retrieval)

**「グラフが要らない」側の公式の記述**
- Neo4j の GraphRAG Pattern Catalog は、チャンクと埋め込みだけの Lexical Graph を最初のパターンとして挙げ、"Basic Retrievers" 用だとしている — [graphrag.com: Lexical Graph](https://graphrag.com/reference/knowledge-graph/lexical-graph/)。Labs のページは、表・画像・スライドには向かないと書く — [Neo4j Labs](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)。それ以上に「グラフを作らないほうがよい」条件を書いた Neo4j の文書は見つからなかった。

### Inferences
- Neo4j 系のツールで作られるのは、Han et al. の「KG-GraphRAG（LLM 抽出の三つ組）」に近いグラフである。LLM Graph Builder と neo4j-graphrag はどちらもチャンクを残すので「三つ組＋本文」側に当たるが、それでも NQ と HotpotQA で RAG より 14〜17 ポイント低かった。マイクロソフト式のコミュニティ要約は LLM Graph Builder にも入ったが、Global 側の幻覚と取得トークンの 2.7〜4.5 倍の増加を伴う。
- 答えのエンティティの網羅率（約 66%）は GPT-4o-mini での値である。弱いローカル LLM ならさらに下がり、構造化出力の失敗でチャンクごと抜ける分も加わる、と見るのが妥当である（直接の測定はない）。
- 約 400 件の設計ノートで LLM エージェントが過去の知見を引くという用途は、ほとんどが単発の詳細な質問（「〜をどう決めたか」）と推定される。この評価に沿えば、RAG（原文チャンク）を主にし、グラフは多段や横断の質問の補助に回す設計が筋になる。論文が示す、両方の取得結果を連結する Integration が、ハイブリッドの現実的な形である。
- 「data.world が 3 倍」という数字の出典は、記憶では Sequeda et al.（arXiv 2311.07509、2023-11）の、企業の SQL データベース上の質問応答で、知識グラフ表現を介すと GPT-4 の正解率が 16.7% から 54.2% に上がった、という結果である。散文の文書から自動抽出したグラフの話ではない。本調査では原典を取得していないので、使う前に確認が要る。

### Gaps
- Neo4j の公式資料で、LLM Graph Builder や neo4j-graphrag の抽出品質（精度・再現率）や、ベクトル検索に対する改善幅を測った数値は見つからなかった。
- GraphRAG-Bench の本文の数値（どの課題で GraphRAG が勝つか、索引の費用）は読んでいない。
- MLOps Community の分析、Lettria、data.world の数字は検索要約だけで、原典を読んでいない。

---

## 5. 日本語での利用・評価

### Takeaway
Neo4j のツールを日本語の文書で評価した公開結果は見つからなかった。公式は英語の長文を最適としている。日本語に関係する公開情報は、空白のないテキストで分割器が無限ループするバグの修正（neo4j-graphrag 1.17.0）、非 ASCII ラベルの修正（1.22.0）、中国語の PDF と小型ローカル LLM で抽出に失敗した Issue（#1123）くらいである。日本語の記事も、概要と導入手順の紹介にとどまる。

### Cited Findings
- LLM Graph Builder の公式ページは "best results for files with long-form text in English" と書く — [Neo4j Labs](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)
- neo4j-graphrag-python 1.17.0（5 月 27 日、2026 年と推定）: "Fixed an infinite loop in FixedSizeSplitter on text without whitespace"。1.22.0（10 月 1 日）: ParquetWriter の非 ASCII ラベルを修正 — [Releases](https://github.com/neo4j/neo4j-graphrag-python/releases)
- #1123 は、中国語の PDF を Ollama の deepseek-r1:1.5b で処理し、構造化出力の検証エラーでグラフができなかった例である。メンテナは LLMGraphTransformer と一部の LLM の相性の問題と答えている — [Issue #1123](https://github.com/neo4j-labs/llm-graph-builder/issues/1123)
- 日本語の記事は、Zenn の Scrap「GraphRAG for Python (Neo4j) を試してみる」（パッケージの概要と対応バージョン）が見つかった程度で、日本語の抽出品質を測ったものはない（検索要約のみ） — [Zenn scrap](https://zenn.dev/fukuchan77/scraps/4be2bf6ca7d9e4)。HackerNoon にある日本語の記事は英語記事の機械翻訳である — [HackerNoon（日本語版）](https://hackernoon.com/lang/ja/mastering-llm-knowledge-graphs-build-and-implement-graphrag-in-just-5-minutes)
- 日本の研究機関の著者による CEUR の LLMGraphTransformer 比較も、対象は英語の計算機科学の論文要旨である（検索要約のみ） — [CEUR-WS Vol-4085 paper49](https://ceur-ws.org/Vol-4085/paper49.pdf)

### Inferences
- 既定の埋め込みはどちらも英語向けとみられる。neo4j-graphrag の `SentenceTransformerEmbeddings` の既定は `all-MiniLM-L6-v2` で、LLM Graph Builder の既定は 384 次元の SentenceTransformer（おそらく同じモデル）である。日本語で使うなら、多言語の埋め込みへの差し替えが前提になる（モデルの学習言語は本調査で確認していない）。
- `FuzzyMatchResolver` の Levenshtein 距離は、短い漢字の名前では 1 文字違いで別物になることも、同一になることもある。英語の名前と同じ閾値は使えないと考えられる。日本語の表記ゆれの正規化（既存レポートの Sudachi などによる決定的なキー）は、Neo4j のツールには含まれていない。
- 分割器のバグ修正が 2026 年まで残っていたことから、日本語のような空白のない言語は、このパッケージで主な検証対象になっていないとみられる。

### Gaps
- Neo4j のツールで日本語の文書から抽出したときの精度、歩留まり、文書をまたぐ辺の数を測った公開資料は見つからなかった。
- `SpaCySemanticMatchResolver` で日本語の spaCy モデルを使えるか、既定の埋め込みモデルの学習言語は確認していない。
- Neo4j の日本法人や日本のコミュニティによる GraphRAG の事例資料は、今回の検索では見つからなかった。
