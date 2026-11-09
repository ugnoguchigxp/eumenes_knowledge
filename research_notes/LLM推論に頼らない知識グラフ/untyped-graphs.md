# 型付き関係を持たないグラフ（文書-エンティティ二部グラフ、共起グラフ、埋め込み類似グラフ）による関連文書発見・ナビゲーション・マルチホップ検索（調査日 2026-11-09）

前提: Markdown 文書（日英混在の個人・チームノート）を最大 2 KB の断片に分けて SQLite に格納している。通常運用は小型ローカル LLM（reasoning off）と multilingual-e5-small（384 次元）。現行では、LLM が断片ごとにエンティティと自由記述の関係を逐語引用付きで抽出している。しかし関係が集約されず（600 関係言及 → 597 エッジ、文書をまたぐエッジは 0）、抽出も遅い（60 KB で約 2 時間）。以下は一次情報（arXiv 本文、公式 README、公式ドキュメント）を優先して集めた。2024 年以前の事実には「(旧)」と付けた。二次情報や検証できなかった点はその旨を書いた。

評価軸の略記は次のとおり: 【コスト】ローカルでの計算・トークンコスト、【日本語】日本語対応、【増分】増分更新、【説明】LLM を使わずにエッジを根拠つきで説明できるか、【品質】報告された品質。

---

## Q1. 関係を使わない（または型を使わない）グラフ上の検索システム: LinearRAG、KET-RAG のキーワード-チャンク二部グラフ、MiniRAG の異種チャンク-エンティティグラフ、HippoRAG / HippoRAG 2 のパッセージ・フレーズノードと Personalized PageRank。型付き関係と共起を比べたアブレーションは何を示すか

### Takeaway
2025〜2026 年の結果を並べると、マルチホップ検索の性能を支えているのは「関係の型」ではない。効いているのは (a) 元のパッセージ（チャンク）をノードとして残すこと、(b) エンティティ・キーワードを介した文書間の接続を十分な密度で作ること、(c) Personalized PageRank（PPR）などによる伝播、の 3 点である。LinearRAG は関係抽出を完全にやめた（spaCy NER と文・パッセージの包含関係だけ）。それでもインデックス時の LLM トークンは 0 で、HippoRAG 2 を 2Wiki・HotpotQA・MuSiQue・Medical のすべてで上回った。HippoRAG 系でも PPR は述語（関係名）を辿らない。トリプルが役立っている場面は「クエリと照合するための文脈つきテキスト」として使われるときに限られる。

### Cited Findings

