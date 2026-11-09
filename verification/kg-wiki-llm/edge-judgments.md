# wiki-llm の辺の判定（sudachi-napi、2026-11-09）

判定は Claude。基準: A = 文が 2 つの間の関係を述べている。B = 同じ文で並べて触れているだけ。C = 片方が実体でない（一般語、数式、書誌の行、途中で切れた名前）。
標本は `random.seed(20261109)` で、グラフ API の答えの辺から無作為に取った。

## all（408 本から 20 本）: A 1、B 2、C 17

| # | 辺 | 文書 | 判定 | 根拠の文 |
| --- | --- | --- | --- | --- |
| 1 | 確率 — 確率変数 | 1 | B | 日本産業規格では、「確率変数がある値となる確率，又はある集合に属する確率を与える関数」と定義している。 |
| 2 | 使用 — 訓練 | 1 | C | 2026年現在、ニューラルネットワークのTransformerを使用し、膨大なラベルなしテキストを使用して自己教師あり学習または半教師あり学習によって訓練する手法が主流である。 |
| 3 | Google — CEO | 1 | C | 2人はExciteの最高経営責任者（CEO）ジョージ・ベルを訪問し、Googleを100万ドルで買収するオファーを持ちかけたが、ベルはこのオファーを拒絶した。 |
| 4 | 生成 — 出力 | 2 | C | 次に、LLMはクエリと取得した文書の両方に基づいて出力を生成する。 |
| 5 | 人間 — LLM | 3 | C | 2022年11月30日に同社が発表した生成AIチャットボット「ChatGPT」用として、GPT-3をベースに人間との対話能力向上のためのファインチューニング（追加学習）を行ったモデルであり、ChatGPTリリース当時の基盤となった大規模言語モデル (LLM) である。 |
| 6 | Google — 記事 | 1 | C | 2005年の『ニューヨーク・タイムズ』の記事 ならびに他の媒体においては、Googleが、自社利益の優先に反対する「邪悪になるな（Don't be evil.）」との企業理念を失っていることが示唆された。 |
| 7 | モデル — 利用 | 3 | C | Self-Attention機構（自己注意機構）を利用したモデルである。 |
| 8 | 検索エンジン — ペイジ | 1 | A | ペイジとブリンは、ウェブサイト同士の関係を分析することで検索結果をランクづけする、改良された検索エンジンの理論を提唱した。 |
| 9 | プロンプト — 画像 | 1 | C | 「テキストから画像」へ、あるいは「テキストから音声」へ変換するモデルとコミュニケーションする場合、典型的なプロンプトは、『馬に乗る宇宙飛行士の高品質な写真』や、『有機的なサンプルを使ったLo-Fiなスローテンポのエレクトロ・チル』など、希望する出力の説明である。 |
| 10 | 発表 — OpenAI | 3 | C | OpenAI o3を発表（o2という名称は商標問題で使用せず）。 |
| 11 | 問題 — アルゴリズム | 2 | C | しかし、状態数に応じてうまくスケールする（あるいは状態空間が無限の問題でも対応する）アルゴリズムがないため、単純な探索方法が最も実用的となる。 |
| 12 | OpenAI — 設立 | 3 | C | 1月21日、OpenAI、オラクル、ソフトバンク、MGXが米国政府と連携し、OpenAIのために米国内のAIインフラストラクチャを構築する合同会社Stargate Projectを設立。 |
| 13 | 場合 — 可能性 | 2 | C | 可能性のある各方策について、それに従った場合の収益をサンプリングする |
| 14 | Google — 活用 | 2 | C | 従来の再帰型ニューラルネットワーク（RNN）に代わり、Attentionメカニズムを活用することで大規模データの並列計算が可能となり、OpenAIのGPTやGoogleのBERTに代表される大規模言語モデル（LLM）の急速な発展へとつながった。 |
| 15 | モデル — LLM | 2 | C | 2022年11月30日に同社が発表した生成AIチャットボット「ChatGPT」用として、GPT-3をベースに人間との対話能力向上のためのファインチューニング（追加学習）を行ったモデルであり、ChatGPTリリース当時の基盤となった大規模言語モデル (LLM) である。 |
| 16 | 生成 — LLM | 2 | C | 次に、LLMはクエリと取得した文書の両方に基づいて出力を生成する。 |
| 17 | LLM — 言語モデル | 2 | B | 2023年12月、Googleは、OpenAIのChatGPTで使用される「GPT」と似たようなAIモデルである新しいLLM「Gemini (言語モデル)」を公開した。 |
| 18 | 多く — はじめ | 2 | C | 深層学習は機械学習の殆ど全てを独占する程に大きな影響を与えており、2015年に発表された拡散モデルに代表される生成モデルの多くに組み込まれたほか、2017年に発表されたTransformerをはじめとする大規模言語モデルなどの基盤にもなっている。 |
| 19 | 人間 — 言語モデル | 2 | C | GPT-3は自己回帰型の言語モデルで、ディープラーニング（深層学習）により人間の文章のようなテキストを生成する。 |
| 20 | リリース — Claude | 1 | C | 2022年の夏、Claudeの最初のバージョンのトレーニングを終えたが、社内で追加の安全性テストが必要であることと、AIの開発競争が激化することによるリスクを避けたいと言及し、リリースしなかった。 |

