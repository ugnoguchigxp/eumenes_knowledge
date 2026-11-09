# 正規化キーとモデルの判断が食い違う組

キーは `sudachi`（kg.md §8）。抽出は `verification/kg-ai-memory/20261107T231544-lfm2.5/knowledge.db` のもの。比べた実行ごとに、キーが同じかどうかと、その実行のモデルの判断が食い違った組を、キーの組ごとに 1 組ずつ、決まった擬似乱数の順で並べる。

- 並ぶのはモデルが判断した組だけ。v3 はまとまりごとに 1 件しか問わないので、キーが同じでもモデルが判断していない組は多い。`unsure` の組は並べない。
- 同じキーの組に食い違いが何組あっても、並ぶのは 1 組。数は表の全体の数と比べて読む。
- 「判定」は `--judgments` の 74 組から: キー（キーが正しい）、モデル（モデルが正しい）、？（決められない。多くは文脈で意味の決まらない一般語）。抽出は verification/kg-ai-memory/20261107T231544-lfm2.5（entity id はこの抽出のもの）。判定の初版は Claude（素材を書いた者）が原文を見て付けた。人の確認はまだ。

## `verification/kg-ai-memory/20261107T231544-lfm2.5/knowledge.db`（link v2）

| | same | different | unsure |
| --- | --- | --- | --- |
| キーが同じ | 1160 | 31 | 38 |
| キーが違う | 1478 | 9540 | 269 |

### キーは同じ、モデルは different（全 31 組から 19 組）