**LinearRAG（arXiv 2510.10114、2025-10 投稿、v4 2025-11、ICLR 2026 採録と README に記載）**
- 「relation-free hierarchical graph」(Tri-Graph) を作る。ノードは entity、sentence、passage の 3 種。エッジはパッセージ→含むエンティティ（contain 行列 C）と、文→言及するエンティティ（mention 行列 M）だけ。文は句読点で分割し、エンティティは spaCy NER で取る。インデックス時に LLM は使わず、論文には「without incurring LLM token costs」とある — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- 検索は 2 段階。(1) クエリのエンティティを spaCy で取り出し、最も類似するグラフ上のエンティティに対応づける。そこから文を介して数回伝播させる（動的枝刈り閾値 δ=4）。(2) 活性化したエンティティを seed として、passage-entity グラフ上で PPR を回す（d=0.85、top-k=5）。パッセージの初期スコアは「クエリとパッセージの類似度」と「エンティティ由来の項」を組み合わせる — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- Table 1（Contain-Acc / GPT-Acc, %）: HotpotQA は LinearRAG 64.30/66.50、HippoRAG2 62.90/64.30。2Wiki は LinearRAG 70.20/63.70、HippoRAG2 62.70/55.00、HippoRAG 66.10/59.90。MuSiQue は LinearRAG 33.90/37.00、HippoRAG2 31.00/35.00。Medical（GPT-Acc）は LinearRAG 63.72、HippoRAG2 60.77、LightRAG 54.36、RAPTOR 55.75 で、vanilla top-5 retrieval が 61.68 — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- 効率（Table 2、2Wiki）: LinearRAG はインデックス 249.78 s、prompt/completion トークン 0/0、平均精度 66.95。HippoRAG2 は 1147.01 s、4.98M/1.22M トークン、58.85。LightRAG は 4933.22 s、35.52M/51.16M トークン、47.10。大規模版（ATLAS-Wiki）では 5M トークンで LinearRAG 1409.95 s 対 RAPTOR 18033.75 s、10M トークンで 3084.38 s 対 46430.96 s — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- 関係抽出を避ける理由として論文は 4 点を挙げる。(i) 局所的な誤り（例: 「Einstein did not win the Nobel Prize…」が受賞と読まれる）。(ii) 大域的な不整合（パッセージごとに独立に抽出するので、コーパス全体では関係が衝突・重複する）。(iii) 関係を原子的なトリプルに落とすと含意が失われる。(iv) パッセージをつなぐ主な錨は関係ではなくエンティティである — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- アブレーション（Figure 4）: エンティティ活性化を外しても、大域重要度集約を外しても性能は下がる。本文には「Each module of LinearRAG is critical」とあるだけで数値はない。「関係抽出を足し戻す」アブレーションは本文中に見つからなかった — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- 実装（README）: NER は `en_core_web_trf`（Medical は `en_core_sci_scibert`）、埋め込みは `all-mpnet-base-v2`、生成 LLM の例は `gpt-4o-mini`。増分インデックスについての記述はない。ライセンスは GPL-3.0。GPU があればベクトル化した検索、なければ BFS 反復で動く — [LinearRAG GitHub](https://github.com/DEEP-PolyU/LinearRAG)

**KET-RAG（arXiv 2502.09304、2025-02 投稿、v2 2025-06）**
- キーワード-チャンク二部グラフを作る。既定のキーワード抽出は「トークン化してストップワードを除くだけ」で LLM は使わない（TF-IDF も使えると書かれている）。キーワードノードの説明はそのキーワードを含む全文で、埋め込みはそれらの文埋め込みの平均。チャンクは 2^τ 個のサブチャンクに分け、含むキーワードとつなぐ — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- スケルトン KG 用のコアチャンクは次のように選ぶ。チャンク間に KNN グラフ（既定 K=2）を張る。近傍の半分は共有キーワード数、残り半分は埋め込みコサインで決める。このグラフ上の PageRank 上位 ⌈β|V|⌉（β=0.8）を LLM のトリプル抽出に回す — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- アブレーション（低コストモード、Table 2）: Skeleton-RAG のみ（LLM の KG だけ）は MuSiQue Coverage/EM 43.4/11.0、HotpotQA 57.8/20.0、RAG-QA 勝率 28.6。Keyword-RAG のみ（LLM なしの二部グラフ）は 50.8/7.0、60.2/24.4、勝率 37.0。両者を組み合わせた KET-RAG-P は 77.0/14.0、81.6/28.6、39.6。Text-RAG（単純ベクトル）は 26.4/3.0、37.2/14.8、0.0 — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- Keyword-RAG を Text-RAG と比べると（MuSiQue）、Coverage +92.4%、EM +133.3%、F1 +118.5%。PageRank でコアチャンクを選ぶと、ランダム選択より EM が最大 4.5% 上がる。検索予算のうちスケルトンに回す割合 θ を 0.2 程度入れるだけで、Keyword-RAG はかなり良くなる — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- コスト（USD、低/高モード）: MuSiQue で MS-GraphRAG 2.30/24.94、KET-RAG-P 1.89/20.04、Text-RAG 0.02/0.05。「1 桁以上安い」という主張は、KET-RAG の低コストモードと他手法の高精度モードを比べたもの。同じモード同士の差は約 18〜19% — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- arXiv の abstract ページにはコードリポジトリへのリンクがない — [KET-RAG abs](https://arxiv.org/abs/2502.09304)

**MiniRAG（arXiv 2501.06713、2025-01）**
- 異種グラフで、ノードはテキストチャンクとエンティティの 2 種、エッジは entity-entity と entity-chunk の 2 種。entity-chunk エッジには言語モデルが書いた説明文がつく（text-attributed edge）。したがって完全な relation-free ではない。関係の型を付けてはおらず、ただの共起とも書かれていない — [MiniRAG HTML](https://arxiv.org/html/2501.06713)
- 小型 LM（Phi-3.5-mini、GLM-Edge-1.5B、Qwen2.5-3B、MiniCPM3-4B）と all-MiniLM-L6-v2 で動かす想定。LiHuaWorld での精度は Phi-3.5-mini で LightRAG 39.81 → MiniRAG 53.29、Qwen2.5-3B で 39.18 → 48.75。GraphRAG は SLM では有効な応答を生成できなかった（表では「/」）。gpt-4o-mini では LightRAG 56.90、MiniRAG 54.08 — [MiniRAG HTML](https://arxiv.org/html/2501.06713)
- アブレーション（LiHuaWorld、Phi-3.5-mini）: full 53.29 に対し、semantic indexing を外すと 26.02、chunk 経由の検索 R_chunk を外すと 48.90、edge 経由の検索 R_edge を外すと 50.47。エッジ情報を外したときの落ち幅（0.3〜4.7 pt）は、索引構造そのものを外したとき（約 25 pt）よりずっと小さい。ストレージは LightRAG（gpt-4o-mini）の 25% で同程度の精度と主張しているが、本文に具体値はない — [MiniRAG HTML](https://arxiv.org/html/2501.06713)

**HippoRAG（旧、arXiv 2405.14831、2024）と HippoRAG 2（arXiv 2502.14802、ICML 2025）**
- HippoRAG 2 のグラフ: LLM の schema-less OpenIE で得たトリプルの主語・目的語をフレーズノードにする。各パッセージもノードにして、抽出元フレーズと「contains」エッジで結ぶ。フレーズ埋め込みの類似度が 0.8 を超える組に synonym エッジを張り、これでパッセージ同士がつながる — [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2)
- PPR の seed: クエリをトリプル全体の埋め込みと照合し（query-to-triple）、上位 5 件を LLM でフィルタする。フィルタを通ったトリプルのフレーズを seed にする。全パッセージノードも seed になり、重み係数は既定 0.05。damping は 0.5。トリプルが残らなければ dense retrieval の結果をそのまま返す — [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2)
- アブレーション（Recall@5、MuSiQue/2Wiki/HotpotQA/平均）: full 74.7/90.4/96.3/87.1。NER→ノード照合は 53.8/91.2/78.8/74.6。クエリ→ノード照合は 44.9/65.5/68.3/59.6。パッセージノードなしは 63.7/90.3/88.9/81.0。フィルタなしは 73.0/90.7/95.4/86.4 — [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2)
- QA F1（Llama-3.3-70B 読み手）の平均は NV-Embed-v2 57.0、HippoRAG 2 59.8、HippoRAG 53.1、GraphRAG 49.6、RAPTOR 48.8、LightRAG 6.6。NQ（単純 QA）では NV-Embed-v2 61.9 に対し RAPTOR 50.7、GraphRAG 46.9、HippoRAG 55.3 と構造拡張型は軒並み下回る。上回ったのは HippoRAG 2（63.3）だけだった。著者は、LLM が生成した要約や構造が雑音になったことを原因に挙げている — [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2)
- インデックスコスト（MuSiQue、11,656 パッセージ）: NV-Embed-v2 12.1 分。HippoRAG 2 は 99.5 分で入力 9.2M・出力 3.0M トークン。GraphRAG は 277.0 分で 115.5M/36.1M。LightRAG は 235.0 分で 68.5M/18.3M — [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2)
- (旧) HippoRAG 1 のアブレーション（Recall@2/@5 平均）: full 57.4/72.9。OpenIE を REBEL に替えると 46.2/58.4。Llama-3.1-8B では 54.4/67.8。PPR の代わりにクエリノードだけを使うと 50.7/56.2、クエリノードと隣接ノードを使うと 42.2/59.2。node specificity なしは 54.7/70.9、synonym エッジなしは 56.2/70.5。REBEL で落ちる理由について、論文はノード・エッジ数が GPT-3.5 の約半分になり連想が欠けるためと説明している — [HippoRAG HTML](https://arxiv.org/html/2405.14831)
- (旧) HippoRAG 1 本文には、PPR の遷移に関係の型が使われるという記述がない。限界の節で「関係でグラフ探索を直接導くこと」を今後の課題に挙げている — [HippoRAG HTML](https://arxiv.org/html/2405.14831)
- HippoRAG の現行 README: MCP サーバの `index` は既存パッセージを飛ばして追加し、`delete` は本文または `source_id` で削除する。インデックスは `--save_dir` に永続化される。ローカル vLLM（OpenAI 互換）にも対応する。言語対応の記述はない — [HippoRAG GitHub](https://github.com/OSU-NLP-Group/HippoRAG)

**Microsoft GraphRAG の FastGraphRAG と LazyGraphRAG（共起グラフ版）**
- FastGraphRAG: 「entities are noun phrases extracted using NLP libraries such as NLTK and spaCy」、「relationships are defined as text unit co-occurrence between entity pairs」。エンティティにも関係にも説明文がない。既定は NLTK と正規表現で、主に英語向け。共起グラフを良くするため、チャンクを 50〜100 トークンに小さくするよう推奨している。グラフ抽出はインデックスコストの約 75% を占め、FastGraphRAG はそれをほぼ省く。一方でグラフは「quite a bit noisier」になる — [GraphRAG docs: Indexing methods](https://microsoft.github.io/graphrag/index/methods/)
- (旧, 2024-11) LazyGraphRAG: 名詞句の抽出と共起から概念グラフを作り、グラフ統計で階層コミュニティを作る。インデックス時に LLM で要約しない。インデックスコストは「identical to vector RAG and 0.1% of the costs of full GraphRAG」。LLM はクエリ時にだけ使う（サブクエリ化、チャンクの関連性判定、claim 抽出） — [Microsoft Research Blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- GraphRAG-Bench（後述 Q6）の Novel データセット: Lazy-GraphRAG は fact retrieval ACC 51.65 で、RAG（rerank あり）60.92 より低い。complex reasoning は 49.22 で RAG の 42.93 より高い。Medical では complex reasoning も 47.82 対 58.64 で RAG を下回った。表の列対応は取得ツールの推定なので、原典で確認が要る — [GraphRAG-Bench HTML](https://arxiv.org/html/2506.05690v3)

**LLM を使わない構文ベース KG（SAP、arXiv 2507.03226、2025-07）**
- spaCy の係り受けから {SAP, launch, Joule_for_Consultants} のような動詞ベースのトリプルを作る。LLM-as-Judge の加重平均は依存構造 KG 61.87%、GPT-4o KG 65.83%（約 94%）、dense ベクトル 50.80%。RAGAS 平均は 74.93%、75.83%、71.48%。GPT-4o による構築は 80 万 API コールで逐次 65.7 日と見積もられている。依存構造パイプラインの時間は報告されていない。評価は SAP の 2 データセットだけ — [SAP 論文 HTML](https://arxiv.org/html/2507.03226v2)

### Inferences
- LinearRAG、KET-RAG の Keyword-RAG のみ版、LazyGraphRAG の 3 つが、型付き関係なしでもマルチホップ検索は成り立つことを示している。LinearRAG と LazyGraphRAG はインデックス時の LLM ゼロ、KET-RAG Keyword-RAG はキーワード側の LLM ゼロ。LinearRAG では、HippoRAG 2 のトリプル（関係テキスト）が果たしている「クエリとの照合キー」の役割を、文ノード（sentence→entity の mention 行列）が代わりに担っていると読める。HippoRAG 2 で query-to-triple が NER-to-node より Recall@5 で平均 12.5 pt 高いのは、関係の型の効果ではない。照合単位として文脈つきのテキストを使った効果である。本プロジェクトで言えば、断片内の文（または逐語引用スパン）をノードにすれば、LLM 抽出なしで同じ効果を狙える。
- HippoRAG 1 で REBEL に替えると落ちる理由は「エッジが少ない」ことにある。関係の型の差ではない。GraphRAG-Bench でも、密なグラフの HippoRAG2（平均次数 8.75）が最良だった。どちらも、型より接続の網羅率と密度が効くことを示している。本プロジェクトの「600 言及 → 597 エッジ、文書横断 0」は、LinearRAG が言う「大域的な不整合」がそのまま現れた例と考えられる。文書をまたいだ接続は、正規化したエンティティ（名詞句）を共有ノードにすることで初めて生まれる。
- MiniRAG のアブレーションを見ると、エッジ説明文（LM 生成）を外しても落ち幅は小さく、効いているのは索引構造だった。小型 LM で関係説明を作る費用に見合う効果は見込めない。
- HippoRAG 2 の synonym エッジ閾値 0.8 は NV-Embed-v2 前提の値である。multilingual-e5 ではコサインが 0.7〜1.0 に集中する（Q3 参照）ので、そのままでは閾値が緩すぎる可能性が高い（推論）。

### Gaps
- LinearRAG に「関係抽出を足し戻した」比較や、日本語での評価は見つからなかった。数値つきのアブレーションは図だけで、本文から取れなかった。
- KET-RAG の公式リポジトリは確認できなかった。
- 日本語のマルチホップ QA で relation-free グラフを評価した論文は見つからなかった。
- MiniRAG の entity-entity エッジがどう作られるか（LM 抽出か共起か）は、本文からは確定できなかった。

---

## Q2. 共起の重み付け（PMI、NPMI、TF-IDF、BM25 重み）、TextRank やキーワードグラフ、コンセプトマップと関連文書推薦への応用。Personalized PageRank やランダムウォークによる関連文書

### Takeaway
共起エッジの重みは、頻度だけでなく「期待値で割る」正規化（PMI/NPMI、VOSviewer の association strength、STRING の頻度補正）を入れるのが定石である。これでハブ語（どこにでも出る語）を抑え、エッジの強さをスコアとして示せる。関連文書の算出には二通りの道がある。一つは古典的な TF-IDF の「interesting terms」（Lucene MoreLikeThis）。もう一つは、文書-エンティティ二部グラフ上の PPR（LinearRAG、KET-RAG、HippoRAG と同じ機構）。どちらもクエリ時の LLM は不要で、根拠（共有語や共有エンティティ）をそのまま提示できる。

### Cited Findings
- (旧, 2009) NPMI は Bouma（GSCL 2009）による。式は log2(p(w1,w2)/(p(w1)p(w2))) / −log2 p(w1,w2) で、値域はおよそ −1〜1 — [IDS Mannheim derekovecs（式と出典表示）](https://corpora.ids-mannheim.de/derekovecs); [dblp: Bouma](https://dblp1.uni-trier.de/rec/conf/acl/Bouma10.html)（dblp は Bouma の 2010 年 ACL 論文の記録。2009 年 GSCL 論文そのものは開けなかった）
- (旧, 2004) TextRank（Mihalcea & Tarau, EMNLP 2004）は、キーワード抽出と文抽出のためのグラフベースのランキングモデル — [ACL Anthology W04-3252](https://aclanthology.org/W04-3252/)（窓幅などの詳細は PDF を読めず未確認）
- InfraNodus は 4-gram の滑り窓で語の共起を取り、隣接語は重み 3、1 語おきは 2、2 語おきは 1 とする。ストップワードと TF-IDF で補助語を除き、見出し語化する。中心性は betweenness、クラスタは Louvain、レイアウトは Force-Atlas — [InfraNodus: Text Network Analysis](https://infranodus.com/docs/text-network-analysis)
- VOSviewer は共起行列を association strength で正規化して類似度行列にする。association strength は「観測された共起数」と「独立なら期待される共起数」を比べる指標で、総出現数の差を補正する — [arXiv 2109.04086（VOSviewer を使った研究による説明、二次）](https://arxiv.org/pdf/2109.04086)
- STRING（タンパク質相互作用 DB）のテキストマイニング channel は「how often two proteins are mentioned together within the same sentence, paragraph, or document」を測る。各タンパク質の全体頻度で重み付けするので、よく研究されたタンパク質ほど強い共起の偏りがないとリンクにならない。信号は参照データでの既知関連の再現率で較正される。共起は「does not attempt to determine the exact type of interaction」で、機能的関連として扱われる — [STRING help: scores](https://string-db.org/help/scores/)
- Lucene MoreLikeThis は、元文書内で頻度が高く索引全体では文書頻度が低い語（TF-IDF の考え方）を「interesting terms」として選び、類似文書クエリを作る。minTermFreq、minDocFreq、maxDocFreq、maxQueryTerms、boost などのパラメータがある（既定値の数値は別ページにあり、未確認） — [Lucene MoreLikeThis Javadoc](https://lucene.apache.org/core/9_9_0/queries/org/apache/lucene/queries/mlt/MoreLikeThis.html)
- PPR（random walk with restart）は、出発ノードから歩いて目標ノードに行き着く確率として定義される、広く使われるノード類似度 — [arXiv 2110.15513](https://arxiv.org/pdf/2110.15513)。(旧) 二部グラフ（ユーザ-アイテム、クエリ-ページ）上の頂点ランキングを扱う BiRank もある — [BiRank arXiv 1708.04396](https://pdf.arxiv.org/pdf/1708.04396)
- 文書-エンティティ二部グラフ上の PPR を「エンティティを seed にしてパッセージを取る」形で使い、最新の結果を出しているのが LinearRAG（d=0.85）と HippoRAG 2（d=0.5、パッセージ seed 重み 0.05）。HippoRAG 1 では、PPR をクエリノードだけ、あるいはクエリノードと隣接ノードの単純展開に置き換えると Recall@5 平均が 72.9 → 56.2 / 59.2 に落ちた — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4); [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2); [HippoRAG HTML](https://arxiv.org/html/2405.14831)
- HippoRAG 1 の「node specificity」（フレーズが出現するパッセージ数の逆数で seed を重み付けする、IDF に相当する仕組み。この定義は筆者の論文理解によるもので、今回の取得では本文を再確認していない）を外すと Recall@5 平均は 72.9 → 70.9 で、MuSiQue と HotpotQA で効いた — [HippoRAG HTML](https://arxiv.org/html/2405.14831)
- KET-RAG はチャンク KNN グラフの半分を「共有キーワード数」で張り、PageRank 上位のチャンクを重要チャンクとして扱う。ランダム選択より EM が最大 4.5% 高い — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- Connected Papers（論文推薦）は co-citation と bibliographic coupling に基づく類似度で、型のないグラフを作る。約 5 万本を解析し、起点論文と最も強く結びつく数十本だけを力学レイアウトで表示する。グラフ上の近さは、引用パターンが似ていることを表すだけで、結論が一致していることは意味しない（いずれも大学図書館ガイドなど二次情報。公式 About ページは取得できなかった） — [LMU LibGuide](https://libguides.lmu.edu/AIresearchtools/CP); [casrai.org](https://www.casrai.org/guides/connected-papers)

### Inferences
- 本プロジェクトの関連文書発見には次の 2 段構成が素直に合う（推論）。(1) 文書（断片）とエンティティ・キーワードの二部グラフを作り、エンティティ側を IDF または NPMI で重み付けする。(2) 起点文書のエンティティ集合を seed にして PPR を回し、文書ノードのスコアを順位にする。根拠の提示はクエリ時の LLM なしでできる。共有エンティティの一覧、各エンティティの出現断片（UTF-8 バイト範囲）、NPMI または association strength の値を見せればよい。これは STRING の「共起スコア＋根拠文書」と同じ形である。
- 「どこにでも出る語」（例: 社内の製品名や「設計」「対応」など）を抑えることが、品質と見た目の両方で最重要になる。HippoRAG の node specificity、STRING の頻度補正、Lucene MLT の maxDocFreq、VOSviewer の association strength は、どれも同じ問題への対処である。
- TextRank と InfraNodus の語レベル共起グラフは、主に文書内の要約・可視化に向く。文書間のつながりを作るには、語を名詞句やエンティティに正規化して文書横断のノードにする必要がある（推論）。

### Gaps
- 「NPMI 重み付けの文書-エンティティ PPR」と「埋め込み kNN」を、関連文書推薦の品質（人手評価や nDCG）で直接比べた 2025〜2026 年の研究は見つからなかった。
- TextRank の原論文の窓幅・評価値、Bouma 2009 の本文は確認できていない。
- コンセプトマップ（concept map）を自動生成して関連文書推薦に使った研究は、今回の調査範囲では探し切れていない。
- 個人ノートの「関連ノート推薦」をユーザ評価した研究は見つからなかった。

---

## Q3. パッセージ埋め込みの kNN グラフとトピックモデル（BERTopic）によるクラスタリングとナビゲーション。エンティティグラフとの比較

### Takeaway
埋め込み kNN の「コーパスグラフ」は安くて効く。GAR（旧, CIKM 2022）では k=8 で 1 パッセージ 32 バイト、nDCG 最大 +8%、R@1k 最大 +12%。ただしエッジの理由を説明できない。また e5 系はコサイン値が 0.7〜1.0 に集中し、高次元埋め込みには hubness（特定文書が多くの kNN リストに現れる現象）があるので、絶対閾値と生の kNN はそのままでは使いにくい。エンティティ・キーワードのグラフは説明しやすく、マルチホップに強い。KGP では TAGME のエンティティグラフが最良だったが、最も遅かった。両者を混ぜる設計（KET-RAG の KNN グラフは半分を共有キーワード、半分をコサインで張る）が実用的な折衷になる。BERTopic はナビゲーション用のクラスタラベルに向く。ただし増分更新には制約があり、日本語には分かち書きが必須。

### Cited Findings
- (旧, 2022) GAR（Adaptive Re-Ranking with a Corpus Graph、CIKM 2022）: 各パッセージについて BM25 または TCT-ColBERT で上位 k+1 件を取り、自分を除いて k=8 近傍のグラフにする。k=1〜16 を掃引した結果、k≥6 で安定した。保存は 32 バイト/パッセージで、MS MARCO 全体で 283 MB。BM25>>monoT5-base の場合、DL19 nDCG@c=100 は 0.665 → 0.722（TCT グラフ）、R@1k は 0.755 → 0.839。構築時間は BM25 グラフが 24 コア CPU で約 8 時間、TCT グラフが RTX 3090 で約 3 時間 — [GAR (ar5iv)](https://ar5iv.labs.arxiv.org/html/2208.08942); [arXiv abs](https://arxiv.org/abs/2208.08942)
- (旧, 2023) KGP（Knowledge Graph Prompting）: パッセージをノードとし、類似度または構造でつないだグラフを LLM エージェントが辿る。構築法を比べると、HotpotQA では KNN-MDR が TF-IDF や KNN-ST より良いトレードオフ、MuSiQue では KNN-ST（sentence transformer）が KNN-MDR より良かった。TAGME（エンティティリンク）は最も高性能だが遅延が大きく、論文には「it usually takes more than 8 hours to extract entities of all passages for even just 12 Wikipedia documents」とある。TF-IDF（キーワード共有）は近傍が限られ、SF-EM が 0.7 未満に頭打ちになる — [KGP HTML](https://arxiv.org/html/2308.11730v3)
- 2025〜2026 の統一比較（arXiv 2503.04338 v2、2026-04 改訂）は、KGP 型の Passage Graph を「チャンクをノードにし、十分にエンティティを共有すればリンクする」構造に分類し、構築に LLM を使わない（トークンコスト 0）としている。一方、元のチャンクを持たずグラフ構造だけに頼る手法（G-retriever、ToG、DALK）は多くのデータセットで性能が低い。木構造の RAPTOR が specific QA で最も強く、KGP は上位ではなかった — [In-depth Analysis HTML](https://arxiv.org/html/2503.04338v2)
- KET-RAG のチャンク KNN グラフ（K=2）は、半分を共有キーワード数、半分を埋め込みコサインで張る混合型。PageRank で重要チャンクを選ぶのに使っている — [KET-RAG HTML](https://arxiv.org/html/2502.09304v2)
- multilingual-e5-small の model card FAQ: 「Use "query: " prefix for symmetric tasks such as semantic similarity, bitext mining, paraphrase retrieval」「Use "query: " prefix if you want to use embeddings as features, such as … clustering」。コサインが 0.7〜1.0 に集まるのは「a known and expected behavior as we use a low temperature 0.01 for InfoNCE」で、絶対値より相対順位が重要とある。入力は最大 512 トークンで切り詰められる — [multilingual-e5-small README](https://huggingface.co/intfloat/multilingual-e5-small/raw/main/README.md)
- (旧, 2023) Sentence-BERT 系の埋め込みには強い hubness がある。hubness を低減すると hubness が約 75%、誤り率が約 9% 下がった。hubs は「query に関係なく同じオブジェクトが結果に出る」原因になる — [arXiv 2311.18364](https://arxiv.org/pdf/2311.18364.pdf); [scikit-hubness concepts](https://scikit-hubness.readthedocs.io/en/latest/documentation/concepts.html)
- multilingual-e5-small の日本語検索性能（参考値）: JaQuAD の nDCG@10 は 59、JaGovFaq は 65.6、平均 62.3（multilingual-e5-base は 64.5） — [Granite Embedding 論文 Table 13](https://arxiv.org/pdf/2502.20204)。金融ドメインの JFinTEB（2026）では E5-small の総合平均 75.2、E5-large 79.3、日本語特化の Sarashina 80.9、Ruri-310M 79.4 — [JFinTEB arXiv 2604.15882](https://arxiv.org/pdf/2604.15882)
- BERTopic のオンライン学習: `partial_fit` で増分更新するには、UMAP を IncrementalPCA に、HDBSCAN を MiniBatchKMeans に置き換え、OnlineCountVectorizer（`decay` で古い頻度を減衰）を使う。新しいトピックの発見には River（DBSTREAM 等）を使う。`fit` の後に `partial_fit` はできず、追跡されるのは直近バッチだけ。代替として、新データで別モデルを学習して `merge_models` で統合する方法がある — [BERTopic docs: Online](https://maartengr.github.io/BERTopic/getting_started/online/online.html)
- BERTopic を日本語で使うには、c-TF-IDF 用の CountVectorizer に形態素解析器を渡す必要がある。公式ドキュメントは中国語の分かち書き器を例に、カスタム tokenizer の渡し方を示している — [BERTopic docs: Vectorizers](https://maartengr.github.io/BERTopic/getting_started/vectorizers/vectorizers.html)。既定の token_pattern では日本語が分割されず `ValueError: empty vocabulary` になる、という報告がある（個人ノート、二次） — [nishio scrapbox](https://scrapbox.io/nishio/TTTC:empty_vocabulary)

### Inferences
- 関連文書を出すときは、埋め込み kNN を主シグナルに使ってよい（安く、増分更新も近傍の再計算で済む）（推論）。ただし表示エッジとしては、共有エンティティか共有キーワードがある kNN エッジだけを「説明つきエッジ」として出すのがよい。それ以外は「意味的に近い（理由は本文の類似）」と明示し、最も近い断片ペアを根拠として見せる。e5 では絶対閾値（例: 0.8）が効きにくいので、相互 kNN（mutual kNN）か順位ベースの閾値にすると、hubness も抑えられる（推論。相互 kNN の効果を直接示す出典は今回取っていない）。
- e5 で類似度グラフを作るときは、両側とも「query: 」前置にする（symmetric task 扱い）。本プロジェクトで検索用に「passage: 」で埋め込んでいる断片をそのまま kNN グラフに流用すると、model card の推奨から外れる（推論）。
- BERTopic は「クラスタ単位のナビゲーション（トピック一覧 → 文書）」には向くが、文書間エッジの説明にはならない。増分更新は `partial_fit` の制約（HDBSCAN 不可、直近バッチのみ）があるので、個人ノート規模（数千断片）なら定期的に全体を再学習する方が単純（推論）。
- 512 トークンの上限は 2 KB 断片（日本語だと約 700〜1,000 トークンになり得る）を切り詰める可能性がある（推論。日本語のトークン数は未計測）。

### Gaps
- 埋め込み kNN グラフとエンティティ二部グラフを「関連文書推薦」の人手評価で比べた研究は見つからなかった（KGP の比較はマルチ文書 QA で、2023 年）。
- multilingual-e5-small の JMTEB での検索スコアは取得できなかった。
- 日本語・英語が混ざったノートで hubness がどの程度出るかの報告は見つからなかった。

---

## Q4. 型付き関係のないテキストの知識グラフをどう見せるか: 共起ネットワークツール（InfraNodus、VOSviewer）、Obsidian のようなグラフビュー。利用者が何を有用と感じ、何が「hairball」になるか。フィルタとレイアウトの実践

### Takeaway
利用者の声も既存ツールの設計も同じことを示している。全体グラフ（global graph）は数百ノードを超えると hairball になり、役に立つのは「起点ノードの近傍（local graph、深さ 1〜2）」と「強いエッジだけを残した骨格」である。既存ツールは次の 4 つの手で読める図にしている。(1) 最小出現回数で語を足切りする、(2) 期待値で正規化した重みを使う、(3) 中心性でノードの大きさを決め、モジュラリティでクラスタを色分けする、(4) 力学レイアウトに加えて、ローカル表示・検索フィルタ・グループ色を用意する。統計的なバックボーン抽出（disparity filter）を使うと、エッジを大きく減らしても重みの大部分を残せる。

### Cited Findings
- Obsidian の Graph view（公式ヘルプ）: global graph は vault 内の全ノートを表示する。local graph はアクティブなノートにつながるノートだけを表示し、Depth スライダで階層を増やせる。フィルタは検索語、Tags、Attachments、Existing files only、Orphans。検索語でグループを作って色を付けられる。表示設定は矢印、Text fade threshold、Node size、Link thickness。力の設定は Center、Repel、Link force、Link distance — [Obsidian Help: Graph view](https://obsidian.md/help/plugins/graph)
- Obsidian フォーラムの利用者の声: ノート数が増えると全体グラフは「completely useless」になる。約 1 万ノートの利用者は「pretty feature」と評した。local graph だけ使う、local graph の Incoming/Outgoing フィルタは非常に有用、という声が多い。global graph にもこのフィルタや保存フィルタを、という要望がある。擁護側は「検索語や `-path:` 除外を使えば役立つ」と言う — [How do you use the graph view?](https://forum.obsidian.md/t/how-do-you-use-the-graph-view/2785); [You All Say the Graph Is Useless…](https://forum.obsidian.md/t/you-all-say-the-graph-is-useless-let-me-show-you-how-to-use-it/116738); [Outgoing/Incoming link filters in global graph](https://forum.obsidian.md/t/outgoing-incoming-link-filters-in-global-graph-view/52139)（いずれも利用者の意見であり、定量調査ではない。「200 ノードを超えると hairball」といった数値を載せたブログは根拠データがなく除外した）
- InfraNodus: ノードの大きさを betweenness centrality で決め、Louvain で色分けし、Force-Atlas でハブ同士を離す。クラスタ間の「structural gaps」を検出し、生成 AI でそれを埋める問いを提案する。乱雑さへの対処として「最大ノードを除いて再計算し、新たに影響力を持つノードを見る」という手作業の手順を勧めている — [InfraNodus: Network Analysis](https://infranodus.com/docs/network-analysis); [InfraNodus: Text Network Analysis](https://infranodus.com/docs/text-network-analysis)。方法論は WWW'19 論文に基づく — [InfraNodus WWW'19 PDF（第三者ミラー）](https://ryuchen.github.io/essay/0x00000C.files/1-WWW-%20InfraNodus-%20Generating%20Insight%20Using%20Text%20Network%20Analysis.pdf)。日本語・中国語対応の記述は公式ページに見つからなかった。
- VOSviewer: 最小出現回数の閾値で、どの語を地図に載せるかを決める。低い閾値ではほぼすべての語、高い閾値では頻出語だけが残る — [arXiv 2305.09439](https://arxiv.org/pdf/2305.09439)。各候補語に relevance score を計算して、情報量の多い語に絞り込む。ある例では 325 語から 195 語（約 60%）が選ばれた — [VOSviewer text mining blog（二次）](https://cobalt-dodecahedron-fdd2.squarespace.com/blog/3ut7ii459sndohl2vdxx0jd13ycoal)。抄録ベースの分析では relevance score が重要語を落とすことがある、という報告もある（同検索結果の韓国の研究、二次） — [koreascience.kr](https://koreascience.kr/article/JAKO202030363186927.page?lang=en)
- (旧, 2009) Disparity filter（Serrano, Boguñá, Vespignani）: 重み付きネットワークで、局所的な重み分布から統計的に有意に外れるエッジだけを残す。米国空港網では有意水準約 0.05 で、総重みの 80%、ノードの 66% を保ったままエッジを 17% まで減らした — [arXiv 0904.2389](https://arxiv.org/abs/0904.2389)（数値は検索結果の要約で、本文未確認）。(旧, 2015) Nocaj, Ortmann, Brandes の「Untangling the hairballs」は、局所密度に深く埋め込まれたエッジ（quadrilateral Simmelian backbone）と UMST による連結性保持を組み合わせ、small-world ネットワークを描けるようにした — [JGAA paper370](https://jgaa.info/index.php/jgaa/article/download/paper370/2582)。R パッケージ `backbone` は disparity を重み付きネットワークの既定にしている — [backbone_from_weighted](https://rdrr.io/cran/backbone/man/backbone_from_weighted.html)
- Connected Papers は「起点 1 本から数十本だけ」を表示する設計で、ノードの大きさは被引用数、色は出版年を表す（二次情報） — [LMU LibGuide](https://libguides.lmu.edu/AIresearchtools/CP)
- 正規化重みと頻度の差: GraphRAG-Bench の計測では HippoRAG2 のグラフが平均次数 8.75、クラスタ係数 0.657（Novel）で、MS-GraphRAG は 1.48 / 0.315。密なグラフほど検索性能は良いが、そのまま描けば hairball になりやすい — [GraphRAG-Bench HTML](https://arxiv.org/html/2506.05690v3)

### Inferences
- 本プロジェクトのビューア（ホストアプリの UI artifact）では、次の構成が既存ツールの実践と利用者の声に合う（推論）。既定は「選択した文書またはエンティティを中心にした local view（深さ 1、最大 20〜50 ノード）」にする。全体表示はクラスタ単位（Louvain や BERTopic のクラスタを 1 ノードに畳む）にする。エッジは NPMI または association strength で正規化したうえで disparity filter かノードあたり top-k で間引く。ノードの大きさは文書頻度より betweenness か PPR スコアで決める。「関係の型」で色分けする代わりに、エッジの「根拠の種類」で色分けする（共有エンティティ、共有キーワード、埋め込み類似のみ）。
- 検索中心で使うツール（chat・authoring・coding エージェント）では、グラフは「関連文書の理由を見せる UI」として使うのが主になる。全体グラフの美しさは主目的にならない（推論）。

### Gaps
- VOSviewer の公式マニュアル（PDF）は取得したが本文を抽出できず、既定値（binary counting の既定、relevance score で選ぶ割合、表示エッジ数の上限）は一次情報で確認できていない。
- グラフビューの有用性を定量的に評価したユーザ研究（タスク成功率など）は見つからなかった。Obsidian の声はフォーラムの逸話。
- InfraNodus の日本語対応（形態素解析の有無）は未確認。

---

## Q5. 「Lazy typing」: 型のないエッジを共有根拠とともに表示し、利用者がそのエッジを開いたときだけ LLM に関係を名付けさせる方式（そうしているシステムや論文）

### Takeaway
「インデックス時は共起だけを持ち、LLM はクエリ時に遅延実行する」設計は、Microsoft の LazyGraphRAG（旧, 2024-11）と FastGraphRAG（関係に説明文なし）で実用化されている。「エッジ＝根拠文の集合とし、要約・命名はその根拠文から作る」設計は、DEER / CovidDEER（旧, 2022〜2023）と STRING のテキストマイニング channel が先例になる。ただし「利用者がエッジを開いた時点で LLM に関係名を付けさせ、それを評価した」研究は見つからなかった。最も近いのは CovidDEER で、エッジ上の上位 5 文を ChatGPT で要約しつつ、利用者には元の文を確認するよう勧めている。

### Cited Findings
- (旧, 2024-11) LazyGraphRAG: 「defers all LLM use until query time」。インデックスは名詞句の共起グラフとコミュニティ構造だけ。クエリ時に LLM がサブクエリ化、チャンクの関連性判定、claim 抽出を行う。ローカルクエリではベクトル RAG と同程度のクエリコストで全比較手法を上回り、グローバルクエリでは GraphRAG Global Search と同程度の品質をクエリコスト 700 分の 1 以下で出した（5,590 本の AP ニュース、合成クエリ 100 件） — [Microsoft Research Blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- FastGraphRAG: 関係は共起だけで説明文を持たない。コミュニティレポートは LLM が書くが、材料は LLM 生成の説明ではなく、名詞句を含む生のテキスト単位 — [GraphRAG docs: Indexing methods](https://microsoft.github.io/graphrag/index/methods/)
- (旧, 2023) CovidDEER（Descriptive KG、EMNLP 2023 Demo）: PubTator と SciSpacy でエンティティを取り、文中で主語・目的語エンティティが共起する組ごとに、係り受けパスに基づく relation description score（RDS、0〜1、閾値 0.7）で文を採点する。閾値を超えた文がエッジの「関係記述」になる（72,014 文書、140,574 ノード、863,102 エッジ）。Entity-Entity クエリは、2 エンティティを結ぶエッジ上の文を返す。ChatGPT は RDS 上位 5 文から短い関係要約を書く。直接の文がないペアについては、FiD の relation synthesis モデルがマルチホップの文から記述を合成する。著者による忠実性評価は 20 件で 4.10/5。利用者には生成文ではなく元の文を確認するよう推奨している。要約がクエリ時に生成されるのか事前計算なのかは、論文から明確に読み取れない — [CovidDEER HTML](https://arxiv.org/html/2310.11681); [arXiv abs](https://arxiv.org/abs/2310.11681)
- STRING のテキストマイニング: 共起 channel は型を決めず「機能的関連」とし、物理的相互作用は別の fine-tune 済み NLP/LLM 抽出器が担う（「binds」「forms a complex」など）。各 channel の寄与はエッジのポップアップで見られる — [STRING help: scores](https://string-db.org/help/scores/)。テキストマイニング表示用の抄録テーブル（`evidence.abstracts`）や、各タンパク質を言及する抄録の表がスキーマにある — [STRING help: database](https://string-db.org/help/database)
- 2 エンティティのつながりを LLM に説明させる研究（文化遺産 KG、arXiv 2501.06628、2025-01）: パターンベースで接続を発見したあと、LLM がつながりの説明を生成する。ただし対象は型付き KG — [arXiv 2501.06628](https://arxiv.org/pdf/2501.06628)
- RELRaE（arXiv 2507.03829、2025-07）は、LLM に「このラベルは関係を正しく表しているか」と問い、違えば別のラベルを提案させる「関係ラベルの事後付与・改善」手法。クエリ時に動かすかどうかは未確認 — [RELRaE](https://arxiv.org/pdf/2507.03829)

### Inferences
- 本プロジェクトに当てはめた「lazy typing」は次の形が自然である（推論）。インデックス時は共起エッジ（共有エンティティ・共有文・NPMI）と根拠スパン（UTF-8 バイト範囲）だけを保存し、LLM は呼ばない。ビューアで利用者がエッジを開いたら、まず根拠スパンをそのまま表示する（LLM なし、即時）。「関係を説明」ボタンを押したときだけ、小型ローカル LLM に根拠スパン上位 N 件を渡して関係名と一文の説明を作らせ、結果をキャッシュする。その出力にも根拠スパンへの引用を必須にすれば、既存の検証可能な引用の仕組み（逐語引用のバイト範囲）と両立する。
- この方式なら、LLM を使う回数は「利用者が開いたエッジ数」に比例するだけになる。全断片の事前抽出（60 KB で約 2 時間）と比べて桁違いに少なくなると見込める（推論。開封率のデータはない）。CovidDEER の「生成文より元の文を見よ」という勧めは、生成した関係名を補助表示にとどめ、根拠を主表示にする UI 方針を裏づける。

### Gaps
- 「エッジを開いたときにだけ関係を生成する」方式の利用者評価や、キャッシュ戦略を扱った論文・製品文書は見つからなかった。
- LazyGraphRAG の独立した再現評価としては GraphRAG-Bench の数値（Q1、Q6）があるが、ローカル小型 LLM での評価は見つからなかった。

---

## Q6. 2025〜2026 年の研究: グラフ構造が検索に効くのはどんなときか、プレーンなベクトル検索・ハイブリッド検索との比較

### Takeaway
2025〜2026 年の体系的比較（ICLR 2026 の GraphRAG-Bench、RAG vs GraphRAG の v3（2026-03）、2026-04 の RAGSearch、統一フレームワーク分析の v2（2026-04））の結論はおおむね一致している。単一ホップの事実検索では、rerank つきのベクトル RAG が GraphRAG と同等以上である。グラフが効くのはマルチホップ推論・文脈要約・多数概念の統合で、効果はグラフの密度と「元のチャンクを残すか」に強く依存する。agentic な多段検索は dense RAG と GraphRAG の差を縮める。一方、グラフは文書間をつなぐ構造として、関連文書の提示や閲覧には検索精度とは別の価値がある（この点を検索ベンチマークは測っていない）。

横断的な補足として、relation-free の手法を日本語に移すには、英語用の NER や名詞句抽出器（spaCy の英語モデル、NLTK）を日本語用（GiNZA / SudachiPy）に差し替えるのが前提になる。増分更新はグラフの種類で難しさが違う。二部グラフと PPR はクエリ時に計算するので追記しやすい。コミュニティ（Louvain）や BERTopic は再計算が必要になる。

### Cited Findings
- GraphRAG-Bench（「When to use Graphs in RAG」arXiv 2506.05690、v3 2026-02、ICLR 2026）: 冒頭で「GraphRAG frequently underperforms vanilla RAG on many real-world tasks」という先行報告を踏まえ、どの場面でグラフが効くかを問う — [ICLR 2026 poster](https://iclr.cc/virtual/2026/poster/10007992); [arXiv HTML](https://arxiv.org/html/2506.05690v3)
- 同ベンチの生成精度（GPT-4o-mini、Novel）: Fact Retrieval は RAG（rerank）60.92 に対し MS-GraphRAG 49.29、HippoRAG 52.93、HippoRAG2 60.14。Complex Reasoning は RAG 42.93 に対し MS-GraphRAG 50.93、HippoRAG2 53.38。Contextual Summarize は RAG 51.30 に対し MS-GraphRAG 64.4、HippoRAG2 64.10。検索の証拠再現率は、fact retrieval で RAG（rerank）83.21、HippoRAG2 70.29。complex reasoning では HippoRAG 87.91、RAG 64.47 — [GraphRAG-Bench HTML](https://arxiv.org/html/2506.05690v3)
- 同ベンチの検索時プロンプト長（平均トークン、Novel）: vanilla RAG 879、HippoRAG2 1,008、RAPTOR 3,441、HippoRAG 7,208、MS-GraphRAG local 38,707、LightRAG 100,832、MS-GraphRAG global 331,375（本文と表に不整合があると取得ツールが指摘している）。著者の指針は、単純な事実検索には basic RAG、複雑な推論・要約・多概念の統合には GraphRAG。密なグラフ（HippoRAG2）が最良だが構築コストが高い — [GraphRAG-Bench HTML](https://arxiv.org/html/2506.05690v3)
- RAG vs GraphRAG（arXiv 2502.11371、v3 2026-03）: RAG は単一ホップと細部を要する質問に強く、GraphRAG はマルチホップと推論集約型に強い。要約では、RAG は細部を、GraphRAG は多面的な内容を拾う。local search と global search のどちらを使うかで結果が大きく変わる。両者を適応的に選ぶか統合するハイブリッド（Selection / Integration）が一貫して改善し、効率とのトレードオフがある — [arXiv 2502.11371](https://arxiv.org/abs/2502.11371)
- Do We Still Need GraphRAG?（RAGSearch、arXiv 2604.09666、2026-04）: agentic search は dense RAG を大きく改善し、特に RL ベースで GraphRAG との差を縮める。GraphRAG は複雑なマルチホップ推論で依然有利で、オフラインのコストを償却できれば agentic search の挙動がより安定する（abstract のみ確認、具体値は未取得） — [arXiv 2604.09666](https://arxiv.org/abs/2604.09666)
- 統一フレームワーク分析（arXiv 2503.04338 v2、2026-04 改訂）: 元のチャンクを保持することが重要で、グラフ構造だけに頼る手法（G-retriever、ToG、DALK）は多くのデータセットで振るわない。G-retriever は Quality で Zeroshot より精度が 14.17% 下がった。グラフ構築のトークンコストは Passage Graph（0）< Tree < KG < Textual KG < Rich KG の順で、Rich KG は Tree の最大 40 倍。抽象 QA では MS-GraphRAG global が首位だが、MultihopSum では VanillaRAG の 57 倍の時間と 210 倍のトークンを使う（1 クエリ約 9 分、30 万トークン） — [In-depth Analysis HTML](https://arxiv.org/html/2503.04338v2)
- HippoRAG 2（ICML 2025）: NV-Embed-v2 に QA F1 平均で 57.0 → 59.8。構造拡張型の中で単純 QA（NQ）でも dense を下回らなかったのは HippoRAG 2 だけ — [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2)
- LinearRAG（ICLR 2026）: Medical では vanilla top-5（61.68）に対し LinearRAG 63.72、HippoRAG2 60.77、LightRAG 54.36、RAPTOR 55.75。relation-free グラフは vanilla を上回ったが、HippoRAG2、LightRAG（どちらも関係を抽出する）と RAPTOR（木構造）は vanilla を下回った — [LinearRAG HTML](https://arxiv.org/html/2510.10114v4)
- SAP（2025-07）: 企業ドメインでは、LLM-as-Judge で dense ベクトル 50.80% に対し、依存構造 KG 61.87%、GPT-4o KG 65.83% — [SAP 論文 HTML](https://arxiv.org/html/2507.03226v2)

#### 横断: 日本語対応・増分更新
- GiNZA は spaCy 上の日本語 NLP ライブラリで、トークナイザは SudachiPy、ライセンスは MIT。NER のラベル体系は関根の拡張固有表現階層と拡張 OntoNotes5 で、学習データは GSK2014-A（BCCWJ 版）の一部。`ja_ginza_electra` は遅いがより高精度とされる — [GiNZA GitHub](https://www.github.com/megagonlabs/ginza); [megagon.ai GiNZA](https://megagon.ai/ginza/)
- LinearRAG の NER は `en_core_web_trf` で、日本語対応の記述はない — [LinearRAG GitHub](https://github.com/DEEP-PolyU/LinearRAG)
- FastGraphRAG の既定（NLTK と正規表現）は主に英語向けで、spaCy による別オプションもある — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)
- HippoRAG の MCP サーバは、パッセージの追加（既存は飛ばす）と削除（本文または source_id 指定）に対応している — [HippoRAG GitHub](https://github.com/OSU-NLP-Group/HippoRAG)
- BERTopic の増分更新は `partial_fit`（IncrementalPCA、MiniBatchKMeans、OnlineCountVectorizer）か `merge_models` で行う — [BERTopic docs: Online](https://maartengr.github.io/BERTopic/getting_started/online/online.html)
- GAR のコーパスグラフは 1 パッセージ 32 バイト（k=8）で、構築はパッセージごとの近傍検索 — [GAR (ar5iv)](https://ar5iv.labs.arxiv.org/html/2208.08942)

### Inferences
- 本プロジェクトの用途を当てはめると次のようになる（推論）。
  - チャット・エージェント向けの事実検索と引用: まずハイブリッド（BM25 と e5）＋ rerank を主にする。グラフは補助（PPR による候補拡張、GAR 型のコーパスグラフ再ランク）にとどめる。
  - マルチホップや「この設計に関係する別文書」: relation-free の文書-エンティティ PPR（LinearRAG 型）が、低コストで効果を見込める唯一の現実解。
  - 関連文書の提示と閲覧: 検索ベンチマークの外にある価値なので、根拠が説明できる共起エッジが向く。
  この 3 つのどれにも型付き関係は必要ない。型付き関係が効く可能性があるのは「関係の種類そのものを問う質問」（例: 依存する、置き換える、矛盾する）と、ビューアでの意味的な色分けである。前者は lazy typing（Q5）で、利用者が必要としたときに作れば足りる。
- グラフの価値は「密度」と「元テキストへの戻りやすさ」で決まる（GraphRAG-Bench の平均次数、2503.04338 の chunk 保持、HippoRAG 2 のパッセージノード）。本プロジェクトの現行グラフは文書横断のエッジが 0 なので、検索に効く前提をそもそも満たしていない。

#### 横断: 評価軸別の整理
- 手法ごとに【コスト】【日本語】【増分】【説明】【品質】をまとめると次のとおり（推論。各行の事実は上の出典による）。
  - 文書-エンティティ二部グラフと PPR（LinearRAG 型）: 【コスト】LLM 0、NER と疎行列演算だけ。【日本語】GiNZA への差し替えが必要で、技術用語・コード識別子・製品名の取りこぼしが課題になる。【増分】行と列を追記するだけで、PPR はクエリ時に計算。【説明】共有エンティティと出現文（バイト範囲）で完全に説明できる。【品質】英語のマルチホップでは HippoRAG2 以上。
  - キーワード-チャンク二部グラフ（KET-RAG の Keyword 側）: 【コスト】LLM 0（分かち書きとストップワード除去、または TF-IDF）。【日本語】形態素解析器があればそのまま使える。【増分】容易。【説明】共有キーワードと出現文で説明できる。【品質】ベクトル単体より大幅に良い（MuSiQue の Coverage +92%）が、EM はスケルトン KG に劣る場合がある。
  - 共起グラフと NPMI（LazyGraphRAG / FastGraphRAG 型）: 【コスト】LLM 0。【日本語】名詞句抽出器を日本語用に替える必要がある。【増分】頻度表を更新し NPMI を再計算する（安い）。コミュニティを使うなら再計算が要る。【説明】共起文と NPMI 値で説明できる。【品質】GraphRAG-Bench では、推論・要約で RAG を上回る場合と下回る場合がある。
  - 埋め込み kNN（GAR 型）: 【コスト】埋め込みは既存のものを使える。【日本語】e5 が対応済み。【増分】新しい断片の近傍だけを計算し、既存ノードの近傍リストを差分で更新する。【説明】弱く、最も近い断片ペアの提示にとどまる。【品質】再ランクで nDCG 最大 +8%（英語、2022 年）。
  - BERTopic: 【コスト】低い（UMAP / HDBSCAN、c-TF-IDF）。【日本語】tokenizer 必須。【増分】制約あり。【説明】トピック語だけで、エッジ単位の説明はできない。【品質】ナビゲーション用で、検索の品質指標はない。

### Gaps
- 日本語コーパス、個人ノート規模（数百〜数千文書）、小型ローカル LLM という条件で GraphRAG と vanilla RAG を比べた 2025〜2026 年の研究は見つからなかった。
- RAGSearch（2604.09666）の具体的な数値と比較対象手法は取得できなかった。
- 「関連文書の発見・閲覧」を明示的なタスクとして評価した GraphRAG 系ベンチマークは見つからなかった（既存のベンチマークはどれも QA か要約）。
- GiNZA の NER が、技術ノート（コード識別子、英字の製品名、日英混在）で何件取れるかの評価は見つからなかった。日本語の名詞句ベース共起グラフを RAG で評価した研究も見つからなかった。
- LinearRAG の行列構造に対する増分更新（文書の追加・削除）が公式に想定されているかは、README からは確認できなかった。
