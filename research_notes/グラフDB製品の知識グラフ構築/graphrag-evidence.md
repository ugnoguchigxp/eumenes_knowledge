# LLM で作る文書知識グラフ（GraphRAG）の効果と、抽出品質のモデル規模依存（2026-11-10 時点）

前提: 既存報告 `reports/LLM推論に頼らない知識グラフ.md`（以下「既存報告」）が確立した内容（LinearRAG、RAGSearch の +0.47/+27.23 と構築費用、MiniRAG の 56.90→35.42、KET-RAG、HippoRAG 2 論文での LightRAG F1 6.6、Fidelity Before Structure、LazyGraphRAG の MSR ブログ、GLiREL・GLiNER-Relex、Constraint Tax、Sub-Billion Super-Frontier、Gopal et al.、GraphRAG-Bench の事実検索 60.92 対 49.29 と複雑推論 53.38 対 42.93）は繰り返さない。本ノートは追加と訂正だけを書く。日付は各結果の arXiv 版や公開日。

## Q1. GraphRAG と素の RAG の系統的比較: どの課題で効き、どの課題で損をし、差はどれだけか

### Takeaway
2026 年の独立評価は一致して、**単一事実と詳細を問う質問では素の RAG が勝ちか互角、多段・比較・時系列・要約ではグラフが勝つ**としている。ただし、Han et al. の最新版（2026-11-07）では、**RAG に GraphRAG と同じ量の文脈 token を与えると差がほぼ消える**（71.01 対 71.17）。三つ組だけを渡す KG 型は全課題で RAG に大きく負ける。エージェント型の検索とモデルの大型化でも、グラフの上積みは縮む。

### Cited Findings
**RAG vs. GraphRAG: A Systematic Evaluation and Key Insights（Han et al.、v1 2025-02-17、v4 2026-11-07）**
- 設定: 生成は Llama-3.1-8B/70B-Instruct、グラフ抽出は GPT-4o-mini（付録で GPT-4o）、約 256 token の断片、ada-002 の埋め込み、top-k=10。比較対象は KG-GraphRAG（三つ組のみ / 三つ組＋本文、LlamaIndex 実装）、Community-GraphRAG（Microsoft の Local/Global）、HippoRAG2、RAPTOR。LightRAG は含まない — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4), [abs](https://arxiv.org/abs/2502.11371)
- QA（Llama-3.1-8B）: NQ の F1 は RAG **64.78**、HippoRAG2 61.03、Community-Local 63.01、Community-Global 54.48、KG（三つ組＋本文）50.27、KG（三つ組のみ）**34.28**。HotpotQA の F1 は RAG 60.04、HippoRAG2 **63.01**、Local 61.66、KG（三つ組のみ）25.02。MultiHop-RAG の Acc は RAG 67.02、HippoRAG2 **70.27**、Local 69.01。NovelQA の平均は RAG **57.12**、HippoRAG2 56.54、Global 39.17 — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- MultiHop-RAG の種類別: Temporal は RAG **30.70** に対し Local 50.60、Global 53.34、HippoRAG2 49.91。Comparison は RAG 57.59 に対し Global 64.02。Inference は RAG 92.16 で最高。答えのない Null 質問では RAG **96.01**、Global **19.27**、Local 80.07、HippoRAG2 85.71 で、グラフの要約文脈では「答えがない」と言えずに作話しやすい — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 抽出の取りこぼし: 答えに関わる実体のうち、構築した KG に入っていたのは HotpotQA で **65.8%**、NQ で **65.5%** だけ。検索精度（HotpotQA/NQ）は RAG 88.60/86.70、KG（三つ組のみ）39.20/32.18 — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- **token を揃えた対照**: MultiHop-RAG（70B 生成）で、Community-GraphRAG は 9,770 token、RAG は 3,631 token を取得していた。RAG の取得量を揃えると、RAG は 65.77 から **71.01** に上がり、GraphRAG の **71.17** とほぼ並ぶ — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 混成: 質問ごとに RAG とグラフを選ぶ Selection は最良の単体比 **+1.1%**、両方の文脈を連結する Integration は **+6.4%**（MultiHop-RAG、70B）。要約（ROUGE-2）では Integration は RAG とほぼ同じ — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 要約の LLM 判定の順序バイアス: QMSum の網羅性で、GPT-4o 判定の GraphRAG-Local の勝率は、先に提示すると **0.97**、後に提示すると **0.12**。GPT-5.4 でもバイアスは減るが消えない。両方の順序の平均を取るよう勧めている。MS GraphRAG 論文系の「要約で勝つ」という主張の割り引きにつながる — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 追加評価（v4）: LongBench-v2 の Multi-Document で HippoRAG2 40.3 対 RAG 35.1、LoCoMo で 0.5248 対 0.5114。ただし総 token は LongBench-v2 で RAG 32.9M に対し HippoRAG2 **220.6M** — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)