| # | 言及 A | 言及 B | 判定 |
| --- | --- | --- | --- |
| 1 | **M1**（前提の記号、eumenes-memory-direction）: 施策に添える前提の記号の一つとして例示されている | **M1**（記憶・概念（言及対象）、eumenes-memory-direction）: eumenes_memory が矛盾をすでに扱えるという、ADD-only の書込みを取り入れない理由で言及される eumenes_memo… | キー（同じ前提 M1） |
| 2 | **Platform**（プラットフォーム、mem0-architecture-shift）: 記憶の減衰と時間推論が発表されたプラットフォーム | **Platform**（対象、memory-research-map）: 施策4でmem0側がstate keyと質問の意図の分類を足した対象。 | キー（mem0 の Platform） |
| 3 | **examples**（資料・データ、eumenes-memory-direction）: 方式Aと方式Bを比較するために用いる例。絞り方を決める材料。 | **examples**（対象・場所、eumenes-memory-direction）: eumenes_memoryの取り込み役を作る場所。 | キー（同じ examples の場所） |
| 4 | **byte 範囲**（コードが決定する事項、eumenes-memory-evaluation）: 語句で分岐する処理は足さないと明記されており、コードが決定する事項の一つ。 | **byte 範囲**（出典の情報、eumenes-memory-direction）: knowledge の根拠の一つ。バイト範囲。 | キー（同じ概念） |
| 5 | **State**（記憶のカテゴリ、eumenes-memory-evaluation）: 本人についての記憶を保存するカテゴリ。種類は好み・本人の事実・制約・習慣・他人についての覚え書きの5種。同じ対象・種類・意味の鍵で有効なもの… | **State**（状態、eumenes-memory-evaluation）: 合成の18件のSeedのうちStateに入るものは10件である | キー（同じ記憶の区分） |
| 6 | **試験**（表の見出し、eumenes-memory-evaluation）: 断片の本文の先頭にある見出し。表の内容を統括する見出し語。 | **試験**（検証手法、memory-research-map）: eumenes_memory の側では実行していない検証手法。 | ？（一般語） |
| 7 | **Eumenes**（対話システム、eumenes-memory-direction）: knowledge と memory の両方を引用する対話。引用するなら対応表を作って揃える。 | **Eumenes**（場所（保持先・システム）、eumenes-memory-direction）: 索引を持つことの推奨対候補。host に持つことが推奨される | キー（） |
| 8 | **quality-80**（品質目標の識別子、eumenes-memory-evaluation）: 回答の評価、品質の目標達成、根拠のない断定のゼロ化を含む複数の目標が未達である状態を指すラベル | **quality-80**（指標・基準、eumenes-memory-direction）: 費用の上限を予約の台帳で守る際に同じく適用される基準。 | キー（同じ品質の目標） |
| 9 | **3 つの信号**（採点に用いられる信号の数、mem0-architecture-shift）: 読み出しで採点に用いられる信号の数 | **3 つの信号**（融合される信号、memory-research-map）: 施策1の候補絞り込みでmem0側が融合し、1回を約7,000 tokenに収める対象。 | キー（mem0 の 3 つの信号） |
| 10 | **公開ベンチマーク**（評価手法、eumenes-memory-evaluation）: mem0 が行う評価。自社の測定による。eumenes_memory では公開ベンチマークはない。 | **公開ベンチマーク**（評価手法、eumenes-memory-direction）: E4の評価では公開ベンチマークでは測られていないとされている | キー（） |
| 11 | **ベンチマークの数値**（mem0 の性能評価の数値、mem0-architecture-shift）: mem0 自身の測定によるベンチマークの結果の数値 | **ベンチマークの数値**（指標、memory-research-map）: 方向の目安としてだけ用いられる数値。事実の確定には用いない。 | キー（mem0 の数値） |
| 12 | **版**（eumenes_memory が持つもの、eumenes-memory-direction）: eumenes_memory が持っているものの一つ。 | **版**（出典の情報、eumenes-memory-direction）: knowledge の根拠の一つ。版（バージョン）。 | ？（一般語） |
| 13 | **mem0**（システム（メモリ機能を持つ）、eumenes-memory-direction）: 知識の記憶・取り出しを行うシステム。アーキテクチャが転換された。 | **mem0**（製品・システム、eumenes-memory-direction）: 複数の信号の融合を行うシステム。方式Bがこれに当たる。 | キー（） |
| 14 | **モデル**（対象・システム、eumenes-memory-direction）: 候補や記憶の本文を受け取って応答を生成する対象。全件を渡すか候補を絞って渡すかの対象。 | **モデル**（検証手法、memory-research-map）: eumenes_memory の側では実行していない検証手法。 | ？（一般語） |
| 15 | **想起**（処理・機能、eumenes-memory-direction）: 記憶から候補を取り出す処理。記憶が数百件を超えると実行できなくなる。 | **想起**（入力処理を行う対象、eumenes-memory-direction）: 質問の意図（「今」「過去」「期間」のいずれを問うのか）を受け取る入力。 | キー（同じ想起） |
| 16 | **記憶**（システムが保持する情報、mem0-architecture-shift）: 時間推論の対象。種類として予定・状態・出来事・関係・好み・不在がある。 | **記憶**（システムの機能、eumenes-memory-direction）: 稼働中の実際の記憶は0件であるとされている | ？（一般語） |
| 17 | **DELETE**（出来事の種別、mem0-architecture-shift）: 旧版が add() から返されていた出来事のうちの1つ。 | **delete**（明示的な操作コマンド、mem0-architecture-shift）: 新では訂正に明示のupdate・deleteだけが用いられる。 | モデル（旧の出来事と新の操作） |
| 18 | **外部のグラフ DB**（外部データベース、mem0-architecture-shift）: OSS版が対応していた外部のデータベース | **外部のグラフ DB**（mem0 の変更・技術、eumenes-memory-direction）: mem0 の変更の一つ。mem0 自身が約 4,000 行ごとに外したため取り入れない。 | キー（） |
| 19 | **関係**（データ構造・概念、mem0-architecture-shift）: 旧はMem0gの型付き関係、新は実体による順位の加点だけ。 | **関係**（検索の経路、eumenes-memory-direction）: eumenes_knowledge の検索が RRF で融合する4つの経路の一つ。 | モデル（mem0 の関係と検索の経路） |

### キーは違う、モデルは same（全 1478 組から 20 組）