## proper-2docs（432 本から 40 本）: A 13、B 14、C 13

| # | 辺 | 文書 | 判定 | 根拠の文 |
| --- | --- | --- | --- | --- |
| 1 | Pr — max | 1 | C | {\displaystyle \arg \max _{\tilde {Z}}\sum _{i}\log Pr[Y^{i}｜{\tilde {Z}}\ast E(X^{i})]} |
| 2 | Google — OpenAI | 3 | B | 従来の再帰型ニューラルネットワーク（RNN）に代わり、Attentionメカニズムを活用することで大規模データの並列計算が可能となり、OpenAIのGPTやGoogleのBERTに代表される大規模言語モデル（LLM）の急速な発展へとつながった。 |
| 3 | マイクロソフト — NASA | 1 | A | 6月、マイクロソフトがAzure Governmentを通じて、国防総省やNASAといった米国の主要政府機関へのGPT-4の提供を発表。 |
| 4 | OpenAI — Microsoft Azure | 1 | A | 10月、OpenAIのツールが米国防総省とマイクロソフト間の契約により、Microsoft Azureを通じて米アフリカ軍に提供されていたことが調達文書で確認される。 |
| 5 | GPT — Gemini | 1 | A | 2023年12月、Googleは、OpenAIのChatGPTで使用される「GPT」と似たようなAIモデルである新しいLLM「Gemini (言語モデル)」を公開した。 |
| 6 | LLM — Transformer | 2 | B | GPT-3（ジーピーティースリー、Generative Pre-trained Transformer 3）は、OpenAIが開発したGPTシリーズの大規模言語モデル (LLM) 。 |
| 7 | GPT-3 — 米国 | 1 | B | 最初の実験では、米国の80名の被験者に、200語程度の短い記事が人間によって書かれたものか、GPT-3によって書かれたものかを判断するように求められた。 |
| 8 | AI — ChatGPT | 1 | A | 大規模言語モデル（LLM）を用いたAIであるchatGPTが登場したことで機械翻訳は一変した。 |
| 9 | GPT — BERT | 2 | B | 従来の再帰型ニューラルネットワーク（RNN）に代わり、Attentionメカニズムを活用することで大規模データの並列計算が可能となり、OpenAIのGPTやGoogleのBERTに代表される大規模言語モデル（LLM）の急速な発展へとつながった。 |
| 10 | Transformer — Generative Pre-trained | 3 | C | GPT-1（Generative Pre-trained Transformer 1）は、2018年6月11日に発表された言語モデルである。 |
| 11 | マイクロソフト — オープンソース | 1 | B | 同年7月27日、NVIDIAはOpenAIの暴走事故を受けてマイクロソフトやスペースX、パランティア・テクノロジーズなどとオープンソースのAIを活用するサイバー攻撃対策に向けた「Open Secure AI Alliance」を設立した。 |
| 12 | GPT-4 — Generative Pre-trained | 2 | C | 2023年3月14日、Generative Pre-trained Transformer 4（GPT-4）のリリースを発表した。 |
| 13 | text — begin | 2 | C | {\displaystyle L({\hat {y}},y)={\begin{cases}1&{\text{if }}{\hat {y}}\neq y\\0&{\text{otherwise}}\end{cases}}} |
| 14 | 日本 — イギリス | 1 | B | また「日本のプライバシーに対する感覚は、アメリカ、イギリスとでは違うのではないか。 |
| 15 | Google — AI | 1 | A | Google LLC（グーグル）は、情報技術、検索エンジン、オンライン広告及び人工知能（AI）等の事業を行うアメリカの多国籍企業である。 |
| 16 | GLUE — MMLU | 1 | B | たとえば、GLUE、SuperGLUE、MMLU、BIG-bench、HELMなどがある。 |
| 17 | マイクロソフト — Microsoft Azure | 2 | A | 10月、OpenAIのツールが米国防総省とマイクロソフト間の契約により、Microsoft Azureを通じて米アフリカ軍に提供されていたことが調達文書で確認される。 |
| 18 | OpenAI — pre-trained | 1 | C | OpenAIのGPT（generative pre-trained transformer）シリーズの最初のモデルであるGPT-1は、2018年に、985M語で構成されるBookCorpusで訓練された。 |
| 19 | Anthropic — AGI | 1 | A | Anthropic は、責任あるAIの使用を企業理念とし、汎用人工知能（AGI）を研究している。 |
| 20 | 我妻幸長 — 翔泳社 | 1 | C | 我妻幸長：「BERT実践入門」、翔泳社、ISBN 978-4-7981-7781-6 (2023年7月20日). |
| 21 | OpenAI — xAI | 1 | B | 大規模言語モデル（LLM）であるClaudeを公開しており、OpenAIのChatGPT、GoogleのGemini、xAIのGrokと競合している。 |
| 22 | 東京オフィス — アジア初 | 1 | C | 2024年4月15日、サンフランシスコ、ロンドン、ダブリンに続き、世界で4カ所目でアジア初となる東京オフィス（OpenAI Japan）を開設し、日本語向けに最適化したGPT-4カスタムモデルを発表。 |
| 23 | LLM — モンテカルロ木探索 | 1 | A | モンテカルロ木探索では、LLMをロールアウトのためのヒューリスティクスとして使用することができる。 |
| 24 | GPT-3 — オープンソース | 1 | B | 2019年、OpenAIは、このモデルがフェイクニュースを永続させるという懸念を挙げて、それまでのオープンソースの慣習を破り、GPT-3の前身モデルを公開しなかった。 |
| 25 | ChatGPT — マイクロソフト | 1 | A | マイクロソフトのサービスと ChatGPT でプラグインは共通で利用可能。 |
| 26 | Google — Transformer | 1 | B | 1991年に考案されたアンサンブル学習の一種である混合エキスパート（Mixture-of-Experts、MoE）は、2017年に扱えるパラメータ数を増やすためにGoogleがディープラーニング（LSTM, Sparsely-Gated Mixture-of-Experts Layer）に適用し、その後、GShard（ |
| 27 | サム — カリフォルニア州 | 1 | C | 2025年11月、Social Media Victims Law CenterとTech Justice Law Projectは、OpenAIとサム・アルトマンを相手取り、カリフォルニア州の裁判所で7件の訴訟を起こした。 |
| 28 | ChatGPT — 岡野原大輔 | 1 | C | 岡野原大輔：「大規模言語モデルは新たな知能か：ChatGPTが変えた世界」、岩波書店、ISBN 978-4-00-029719-6 (2023年6月20日). |
| 29 | ISBN — Models | 1 | C | Konstantinos Spiliopoulos, Richard B. Sowers, and Justin Sirignano : Mathematical Foundations of Deep Learning Models and Algorithms, AMS (GSM/252), ISBN 978-1- |
| 30 | GPT-1 — Wikipedia | 1 | B | その結果、GPT-3は、前身モデルであるGPT-1よりも有毒言語の生成が少なくなったものの、Wikipediaのデータのみで学習した言語モデルであるCTRL Wikiよりも有毒言語は生成が多く、毒性基準も高かった。 |
| 31 | GPT-3 — Generative Pre-trained | 2 | C | GPT-3は2020年5月に発表された、Generative Pre-trained Transformer 2（GPT-2）の後継モデルである。 |
| 32 | 米国 — 米国政府 | 2 | B | 1月21日、OpenAI、オラクル、ソフトバンク、MGXが米国政府と連携し、OpenAIのために米国内のAIインフラストラクチャを構築する合同会社Stargate Projectを設立。 |
| 33 | ISBN — Liu | 1 | C | Sebastian Raschka、Yuxi (Hayden) Liu、Vahid Mirjalili：「Python 機械学習プログラミング[PyTorch ＆ scikit-learn編]」、インプレス、ISBN 978-4-295-01558-1 (2022年12月21日). |
| 34 | Google — xAI | 1 | B | 大規模言語モデル（LLM）であるClaudeを公開しており、OpenAIのChatGPT、GoogleのGemini、xAIのGrokと競合している。 |
| 35 | GPT-3 — GPT-1 | 2 | A | 訓練に要した計算量は、GPT-1が0.96ペタFLOPS・日（NVIDIA Quadro P600を8GPU・30日）、GPT-2では数十ペタFLOPS・日だったのに対し、GPT-3では、3,640ペタFLOPS・日（NVIDIA V100を数千GPU・月と推定されている）を要した。 |
| 36 | Claude — 米国防総省 | 1 | A | 2026年2月、年初にアメリカ合衆国がベネズエラに対して行った軍事作戦に米国防総省がClaudeを使用していたことが発覚。 |
| 37 | GPT-3 — Wired | 1 | A | 『WIRED』は、GPT-3が「シリコンバレー全体に悪寒を引き起こした」と述べた。 |
| 38 | OpenAI — generative | 2 | C | 2018年6月11日、OpenAIの研究者と技術者は、データセットを介して膨大で多様なテキストのコーパスを用いて事前学習できる生成モデル（言語モデル、人工知能システム）に関する、彼らが生成的事前学習（generative pre-training、GP）と呼ぶプロセスの原論文を発表した。 |
| 39 | OpenAI — ChatGPT Enterprise | 1 | A | 2024年4月12日（米国時間）、OpenAIは公式Xアカウントで、ChatGPTの有料プラン「ChatGPT Plus」「ChatGPT Team」「ChatGPT Enterprise」で、GPT-4 Turboを提供開始したことを発表した。 |
| 40 | OpenAI — arXiv | 1 | B | 2020年5月28日、OpenAIの31人の技術者と研究者のグループによるarXivの査読前論文で、第3世代の「最先端の言語モデル」であるGPT-3の開発について説明された。 |

