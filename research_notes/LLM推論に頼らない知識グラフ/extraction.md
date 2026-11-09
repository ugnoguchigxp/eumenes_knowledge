# 強い LLM に頼らないエンティティ・関係抽出の選択肢（調査日 2026-11-09）

前提: 現行は小型ローカル LLM（reasoning off）で 2 KB 断片あたり約 52 s / 約 2,800 出力トークン、60 KB で約 2 時間。自由記述の関係名が集約されない（600 関係言及 → 597 エッジ、文書横断 0）。引用は UTF-8 バイト範囲で保持したい。以下は一次情報（論文・model card・GitHub・公式ドキュメント）を優先して集めたもの。2024 年以前の事実は「(旧)」と明記した。

## Q1. GLiNER 系・GLiREL・GLiNER-Relex・ReLiK・NuExtract・Triplex・REBEL/mREBEL・UniversalNER: サイズ、速度、CPU、多言語/日本語、span 出力、zero-shot ラベル

### Takeaway
エンコーダ型の span 抽出器（GLiNER2 / GLiNER2.5、GLiNER-Relex、GLiREL、ReLiK）は 74M〜0.9B 程度で CPU でも動き、文字オフセットを返せるものが多い。日本語での公開ベンチマーク値は、ほぼ「日本語 fine-tune 版の in-domain F1」しか見つからなかった。ゼロショット精度は GPT-4o / GPT-5-mini と同程度かやや下回る程度。関係抽出をエンドツーエンドで評価すると、どの方式でも絶対値は低い（micro-F1 で 20 台）。生成型（NuExtract、Triplex、mREBEL、UniversalNER）は span を返さず、サイズは 0.5B〜8B。

### Cited Findings