| # | 言及 A | 言及 B | 判定 |
| --- | --- | --- | --- |
| 20 | **Platform**（mem0 の形態、mem0-architecture-shift）: mem0 の形態の一つ。時間の扱いを持つ。型付きの関係の応答からは消えた。 | **mem0**（製品・システム、eumenes-memory-direction）: 複数の信号の融合を行うシステム。方式Bがこれに当たる。 | キー（部分と全体） |
| 21 | **Eumenes**（ホスト、eumenes-memory-evaluation）: eumenes-memory の実行時ホスト。接続・transaction・checkpointを持ちます。 | **eumenes_memory**（記憶システム、eumenes-memory-evaluation）: 記憶の件数に対する読み出しと出典からの忘却のp95を計測対象とするシステム。 | キー（別の実体） |
| 22 | **eumenes-memory 0.0.4（本体）**（パッケージ（本体）、eumenes-memory-evaluation）: 純粋な API（`.`）と SQLite に永続する API（`./sqlite`）を持つライブラリ。実行時の依存はなく、接続・transa… | **0.0.4**（版番号、eumenes-memory-evaluation）: Eumenes の vendor の版番号。同じ版番号で中身が異なるものが2つ存在する | ？（版と本体） |
| 23 | **mem0**（システム・プロジェクト、mem0-architecture-shift）: LLM を用いた記憶システムの開発元。書込み方式の転換について記述している。 | **この文書**（文書、mem0-architecture-shift）: mem0 の記述を採った文書。 | キー（紹介する文書） |
| 24 | **意味・キーワード・実体の3つの信号**（取り出しの信号、eumenes-memory-direction）: mem0 の取り出しが融合する3つの信号。 | **mem0**（記憶システムの名称、memory-research-map）: 2026年4～5月にアーキテクチャの転換が行われたシステム。ADD-only、グラフの削除、複数の信号の融合、時間推論の変更を含む | キー（部分） |
| 25 | **mem0**（システム・製品、mem0-architecture-shift）: 評価の軸が「小さな予算で答える」へ移るセクションで論じられているシステム。取得あたりのトークン数や本番環境での成り立ちやすさについて言及され… | **The Token-Efficient Memory Algorithm**（mem0 のブログ記事（アルゴリズム解説）、mem0-architecture-shift）: mem0 の新しいアルゴリズム・数値・注意書きを扱う記事。2026-04-16 の公開で 9-28 に更新。 | キー（記事） |
| 26 | **mem0**（システム・OSS、mem0-architecture-shift）: 記憶機能を持つシステム。2025年の論文と旧OSSと、2026年4月以降のOSSとPlatformがある。 | **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory**（論文、mem0-architecture-shift）: Mem0について記した論文。arXiv 2504.19413として2025-04-28に公開された。 | キー（論文） |
| 27 | **mem0**（システム・OSS、mem0-architecture-shift）: 記憶機能を持つシステム。2025年の論文と旧OSSと、2026年4月以降のOSSとPlatformがある。 | **mem0 OSS**（オープンソースソフトウェア、eumenes-memory-direction）: 公開データを測る際に同じ条件で用いられるオープンソースソフトウェア | キー（OSS 版は別の実体） |
| 28 | **記憶の更新**（機能、eumenes-memory-direction）: mem0 が最も弱い分類に属する機能の一つ。 | **mem0**（システムまたは手法、memory-research-map）: 訂正・忘却をアプリに任せる方針を持ち、知識の更新と矛盾の解決が最も弱いとされるシステム。 | キー（機能） |
| 29 | **examples/seeds/README.md**（実験記録ファイル、eumenes-memory-evaluation）: eumenes_memory のシードの実験記録を記載したファイル。 | **Seed**（説明対象、eumenes-memory-direction）: READMEで説明されているもの。合成の18件に合わせて直す。 | キー（ファイルと Seed） |
| 30 | **fail closed**（動作方針・概念、eumenes-memory-evaluation）: 整合しなかった場合にシステムが停止する動作方針。 | **出典**（概念 / メタデータ、eumenes-memory-direction）: byte範囲とdigestによって持ち、読める範囲をfail closedで制限する出典。 | キー（別の概念） |
| 31 | **ベンチマークの数値**（指標、mem0-architecture-shift）: mem0 が自社の Platform で測ったもので、ページによって値が食い違い、回答と採点に使ったモデルも書かれていない。 | **mem0**（OSS（オープンソースソフトウェア）、mem0-architecture-shift）: ブログで数値を提供しているソフトウェア。Platform で測った値には OSS にない独自の最適化が含まれるとされる。 | キー（数値） |
| 32 | **Eumenes**（ホスト、eumenes-memory-evaluation）: eumenes-memory の実行時ホスト。接続・transaction・checkpointを持ちます。 | **ホスト**（主体、eumenes-memory-evaluation）: 悪意ある書換えを防ぐ責任を持つとされる。 | モデル（ホスト＝Eumenes） |
| 33 | **Eumenes**（主体 / 所有者、eumenes-memory-direction）: SQLiteを所有する主体。 | **knowledge**（知識、eumenes-memory-direction）: Eumenes が持つ知識。mem0 が OSS から外したグラフの役割を代替する。 | キー（持ち主と知識） |
| 34 | **update**（mem0 の訂正方法、eumenes-memory-evaluation）: mem0 で矛盾を訂正するときの明示的な操作。自動の訂正はない。 | **mem0**（記憶システムの名称、memory-research-map）: 2026年4～5月にアーキテクチャの転換が行われたシステム。ADD-only、グラフの削除、複数の信号の融合、時間推論の変更を含む | キー（操作） |
| 35 | **OSS 版**（オープンソース版のmem0、mem0-architecture-shift）: 外部のグラフDBへの対応をしていたmem0の版 | **mem0**（Mem0、mem0-architecture-shift）: 関係の出力を使っていた利用者にとって後退だと書かれているもの。 | キー（OSS 版は別の実体） |
| 36 | **OSS**（オープンソースソフトウェア、mem0-architecture-shift）: 外部のグラフDBへの対応を約4,000行ごと外したソフトウェア。 | **mem0 OSS**（オープンソースソフトウェア、eumenes-memory-direction）: 公開データを測る際に同じ条件で用いられるオープンソースソフトウェア | モデル（同じ OSS） |
| 37 | **OSS の SDK**（ソフトウェア開発キット（SDK）、mem0-architecture-shift）: mem0 の OSS（オープンソース）版SDK。文書では「変わったこと」が論じられている。 | **mem0**（メモリ機能を提供するシステム・製品、mem0-architecture-shift）: 公式の文書・コード・論文の出典対象となっている mem0 という製品・システム。 | キー（部分） |
| 38 | **tgz**（圧縮ファイル、eumenes-memory-direction）: 同じ版番号で中身の違うものが存在するとされている | **施策 5 配布の管理**（判断事項、memory-research-map）: 判断の一つ。mem0側では関係なしとされ、評価の側では同じ版番号で中身の違うtgzがあるとされる。 | キー（施策と配布物） |
| 39 | **最新の source の host**（試験の時点・対象、eumenes-memory-evaluation）: 最新のsourceのhostで行われた試験。63件成功、3件省略（実際のEumenesを使う任意の試験）、失敗0。 | **host**（役割・主体、eumenes-memory-direction）: planを提供する主体。eumenes_memoryは会話これをapplyに通す。 | キー（試験の時点） |