**When to use Graphs in RAG / GraphRAG-Bench（Xiang et al.、ICLR 2026、v3 2026-02-22）の既存報告にない数値**
- Medical データの ACC（生成は GPT-4o-mini）: 事実検索は RAG＋再順位付け 64.73 対 HippoRAG2 66.28、複雑推論は 58.64 対 61.98、文脈要約は 65.75 対 Fast-GraphRAG 67.88、創作は 60.61 対 HippoRAG2 68.05。Novel の文脈要約では MS-GraphRAG 64.40 対 RAG 51.30 — [arXiv HTML](https://arxiv.org/html/2506.05690)
- 1 問あたりの文脈 token: 素の RAG 879、HippoRAG2 1,008、RAPTOR 3,441、Fast-GraphRAG 4,204、HippoRAG 7,208、MS-GraphRAG local **38,707**、LightRAG **100,832**、MS-GraphRAG global **331,375**（Novel） — [arXiv HTML](https://arxiv.org/html/2506.05690)
- グラフの平均次数（Novel）: MS-GraphRAG 1.48、HippoRAG 1.73、LightRAG 2.10、Fast-GraphRAG 3.19、HippoRAG2 **8.75**。著者は「関係が多いほど良いわけではない」と書く。成績が良い手法ほど密なグラフを持っていた — [arXiv HTML](https://arxiv.org/html/2506.05690)
- コーパスの規模: 素の RAG の複雑推論は、小さいコーパスの 58.64% から大きいコーパスの **43.20%** に落ち、HippoRAG2 は安定していた。著者は「類似度は高いが無関係な雑音」が原因だと推測しているが、検証はしていない — [arXiv HTML](https://arxiv.org/html/2506.05690)
- 本文と表の不一致: 創作の忠実性の最高値を、本文は RAPTOR の 70.9% とし、表は HippoRAG の 71.53 としている — [arXiv HTML](https://arxiv.org/html/2506.05690)

**エージェント型の検索（RAGSearch、2026-04-01）の既存報告にない部分**
- 生成は Qwen2.5 の 3B/7B（RL で学習した Search-R1・Graph-R1）と 7B/32B（学習なしの Search-o1・GraphSearch）。グラフは GPT-4o-mini で構築 — [arXiv HTML](https://arxiv.org/html/2604.09666v1)
- RL エージェントでは、3B から 7B にすると GraphRAG と密検索の差が平均 **14.70 から 9.75** に縮む。学習なしのエージェントでは 7B から 32B で **7.80 から 7.19**。GraphSearch では多段の差が 27.23 から 26.59 になる。効果はエージェントの設計に依存し、Search-o1 では一定しない — [arXiv HTML](https://arxiv.org/html/2604.09666v1)
- 安定性: HotpotQA での Search-o1 のばらつきは、密検索で ±1.03、HippoRAG2 で ±0.22 — [arXiv HTML](https://arxiv.org/html/2604.09666v1)
- 結論として著者は、一般の QA では密 RAG が実用的で、グラフは複雑な多段推論で優位が残る、としている — [arXiv HTML](https://arxiv.org/html/2604.09666v1)

**その他**
- Is GraphRAG Needed?（2026-06-24、ACL 2026 GEM Workshop）: 半構造の知識ベースで、RAG・GraphRAG・Modular・Agentic の 9 つの場面を比べた。検索を広げても生成の質は比例して上がらない「retrieval-generation gap」を指摘し、検索指標は高度な検索の利得を過大評価しうるとした。文脈の工夫で token を 19〜53% 削減。手法ごとの数値は取得できなかった — [arXiv abs](https://arxiv.org/abs/2606.25656v1)
- Microsoft の BenchmarkQED（2025-06-05、Microsoft 自身の評価）: AP News の健康記事 1,397 本、AutoQ が作った 4 種類×50 問＝200 問、判定は GPT-4.1 で各問 6 回。LazyGraphRAG（関連判定は GPT-4o mini、展開と回答は GPT-4o）は、8k・120k・1M token 文脈のベクトル RAG と LightRAG・RAPTOR・TREX に対し、**96 の比較すべてで勝ち**、有意でなかったのは 1 つだけ。勝率の数値は図にしかない。既存報告が引いた MSR ブログ（AP 5,590 本・100 問）の後の評価にあたる — [MSR blog](https://www.microsoft.com/en-us/research/blog/benchmarkqed-automated-benchmarking-of-rag-systems/)
- 日本の実務記事（NTT データ）は、文書全体にまたがる質問では GraphRAG が上回り、特定の箇所で答えられる質問では従来の RAG で十分だった、としている（定性的な報告。数値は未確認） — [NTT DATA](https://www.nttdata.com/jp/ja/trends/data-insight/2024/1108/)

### Inferences
- Han et al. の token を揃えた対照は、GraphRAG の上積みの一部が「グラフの構造」ではなく「LLM に渡す文脈の量」によることを示す。素の RAG の k を増やすか、近傍を足すだけの安い比較対象を必ず置くべきである。
- 用途（エージェントによる知識の再利用）で多いのは、「この設計判断は何か」「この API はどう決めたか」のような単一事実・詳細の質問だと考えられる。そこではどのベンチでも RAG が互角以上である。グラフが勝つのは多段・時系列・比較・全体の要約であり、設計メモでは「経緯」や「変更の時系列」がこれに当たる。
- 呼び出し側のエージェントが強いモデルで反復検索するなら、RAGSearch の結果からグラフの上積みはさらに小さくなる見込みである。
- 三つ組だけを文脈に渡す KG 型は、全課題で RAG に負ける。グラフを使う場合でも、最終の文脈は原文の断片にするべきである（既存報告の結論と同じ方向）。

### Gaps
- 社内の設計メモや技術文書のような「中規模（数百文書）・領域固有・日本語」のコーパスで、GraphRAG と RAG を比べた査読付きの評価は見つからなかった。
- Is GraphRAG Needed? の手法ごとの数値と、BenchmarkQED の勝率の数値は、本文や図から取得できなかった。
- 関連文書の推薦や閲覧を課題としたグラフ RAG の評価は、今回も見つからなかった。

## Q2. GraphRAG 各方式の索引費用と、安い索引で利得がどれだけ残るか

### Takeaway
同じ 56k token の本 1 冊で比べると、LLM 抽出型の索引は、コーパスの **3〜12 倍の LLM token** を使う（MS-GraphRAG 65.5 万、LightRAG 47.4 万、HippoRAG2 33.0 万）。精度で上位の HippoRAG2 は、LightRAG・MS-GraphRAG より索引が安く、問い合わせ時の文脈も素の RAG 並みである。一方で、抽出器を GPT-4o-mini から GPT-4o に替えると +3.9 点上がり、抽出の質は効く。

### Cited Findings
- GraphRAG-Bench 付録 G.3（2026-02-22）、Novel の本 1 冊（約 56k token）の索引: MS-GraphRAG 292.45 秒・総 **654,673** token（入力 535,832・出力 118,841）、LightRAG **710.32 秒**・474,172、KET-RAG 350.43 秒・517,551、LazyGraphRAG 253.59 秒・591,150、HippoRAG2 96.71 秒・**329,993**、Fast-GraphRAG 281.74 秒・251,817、HippoRAG 77.42 秒・177,961、RAPTOR 135.21 秒・115,541、KGP 32.01 秒・89,215 — [arXiv HTML](https://arxiv.org/html/2506.05690)
- Han et al.（v4、2026-11-07）、MultiHop-RAG の構築時間: RAG 135 秒、Community-GraphRAG 5,560 秒、KG-GraphRAG 7,702 秒。検索時間は RAG 1,724 秒、KG-GraphRAG 14,434 秒、Community 1,249 秒 — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 抽出器の強さ: MultiHop-RAG（生成は 70B）で、RAG 65.77、GPT-4o-mini で作ったグラフ 71.17、GPT-4o で作ったグラフ **75.08**。Temporal は 25.73、49.06、58.49 — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 日本語の個人の実測（Qiita、2026-06-11）: 約 1 万件・約 800 万 token の日本語文書（技術メモと設計文書 6,200 ファイルを含む）。索引はベクトル RAG が約 12 分・$3.20、LightRAG が約 2 時間・$42.80・LLM 呼び出し 1,800 回、MS GraphRAG が約 8 時間・$184.50・7,200 回。使った LLM は明記されていない — [Qiita](https://qiita.com/kenimo49/items/2ca9ed99889bf9ebe4e2)
- 小型の専用抽出器: RAGU（2026-07-13）は 7B の Meno-Lite-0.1 を抽出に使い、KG 構築で Qwen2.5-32B を調和平均で相対 +12.5% 上回り、英語の GraphRAG 課題でも並んだとする。抽出と統合を分け、二段の型付き抽出、DBSCAN による重複除去、Leiden を使う。索引費用は記載がない — [arXiv abs](https://arxiv.org/abs/2607.11683)
- 安い索引の例（既存報告の補足）: LLM を使わない LinearRAG や、キーワードの二部グラフについては既存報告を参照。GraphRAG-Bench は LazyGraphRAG に 59 万 token を計上しており、「索引に LLM を使わない」という Microsoft の説明と食い違う。この点も既存報告が指摘済み — [arXiv HTML](https://arxiv.org/html/2506.05690)

### Inferences
- チームの実測（60 KB で約 2 時間）をそのまま延ばすと、400 本の設計メモ（1 本 3〜5 KB と仮定すると 1.2〜2 MB）では **40〜65 時間**になる（推測。文書の大きさは未確認）。版の更新のたびに抽出し直すなら、運用は成り立たない。
- 費用あたりの精度で一番効率がよいのは、HippoRAG2 型（OpenIE の三つ組と PPR、文脈は原文の段落）である。高いのは、要約を作る MS-GraphRAG の Global と LightRAG。ただし HippoRAG2 も、抽出には GPT-4o-mini 級か 70B 級のモデルを前提にしている。
- 「安い索引で利得がどれだけ残るか」を直接測った結果は、既存報告の LinearRAG（LLM token 0 で HippoRAG2 を上回る）と、Han et al. の token を揃えた対照（RAG の k を増やすだけで追いつく）の 2 つである。どちらも、高価な LLM 抽出の利得の大半は、安い代替で取れることを示唆している。

### Gaps
- Qiita の日本語の比較は、LLM の名前、採点の方法（著者 1 人が 0〜3 で主観採点）、質問の作り方がはっきりせず、数値がきれいすぎる点でも、強い根拠にはならない。
- ローカルの小さいモデルで、索引の時間と品質を GPT-4o-mini と並べて測った公開評価は見つからなかった。

## Q3. 抽出品質のモデル規模依存と失敗の型（関係名の爆発、スキーマの逸脱、作られた辺）

### Takeaway
「関係名の数が辺の数とほぼ同じになる」現象は、Microsoft GraphRAG の既定の抽出器でも報告されている（**981 辺に関係型 966**）。チームの「600 言及に 597 関係名」は、モデルが弱いせいではなく、正規化の段がない自由文抽出の典型的な挙動である。小さいモデルでは、7B 未満で構造化出力そのものが壊れる。8B 前後でも、精度は高いのに再現率が低い、文書レベルの関係 F1 が教師ありの半分以下、という結果が並ぶ。また、GraphRAG-Bench の「7B が下限」は、索引を GPT-4o-mini で作ったうえでの**生成側の**結果であり、抽出の規模依存を示すものではない（既存報告の記述の訂正）。

### Cited Findings
**関係名の爆発と疎なグラフ**
- KGGen（v2 2025-11-06）: 100 万文字のコーパスで、MS GraphRAG の抽出器は実体 514、辺 981 に対し**関係型 966**で、関係の再利用がほとんどない。グラフも疎で、記事全体から取れる実体と辺が少なすぎ、重要な関係を落とす。OpenIE は「it」「are」のような汎用のノードを作り、無関係な概念の間に偽の近道を作る。著者は原因を、実体と関係の解決の段がないことに帰している — [arXiv HTML](https://arxiv.org/html/2502.09956)
- KGGen の対策: S-BERT で埋め込み、k-means で 128 件ずつの塊に分け、BM25 と意味の近さの上位 16 件の中から LLM に重複（時制、単複、大文字小文字、略語）を判定させて代表名を選ぶ。これを繰り返す。100 万文字で、実体は 0.776 倍、辺は 0.770 倍に縮む — [arXiv HTML](https://arxiv.org/html/2502.09956)
- KGGen の MINE-1（100 記事×15 事実の保持率）: KGGen 66.07%、GraphRAG 47.80%、OpenIE 29.84%。モデル別では、Claude Sonnet 3.5 が 73%、GPT-4o が 66%、Gemini 2.0 Flash が 44%。ランダムに選んだ 100 個の三つ組の妥当性は KGGen 98%、OpenIE 55%、GraphRAG 0% と報告されているが、0% は判定基準の違いを疑わせる値である。関係の再利用の回数も、本文と図の説明が食い違う — [arXiv HTML](https://arxiv.org/html/2502.09956)
- EDC（Extract-Define-Canonicalize、EMNLP 2024）: 自由な抽出のあとで、スキーマを定義し、事後に正規化する 3 段の枠組み。スキーマが大きすぎてプロンプトに入らない問題を、検索器で関係する要素だけを選んで解く。関係の型の数の削減量は abs からは取れなかった — [arXiv abs](https://arxiv.org/abs/2404.03868)

**ローカルの小型モデルで GraphRAG を回した結果**
- GraphRAG on Consumer Hardware（2026-05-20）: Microsoft GraphRAG を、8 GB VRAM の GPU 1 枚で Ollama を通して回した。モデルは Llama 3.1 8B、Mistral 7B、Qwen 2.5 7B、Phi-4-mini 3.8B。**Phi-4-mini は構造化出力の誤りでパイプラインを完了できず**、Mistral は退化した繰り返しを出した。著者は「約 7B 未満は有効な構造化出力を安定して出せない」としている。最も大きいグラフ（実体 1,172）を作ったのは Llama 3.1 だが、回答の質が最良だったのは Qwen 2.5（3.3/5）で、索引の豊かさと回答の質は一致しなかった。ベクトル RAG やクラウドのモデルとの比較はない — [arXiv abs](https://arxiv.org/abs/2605.20815)
- 個人 KG の三つ組抽出（2026-04-18、LLM-Text2KG'26）: ReDial の会話文で、5-shot。Qwen3 は 0.6B→1.7B→4B→8B と大きくなるほど precision が 0.818→0.887→0.948→0.953 と上がる一方、recall は **0.229→0.126→0.098→0.092** と下がり、F1 は 0.358→0.168 と**下がった**。Gemma-3 は 1B/4B/12B で F1 0.622/0.618/0.662。10-shot では、すべてのモデルで recall が 0.01 未満に崩れた。下流の推薦では、Gemma-3 1B の抽出のほうが 4B や 12B の抽出より良い土台になった — [arXiv HTML](https://arxiv.org/html/2607.00003)
- GraphRAG-Bench 付録 G.4 の規模の調査（2026-02-22）: 著者は「the same pre-constructed index (generated by GPT-4o-mini) … across all model sizes」と書いており、変えたのは生成のモデルだけである。Medical の平均 ACC は、Qwen2.5-3B で GraphRAG 57.08 対 RAG 56.13、7B で 61.50 対 56.79、14B で 63.91 対 59.10。付録の本文は 7B の GraphRAG を 57.59 と書いており、表と食い違う — [arXiv HTML](https://arxiv.org/html/2506.05690)
- 抽出器の強さの効果（Han et al.、v4）: GPT-4o-mini を GPT-4o に替えると、MultiHop-RAG で 71.17 から 75.08、時系列の質問で 49.06 から 58.49 に上がる — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)

**スキーマを固定した抽出と、評価の落とし穴**
- Ilves et al.（KaLLM 2026 @ LREC 2026、2026 年 5 月）: 実体の型 6、関係の型 96 の閉じたオントロジーで、Gemini 3 Pro、GPT-5.1、Claude Opus 4.5、Mistral 7B を DocRED で評価した。人手で見直すと、自動の三つ組 F1 は抽出の質を系統的に過小評価していた。正解の注釈が不完全で、原文に照らして正しい三つ組の多くが正解集合にないためである — [ACL Anthology](https://aclanthology.org/2026.kallm-1.21/)。検索結果の抜粋では、Mistral 7B は実体の抽出はそこそこでも、三つ組では **4.2%** まで大きく落ちたとされる。ただし本文の表は読めず、この値は確認できていない — [PDF](https://aclanthology.org/2026.kallm-1.21.pdf)
- 小さいモデルの蒸留: SynthKG（v1 2024-10-22、v2 2026-03-01）は、合成した文書と KG の組で小型モデルを微調整した Distill-SynthKG が、8 倍までの大きいモデルを含む全基準を KG の質で上回るとする。abs には数値もモデル名もない — [arXiv abs](https://arxiv.org/abs/2410.16597)
- 弱い抽出器への前処理（2026-04-03）: Qwen3-32B から蒸留した Qwen3-0.6B の「命題化器」で文を原子命題に分けると、GLiREL や 0.6B の生成モデルのような弱い抽出器では関係の再現率が上がる。強い LLM では実体の再現率が落ちるので、フォールバックで補う。abs に数値はない — [arXiv abs](https://arxiv.org/abs/2604.02866)
- ローカル LLM の比較記事（Medium の会員限定記事、未検証）: 4 つの 7〜8B モデルで実体 F1 は 0.78〜0.91 に収まったが、関係の質のばらつきは大きく、Mistral 7B は形式の適合率 100% でも三つ組 F1 は最低の 0.564 だった、と検索結果の抜粋にある — [Medium](https://medium.com/graph-praxis/building-knowledge-graphs-with-local-llms-from-benchmarking-to-fine-tuning-ed572268aa3f)

### Inferences
- チームの「597/600」と「文書横断 0 本」は、KGGen が MS GraphRAG で見た「966/981」と「疎なグラフ」と同じ型である。関係名の爆発は大きいモデルでも起きる。直すには、正規化と統合の段（KGGen の反復クラスタリング、EDC の事後正規化、固定スキーマ）が要る。モデルを大きくするだけでは直らない。
- 小さいモデルの抽出は、「大きいほど良い」とは限らない。同じ系列でも、規模を上げると慎重になって recall が落ちることがある（Qwen3）。抽出の F1 と下流の効用も一致しない（Consumer Hardware、個人 KG）。モデルを選ぶときは、下流の検索課題で比べる必要がある。
- 既存報告にある「GraphRAG-Bench は 7B 前後が実用の下限としている」という記述は、生成側の話として読むべきである。ローカルの小型モデルで「抽出」が成り立つ下限についての根拠は、Consumer Hardware の「約 7B 未満は構造化出力が壊れる」の 1 本だけである。
- 自動の三つ組 F1 は、正解集合が不完全なため小さく出る。手元で評価するなら、人が抽出結果を判定する（precision 側を見る）形がよい。

### Gaps
- 1〜14B のモデルで、同じ文書群・同じ指示から作った KG を、関係型の数・重複率・文書横断の辺の数で比べた研究は見つからなかった。
- Triplex（SciPhi、Phi-3 3.8B の微調整）の品質の主張は、ベンダーの自己申告以外に独立の評価が見つからなかった。
- KaLLM 2026 の 4 モデルの実体・三つ組 F1 の表は、PDF を読めず取得できなかった。
- 作られた辺（原文にない関係）の発生率を、モデルの規模別に測った研究は見つからなかった。

## Q4. 日本語（と英語以外）での KG 構築や GraphRAG の評価

### Takeaway
日本語の **GraphRAG の公開ベンチマークは見つからなかった**。日本語の文書レベル関係抽出（JacRED、2024）では、GPT-4 の in-context の関係 F1 は **27.45** で、教師ありの 68.73 の半分以下だった。英語から日本語への言語横断の転移も、F1 77 から 45 に落ちる。日本語での実務の比較はブログ記事が中心で、厳密さに欠ける。

### Cited Findings
- JacRED（Ma, Wang, Okazaki、arXiv 2024-04-25、LREC-COLING 2024）: Re-DocRED を元にした日本語の文書レベル関係抽出のデータセットで、関係の型は 35。テストセットの関係 F1 は GPT-3.5（gpt-3.5-turbo-instruct）**13.17**、GPT-4 **27.45**（文書と関係の例 1 組を与えた設定）。教師ありは ATLOP 68.04、DREEAM **68.73** — [arXiv HTML](https://arxiv.org/html/2404.16506v1), [ACL Anthology](https://aclanthology.org/2024.lrec-main.232.pdf)
- 同論文の言語横断の転移（mBERT）: 英語から日本語では、DREEAM が元の英語で 77.22、日本語で **45.29**。日本語から英語では 65.90 から 52.45。Re-DocRED を機械翻訳した日本語データで学習すると F1 54.87、JacRED では 68.73 — [arXiv HTML](https://arxiv.org/html/2404.16506v1)
- NLP2026 C6-16「グラフベースRAGの知識構造化に関するモジュール別検討」（理研・京大ほか、2026 年 3 月）: 文書集合から実体間の関係を抽出するモジュールが QA 性能の主なボトルネックであり、KG を中程度の粒度でコミュニティに分けると検索と多段推論が改善したと報告している。データの言語とモデルは参加報告からは分からない — [HACK The Nikkei](https://hack.nikkei.com/blog/nlp2026/)
- JSAI 2025「ナレッジグラフの構築による専門知の構造化と評価」: 章立てのある技術文書で「章をノード、親子関係を辺」にする GraphRAG-hierarchy を提案し、LLM への入力 token を Hybrid-RAG の約 1/10 に抑えつつ一部の質問で良い回答を得た、とされる。具体性では Hybrid-RAG に劣った。実験は OpenAI のモデルで、ローカル LLM は今後の課題とされている。ただし PDF は読めず、これは検索結果の要約からの記述である — [J-STAGE PDF](https://www.jstage.jst.go.jp/article/pjsai/JSAI2025/0/JSAI2025_3P4OS46b03/_pdf/-char/ja)
- Qiita（2026-06-11）の日本語約 1 万件の比較: 250 問（5 種類×50 問）で、正解率はベクトル RAG・LightRAG・GraphRAG の順に、単一事実 86/78/72、比較 64/76/84、俯瞰 38/64/88、集約 22/58/80、多段 26/52/78。運用の体験として、「Claude Code」の表記ゆれが 7 種類あったこと、GPT-4o-mini や Haiku ではエンティティ抽出の品質が落ちて Leiden のクラスタリングが崩れたことを挙げる。後者に比較のデータはない。採点は著者 1 人の主観で、使った LLM も不明 — [Qiita](https://qiita.com/kenimo49/items/2ca9ed99889bf9ebe4e2)
- 英語以外の多言語の命題化と関係抽出（欧州 6 言語）では、弱い抽出器で多言語の全体精度が上がったとされる。日本語は含まない — [arXiv abs](https://arxiv.org/abs/2604.02866)

### Inferences
- 日本語の文書レベル関係抽出は、GPT-4 でも F1 約 27 である。ローカルの小型モデルの自由文抽出が、日本語の設計メモから使える関係を作れると期待する根拠はない。
- JSAI 2025 の「章の階層をグラフにする」方式は、Markdown の見出し構造を辺にする既存報告の第 1 層と同じ発想で、日本語の技術文書で token を減らせた唯一の手掛かりである（ただし二次情報）。
- Qiita の結果（俯瞰・集約で GraphRAG が大差で勝つ）は、ベンチマークの傾向とは方向が合うが、差の大きさは信頼できない。

### Gaps
- 日本語の GraphRAG・HippoRAG・LightRAG を、公開の質問集合で比べた査読付きの評価は見つからなかった。
- JacRED で 7〜14B のオープンモデルを評価した結果は見つからなかった。
- NLP2026 C6-16 と JSAI 2025 の本文（データの言語、モデル、数値）は、PDF を読めず確認できなかった。

## Q5. 「関連はあるが答えを含まない」文脈が LLM の回答を損なう証拠（グラフ近傍の文書を多く読ませる方式への含意）

### Takeaway
検索で上位に来たが答えを含まない文書は、1 本で精度を最大 25% 下げ、18 本では最大 67% 下げる。無作為な文書より有害である。文脈が長くなると、根拠を正しく取り出せていても精度は 14〜85% 落ちる。グラフの近傍は定義上「関連しているが、たいてい答えではない」ので、近傍を多く読ませるほど、この典型的な害を受ける。

### Cited Findings
- The Power of Noise（Cuconasu et al.、SIGIR 2024）: NQ-open で、Llama2-7B の正解文書だけの精度 0.5642 は、検索上位の無関係な文書（distractor）を 1 本足すと **0.4283** に下がる。distractor 18 本では、正解文書の位置が質問の近くで 0.3781、遠くで 0.2348、中央で **0.1795**。著者は、最大で −0.38（−67%）、1 本でも最大 −25% としている。一方で無作為な文書を足すと、精度が上がる場合がある（MPT は 0.2148 から 0.2930、+36%）。abs の「最大 35%」の再現は表からは厳密にはできない — [arXiv HTML](https://arxiv.org/html/2401.14887v4)
- Lost in the Middle（Liu et al.、arXiv 2023-07、TACL）: GPT-3.5-Turbo で 20 文書の QA。答えの文書が先頭なら **75.8%**、中央（10 番目）なら **53.8%**、末尾なら 63.2%。文書なしの closed-book は **56.1%** なので、中央に置くと文書を渡さないより悪い。20 から 50 文書に増やしても、GPT-3.5-Turbo は約 +1.5%、Claude-1.3 は約 +1% にとどまる — [arXiv HTML](https://arxiv.org/html/2307.03172)
- Long-Context LLMs Meet RAG（Jin et al.、arXiv 2024-10-08）: 多くの長文脈 LLM で、取得する段落を増やすと出力の質は最初は上がり、その後下がる。主な原因は、強い検索器が返す「hard negatives」（関連して見えるが答えでない段落）だとし、並べ替えや RAG 向けの微調整を提案している — [arXiv abs](https://arxiv.org/abs/2410.05983)
- Context Length Alone Hurts LLM Performance Despite Perfect Retrieval（Du et al.、arXiv 2025-10）: 5 つの LLM で、数学・QA・コード。入力が長くなると、精度は 13.9〜85% 落ちる。無関係な部分を空白に替えても、マスクしても落ちる。根拠を質問の直前に置いても落ちる。Llama-3.1-8B は 30k token で 1,000 問中 970 問の根拠を正確に暗唱できたのに、MMLU の精度は短い文脈より 24.2% 低かった。対策は、根拠をまず暗唱させてから短い文脈で解かせる「Retrieve then Solve」 — [arXiv HTML](https://arxiv.org/html/2510.05381v1), [検索結果の要約](https://alphaxiv.org/abs/2510.05381)
- Context Rot（Chroma、2025-07-14）: 18 の LLM で、すべての実験で入力長とともに性能が落ちた。distractor は 1 本でも基準より下げ、4 本でさらに下げる。影響は distractor ごとに不均一。LongMemEval では、要点だけの約 300 token の文脈のほうが、約 113k token の全文脈より、すべてのモデルで有意に高かった — [Chroma](https://www.trychroma.com/research/context-rot)
- グラフ RAG 自身での表れ: MS-GraphRAG の global は 1 問 33 万 token、LightRAG は 10 万 token を文脈に入れる（素の RAG は 879）。GraphRAG-Bench の著者は「sudden context explosion」を注意点に挙げ、探索の範囲を区切るよう勧めている — [arXiv HTML](https://arxiv.org/html/2506.05690)。Han et al. では、要約の文脈を使う Community-Global が、答えのない質問で RAG の 96.01 に対し 19.27 しか正しく応答できなかった — [arXiv HTML v4](https://arxiv.org/html/2502.11371v4)
- 「検索を広げても生成は比例して良くならない」という 2026 年の観察もある — [Is GraphRAG Needed?](https://arxiv.org/abs/2606.25656v1)

### Inferences
- チームの共起の辺は、25 組中 3 組しか「深い」と判定されなかった（12%）。グラフの近傍の文書を広げて読ませると、近傍の約 9 割が「関連はあるが答えではない」文脈になる。これは Power of Noise の distractor や Jin et al. の hard negative と同じ性質で、無作為な文書より有害な種類の雑音である（推論）。
- したがって、グラフの近傍は「読ませる文脈」ではなく、「候補を出す経路」として使い、最終的に LLM に渡すのは再順位付けで絞った少数の原文断片にするのがよい。答えの断片は文脈の先頭か末尾に置く。
- 呼び出し側が強いエージェントなら、近傍は「辿れる道具」として出し、どこまで読むかをエージェントに任せるほうが、一度に大量の近傍を渡すより害が小さいと考えられる（推論。直接の比較はない）。

### Gaps
- 「グラフで辿った近傍文書」を distractor として、その害を直接測った研究は見つからなかった。
- 日本語の文脈での distractor の効果や、Lost in the Middle の追試は見つからなかった。
- Context Rot の数値は、本文に集計値がなく図にしかない。