#### 比較表（数値はすべて各出典の記載のまま）
| モデル | サイズ / backbone | タスク | span 出力 | 多言語・日本語 | ライセンス | 保守状況 | 出典 |
|---|---|---|---|---|---|---|---|
| GLiNER2 (`gliner2-base-v1` / `large-v1` / `multi-v1`) | 205M（DeBERTa-v3-base）/ 340M（v3-large）/ 約 205M（mDeBERTa-v3-base） | NER、分類、構造化 JSON、関係抽出（`extract_relations`）、`JointIE` | `include_spans=True` で start/end（長文では全文オフセット） | multi 版あり。日本語への言及なし。空白で単語を区切らない言語には `"char"` word splitter を推奨（例は中国語） | Apache-2.0 | PyPI 1.0.0（2025-07-04）〜 2.1.0（2026-10-09）、2025-26 年に 17 リリース | [GitHub](https://github.com/fastino-ai/GLiNER2), [PyPI](https://pypi.org/project/gliner2/#history) |
| GLiNER2.5（boundary 型） | `small-v1` 74M（DeBERTa-v3-xsmall、CPU/edge 向け）、`base-v1` 194M、`multi-v1` 287M（mDeBERTa-v3-base、多言語向けの推奨） | GLiNER2 と同じ ＋ span attributes | 同上 | multi 版あり、日本語の記載なし | Apache-2.0 | 同上 | [GitHub](https://github.com/fastino-ai/GLiNER2) |
| GLiNER multi v2.1（旧, 2024） | 表記が「0.3B params」と「209M」で食い違う | NER | card の例ではテキストとラベルのみ表示 | multilingual。日本語の記載なし | Apache-2.0 | GLiNER ライブラリ v0.2.21（2025-06）〜 v0.2.30（2026-11-02） | [HF](https://huggingface.co/urchade/gliner_multi-v2.1), [Releases](https://github.com/urchade/GLiNER/releases) |
| gliner-x-large（Knowledgator） | 0.9B、mT5 encoder | NER | 記載なし | 20 言語（card のメタデータは「23 languages」）。**日本語は含まれない** | Apache-2.0 | 日付の記載なし | [HF](https://huggingface.co/knowledgator/gliner-x-large) |
| gliner-multitask-large-v0.5（旧, 2024） | パラメータ数の記載なし | NER、RE（ラベル形式 `"Microsoft <> founder"`）、要約、QA、open IE、キーフレーズ | — | 英語 | Apache-2.0 | 論文 2024-06 | [HF](https://huggingface.co/knowledgator/gliner-multitask-large-v0.5) |
| GLiNER-Relex | `knowledgator/gliner-relex-large-v1.0`、DeBERTa-v3-large ＋ BiLSTM | NER＋RE を同時に。ラベルは自然言語文字列 | 語・トークン単位（文字オフセットは記載なし） | 多言語には触れていない | 論文は CC BY 4.0、モデルは記載なし | arXiv 2026-05-11 | [arXiv 2605.10108](https://arxiv.org/html/2605.10108v1) |
| GLiREL | 467M、DeBERTa-v3-large | ゼロショット関係分類（入力にエンティティの start/end が必要） | 入力側に span を受け取る | 英語の合成データのみ、多言語評価なし | 未確認 | NAACL 2025 | [arXiv 2501.03172](https://arxiv.org/html/2501.03172) |
| ReLiK（旧, ACL Findings 2024、arXiv v3 は 2025-05） | small / base / large / xl（パラメータ数の記載なし） | エンティティリンキング（Wikipedia index）、RE、cIE | 文字単位の start/end（既定は `--annotation-type char`） | 英語の例のみ | **CC BY-NC-SA 4.0** | GitHub Releases は空 | [GitHub](https://github.com/SapienzaNLP/relik), [arXiv](https://arxiv.org/abs/2408.00103) |
| NuExtract 2.0 | 2B（Qwen2-VL-2B）/ 4B（Qwen2.5-VL-3B）/ 8B（Qwen2.5-VL-7B） | テンプレート JSON 抽出。型は `verbatim-string`、`string`、`enum`、`multi-label` など | オフセットは返さない（`verbatim-string` は原文をそのまま写す） | 「multilingual」とのみ記載、日本語は未記載 | 2B・8B は MIT、4B は Qwen Research License | 後継の NuExtract3 あり | [HF](https://huggingface.co/numind/NuExtract-2.0-2B) |
| NuExtract3 | 4B VLM | 構造化抽出＋OCR/Markdown 化、reasoning あり/なし | — | 多言語文書に対応 | Apache 2.0 | 2026-05 リリース。GGUF・MLX あり | [NuMind blog](https://numind.ai/blog/nuextract-3-release), [search 要約](https://huggingface.co/numind/NuExtract3) |
| NuExtract 1.5（旧） | 4B（Phi-3.5-mini）、tiny 0.5B（Qwen2.5-0.5B） | 抽出優先（出力の大半が原文どおり） | — | en/fr/es/de/pt/it。**日本語なし** | MIT | — | [HF](https://huggingface.co/numind/NuExtract-1.5) |
| Triplex（旧, 2024） | 4B（Phi-3 3.8B の fine-tune） | entity types と predicates を JSON リストで与えて KG トリプルを生成 | 出力形式の明記なし | 言語の記載なし | CC BY-NC-SA 4.0（直近 12 か月の総収入 500 万ドル未満の組織は免除） | GGUF 量子化版 7 種 | [HF](https://huggingface.co/SciPhi/Triplex) |
| mREBEL large（旧, ACL 2023） | 0.6B、mBART 系 | seq2seq で Wikidata 関係トリプル（type 付き）を線形化して出力 | span なし | 学習データ SREDFM は 18 言語で、**ja を含む（48.7 万行）** | metadata は cc-by-nc-sa-4.0、本文は「CC BY-SA 4.0」と食い違う | — | [HF](https://huggingface.co/Babelscape/mrebel-large), [SREDFM](https://huggingface.co/datasets/Babelscape/SREDFM) |
| UniversalNER（旧, ICLR 2024） | 7B（LLaMA-7B） | 1 クエリにつきエンティティ型 1 つ | JSON 出力、span は明記なし | 英語 | CC BY-NC 4.0 | — | [HF](https://huggingface.co/Universal-NER/UniNER-7B-type), [arXiv](https://arxiv.org/abs/2308.03279) |
| Otter（多言語 NER, 2026） | mmBERT cross-encoder、VRAM 1.4 GB | NER | サブワード上の span 候補（文字オフセットは明記なし） | 100 以上の言語。日本語は設計判断用の holdout に含まれる | モデルのライセンスは記載なし（code は github.com/whoisjones/otter） | arXiv v3（2026-08-30） | [arXiv 2601.06347](https://arxiv.org/html/2601.06347) |

#### 速度・CPU
- GLiNER2 論文の Table 4（「standard CPU」、CPU 型番と系列長の記載なし）: ラベル数 5/10/20/50 で GLiNER2 は 130/132/163/208 ms、GPT-4o（API）は 358/382/425/463 ms、DeBERTa は 1714/3404/6758/16897 ms、GLiClass は 137/131/140/190 ms。本文の「DeBERTa は 20 ラベルで 6.8 倍遅い」は表から計算した約 41 倍と合わない — [arXiv 2507.18546](https://arxiv.org/html/2507.18546)
- GLiNER2 は「CPU first」をうたい、標準的な推論に GPU は不要。`quantize`、`compile`、LoRA（アダプタは約 2〜10 MB、フルモデルは約 450 MB）に対応 — [GitHub](https://github.com/fastino-ai/GLiNER2)
- GLiREL の推論速度（m=10）: CPU で 4.63 文/s（Wiki-ZSL）と 4.93 文/s（FewRel）、GPU で 47.60 / 41.07 文/s。TMC-BERT は CPU で 0.12 / 1.91 文/s — [arXiv 2501.03172](https://arxiv.org/html/2501.03172)
- GLiNER-Relex: NVIDIA L4、batch 1、平均 288 語の文書で 0.9 s/文書。GPT-5-mini（API）は 64 s/文書で、スループット差は約 70 倍。CPU の数値は報告されていない — [arXiv 2605.10108](https://arxiv.org/html/2605.10108v1)
- GLiNER-Relex をローカルで動かすには RAM/VRAM が約 1〜2 GB 必要 — [Knowledgator cookbook](https://docs.knowledgator.com/docs/cookbooks/graphrag-system/index.html)
- Otter: 1 例あたり 18 ms、VRAM 1.4 GB。性能で上回る 4B ベースラインより 50〜80 倍速い — [arXiv 2601.06347](https://arxiv.org/html/2601.06347)
- ReLiK（RTX 4090）: AIDA test 全体を EL small/base が 29 s、large が 1 分 46 秒で処理。RE large（NYT）は 30 s。比較対象の GENRE は 38 分、REBEL は 1 分 45 秒。`relik serve` と Docker の既定は CPU で、CPU 用の FAISS もある — [GitHub](https://github.com/SapienzaNLP/relik)
- GLiNER ライブラリの更新: v0.2.26（2026-03）で CPU 前処理・デコードをベクトル化し、v0.2.27（2026-05）で quantize/compile、v0.2.29（2026-09）で ONNX と並ぶ OpenVINO 対応（bi-encoder と関係抽出モデルを含む）、v0.2.30（2026-11-02）で TorchAO による FP8 と統合 entity/relation serving API を追加。年はリリースページに書かれておらず、順序から推定したもの — [GitHub Releases](https://github.com/urchade/GLiNER/releases)

#### 品質（ベンチマーク）
- GLiNER2 の CrossNER ゼロショット平均 F1: GLiNER2 0.590、GPT-4o 0.599、GLiNER-M 0.615。ゼロショット分類の 7 ベンチマーク平均: GLiNER2 0.72、GPT-4o 0.84。学習データは 254,334 例で、実文書 135,698 件に GPT-4o で注釈を付けたものと、GPT-4o による合成 118,636 件。構造化抽出はベンチマークがないため評価していない — [arXiv 2507.18546](https://arxiv.org/html/2507.18546)
- GLiREL の関係分類（gold entity、未見ラベル m 個、macro F1、Wiki-ZSL / FewRel）: 合成データで事前学習した版は m=5 で 83.28 / 94.20、m=15 で 73.91 / 84.48。GPT-4o は m=5 で 80.03 / 89.20、m=15 で 41.57 / 70.70。素の GLiREL は m=5 の Wiki-ZSL で 62.80 と GPT-4o に負けている。限界: ラベルは DeBERTa の 512 トークン以内に収める必要がある。エンティティ対の数がほぼ二乗で増えるため文書レベルでメモリが厳しい。Re-DocRED で予測 coreference を使うと 25.08（gold では 54.13） — [arXiv 2501.03172](https://arxiv.org/html/2501.03172)
- GLiNER-Relex 論文の Table 2（エンドツーエンドのトリプル micro-F1、CoNLL04 / DocRED / FewRel / CrossRE / 平均）: GLiNER-Relex 40.4 / 31.3 / 12.5 / 18.1 / 25.6、GPT-5-mini 42.4 / 18.6 / 15.0 / 12.4 / 22.1、GLiNER2 32.9 / 11.7 / 20.8 / 6.0 / 17.8、GLiREL（gold entity）4.5 / 2.4 / 24.0 / 1.4 / 8.1。本文と表の数値が複数箇所で食い違う（例: GLiNER2 の CoNLL04 は本文 34.1、表 32.9）。長文は 2048 語で切り捨て（sliding window なし）。エンティティが密な箇所では all-pairs 列挙のため precision が下がる — [arXiv 2605.10108](https://arxiv.org/html/2605.10108v1)
- ReLiK: NYT の RE micro-F1 は large で 95.0（REBEL 93.1、USM 94.0）。EL の GERBIL InKB（AIDA）は large 86.4、small 82.2 — [GitHub](https://github.com/SapienzaNLP/relik)
- 多言語 NER（Otter 論文、7 ベンチマーク・250 test split、macro F1）: GPT-5 0.347、Qwen3-32B 0.503、Gemma3-27B 0.543、GLiNER-multi-v2.1 0.427、GLiNER-x-base 0.431、Otter（cross-encoder）0.489。日本語単独の数値は載っていない — [arXiv 2601.06347](https://arxiv.org/html/2601.06347)
- gliner-x-large と gliner_multi-v2.1 の UD 系 NER F1: en_ewt 0.7549 / 0.573、zh_pud 0.6794 / 0.641。日本語の値はない — [HF](https://huggingface.co/knowledgator/gliner-x-large)
- gliner-multitask-v0.5 のゼロショット NER 平均 F1 は 0.6276（NuNER_Zero-span 0.6196、gliner_large-v2.1 0.5754）。RE の F1 は報告されていない（旧, 2024） — [HF](https://huggingface.co/knowledgator/gliner-multitask-large-v0.5)
- UniversalNER: 43 データセット・9 ドメインの平均 F1 で ChatGPT を 7〜9 ポイント上回る（旧, 2023） — [arXiv](https://arxiv.org/abs/2308.03279)
- Triplex: 「GPT-4 の 1/60 のコストで上回る、KG 作成コスト 98% 削減」という自己申告。ベンチマークは画像のみで数値テキストはない（旧, 2024） — [HF](https://huggingface.co/SciPhi/Triplex)

#### 日本語
- 日本語向け GLiNER の公開モデル `vumichien/ner-jp-gliner`: backbone は ku-nlp/deberta-v3-base-japanese、学習データは stockmark/ner-wikipedia-dataset。P 96.07 / R 89.16 / F1 92.49（同データでの評価）。ライセンスは cc-by-nc-4.0 — [HF](https://huggingface.co/vumichien/ner-jp-gliner)
- 日本語の GLiNER を公式モデルとして出しているところは、検索では見つからなかった。Towards AI の記事に deberta-v3-base-japanese で GLiNER を学習するチュートリアルはある — [WebSearch 要約（Towards AI）](https://pub.towardsai.net/revolutionizing-named-entity-recognition-with-efficient-bidirectional-transformer-models-5397af9efae6)
- GLiNER ライブラリ v0.2.21（2025-06）で多言語テキスト splitter と関係抽出の index 返却、v0.2.22（2025-08）で jieba3 と Stanza の splitter が入った — [GitHub Releases](https://github.com/urchade/GLiNER/releases)
- Otter 論文では、FiNERweb（91 言語）で学習すると英語のみやラテン文字のみで学習した場合より日本語のスコアが上がると本文に書かれているが、値は図にしかない — [arXiv 2601.06347](https://arxiv.org/html/2601.06347)

### Inferences
- 現行の 52 s/断片に対して、エンコーダ型は 1 文書あたり数十 ms〜1 s 程度で動く（GLiNER2 は CPU で 130〜208 ms、GLiNER-Relex は GPU で 0.9 s/288 語）。出典の条件はそろっていないが、60 KB の取り込みは時間単位から分単位以下に縮む可能性が高い。ただし GLiNER2 の Table 4 は DeBERTa（NLI）や GLiClass との比較なので、おそらく分類タスクの遅延であり、NER や RE の CPU 遅延と同じとは限らない。
- 引用（UTF-8 バイト範囲）との相性が良いのは、GLiNER2（`include_spans`）、ReLiK（char 単位）、GLiNER 系（v0.2.21 以降は関係抽出も index を返す）。どれも Python の文字インデックスを返すはずなので、UTF-8 バイト範囲に変換する層が要る。生成型の NuExtract・Triplex・mREBEL・UniversalNER は span を返さず、`verbatim-string` で写した文字列を原文から探して位置を決めるしかない（同じ文字列が複数あるときは曖昧になる）。
- 関係ラベルを固定集合にすれば集約の問題は構造的に解ける（GLiNER2 `extract_relations`、GLiNER-Relex、GLiREL、Triplex の predicates リスト）。ただしゼロショットでエンドツーエンドの RE は micro-F1 25 前後（GLiNER-Relex 表）にとどまり、GPT-5-mini も 22 前後なので、絶対値はまだ低い。
- 日本語で現実的な候補は、mDeBERTa 系の GLiNER2.5-multi（287M）か GLiNER2-multi に `"char"` か Sudachi 系の word splitter を組み合わせる形と、日本語 DeBERTa で GLiNER/GLiNER2 を自前で LoRA fine-tune する形。fine-tune 用データは Stockmark データセットと、一度だけ使う強いクラウドモデルで作る合成データが考えられる。vumichien/ner-jp-gliner は非商用ライセンスなので参考実装にとどまる。
- ReLiK のエンティティリンキングは Wikipedia index が前提で、個人やチームのメモに出てくる固有名（社内プロジェクト名など）はほぼ index に載っていない。文書横断の同一性判定にそのまま使うのは難しい。ライセンスも非商用。
- mREBEL は学習データに日本語が入っているが、Wikidata の関係スキーマに固定され、span を返さず、ライセンスも非商用寄りなので、引用前提の用途には合いにくい。

### Gaps
- GLiNER2 / GLiNER2.5 の multi 版、GLiNER multi v2.1、GLiNER-Relex の **日本語での公開評価値** は見つからなかった。Otter 論文の日本語値は図にしかない。
- GLiNER2 の `include_spans` が返す start/end が文字単位かトークン単位か、README の要約からは断定できない。
- GLiREL のコードとモデルのライセンス、GLiNER-Relex モデルのライセンス、GLiNER2.5 の初出日は確認できなかった。
- Triplex の出力形式（JSON トリプルか）、NuExtract 2.0 のベンチマーク数値（図のみ）、NuExtract3 の日本語性能は確認できなかった。
- CPU 上で NER と RE を合わせて回したときの、2 KB あたりのスループットを同じ条件で測った一次資料は見つからなかった。
- Otter 論文で GPT-5 が 0.347 と極端に低い理由（出力形式の失敗かどうか）は、読めた範囲では確認できなかった。

## Q2. 日本語 NLP スタック（spaCy + GiNZA、Sudachi、Juman++/KWJA）と日本語 NER データセット・モデル

### Takeaway
GiNZA 5.3.0（2026-09-30）は spaCy 互換で、エンティティの文字オフセット（`start_char` / `end_char`）、係り受け、文節 API、簡易な節 API がそろい、2026 年も活発に保守されている。ただし ENE（拡張固有表現）の精度は 53.9（ja_ginza）〜 70.8（ja_ginza_bert_large）にとどまる。KWJA は NER 84.6〜85.9 に加えて述語項構造・共参照・談話関係まで出す。Sudachi の `normalized_form` と同義語グループ ID は、表記ゆれを吸収して同一性を判定する材料になる。

### Cited Findings
- GiNZA の最新版は 5.3.0（2026-09-30、「Grossular Garnet」）。Python 3.10 以上と spaCy 3.8.16 以上が必要で、`ja_ginza_bert_large` を正式リリースした。5.2.1（2026-09-01）では 49,149 バイトを超える長文の処理を修正。5.2.0（2024-03-31）で実験的な clause API を追加。MIT ライセンス — [GitHub](https://github.com/megagonlabs/ginza)
- GiNZA の精度（UD_Japanese-BCCWJ r2.8 test、LAS / UAS / UPOS / ENE）: ja_ginza_bert_large 93.8 / 94.9 / 98.3 / 70.8、ja_ginza_electra 92.3 / 93.7 / 98.1 / 61.3、ja_ginza（v5）89.2 / 91.1 / 97.0 / 53.9。ENE は関根の拡張固有表現階層で評価したもの。OntoNotes5 に写像するとカテゴリ数が大幅に減るので、スコアは一般に上がる — [GiNZA docs](https://megagonlabs.github.io/ginza/)
- GiNZA の速度とメモリ: M4 Max で ja_ginza に thinc-apple-ops を使うとスループットが 2.6〜5.2 倍、ja_ginza_bert_large を MPS で動かすと 1.3 倍（絶対値の記載はない）。Transformer 系モデルにはメモリ 16 GB 以上を推奨。辞書は SudachiDict-core、分割モードの既定は C — [GiNZA docs](https://megagonlabs.github.io/ginza/)
- GiNZA の NER ラベル: `token.ent_type_` は ENE、`token._.ne` は拡張 OntoNotes5（PHONE、EMAIL、URL、PET_NAME を追加）。学習コーパスは NER が GSK2014-A（2019）の BCCWJ 版、構文が UD Japanese BCCWJ r2.8 — [GitHub](https://github.com/megagonlabs/ginza)
- 文節 API（v4.0.0〜）: `bunsetu_spans(Span)`、`phrase(Token)`、`bunsetu_head_tokens(Span)` など。clause API（v5.2.0、実験的）は、読点で区切った区間のうち文節を 2 つ以上含むものを節とみなす単純な実装 — [GiNZA docs](https://megagonlabs.github.io/ginza/)
- spaCy の `Span.start_char` / `Span.end_char` は「The character offset for the start/end of the span」 — [spaCy API](https://spacy.io/api/span)
- Sudachi（sudachi.rs、Apache-2.0）: 分割モードは A（短単位）/ B（中単位）/ C（固有表現相当の長単位、既定）。各トークンに normalized form がある（例: 附属 → 付属）。辞書は small（UniDic 語彙のみ）/ core（既定）/ full（雑多な固有名詞を追加）。インストール例の版は 0.8.2、`sudachipy>=0.6.11` を推奨 — [GitHub](https://github.com/WorksApplications/sudachi.rs)
- SudachiPy の Morpheme API: `begin()` / `end()` は「begin/end index of this in the input text」（文字かバイトかは書かれていない）。ほかに `normalized_form()`、`dictionary_form()`、`reading_form()`、`synonym_group_ids()`（List[int]）、`split(mode)` がある — [SudachiPy API](https://worksapplications.github.io/sudachi.rs/python/api/sudachipy.html)
- KWJA（MIT）: 誤字訂正、単語分割、正規化、形態素解析、NER、係り受け、述語項構造、橋渡し照応・共参照、談話関係を統合して解析する。モデルは tiny / base / large で CPU 実行可。精度（v2.x base / large）は NER 84.6 / 85.9、係り受け 93.5 / 93.6、共参照 78.6 / 79.2。出力は KNP 形式で rhoknp でパースできる。文字オフセットの記載はなく、速度の数値もない — [GitHub](https://github.com/ku-nlp/kwja)
- Stockmark の Wikipedia NER データセット v2.0: 5,343 文（約 10% はエンティティを含まない負例）、8 タイプ（人名 2,980、法人名 2,485、地名 2,157、製品名 1,215、政治的組織名 1,180、施設名 1,108、その他の組織名 1,051、イベント名 1,009）。span は `[start, end]` で、例からは文字単位・終端排他と読める。CC-BY-SA 3.0（商用可）。2021 年の言語処理学会で発表（旧） — [GitHub](https://github.com/stockmarkteam/ner-wikipedia-dataset)
- 日本語の文書レベル関係抽出データセット JacRED（LREC-COLING 2024、旧）: Re-DocRED を機械翻訳してモデルを学習し、そのモデルで人手アノテーションを補助して作った。翻訳データだけで学習すると、日本語の原文では recall が低くなると報告されている — [WebSearch 要約（LREC 2024）](https://aclanthology.org/2024.lrec-main.232.pdf)
- 日本語の汎用 IE LLM である GIELLM（2023、旧）と、日・英・中の多言語 IE データセット MMM および OIELLM（arXiv 2407.10953、2026-04 に改訂）がある — [WebSearch 要約](https://arxiv.org/html/2407.10953)

### Inferences
- GiNZA は spaCy の Span なので、エンティティや名詞句を文字オフセット付きで取り出せる。そのまま UTF-8 バイト範囲に変換できる。ENE の精度は 54〜71 と高くないので、「固有表現の種類」を当てる主力にはしにくい。用途は、候補抽出（名詞句・文節の head）と、係り受けに基づく SVO 風の関係候補づくりに向く（Q5 の英語での依存構造 GraphRAG と同じ発想）。
- Sudachi の `normalized_form`（附属 → 付属 のような表記ゆれの正規化）と `synonym_group_ids` は、文書横断の同一性判定の前処理（決定的なキー生成）に使える。LLM にペアごとに判定させる回数を減らせる見込みがある。
- KWJA の述語項構造（ガ格・ヲ格・ニ格など）は、日本語の「述語＋項」形式のトリプル候補を LLM なしで出せる数少ない手段。KNP 形式から原文の文字位置を復元する手間と、速度は検証が必要。
- 混在文（日本語＋英語）では、GiNZA/Sudachi が英語部分をどう分割し、どう NER するかは未検証。英語部分は GLiNER2 の英語モデルや spaCy の英語モデルに振り分けることも考えられる。

### Gaps
- GiNZA と KWJA の CPU での絶対スループット（文字/s）の一次資料は見つからなかった。
- Stockmark データセットで GiNZA、KWJA、日本語 BERT 系 NER を比べた公式スコアは見つからなかった（vumichien/ner-jp-gliner の 92.49 のみ）。
- Juman++ 単体と KWJA の最新リリース日（2025〜2026 年の保守状況）は確認できなかった（README の Releases は空）。
- SudachiPy の `begin()` / `end()` が文字単位かバイト単位か、公式ドキュメントからは断定できなかった。

## Q3. OpenIE（多言語・日本語）とキーフレーズ抽出（KeyBERT、YAKE、TextRank）

### Takeaway
日本語で使える、保守されている OpenIE の既製モデルは見つからなかった。研究としては MiLIE（2021、日本語の評価セットを公開）と NEC の言語間転移（MRL 2023）があるだけ。キーフレーズ抽出の KeyBERT と YAKE は日本語に直接は対応しておらず、形態素解析器で単語を切る前処理が必要。どちらもオフセットを返さない。

### Cited Findings
- MiLIE（Kotnis ら, 2021、旧）: 反復予測で多言語 OpenIE を行い、ルールベースと組み合わせられる。中国語からガリシア語まで複数言語で SOTA を上回ったと報告し、日本語とガリシア語の OpenIE 評価データセットを公開した — [WebSearch 要約（arXiv 2110.08144）](https://arxiv.org/abs/2110.08144v1)
- NEC（MRL 2023、旧）: 英語で学習したモデルを他言語に転移する OpenIE。ドイツ語・アラビア語・日本語で実験し、日本語向けには疑似英語文に格助詞を挿入する手法を提案した。コードとベンチマークは GitHub で公開 — [WebSearch 要約（MRL 2023）](https://preview.aclanthology.org/moar-dois/2023.mrl-1.11.pdf)
- DetIE（旧）: 物体検出に着想を得た多言語 OpenIE。2 言語でゼロショット評価し、言語ごとの合成データ生成も提案している — [ar5iv](https://ar5iv.labs.arxiv.org/html/2206.12514)
- gliner-multitask-large-v0.5 は open IE とキーフレーズ抽出もタスクに含むが、英語のみ（旧, 2024） — [HF](https://huggingface.co/knowledgator/gliner-multitask-large-v0.5)
- KeyBERT FAQ: 多言語には `paraphrase-multilingual-MiniLM-L12-v2` などを推奨。中国語は jieba を使う独自の `CountVectorizer(tokenizer=...)` を `extract_keywords(..., vectorizer=...)` に渡す（日本語への言及はない）。GPU が望ましく、CPU では大幅に遅い。文書はまとめて渡した方が速い。オフセットを返すかどうかの記載はない — [KeyBERT FAQ](https://maartengr.github.io/KeyBERT/faq.html)
- YAKE: 学習もコーパスも辞書も要らない軽量な手法で、「multiple languages」に対応するとあるが、日本語・中国語への言及はない。出力は `(keyword, score)` の組でオフセットはない（旧, ECIR 2018） — [GitHub](https://github.com/LIAAD/yake)
- Spark NLP の YAKE 実装は、事前に文分割器とトークナイザを通す必要がある — [WebSearch 要約（Spark NLP）](https://sparknlp.org/api/python/reference/autosummary/sparknlp/annotator/keyword_extraction/yake_keyword_extraction)

### Inferences
- 日本語の KeyBERT は、Sudachi/GiNZA の単語分割を CountVectorizer の tokenizer に渡し（中国語の jieba 例と同じ形）、埋め込みには既存の multilingual-e5-small を流用する形が素直。e5 を KeyBERT にそのまま差し込めるかは未確認。候補は名詞句（GiNZA の文節 head や Sudachi の C 単位名詞連続）に絞ると質が上がると考えられる。
- キーフレーズは引用用のオフセットを持たないので、候補生成の段階でトークンの位置を保持し、後から span を付ける必要がある。
- OpenIE の代わりに、GiNZA の係り受けか KWJA の述語項構造からルールで述語＋項を取り出す方が、日本語では現実的と考えられる。ただし関係名は述語の表層形になるため、集約には Sudachi の正規化か、固定ラベルへの写像（Q4）が別に要る。

### Gaps
- TextRank / PositionRank の日本語実装（pytextrank を GiNZA 上で動かすなど）の公式な対応状況と評価値は調べきれなかった。
- 2025〜2026 年に公開された日本語 OpenIE のモデルや評価は見つからなかった。MiLIE や NEC の日本語チェックポイントが配布されているかも未確認。
- Stanford OpenIE、OpenIE6 など英語 OpenIE ツールの現在の保守状況は調べていない。

## Q4. 小型モデルによる閉スキーマ関係抽出（固定ラベルでのゼロショット関係分類、制約付き/文法ベースデコード）: 固定リストから選ぶのと自由記述とでどう違うか

### Takeaway
固定ラベル集合での関係分類では、専用エンコーダ（GLiREL）はラベル数が増えても精度が落ちにくい。GPT-4o はラベル数が増えると大きく落ちる（m=5 → 15 で Wiki-ZSL 80.0 → 41.6）。小型の生成 LLM に hard な制約付きデコード（JSON schema、enum）を掛けると、スキーマ妥当性は 100% になるが、中身の正答率は下がることがある（「constraint tax」）。fine-tune した 0.5B の SLM は、関係抽出でフロンティア LLM のゼロショットを上回った報告がある。

### Cited Findings
- 固定ラベル・未見ラベル数 m を変えた関係分類（gold entity）: GPT-4o は Wiki-ZSL で m=5 / 10 / 15 が 80.03 / 68.35 / 41.57、FewRel で 89.20 / 66.20 / 70.70。合成事前学習ありの GLiREL は Wiki-ZSL 83.28 / 83.67 / 73.91、FewRel 94.20 / 87.60 / 84.48。ラベルは入力と同じ 512 トークン枠に入れるので数に上限があり、他のラベルの順序や数で結果が変わる — [arXiv 2501.03172](https://arxiv.org/html/2501.03172)
- ゼロショットのエンドツーエンド RE（ラベルは自然言語文字列）: GLiNER-Relex は平均 25.6、GPT-5-mini（プロンプト）22.1、GLiNER2 17.8 — [arXiv 2605.10108](https://arxiv.org/html/2605.10108v1)
- 「Sub-Billion, Super-Frontier」（2026-06）: 一般ドメインを pool した fine-tune 済み Qwen2.5-0.5B が positive-class micro-F1 0.83、ゼロショットの GPT-5.4 が 0.69、Claude Sonnet 4.6 が 0.66。伝記ベンチでは 0.92 対 0.83（GPT-5.4）。著者は、差は SLM が本質的に強いからではなくタスク適応の効果だとしている。ドメイン適応の事前学習の効果は小さく、同じ系列内のスケール差の効果もわずか — [arXiv 2606.22606](https://arxiv.org/abs/2606.22606)
- 「The Constraint Tax」（2026-05）: Qwen2.5-0.5B/1.5B と SmolLM2-1.7B の 15,000 生成で、hard な schema decoding はスキーマ妥当性を 61.5% → 100% に上げたが、回答正答率は 19.7% → 11.0% に下がり、wrong-but-valid は 49.5% → 88.9% に増えた。カレンダーの tool-call では Qwen2.5-1.5B が prompt-only JSON で 91.5%、hard schema で 48.0%。推奨は、自由に推論させた後で制約を掛ける「delayed packaging」と、指標を分けて報告すること — [arXiv 2605.26128](https://arxiv.org/abs/2605.26128)
- 「Constrained Decoding Eliminates Structural Failures in Small LLMs...」（2026-09）: 0.6B〜4B の 5 モデル、14 タスク（データ抽出を含む）。素の妥当性 78.6〜92.9% が、Outlines や XGrammar を使うと全モデルで 100% になった。型強制の失敗は CD で直るが、指示の意味の失敗は残る — [arXiv 2609.23742](https://arxiv.org/abs/2609.23742)
- 未確認（検索結果の要約から得ただけで本文未読）: enum で制約したデコードで、MetaTool での Qwen2.5-3B の信頼性が 83.6% → 60.9% に下がった — [arXiv 2510.07248](https://arxiv.org/pdf/2510.07248)。制約付きデコードで fine-tune した Mistral-7B がスキーマ正確度 99.5%、内容類似度 94.0%（SLOT、EMNLP 2025 Industry） — [arXiv 2505.04016](https://arxiv.org/pdf/2505.04016v1)
- 小型抽出モデル側の固定選択肢: NuExtract 2.0 のテンプレートは `enum`（単一選択）と `multi-label` をサポートし、該当なしは `null` / `[]` を返す。温度は 0 付近を推奨（Ollama の既定 0.7 は不適）。GLiNER2 は構造化抽出で choice 制約を持つほか、`Classifier`（constrained classification）がある。Triplex は predicates のリストを入力にとる — [NuExtract HF](https://huggingface.co/numind/NuExtract-2.0-2B), [GLiNER2 paper](https://arxiv.org/html/2507.18546), [GLiNER2 GitHub](https://github.com/fastino-ai/GLiNER2), [Triplex HF](https://huggingface.co/SciPhi/Triplex)

### Inferences
- 関係名の集約問題（597 エッジ・文書横断 0）は、固定の関係ラベル集合（例: 20〜50 個程度を一度だけ強いクラウドモデルで設計）に写像するだけで構造的に解ける。精度面では、ラベルを増やすと LLM が崩れやすく、専用エンコーダの方が安定する、という GLiREL 表の傾向が使える。
- 小型 LLM を残すなら、「自由に書かせてから、後段で固定ラベルに写像する（埋め込みの近傍か分類器）」方が、「hard な enum 制約で直接選ばせる」より安全な可能性が高い（constraint tax の結果より）。逆に、エンコーダ型分類器（GLiNER2 `Classifier`、GLiREL）なら、制約は構造上自然に満たされる。
- 現行の 2,800 出力トークンの大半は、自由記述の関係文と逐語引用の生成とみられる。span 抽出型に置き換えれば逐語引用は原文オフセットそのものになり、生成コストもハルシネーションのリスクもなくなる。
- 最も精度が期待できるのは、一度だけの強いモデル（設計時）で自分たちの文書ドメインの銀ラベル（エンティティ型・関係ラベル）を作り、GLiNER2 / GLiNER-Relex を LoRA で fine-tune する道（Sub-Billion 論文の「タスク適応が効く」という結論と整合）。ただし日本語での実証はない。

### Gaps
- 日本語の文で、固定ラベル集合による関係分類を小型モデル（エンコーダ型か ≤4B の LLM）で評価した資料は見つからなかった。
- 「固定リストから選ばせる」と「自由記述させて後で写像する」を同じ小型 LLM で直接比べた、関係抽出に特化した研究は見つからなかった（constraint tax 論文は IE 専用ではない）。
- 2510.07248 と SLOT（2505.04016）の数値は本文で確認していない。

## Q5. 2025〜2026 年の、小型専用抽出器と LLM 抽出を比べた KG 構築ベンチマーク（コスト・品質）

### Takeaway
GraphRAG 全体で LLM 抽出と非 LLM 抽出を比べた一次資料は、依存構造解析（spaCy）による KG 構築が GPT-4o 抽出の約 94%（semantic alignment 61.87 対 65.83）を達成した 1 件だけだった（2025）。GLiNER 系と LLM の GraphRAG での直接比較は「今後の課題」とされていて未実施。抽出段階のスループットでは、GLiNER-Relex が GPT-5-mini の約 70 倍。

### Cited Findings
- 「Towards Practical GraphRAG」（arXiv 2507.03226、2025-07、v3 は 2025-12）: spaCy に独自 tokenizer、受動態の正規化、複数トークン実体の結合、coreference を足したパイプラインで、SVO の依存トリプルとヒューリスティックな線形抽出を行う。エッジラベルは動詞か前置詞、ノード型は「Concept」。550 PDF / 約 2,000 チャンクから 39,155 ノードと 47,613 のエンティティ間関係を得た。評価は semantic alignment（加重平均）が依存構造版 61.87%・GPT-4o 版 65.83%・dense 50.80%、RAGAS 平均が 74.93% / 75.83% / 71.48%。本文では「context precision の 94%」と書いているが、表から計算すると約 95.7% で、94% は semantic alignment の比と一致する。コストと時間は「orders of magnitude faster」とあるだけで実測値はない。チャンクをまたぐエンティティの統合方法は書かれていない。ドメインはコード移行のみ — [arXiv 2507.03226](https://arxiv.org/html/2507.03226)
- GLiNER-Relex（2026-05）: 抽出のスループットは GPT-5-mini の約 70 倍（0.9 s 対 64 s/文書、L4）。GraphRAG で LLM 抽出と回答品質・グラフ網羅率・総コストを比べるのは今後の課題 — [arXiv 2605.10108](https://arxiv.org/html/2605.10108v1)
- 「GLiNER ベース vs LLM ベースの GraphRAG」を正面から比べた研究は、検索では見つからなかった — [WebSearch 要約](https://arxiv.org/html/2605.10108v1)
- 未確認（検索要約経由）: CausalRAG2 はオフライン構築コストを GraphRAG-Global で約 $0.0034 / 1K コーパストークン、LightRAG で約 $0.0015 と報告している — [arXiv 2602.05143](https://arxiv.org/pdf/2602.05143)
- 関連（未読）: 2026 年の「When Is Graph Structure Worth Its Cost?」は、グラフ構造のコストに見合う条件を論じている — [arXiv 2609.18099](https://arxiv.org/pdf/2609.18099)

### Inferences
- 依存構造ベースの KG は、検索・RAG 品質で LLM 抽出の 9 割以上を保てる例がある（英語・単一ドメイン）。日本語では GiNZA 係り受けか KWJA 述語項構造に置き換えた同型のパイプラインが考えられるが、日本語での実証は見つかっていない。
- 総合すると現実的な構成案は次のとおり。(1) GiNZA/Sudachi で名詞句と正規化キーを決定的に作る。(2) GLiNER2(.5)-multi か日本語 fine-tune 版で型付けし、span を付ける。(3) GLiNER2 `extract_relations`、GLiNER-Relex、GLiREL で固定ラベルの関係を付ける。(4) 小型 LLM は、低信頼度の候補、同一性の曖昧なペア、要約にだけ使う。断片単位で決定的に処理するので、変更された断片だけを再抽出する差分更新もしやすい（エンコーダ出力は断片内で閉じる）。
- 差分更新のしやすさ: エンコーダ型・ルール型は、入力が同じなら出力が同じで、高速なので、変更された断片だけを再処理しやすい。一方 GLiREL や GLiNER-Relex はエンティティ対を二乗で列挙するので、断片を長くするとコストとメモリが増える。断片は数百語程度に保つのが無難。

### Gaps
- 日本語（または日英混在）の文書で、GLiNER 系・GiNZA 系と LLM 抽出を、KG 品質と RAG 品質で比べたベンチマークは見つからなかった。
- 2507.03226 の依存構造版と LLM 版の抽出時間・コストの実測値は論文にない。
- LightRAG 型の抽出を小型エンコーダに置き換えたときの、エンドツーエンドの検索品質を比べた資料は見つからなかった。