## `verification/kg-ai-memory/20261108T100152-lfm2.5-relink/knowledge.db`（link v3）

| | same | different | unsure |
| --- | --- | --- | --- |
| キーが同じ | 324 | 67 | 2 |
| キーが違う | 83 | 1080 | 5 |

### キーは同じ、モデルは different（全 67 組から 20 組）

| # | 言及 A | 言及 B | 判定 |
| --- | --- | --- | --- |
| 40 | **本体**（実装の主体、eumenes-memory-evaluation）: モデルを呼びしない実装の主体。host と LLM が判断するのは意味・分類・同義・対象の選択だけである。 | **本体**（eumenes-memory の本体、eumenes-memory-direction）: schema 8 で全文索引を外しており、その判断が守られる。 | キー（同じ本体） |
| 41 | **delete**（mem0 の忘却方法、eumenes-memory-evaluation）: mem0 で忘却を行う操作。履歴に記録される。 | **DELETE**（LLMが選ぶ処理、mem0-architecture-shift）: LLMが更新処理で選ぶ4つの処理の一つ。新しい情報と矛盾する記憶に使う | モデル（新の操作と旧の処理） |
| 42 | **eumenes_memory**（製品・システム、eumenes-memory-direction）: 会話から自動で記憶を作らない。会話をhostのplanからapplyに通す取り込み役をexamplesに作る。 | **eumenes_memory**（知識・記憶システム、eumenes-memory-direction）: eumenes_knowledge との関係において、揃えられるものについて論じられている対象。 | キー（） |
| 43 | **M1**（前提の記号、eumenes-memory-direction）: 施策に添える前提の記号の一つとして例示されている | **M1**（記憶・概念（言及対象）、eumenes-memory-direction）: eumenes_memory が矛盾をすでに扱えるという、ADD-only の書込みを取り入れない理由で言及される eumenes_memo… | キー（同じ前提 M1） |
| 44 | **記憶**（出典・派生物、eumenes-memory-evaluation）: 忘却が届けられる対象の一つ。 | **記憶**（概念、mem0-architecture-shift）: 時とともに溜まるもの | ？（一般語） |
| 45 | **examples**（資料・データ、eumenes-memory-direction）: 方式Aと方式Bを比較するために用いる例。絞り方を決める材料。 | **examples**（対象・場所、eumenes-memory-direction）: eumenes_memoryの取り込み役を作る場所。 | キー（同じ examples の場所） |
| 46 | **実体**（取り出しの要素、eumenes-memory-evaluation）: mem0 の取り出しで意味・BM25と融合される実体。 | **実体**（固有名詞などの実体、mem0-architecture-shift）: ベクトルストアの索引を持つ対象 | キー（mem0 の実体の信号） |
| 47 | **quality-80**（品質目標の識別子、eumenes-memory-evaluation）: 回答の評価、品質の目標達成、根拠のない断定のゼロ化を含む複数の目標が未達である状態を指すラベル | **quality-80**（指標・基準、eumenes-memory-direction）: S2 で残りを終える対象となる品質基準 | キー（同じ品質の目標） |
| 48 | **関係**（記憶機能の構成要素の一つ、mem0-architecture-shift）: mem0 の記憶機能の構成要素の一つ | **関係**（検索の経路、eumenes-memory-direction）: eumenes_knowledge の検索が RRF で融合する4つの経路の一つ。 | モデル（mem0 の関係と検索の経路） |
| 49 | **update**（mem0 の訂正方法、eumenes-memory-evaluation）: mem0 で矛盾を訂正するときの明示的な操作。自動の訂正はない。 | **UPDATE**（出来事の種別、mem0-architecture-shift）: 旧版が add() から返されていた出来事のうちの1つ。 | モデル（新の操作と旧の出来事） |
| 50 | **合成データ**（評価データ、eumenes-memory-evaluation）: 実モデルの評価に使用された合成データ。 | **合成データ**（検証に使用するデータ、eumenes-memory-direction）: 進め方として、どれも合成データと公開データのexamplesで先に確かめるとされる。 | キー（同じ合成データ） |
| 51 | **試験**（表の見出し、eumenes-memory-evaluation）: 断片の本文の先頭にある見出し。表の内容を統括する見出し語。 | **試験**（検証手法、memory-research-map）: eumenes_memory の側では実行していない検証手法。 | ？（一般語） |
| 52 | **書込み**（記憶への書き込み操作、eumenes-memory-evaluation）: CAS（replaces）で行われ、他の書込みとの競合を検出する。 | **書込み**（記憶の書込み処理、mem0-architecture-shift）: 抽出と更新の2段で行われる処理 | モデル（eumenes_memory と mem0 の書込み） |
| 53 | **3 つの信号**（採点に用いられる信号の数、mem0-architecture-shift）: 読み出しで採点に用いられる信号の数 | **3 つの信号**（融合される信号、memory-research-map）: 施策1の候補絞り込みでmem0側が融合し、1回を約7,000 tokenに収める対象。 | キー（mem0 の 3 つの信号） |
| 54 | **新方式**（記憶管理の新方式、eumenes-memory-evaluation）: 矛盾した記憶が並んで溜まる方式 | **新方式**（記憶書き込みの新方式、mem0-architecture-shift）: 1回のLLM呼び出しで事実を追加するだけ（ADD-only）の新方式 | キー（mem0 の新方式） |
| 55 | **出典**（派生物、eumenes-memory-evaluation）: 派生物の一つ。host の出典。 | **出典**（参照元文献または資料、eumenes-memory-evaluation）: State が参照する出典。引用は出典の範囲の bytes と完全に一致しなければならない。 | ？（一般語） |
| 56 | **State**（データ構造またはオブジェクト、eumenes-memory-evaluation）: 出典の参照と UTF-8 の byte 範囲だけを持つ要素。引用が範囲の bytes と完全に一致しなければ受け付けない。 | **State**（状態、eumenes-memory-evaluation）: 合成の18件のSeedのうちStateに入るものは10件である | キー（同じ記憶の区分） |
| 57 | **superseded**（記憶の状態の一種、eumenes-memory-evaluation）: 訂正と忘却の語彙が持つ7つの状態の一つ。 | **superseded**（版（バージョン）、eumenes-memory-direction）: 想起が使うかどうかを切り替える対象となる版。 | キー（同じ状態の名前） |
| 58 | **TypeScript v3.0.0**（SDKのバージョン、mem0-architecture-shift）: 新方式が導入されたTypeScript用SDKのバージョン。 | **TypeScript v3.0.0**（mem0 TypeScript のリリースノート、mem0-architecture-shift）: mem0 の TypeScript v3.0.0 のリリースノート。 | モデル（版とリリースノート） |
| 59 | **モデル**（対象・システム、eumenes-memory-direction）: 候補や記憶の本文を受け取って応答を生成する対象。全件を渡すか候補を絞って渡すかの対象。 | **モデル**（検証手法、memory-research-map）: eumenes_memory の側では実行していない検証手法。 | ？（一般語） |

