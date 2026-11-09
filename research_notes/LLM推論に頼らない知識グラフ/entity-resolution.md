# LLM判断に頼らないエンティティ解決（ローカル・日英混在文書のメンション同定）

調査日: 2026-11-09。凡例: 【旧】= 2024年以前の事実、【2025】【2026】= 該当年の一次情報。コード由来の事実は main ブランチを 2026-11 時点で読んだもの（以後変わる可能性あり）。

## Q1. 確率的レコードリンケージ / ER ライブラリ（Splink, dedupe, Zingg, recordlinkage, pyJedAI）は「名前＋型＋短い説明」のメンションに使えるか

### Takeaway
どのライブラリも「列を持つレコード」を前提にしているが、メンションを（正規化名・読み・型・説明埋め込み・文書ID）の列を持つレコードとして扱えば適用できる。ローカルかつラベル不要という条件に一番合うのは Splink（DuckDB バックエンド、教師なし EM、Fellegi-Sunter、TF 補正、`CosineSimilarityAtThresholds`、増分用の `predict_between`）。dedupe と Zingg は能動学習でラベルを集める前提で、Zingg は Spark/Snowflake が必要なので個人用途のローカル運用には重い。

### Cited Findings
- Splink の README の主張: 「ノートPCで約100万件を約1分でリンク」でき、「モデル学習に教師データは不要」。バックエンドは DuckDB（Python）と Spark（1億件超を想定）。機能として TF（term frequency）補正、ペア予測のクラスタリング（閾値付き）、モデル診断用のインタラクティブ可視化（Comparison Viewer dashboard）を挙げる。README には「Splink 5 リリース」の告知もある（日付は本文になく、ブログ URL から 2026-09-28 頃と推測できる程度） — [Splink GitHub](https://github.com/moj-analytical-services/splink)
- Splink 5.0.0 の wheel は PyPI にあるが、5.0 の変更点は今回確認できなかった — [PyPI splink](https://pypi.org/project/splink)
- Splink の比較関数: `JaroWinklerAtThresholds`（既定 [0.9, 0.7]）、`JaroAtThresholds`、`LevenshteinAtThresholds`（[1, 2]）、`DamerauLevenshteinAtThresholds`、`JaccardAtThresholds`（[0.9, 0.7]）、任意の SQL 距離関数を使う `DistanceFunctionAtThresholds`、埋め込み配列向けの `CosineSimilarityAtThresholds`（シグネチャ既定 [0.9, 0.8, 0.7]）、配列の共通要素数を見る `ArrayIntersectAtSizes`、配列内で最も近い文字列ペアを比べる `PairwiseStringDistanceFunctionAtThresholds`。TF 補正は「完全一致レベルにのみ適用」 — [Splink comparison library](https://moj-analytical-services.github.io/splink/api_docs/comparison_library.html)
- TF 補正: 一般的な値（例: 名前 "Jack"）の一致は重みを下げ、珍しい値（"Portia"）の一致は重みを上げる。あいまい一致では2値のうち頻度の高い方を使う。`tf_adjustment_weight` で効き具合を調整でき、`tf_minimum_u_value` で珍しい誤綴りが過剰に加点されないよう下限を置ける — [Splink TF topic guide](https://moj-analytical-services.github.io/splink/topic_guides/comparisons/term-frequency.html)
- Splink の推論 API: `predict_between(left, right)` は「2つの集合の間だけで候補ペアを作って採点する」関数で、文書には「主な用途の一つは増分レコードリンケージ」とある。`score_pair` は1ペアを採点する。`deterministic_link()` は「真のリンクだけを生むほど厳しい」ブロッキングルールで決定的にリンクする。`compute_blocked_pairs_for_predict` を使うと候補ペアを実体化して別セッションで再利用できる — [Splink inference API](https://moj-analytical-services.github.io/splink/api_docs/inference.html)
- `score_pair` は match_weight / match_probability を返し、waterfall chart でどの比較列が何点寄与したかを表示できる（人間が判断根拠を確認する UI として使える） — [Splink real-time example](https://moj-analytical-services.github.io/splink/demos/examples/duckdb/real_time_record_linkage.html)
- dedupe の能動学習: 未ラベルのペアについて、学習済みブロッキングルールが拾うかどうかと分類器の判定を追跡し、両者が食い違う「disagreement set」からランダムに1ペアを選んで人に尋ねる。ラベルが付くたびに重みとブロッキングルールを学習し直す。推奨ラベル数は文書に書かれていない — [dedupe: Matching records](https://docs.dedupe.io/en/latest/how-it-works/Matching-records.html)
- dedupe のクラスタリングは centroid linkage の階層クラスタリングで、閾値の選び方によって群が大きく変わる。また「推定ペア確率は推移的でない」ので、原理的に正しい群化方法はない — [dedupe: Grouping duplicates](https://docs.dedupe.io/en/latest/how-it-works/Grouping-duplicates.html)
- Zingg: 「少数のペアにラベルを付けて何がマッチかを教える」機械学習型。Spark または Snowflake 上で動く — [Zingg docs](https://docs.zingg.ai/latest/)。学習に使うデータ割合は 0.0001〜0.1 を推奨 — [Zingg tuning doc](https://www.github.com/zinggAI/zingg/blob/main/docs/stepbystep/configuration/tuning-label-match-and-link-jobs.md)。メンテナの助言は「欲しいマッチの型が出揃うまで findTrainingData → label を繰り返す」で、固定のラベル数は示していない — [Zingg discussion #476](https://www.github.com/zinggAI/zingg/discussions/476)
- recordlinkage（Python Record Linkage Toolkit）の索引付け: `Full`（全ペア、二乗コスト）、`Block`（キー一致）、`SortedNeighbourhood`（ソートキーの近傍。「綴り誤りが多くブロッキングで取りこぼすデータ向け」、`window` 既定 3）、`Random`（教師なし学習用のランダムペア） — [recordlinkage indexing reference](https://recordlinkage.readthedocs.io/en/latest/ref-index.html)
- pyJedAI: Standard Blocking と Sorted Neighborhood に加え、sentence-transformer と FAISS で Top-K 近傍を取る「Embeddings-NN」ブロック構築がある。クラスタリングは Connected Components / Unique Mapping / Markov / Correlation / Kiraly / Exact などから選べる（版によって一覧が変わるので注意） — [pyJedAI PyTorch+FAISS tutorial](https://pyjedai.readthedocs.io/en/latest/tutorials/pyTorchWorkflow.html), [pyJedAI PyPI](https://pypi.org/project/pyjedai/0.0.7/)

### Inferences
- Splink はメンション1件を1行（`name_norm`, `name_reading`（読み/ローマ字）, `type_norm`, `desc_emb`（e5 の 384 次元配列）, `name_emb`, `doc_id`）として DuckDB に載せれば適用できる。比較列は名前完全一致→Jaro-Winkler→Jaccard、名前 cosine、説明 cosine、型一致、とする。教師なし EM で m/u を推定できるので、LLM の same/different 判定を置き換える「採点器」になる。ただし Fellegi-Sunter は比較列どうしの条件付き独立を仮定するので、名前 cosine と説明 cosine のように相関する列は証拠を二重に数えて確信度が過大になりやすい（一般論からの推論。少数のラベルで閾値を較正すべき）。
- TF 補正は「同名異物（homonym）」対策にそのまま使える: 文書集合の中で頻出する名前（例: 「設計」「API」）の完全一致は弱い証拠になり、珍しい固有名の一致は強い証拠になる。
- SQLite 主体なら Splink の DuckDB バックエンドを別プロセスでバッチ実行し、結果（ペアと match_probability）を SQLite に書き戻す構成が現実的。DuckDB には SQLite 拡張もあるが、相性は今回確認していない。
- 構造化列が「名前・型・説明」だけなので、ER ライブラリの強みである多列の証拠統合は限られる。ライブラリをそのまま使うより「ブロッキング＋説明可能な加点式スコア＋制約付きクラスタリング」という設計パターンを借りる、という位置づけが妥当。

### Gaps
- Splink/dedupe/Zingg を「短いメンション（名前＋説明文）」に使った精度評価（precision/recall）は見つからなかった。いずれも人名・住所などの構造化レコードでの報告が中心。
- Splink 5 の変更点（埋め込みの扱い、増分 API の名称変更など）は未確認。`find_matches_to_new_records` は現行の API ページに載っていない（4.x から変わった可能性）。
- recordlinkage の ECM（教師なし Fellegi-Sunter 分類器）は、索引ページでは確認できなかった。

## Q2. ブロッキング / 候補生成と名前の文字列類似度（MinHash/LSH、sorted neighbourhood、文字 n-gram、埋め込み kNN、Jaro-Winkler、char n-gram TF-IDF）

### Takeaway
実運用の KG システムの決定的ブロッキングは「正規化名の完全一致」＋「文字 3-gram の MinHash/LSH（Jaccard が高いものだけ自動確定）」＋「名前埋め込みの kNN（top-10〜15、cosine 0.6〜0.9）」＋「編集距離／包含」の組み合わせに収れんしている。日英の別名（共通文字ゼロ）は文字系では原理的に拾えないので、埋め込み kNN・辞書（同義語・Wikidata ラベル）・翻字（カタカナ→英語）の3経路を候補生成に足す必要がある。

### Cited Findings
- Graphiti（Zep）の決定的 dedup【2025-2026 コード】: `_normalize_string_exact` は小文字化と空白の正規化、`_normalize_name_for_fuzzy` は a-z / 0-9 / アポストロフィ以外を空白に置き換える。完全一致は名前の長さやエントロピーに関係なく常に試し、候補が1件なら確定、複数なら「曖昧」として LLM に回す。あいまい一致の前にエントロピーゲートがあり、`_MIN_NAME_LENGTH = 6` 未満かつ `_MIN_TOKEN_COUNT = 2` 未満の名前、または文字エントロピーが `_NAME_ENTROPY_THRESHOLD = 1.5` 未満の名前は LLM に回す。あいまい一致は空白を除いた3文字シングル、`_MINHASH_PERMUTATIONS = 32`（blake2b のシード付きハッシュ）、`_MINHASH_BAND_SIZE = 4`（8バンド）の LSH で候補を出し、Jaccard ≥ `_FUZZY_JACCARD_THRESHOLD = 0.9` のときだけ確定する。それ以外は LLM に回る。別途 `identity_properties`（型ラベル内でプロパティ値が完全一致するか）による前処理もある — [graphiti dedup_helpers.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/utils/maintenance/dedup_helpers.py)
- Graphiti の候補検索: identity プロパティ、完全一致名、名前埋め込みの cosine 検索（`NODE_DEDUP_CANDIDATE_LIMIT = 15`、`NODE_DEDUP_COSINE_MIN_SCORE = 0.6`、リランクなし）の3つを合わせて使う。候補ゼロのメンションは LLM に回さず新規ノードにする。BM25/全文検索はこの経路では使っていない — [graphiti node_operations.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/utils/maintenance/node_operations.py)
- Neo4j + LlamaIndex の重複統合パターン【旧, 2024-06-24】: エンティティ埋め込みのベクトル索引で top-10 近傍を取り、`similarity_threshold = 0.9` を超え、かつ（`apoc.text.distance(toLower(a), toLower(b)) < 5` または名前の包含）を満たし、ラベルが同じものをまとめて統合する。誤統合の例として「1963 AFL Draft」と「1963 NFL Draft」を挙げ、統合前に手動で例外を足すよう勧めている — [Neo4j blog](https://neo4j.com/blog/developer/property-graph-index-llamaindex/)
- Neo4j LLM Graph Builder の既定値: `DUPLICATE_SCORE_VALUE = 0.97`、`DUPLICATE_TEXT_DISTANCE = 5` — [neo4j-labs/llm-graph-builder README](https://github.com/neo4j-labs/llm-graph-builder)
- Sorted neighbourhood は「綴り誤りが多くブロッキングで取りこぼす場合」向けで、窓（既定 3）を広げるほど候補ペアが増える — [recordlinkage](https://recordlinkage.readthedocs.io/en/latest/ref-index.html)
- 英語とカタカナのエンティティ照合の比較【旧, 2018】: 5種類の翻字方式と6種類の類似度（Jaro-Winkler、Levenshtein、RNN による音素確率スコアなど）を比べ、カタカナを英語側（音素経由）に変換して照合する方法が最も良かった — [Yamashita, Awashima, Oiwa, SIGMORPHON 2018](https://aclanthology.org/W18-5809/)
- カタカナ→英語の逆翻字は情報が落ちる変換の逆なので難しい（1つのカタカナ表記に複数の英綴りが対応しうる）【旧, 1998】 — [Knight & Graehl 1998](https://aclanthology.org/www.mt-archive.info/CL-1998-Knight.pdf)。2023年の研究では、カタカナから直接英語に変換する pair n-gram モデルに英語語彙フィルタを組み合わせたものが最良だった — [Ren, CAWL 2023](https://aclanthology.org/2023.cawl-1.6)
- 共通文字のない別名には文字系手法が効かない例: Cognee の文書は "NYC" と "New York City" を埋め込み類似度で拾うために、閾値を既定 0.85 から 0.6 まで下げる必要があるとしている — [Cognee entity dedup guide](https://docs.cognee.ai/guides/memify-entity-deduplication.md)

### Inferences
- Graphiti のあいまい一致は a-z0-9 だけに正規化するので、日本語名は空文字列か極端に短くなってエントロピーゲートで落ち、LLM 判定に回る（コードからの推論）。日本語では MinHash の単位をそのまま使えない。日本語用には (a) NFKC と表記正規化をした文字列の文字 2-gram（漢字・かなは2文字でも情報量が大きい）、(b) Sudachi `normalized_form` の連結、(c) 読み（カタカナ）を経由したローマ字化、をシングル元にした LSH を別に持つのがよい。
- 文字 n-gram（TF-IDF 加重 2〜3-gram の cosine）は MinHash の上位互換になりうる。文書集合内で頻出する n-gram（「システム」「管理」など）を自動で軽くできるので、Splink の TF 補正と同じ効果を名前の部分一致でも得られる（一般論からの推論。日本語で評価した文献は今回見つけていない）。
- 候補生成は「OR 結合」で再現率を稼ぎ、精度は採点とクラスタリングで担保する。各経路の候補数の上限（top-k）と、経路ごとに偽陽性が出やすい傾向（例: 包含は「API」⊂「API Gateway」、編集距離は「AFL/NFL」）を記録しておけば、後段の採点で経路そのものを特徴量にできる。

### Gaps
- Yamashita et al. 2018 の手法別の数値（precision/recall）は、PDF 本文を読めず取得できなかった（抄録のみ）。
- 日本語固有名に対する MinHash / 文字 n-gram TF-IDF / Jaro-Winkler の比較評価は見つからなかった。

## Q3. 埋め込みベースのクラスタリング（階層＋閾値、HDBSCAN、cannot-link 付き correlation clustering）、名前埋め込みと名前＋説明埋め込み、多言語埋め込みの言語横断性能

### Takeaway
2025-2026 年の KG／エージェントメモリ系の実装は、ほぼすべて「名前埋め込みの cosine 閾値（0.6〜0.97）で既存ノードに寄せる」方式で、型一致を必須条件にする実装もある。クラスタリングの理論面では correlation clustering（Pivot 系、3近似）が「負の辺 = cannot-link」を自然に扱え、推移性の破れ（chaining）にも強い。言語横断の別名については、multilingual-e5-small は文単位の言語横断検索で LaBSE に大きく劣り（Tatoeba 64.2 対 81.1）、名前単位の日英照合の精度を直接報告した研究は見つからなかったので、自前で評価する必要がある。

### Cited Findings
- multilingual-e5 技術報告【2024】の bitext mining（Table 5）: BUCC 2018 / Tatoeba(112言語) で LaBSE 98.8 / 81.1、mE5-small 93.2 / 64.2、mE5-base 98.1 / 68.1、mE5-large 98.6 / 75.7、mE5-large-instruct 99.0 / 83.8 — [Wang et al., Multilingual E5 Text Embeddings](https://arxiv.org/html/2402.05672)
- Wikidata の言語間ラベル対応づけ【旧, 2022】: 10言語のラベルで単語／文アラインメント手法を比べ、文埋め込み手法が「異なる文字体系の間でも」他手法を上回った。手法によって F1 が最大 20 ポイント改善した — [Amaral et al. 2022](https://arxiv.org/abs/2206.08709)
- 言語横断エンティティアラインメント（DBP15K、ZH-EN / JA-EN / FR-EN）には「名前バイアス」がある（翻訳済みの名前が多く、名前だけで解けてしまう）。FGWEA 論文【2023】は、これを抑えた hard split で評価している。埋め込みだけで照合する Emb-Match は DBP15K ZH-EN で Hit@1 0.763。エンコーダを mean-pooled mBERT に替えると、hard split の ZH-EN での埋め込み照合精度は 16.1% まで落ちる — [FGWEA, arXiv 2305.06574](https://arxiv.org/html/2305.06574)
- 参考値: 名前と構造の両方を使う BERT-INT は DBP15K JA-EN で Hits@1 0.964、構造中心の GCN-Align は 0.445 — [LLM-Align table, arXiv 2412.04690](https://arxiv.org/pdf/2412.04690)
- 文字体系をまたぐ LLM の同一性判定の失敗【2026-10】: Qwen2.5-7B の同一人物正解率は、ラテン文字で 35.1%、デーヴァナーガリーで 8.5%（異なる人物の正解率は 98% 超）。マラヤーラム 374 ペアでは 5.3%。それでも同一ペアを非同一ペアより上に並べる力は残っていて（AUROC 0.925）、スカラー較正で probe の balanced accuracy の差の 87% を取り戻せる。つまり失敗の主因は判定基準（閾値）の位置にある — [Gopal et al., arXiv 2610.31407](https://arxiv.org/abs/2610.31407)
- iText2KG【2024】: 新しいエンティティを既存の全エンティティと cosine 類似度で比べ、閾値を超えれば最も近いものに寄せ、超えなければ新規にする。1,500 の類似エンティティ対の cosine は平均 0.6 ± 0.12（text-embedding-3-large）で、精度を優先して閾値 0.7 を選んだ。後の版では名前埋め込みとラベル（型）埋め込みを 0.6 : 0.4 で加重する（検索スニペット由来なので要確認）。著者は将来課題として「閾値を不要にすること」と「型をマッチングに組み込むこと」を挙げている — [iText2KG, arXiv 2409.03284](https://arxiv.org/pdf/2409.03284)
- Cognee【2025-2026 文書】: `consolidate_entities_pipeline` は各 Entity の**名前**を埋め込み、cosine で近重複をクラスタにまとめる（`similarity_threshold` 既定 0.85、範囲 (0,1]、`top_k` 既定 10 で N×N 行列は作らない）。`name_match`（小文字化して英数字以外を除いた名前の一致）でも統合する。既定では同じ `EntityType` どうしだけを統合し（`allow_cross_type=False`）、`protect_node_types` で統合禁止の型を指定できる。統合判定に LLM を使うという記述はない — [Cognee guide](https://docs.cognee.ai/guides/memify-entity-deduplication.md)
- Mem0（旧グラフストア連携）: 新しいエンティティと既存ノードの埋め込み類似度が閾値（既定 0.7）以上なら既存ノードを再利用する。重複が出るなら閾値を下げ、無関係なものが統合されるなら上げる、と案内している — [Mem0 graph threshold](https://docs.mem0.ai/platform/features/graph-threshold)。この外部グラフストア連携は内蔵の Graph Memory に置き換わったので、現行版の統合方式は不明 — [Mem0 graph memory](https://docs.mem0.ai/platform/features/graph-memory)
- Pivot（correlation clustering）: ランダムにピボットを選び、正の辺で結ばれた近傍をまとめることを繰り返す。期待値で3近似。1パスのストリーミング版は O(n/ε) 語のメモリで (3+ε) 近似 — [Single-Pass Pivot, arXiv 2305.13560](https://arxiv.org/pdf/2305.13560)。Pivot の着想元は「ER でオラクル（人手）への問い合わせを減らすアルゴリズム」とされる — [Cordner slides](https://cs-people.bu.edu/ncordner/papers/Oral_Exam_Slides.pdf)。2025年も Pivot を超える手法の研究が続いている — [ICML 2025 poster](https://icml.cc/virtual/2025/poster/45406)
- 単純な連結成分は、ペア判定の長い連鎖で過剰に統合しやすく、correlation clustering のようなより厳しいクラスタリングが勧められている（実務者ガイド。二次情報） — [kindatechnical guide](https://kindatechnical.com/knowledge-graphs/scaling-entity-resolution-to-millions-of-records.html)
- 多ソースのエンティティクラスタリングに階層凝集型（HAC）を拡張した研究がある【旧, 2021】 — [Saeedi, David, Rahm 2021](https://scitepress.org/PublishedPapers/2021/106496)
- HDBSCAN を埋め込みの重複検出に使う場合の注意: 高次元で密度が一様だと巨大な1クラスタになりやすいので、次元削減を先にすることが勧められている（画像データの例） — [DataEval docs](https://dataeval.readthedocs.io/en/v1.0.2/concepts/Clustering.html)
- LightRAG issue #1323 の提案【2025-04】: 名前埋め込みの cosine 0.8 で top-10 候補を取り、LLM に統合可否を決めさせる。2026-05 には閾値調整、推移的な統合のリスク、バッチのコストが指摘されている — [LightRAG issue #1323](https://github.com/HKUDS/LightRAG/issues/1323)

### Inferences
- 現状の「LLM の different 判定をハード cannot-link にする」設計は、小モデルの判定が揺らぐ（上の 2610.31407 のとおり、LLM は「スコアの順位」は正しくても閾値の位置がずれやすい）ため、同名同一物の分裂の主因になりうる。cannot-link をハード制約にするのは、人手訂正・型の明確な矛盾・同一文書内で併記された2者（例: 「A と B を比較」）のように確度の高いものだけに限り、それ以外は correlation clustering の負の重みとして扱えば、分裂と誤統合をまとめて最適化できる。
- 名前のみの埋め込みと名前＋説明の埋め込みは役割が違う。名前埋め込みは別名（言語横断・略称）の候補生成に、説明埋め込みは同名異物の分離（homonym 判定）に使う。iText2KG（名前 0.6 / 型 0.4）や Cognee（同型のみ統合）のように「型を必須条件か加点にする」のは、同名異物を防ぐ最も安い手段。
- multilingual-e5-small（384 次元）は文単位の言語横断で LaBSE より大幅に低い。日英の名前別名の再現率が足りないなら、(1) 名前だけ LaBSE や BGE-M3 で別索引を作る、(2) 名前を「名前: X（型: Y）」のような短い文に包んで埋め込む、(3) 辞書・翻字の経路で補う、の順に検討する（いずれも要評価）。
- 閾値はシステムによって 0.6〜0.97 と大きく違い、埋め込みモデルにも強く依存する。e5 系は cosine が全体に高めに出るとよく言われるが、今回は一次資料で確認していない。このため既定値を流用せず、ラベル付きペア数十〜数百で閾値を較正する必要がある。
- 増分運用では、新しいメンションを既存のクラスタ代表（または全メンション）と kNN で比べ、影響を受けた連結成分だけを再クラスタリングすればよい（Graphiti・Cognee・iText2KG はいずれも「新規 vs 既存」の比較で、全体を再クラスタリングしない）。

### Gaps
- multilingual-e5 / LaBSE / BGE-M3 の、日英の**固有名**（人名・製品名・組織名）照合の精度を直接報告した一次資料は見つからなかった。ParaNames（Q4）を使えば評価セットを作れる。
- 名前のみと名前＋説明の埋め込みを同じデータで比べた研究は見つからなかった。
- HDBSCAN をテキストのエンティティ名の重複除去に使った評価は見つからなかった（画像の例のみ）。
- Amaral et al. 2022 の対象 10 言語に日本語が入っているか、手法別の数値は PDF 本文を読めず未確認。

## Q4. 日本語の正規化（NFKC、表記ゆれ、Sudachi 正規化形と同義語辞書、カタカナ⇔英語の翻字照合）

### Takeaway
文字レベルは NFKC と neologdn 相当の規則（長音・ハイフン・チルダ・空白）、語彙レベルは Sudachi の `normalized_form`（附属→付属、SUMMER→サマー、シュミレーション→シミュレーション）、同義・訳語レベルは Sudachi 同義語辞書（インフルエンザ⇔influenza のような英字形も同じグループにある）、という3段で、決定的な表記ゆれの吸収はかなり進む。カタカナ⇔英語の別名は、辞書にない固有名には音素経由の翻字照合が有効だという報告がある。

### Cited Findings
- Unicode 正規化形 NFKC（互換分解の後に正準合成する）は、全角英数を半角に、半角カナを全角にするなどの互換文字の統一を行う — [Unicode UAX #15](https://unicode.org/reports/tr15/)
- neologdn の規則: 半角カナ→全角（ﾊﾝｶｸｶﾅ→ハンカクカナ）、全角記号→半角（！？＠＃→!?@#、ただし「・」などは例外）、長音の連続を1つに（ウェーーーーイ→ウェーイ）、各種ハイフンを "-" に統一、チルダの扱い（既定は削除なので「1995〜2001年」→「19952001年」になる点に注意。`normalize` などのモードあり）、日本語文字間の空白を削除（ＰＲＭＬ　　副　読　本→PRML副読本、0.3.2 以降は抑止可）、繰り返し文字の圧縮（`repeat`） — [neologdn GitHub](https://github.com/ikegami-yukino/neologdn)
- SudachiPy の `normalized_form()` の例: 「附属」→「付属」、「SUMMER」→「サマー」、「シュミレーション」→「シミュレーション」（2021-08-02 版の core 辞書での結果。辞書の版によって変わりうる） — [SudachiPy PyPI](https://pypi.org/project/sudachipy)
- Sudachi 同義語辞書の形式: CSV で、グループ番号（6桁、一度振ったら不変）、体言/用言、展開制御（0 = 常に展開、1 = 他から展開されるが起点にはならない、2 = 使わない）、語彙素番号、同一語彙素内の語形種別（0 代表 / 1 対訳 / 2 別称 / 3 旧称 / 4 誤用）、略語情報（1 = アルファベット略語、2 = その他の略語）、表記ゆれ情報（1 = アルファベット表記（原綴り・ローマ字）、2 = 異表記、3 = 誤表記）、分野（例: 医療、料理）、見出し。例: `000127,...,(医療),インフルエンザ` と `000127,...,1,(医療),influenza`（英字形が同じグループにある）、`支払` は `支払い` の異表記 — [SudachiDict synonyms.md](https://github.com/WorksApplications/SudachiDict/blob/develop/docs/synonyms.md)
- 同義語辞書の見出しは `normalized_form()` の形で登録されているので、引く側も同じ正規化形に変換する必要がある。chikkarpy は SudachiPy の出力に同義語展開を足すライブラリ — [chikkarpy](https://awesome.ecosyste.ms/projects/github.com%2FWorksApplications%2Fchikkarpy)。jpnorm は Sudachi 同義語辞書による語彙正規化を表記ゆれ吸収の機能として持つ — [jpnorm PyPI](https://pypi.org/project/jpnorm/)
- カタカナ⇔英語の照合【旧, 2018】: カタカナを英語に変換して音素経由で照合するのが最良（Q2 参照） — [Yamashita et al. 2018](https://aclanthology.org/W18-5809/)。カタカナ表記は不規則で、ローマ字化で挿入される "h" などが単純照合を乱す — [Ren 2023](https://aclanthology.org/2023.cawl-1.6)
- 多言語の名前対訳コーパス ParaNames: 2022 年版は約 1.18 億の名前、400 言語、1,360 万エンティティ（PER/LOC/ORG）、CC BY 4.0 — [ParaNames, arXiv 2202.14035](https://arxiv.org/abs/2202.14035)。ParaNames 1.0（LREC-COLING 2024）は約 1.4 億の名前、1,680 万エンティティで、英語と他 17 言語の間の正規名翻訳を評価している — [ParaNames 1.0](https://huggingface.co/papers/2405.09496)

### Inferences
- 推奨する決定的キー（複数を並べて持つ）: `k1 = casefold(NFKC(name))` に neologdn 相当の処理（ただしチルダは削除しない設定）、`k2` = Sudachi で分かち書きした各語の `normalized_form` の連結、`k3` = 読み（カタカナ）をローマ字化して長音・促音を正規化したもの、`k4` = 同義語辞書のグループ ID の集合。`k1`/`k2` の一致は強い証拠、`k3`/`k4` の一致は中程度の証拠として採点器に入れる。
- Sudachi 同義語辞書は一般語中心で、個人・チーム固有のプロダクト名は載っていない。ただし「辞書と同じ CSV 形式でユーザー同義語を持つ」設計（グループ ID・対訳・別称・略語・表記ゆれのフラグ）は、人手訂正の保存形式としてそのまま流用できる（後述 Q7）。
- カタカナ⇔英語は、(a) 英語→カタカナ変換辞書や翻字モデルで英語名からカタカナ候補を作り `k3` 空間で照合する、(b) ParaNames や Wikidata の ja/en ラベル対を辞書として引く、の2経路が LLM なしで実装できる。ParaNames は日英の名前埋め込み照合を評価するテストセットにもなる。
- `normalized_form` は辞書の版によって結果が変わるので、正規化キーを保存するときは辞書の版を一緒に記録し、版を上げたら再計算する。

### Gaps
- ParaNames に含まれる日英ペアの件数は未確認。
- 英語→カタカナ変換の具体的なローカル実装（辞書・モデル）の精度は今回調べていない。
- Sudachi 同義語辞書の収録件数（グループ数）は文書に記載がなかった。

## Q5. 公開知識ベース（Wikidata）へのエンティティリンキングを同一性のアンカーにする（mGENRE、ReFinED、BLINK、多言語リンカー）

### Takeaway
Wikidata へのリンクは「公開の有名エンティティ」については日英の別名を一発で束ねる強いアンカーになる（QID が一致すれば同一）。ただし多言語リンカーは XLM-R-large 級で GPU を前提にしており、日本語のエンドツーエンド F1 は 50〜66 程度にとどまる。個人やプロジェクト固有の名前は KB に載っていないので、NIL（未登録）判定の誤りがそのまま誤統合の原因になる。そのため「リンク結果が高信頼のときだけ must-link／異なる QID なら cannot-link に使う」という限定的な使い方が妥当。

### Cited Findings
- BELA【2023】: 97 言語に対応する、初のエンドツーエンド・1パスの多言語エンティティリンキング。メンション検出・曖昧性解消・棄却（rejection）の3ヘッドを持ち、エンコーダは XLM-R-large。索引は 97 言語の Wikipedia の和集合で約 1,600 万エンティティ（言語非依存）。性能は 40GB A100 で計測し、単一 GPU で 53 samples/s、batch 1 で 11.11 samples/s（単言語 GENRE は 0.22） — [BELA, arXiv 2306.08896](https://arxiv.org/html/2306.08896v1)
- 日本語（Mewsli-9'）の数値: エンドツーエンド F1 48.8（ラベル不足のテストセット）/ 66.1（網羅的にラベル付けしたセット）。曖昧性解消の精度は BELA 85.0、Botha et al. 2020 が 88.0、mGENRE（De Cao et al. 2022）が 89.9。メンション検出の再現率は 81.4。棄却ヘッドは「既知かつ正しくリンクされたエンティティだけを残し、残りを棄却する」もので、NIL 単独の評価値は報告されていない — [BELA](https://arxiv.org/html/2306.08896v1)
- Botha et al. 2020「Entity Linking in 100 Languages」: 100 以上の言語、約 2,000 万エンティティを対象にした dual encoder【旧】 — [arXiv 2011.02690](https://arxiv.deeppaper.ai/papers/2011.02690v1)
- ReFinED（Amazon）: Wikipedia / Wikidata へのリンカー。AIDA テスト 231 記事の処理時間は V100 で 6.5 秒、T4 で 7.4 秒、CPU で 29.7 秒（GPU は推奨だが必須ではない）。`entity_set="wikidata"` は約 3,300 万エンティティ（メモリを多く使う）、`"wikipedia"` は約 600 万。エンティティの説明文と細粒度の型を使うので、再学習なしで新しいエンティティを追加でき、ゼロショットのリンクができる。Apache 2.0 — [ReFinED GitHub](https://github.com/amazon-science/ReFinED)
- ParaNames は Wikidata から作った多言語の名前対訳で、名前の翻訳・翻字やエンティティリンキングの補助データとして位置づけられている — [ParaNames](https://arxiv.org/abs/2202.14035)

### Inferences
- ReFinED は CPU でも動くが（AIDA 231 記事で 30 秒）、README には対応言語の記載がなく、日本語の文章をそのまま扱えるかは未確認（英語モデルと推定。要確認）。日本語を扱える BELA / mGENRE は XLM-R-large・mBART 級で、メモリと索引（1,600 万〜2,000 万エンティティ）の負担が大きく、個人用ローカルライブラリの常時運用には重い。
- 実用的な代替案: リンカーモデルを動かさず、Wikidata の ja/en ラベルと別名（alias）だけを事前にダウンロードした「別名辞書」として持ち（ParaNames のような派生データでもよい）、正規化名の完全一致で QID 候補を引く。日英の別名（共通文字ゼロ）を決定的に橋渡しする候補経路になる。曖昧な QID が複数当たる場合は、説明埋め込みと Wikidata の説明文の cosine で絞る。
- ReFinED の「説明文と型で新しいエンティティを追加できる」性質は、ローカルで確定したエンティティ（人手確認済みの正規名＋説明）を独自 KB として登録し、新しいメンションをそこにリンクする「ローカル KB へのリンキング」に転用できる（日本語対応が前提）。個人・プロジェクト固有の名前は、Wikidata ではなくこのローカル正規エンティティ表をアンカーにするのが本筋。
- 公開 KB へのリンクは個人固有名で誤リンクを生みやすい（例: 社内プロジェクト名「Atlas」が有名な別物に飛ぶ）。リンク結果は「高信頼かつ型一致のときだけ加点」、「異なる QID への高信頼リンクは cannot-link 候補」にとどめるのが安全。

### Gaps
- mGENRE のローカル実行要件（モデルサイズ、CPU 推論速度、prefix trie のメモリ）は今回取得できなかった。
- ReFinED の多言語対応、BLINK の日本語対応、NIL 予測の精度（KB 外のメンション）の数値は見つからなかった。
- 個人ノート・社内文書のように KB 外のエンティティが多い集合で、EL をアンカーにして効果があったという報告は見つからなかった。

## Q6. 2025-2026 年の KG・エージェントメモリ系システムのエンティティ dedup（LightRAG、Graphiti/Zep、Cognee、Microsoft GraphRAG、Neo4j、Mem0、iText2KG）：決定的な部分と LLM の部分

### Takeaway
GraphRAG と LightRAG は「完全一致名（GraphRAG は名前＋型）で統合し、LLM は説明文の要約にだけ使う」。Graphiti は「完全一致 → MinHash/LSH（Jaccard ≥ 0.9）→ 解決できないものだけ LLM」の段階制。Cognee・Mem0・Neo4j・iText2KG は「名前埋め込みの cosine 閾値（＋文字列距離・型一致）」で LLM を使わずに統合する。人手で統合する UI は LightRAG の WebUI（Merge Dialog）と Cognee の dry_run が該当する。

### Cited Findings
- Microsoft GraphRAG: 「同じ title と type を持つエンティティは、説明文を配列にまとめて統合する」。その後、説明文の配列を LLM で短い要約にする。関係も source/target が一致すれば同じく統合する — [GraphRAG default dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/)
- LightRAG: 「完全一致の名前だけでエンティティを統合する」ので、別名のまま重複ノードが残る（issue #1323、2025-04-09）。埋め込みと LLM による別名統合の提案は v1.3.5 → v1.4.8 とマイルストーンが送られ、2026-08-30 時点でもコミュニティ実装（文書単位・オプトイン・衝突検出つき）の PR 予告の段階 — [LightRAG issue #1323](https://github.com/HKUDS/LightRAG/issues/1323)
- LightRAG の説明文の統合: 一致したノードの説明文を重複除去して連結し、トークン数が上限を超えたときだけ LLM で要約する（派生実装 GraphGen のコード） — [GraphGen light_rag_kg_builder.py](https://huggingface.co/spaces/chenzihong/GraphGen/blob/main/graphgen/models/kg_builder/light_rag_kg_builder.py)。同じエンティティ・同じ文脈でも、説明文の言い回しは毎回わずかに変わる、と PR 作者が指摘している — [LightRAG PR #2817 (mirror)](https://github-users.yhajoa.workers.dev/HKUDS/LightRAG/issues/2817)
- LightRAG PR #2266（2025-10-27 マージ）: エンティティ編集 API に `allow_merge` を追加し（リネーム先が既存ならそのまま統合）、`graph/entity/edit` が update/rename/merge の結果を `operation_summary` で返す。WebUI に統合元・統合先を選ぶ「Merge Dialog」と、リネーム時の自動統合オプションを追加 — [LightRAG PR #2266](https://github.com/HKUDS/LightRAG/pull/2266)。`POST /graph/entities/merge`（PR #2183、2025-10）や strict/medium/loose の統合プロンプト（PR #2102）もあるが、マージされたかは未確認 — [PR #2183 (mirror)](https://github.colasdn.workers.dev/HKUDS/LightRAG/pull/2183), [PR #2102 (mirror)](https://github.tiyicn.workers.dev/HKUDS/LightRAG/pull/2102)
- Graphiti/Zep: 候補は identity プロパティ・完全一致名・名前埋め込み cosine（≥ 0.6、最大 15 件）。決定的な段階は identity プロパティの一致 → 完全一致名がちょうど1件 → MinHash/LSH で Jaccard ≥ 0.9。完全一致が複数ある（曖昧）、名前が短いかエントロピーが低い、あいまい一致が閾値に届かない、のいずれかなら `dedupe_nodes` プロンプトで LLM に回す。候補ゼロなら LLM を使わず新規ノード — [dedup_helpers.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/utils/maintenance/dedup_helpers.py), [node_operations.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/utils/maintenance/node_operations.py)
- Cognee: 統合判定は名前埋め込みの cosine（既定 0.85）と正規化名の一致で決まる。統合時の代表ノードは「最も接続の多いノード、同点なら `created_at` が古い方、さらに同点なら正規化名」で選ぶ。代表ノードは既存 ID を保ち、重複側の辺は向きを保って付け替え、自己ループになる辺は捨てる。説明文は重複のない非空のものの和集合にする。重複ノードは detach delete し、名前埋め込みもベクトルストアから消す（不可逆）。`dry_run=True` で統合計画をログに出すだけにできる（既定は False） — [Cognee guide](https://docs.cognee.ai/guides/memify-entity-deduplication.md)
- Cognee の文書は「略称と正式名を同じ抽出呼び出しに入れると LLM が自分で解決して1エンティティにしてしまうので、テストでは別々に取り込む」と注記している。抽出段の LLM が暗黙に同一性を判断している — [Cognee guide](https://docs.cognee.ai/guides/memify-entity-deduplication.md)
- Neo4j: 埋め込み kNN（top-10、≥ 0.9）＋編集距離 < 5 または包含＋同じラベル（2024） — [Neo4j blog](https://neo4j.com/blog/developer/property-graph-index-llamaindex/)。LLM Graph Builder の既定値は score 0.97 / text distance 5 — [llm-graph-builder](https://github.com/neo4j-labs/llm-graph-builder)
- Mem0（旧）: 埋め込みの閾値 0.7 で既存ノードを再利用する — [Mem0](https://docs.mem0.ai/platform/features/graph-threshold)
- iText2KG: cosine 閾値（0.7）で新規エンティティを既存に寄せる増分方式 — [iText2KG](https://arxiv.org/pdf/2409.03284)

### Inferences
- 業界の実装は2つに分かれる。「完全一致名で必ず統合する」系（GraphRAG・LightRAG）は同名同一物が分裂しない代わりに、同名異物を誤統合し、別名を取りこぼす。「名前埋め込みの閾値で寄せる」系（Cognee・Mem0・iText2KG・Neo4j）は別名を拾える代わりに、「AFL/NFL Draft」のような近い別物を誤統合する。ユーザーの3つの問題（別名の取りこぼし、同名分裂、同名異物）を同時に解くには、両方の候補経路と、型・説明・頻度（TF）による採点、そして制約付きクラスタリングの組み合わせが必要。
- Graphiti の段階制（決定的に解けるものは決定的に、曖昧なものだけ高コストな判定に回す）は、そのまま LLM なしの設計に移せる。「曖昧」のバケツの行き先を LLM ではなく「人手確認キュー」にすればよい（Q7）。
- Cognee の「最も接続の多いノードを代表にし、元 ID を消す」統合は不可逆なので、人手訂正（分割）を後から反映しにくい。メンション → クラスタの対応表を別に持ち、クラスタを「再計算できる派生物」にしておく設計の方が訂正に強い（推論）。
- GraphRAG・LightRAG の「説明文の LLM 要約」は同一性の判定には関わらない。LLM なしの運用でも、統合後の説明は「代表的なメンションの説明＋出典リスト」にすれば足りる。

### Gaps
- Microsoft GraphRAG に 2025-2026 年版で別名統合（埋め込みなど）が追加されたかは未確認（default dataflow の文書は完全一致のまま）。
- Zep の論文（2025）に、Graphiti のエンティティ解決の精度評価があるかは未確認。
- 現行 Mem0（内蔵 Graph Memory）の統合方式は文書に書かれていない。
- Cognee の `consolidate_entities` が何版から入ったかは文書に日付がなく不明。

## Q7. 能動学習 / human-in-the-loop のエンティティ解決：必要なラベル数と訂正 UI

### Takeaway
能動学習 ER の報告では「全ラベルの約1割（例: 100 対 894）で同等の性能」が典型。最近の研究も「埋め込み空間で既知のマッチ／非マッチの近くを優先して尋ねる」方向（Battleship、SIGMOD 2024）や「凍結した bi-encoder ＋軽量分類器を繰り返し学習する」方向（ALER、2026）で、ローカル運用に合う。訂正 UI は dedupe／Zingg の CLI ラベリング、Splink の waterfall／Comparison Viewer、LightRAG の Merge Dialog、Cognee の dry_run があるが、「分割（unmerge）」を第一級の操作として持つ OSS はほとんどない。

### Cited Findings
- Kasai et al. ACL 2019【旧】: レストラン分野では、能動学習で選んだ 100 ラベルで、目標ドメインの全 894 ラベルで学習したのと同じ性能になった。転移学習と能動学習の組み合わせで、ラベル数を1桁減らして SOTA と同等以上 — [Kasai et al. 2019](https://preview.aclanthology.org/fix_video/P19-1586.pdf)
- Battleship approach（Genossar, Gal, Shraga、SIGMOD 2024）: 「ペア表現のベクトル空間での近さは高い確率でラベルの一致を反映する」という仮定に基づき、既知のマッチ／非マッチの近傍を探して均衡した訓練集合を作る能動学習。少ないサンプルで、全量学習の SOTA と同程度に到達すると報告 — [arXiv 2311.15685](https://arxiv.org/abs/2311.15685)
- ALER（2026-01、arXiv ID 由来の日付）: 凍結した bi-encoder で静的な埋め込みを一度だけ計算し、その上の軽量分類器を繰り返し学習する能動学習型の ER。DBLP で学習ループが 1.3 倍速いと報告（レビューサイト経由の二次情報。ラベル数の報告は確認できず） — [ALER review](https://www.themoonlight.io/review/aler-an-active-learning-hybrid-system-for-efficient-entity-resolution)
- dedupe: 学習済みブロッキングと分類器の判定が食い違うペアからランダムに選んで人に聞き、ラベルのたびに再学習する — [dedupe](https://docs.dedupe.io/en/latest/how-it-works/Matching-records.html)
- Zingg: findTrainingData → label の反復で、欲しいマッチの型が出揃うまで続ける（固定数の指示はない） — [Zingg discussion #476](https://www.github.com/zinggAI/zingg/discussions/476)
- Splink: 学習にラベルは不要（EM）。`score_pair` の waterfall chart と Comparison Viewer dashboard で、ペアごとの根拠を人が確認できる — [Splink README](https://github.com/moj-analytical-services/splink), [Splink real-time example](https://moj-analytical-services.github.io/splink/demos/examples/duckdb/real_time_record_linkage.html)
- Pivot 系の correlation clustering は、ER でオラクル（人手）への問い合わせ数を減らす研究から生まれた — [Cordner slides](https://cs-people.bu.edu/ncordner/papers/Oral_Exam_Slides.pdf)
- 訂正 UI の例: LightRAG WebUI の Merge Dialog（統合元・統合先を選択）と `allow_merge`（2025-10） — [LightRAG PR #2266](https://github.com/HKUDS/LightRAG/pull/2266)。Cognee の `dry_run`（統合計画を事前にログ出力。適用後は重複ノードを削除するので不可逆） — [Cognee guide](https://docs.cognee.ai/guides/memify-entity-deduplication.md)。Neo4j は「統合前に手動の例外を足す」ことを勧めている — [Neo4j blog](https://neo4j.com/blog/developer/property-graph-index-llamaindex/)
- 自動の翻字照合で作ったラベルは、人手ラベルとの一致が約 75% にとどまったため、2026 年の文字体系横断研究ではペアを人手で検証した — [Multilingual-entity/Entity_Identification](https://github.com/Multilingual-entity/Entity_Identification)

### Inferences
- ユーザーのシステムで人手訂正を組み込む最小設計:
  - (1) 訂正を `must_link(mention_a, mention_b)`、`cannot_link(a, b)`、`alias(group_id, surface, kind=対訳|別称|略語|表記ゆれ)` として SQLite に保存する。Sudachi 同義語辞書の列設計を参考にできる。
  - (2) 次のクラスタリングでハード制約として反映する。correlation clustering なら must-link の辺を +∞、cannot-link の辺を −∞ にする。
  - (3) 同じラベルを採点器の閾値較正と（使うなら）分類器の学習データにも使う。
  - (4) 個別の文書ではなく、正規化キーや別名の単位で訂正を保存しておけば、新しい文書が来ても自動で効く。
- 確認キューの優先順位づけ: 「採点が閾値付近（不確実）」「1つの訂正が大きなクラスタの分割・統合に効く（連結成分の橋になっている辺）」「頻出する名前（TF が高い = 同名異物の危険が大きい）」の順に見せれば、Battleship や dedupe と同じ考え方で、少ないラベルで済む。目安は Kasai et al. の例から数十〜百数十ペアだが、短いメンションでの数値ではない。
- 強いクラウドモデルは設計時に1回だけ使える、という条件の生かし方: 開発用データからペアを層別抽出し、クラウドモデルに same/different を付けさせて「銀ラベル」にする → 人が一部を検証する → 閾値・重みの較正と回帰テストに使う。ただし自動ラベルは人手と 75% 程度しか一致しない例があるので、必ず人の検証を挟む。
- 「分割（unmerge）」を安全にするには、統合を破壊的にしない（Cognee 型の削除をしない）。メンション → クラスタの割り当てを毎回再計算できる派生テーブルにしておけばよい。

### Gaps
- 短いメンション（名前＋説明）の ER で、能動学習に必要なラベル数を報告した 2025-2026 年の一次資料は見つからなかった。
- 能動学習 ER の論文で、日本語や言語横断のデータを評価したものは見つからなかった。
- Splink に正式なラベリング UI（人手でペアに正誤を付けて精度を推定する機能）が今もあるかは今回確認していない。
- 分割（unmerge）を UI で扱う OSS の KG ツールは見つからなかった（Reltio などの商用 MDM には merge/unmerge API があるが、今回は調べていない）。