### キーは違う、モデルは same（全 83 組から 20 組）

| # | 言及 A | 言及 B | 判定 |
| --- | --- | --- | --- |
| 60 | **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory**（論文、mem0-architecture-shift）: Mem0について記した論文。arXiv 2504.19413として2025-04-28に公開された。 | **mem0**（OSS のシステム、eumenes-memory-direction）: OSS からグラフを外したシステム。 | キー（論文） |
| 61 | **Eumenes**（ホスト、eumenes-memory-evaluation）: eumenes-memory の実行時ホスト。接続・transaction・checkpointを持ちます。 | **eumenes_memory**（システムや手法の名前、memory-research-map）: 事実の検証対象として言及される対象。リポジトリの記録とファイルを読んで確認したとされる。 | キー（別の実体） |
| 62 | **mem0/memory/main.py**（ソースコードのファイルパス、mem0-architecture-shift）: mem0 の現在のコードにおける memory モジュールの main.py。確認の出典として言及されている。 | **main.py**（ソースコードのファイル、mem0-architecture-shift）: mem0 の main 枝にあるソースコードのファイル。明示的な update・delete・history が残っているという主張の根拠 | モデル（同じファイル） |
| 63 | **回答の品質の受入**（追加する設計（優先順2）、eumenes-memory-direction）: 足すものの優先順2。根拠のない断定を0にし、独立した判定で確かめること。 | **2. 回答の品質の受入を終える（E3）**（タスク・フェーズ、eumenes-memory-direction）: 回答の品質の受入を終えることを目的とするタスク。E3は該当フェーズの番号。 | モデル（同じ施策） |
| 64 | **mem0**（アーキテクチャ、mem0-architecture-shift）: 記憶を扱うシステムのアーキテクチャ。自動の更新・削除がなくなり、明示的な操作が求められる設計に転換された。 | **mem0/memory/main.py**（mem0 のコード（main 枝）、mem0-architecture-shift）: mem0 の main 枝のコード。add() の段階と、明示の操作が残っていることを示す。 | キー（ファイル） |
| 65 | **書込み**（記憶への書き込み処理、mem0-architecture-shift）: mem0 の記憶機能の構成要素の一つ | **2段の書込み**（記憶の書込み方式、mem0-architecture-shift）: Mem0の旧方式として言及される書込み方式。 | キー（上位と下位） |
| 66 | **Platform**（mem0 の構成要素、eumenes-memory-evaluation）: mem0 のうち、state key で古い状態を終わらせ、質問の意図で並べ替える部分。時間管理はここだけ。 | **mem0 の Platform**（製品・サービス、eumenes-memory-direction）: mem0が提供するプラットフォーム。数値の比較対象にはしない。 | モデル（同じ Platform） |
| 67 | **mem0**（一般の記憶ライブラリ、eumenes-memory-evaluation）: eumenes_memory と比較対象として挙げられる、一般の記憶ライブラリ。 | **mem0 OSS**（オープンソースソフトウェア、eumenes-memory-direction）: 公開データを測る際に同じ条件で用いられるオープンソースソフトウェア | キー（OSS 版は別の実体） |
| 68 | **mem0**（一般の記憶ライブラリ、eumenes-memory-evaluation）: eumenes_memory と比較対象として挙げられる、一般の記憶ライブラリ。 | **mem0ai/mem0**（プロジェクト・リポジトリ、mem0-architecture-shift）: Hysen Labsが公開するmem0に関するプロジェクト資料。 | モデル（mem0 のリポジトリ） |
| 69 | **host**（役割・主体、eumenes-memory-direction）: planを提供する主体。eumenes_memoryは会話これをapplyに通す。 | **host の plan**（計画、eumenes-memory-direction）: 本人の事実を記憶にするつなぎ方において通す計画。 | キー（部分） |
| 70 | **mem0**（Mem0、mem0-architecture-shift）: 関係の出力を使っていた利用者にとって後退だと書かれているもの。 | **mem0 のアーキテクチャ転換が何をもたらすか**（文書（リンク）、memory-research-map）: 順1の文書。2026年4～5月のmem0の変更と、それがもたらすものについて、出典と根拠の確かさつきで記述する | キー（紹介する文書） |
| 71 | **delete**（mem0 の忘却方法、eumenes-memory-evaluation）: mem0 で忘却を行う操作。履歴に記録される。 | **明示の `update`・`delete`・`history` が残る**（mem0 のアーキテクチャに関する主張、mem0-architecture-shift）: mem0 に明示的な update、delete、history の機能が残っているという主張 | キー（主張） |
| 72 | **Platform**（プラットフォーム、mem0-architecture-shift）: mem0 が提供するとされるPlatform。 | **Graph Memory（Platform）**（Platform のグラフ記憶のページ、mem0-architecture-shift）: Platform のグラフ記憶の今の形を扱うページ。 | キー（ページ） |
| 73 | **README**（文書、eumenes-memory-evaluation）: 会話履歴から抽出した50件のSeedとState候補28件を案内している文書 | **README.md**（ドキュメントファイル、eumenes-memory-evaluation）: eumenes_memory の設計と状態を確認するために読み込まれたファイル。 | ？（どの README か不明） |
| 74 | **配布の管理**（追加する設計（優先順4）、eumenes-memory-direction）: 足すものの優先順4。中身が変わるたびに版番号を上げ、cleanなcommitからだけ配布物を作ること。 | **5. 配布の管理を正す（E5）**（配布管理の施策、eumenes-memory-direction）: 配布物の管理を正すための施策。E5というコードが付いている。 | モデル（同じ施策） |
| 75 | **約 7,000 token**（mem0 の取り出し量、eumenes-memory-evaluation）: mem0 が取り出しを1回に行う際のtoken数。 | **7,000 token**（mem0 が 1 回で答えるトークン数、eumenes-memory-evaluation）: mem0 が 1 回に約答えるトークン数。eumenes_memory は全件を送るため記憶が増えるほど不利になる。 | モデル（同じ量） |
| 76 | **0.0.4**（版番号、eumenes-memory-evaluation）: eumenes_memory の版番号の一つ。中身の違う tgz が複数存在する。 | **本体 0.0.4**（版（バージョン）、eumenes-memory-direction）: 未コミットの取り込みの一方の版。コミット `30721f30aa19` を持つ | ？（版と本体） |
| 77 | **host**（別パッケージ（CLI・MCP）、eumenes-memory-evaluation）: 記憶の意味の判断を担当する別パッケージ。CLI と MCP からなる。 | **host の稼働**（評価項目、eumenes-memory-evaluation）: 2026-11-07の稼働評価。合成4件と出典の有効性2件が合格し、記録自身が「小標本」と明記 | キー（評価項目） |
| 78 | **host**（別パッケージ（CLI・MCP）、eumenes-memory-evaluation）: 記憶の意味の判断を担当する別パッケージ。CLI と MCP からなる。 | **vendor/eumenes-memory-host/**（ベンダーパッケージディレクトリ、eumenes-memory-evaluation）: Eumenes に含まれる eumenes-memory-host の manifest と tgz を格納するディレクトリ。 | キー（置き場所） |
| 79 | **記憶から小さな予算で取り出す**（記憶システムの特徴・機能、eumenes-memory-evaluation）: 多くの記憶から小さな予算で取り出す部分。mem0 が力を入れていたが、eumenes_memory は持っていない機能。 | **多くの記憶から小さな予算で取り出す**（mem0 が力を入れた機能、eumenes-memory-evaluation）: mem0 が重点的に開発した機能。多くの記憶から小さな予算で記憶を取り出すこと。eumenes_memory が持たない部分。 | モデル（同じ機能） |

