# eumenes_memory の評価（2026-11-07 時点）

## 要約

eumenes_memory は、Eumenes の記憶を「判断しない台帳」として切り出したライブラリです。本体はモデルを呼ばず、ベクトル検索も全文検索も持ちません。持つのは、記憶の状態と版、出典の byte 範囲、書込みの競合の検出（CAS）、忘却の依存閉包と journal という、コードで決められる契約だけです。意味の判断は、Eumenes の steward と、別パッケージの host（CLI・MCP）に置いています。

評価の結論は次のとおりです。

- **強い所**: 訂正・停止・撤回・忘却を区別し、忘却が派生物や DB の復元まで届く仕組みは、mem0 を含む一般の記憶ライブラリより厳密です。矛盾は自動で保存せず確認に回し、記憶ごとに「本人が確かめたか、エージェントが推し量ったか」を残します。
- **弱い所**: 自然文の想起は、許可された記憶を全部モデルに渡す方式です。送信全体が 131,072 bytes を超えると拒否し、合成の 1,001 件では約 310KB で収まりません。記憶が増えたときに候補を絞る仕組みがありません。
- **検証の状態**: 試験は厚く、性能も測っています。ただし実モデルの評価はすべて合成データです。自然文の回答の評価は、予定 80 件のうち 30 件を生成した所で予算を使い切り、根拠のない断定を 1 件以上出しています。稼働中の Eumenes で有効な記憶は 0 件で、実際の利用ではまだ確かめられていません。
- **配布の管理**: 同じ版番号（0.0.4、0.1.0）で中身の違う tgz が複数あり、Eumenes 側の取り込みも未コミットです。

mem0 の転換と並べると、eumenes_memory は「書込み時に判断する」側に立ち、その判断を LLM の自動操作ではなく、確認つきの計画（plan から apply）に置いています。mem0 が手放した訂正と忘却の厳密さを持つ一方で、mem0 が力を入れた「多くの記憶から小さな予算で取り出す」部分を持っていません。

## 対象と範囲

リポジトリには 2 つのパッケージがあります。

- **eumenes-memory 0.0.4（本体）**: 純粋な API（`.`）と、SQLite に永続する API（`./sqlite`）を持つライブラリです。実行時の依存はありません。接続・transaction・checkpoint はホスト（Eumenes）が持ちます。
- **eumenes-memory-host 0.1.0**: 本体の上に、CLI と MCP で記憶を読み書きする口を作るパッケージです。Eumenes の process の中で動き、Eumenes の writer・journal・purge を共有します。

意味の判断は上の 2 つ（Eumenes の steward と host）が持ち、色の付いた本体はコードで決められる契約だけを持ちます。

### 記憶するもの

| 対象 | 内容 |
| --- | --- |
| State | 本人についての記憶。種類は好み（preference）・本人の事実（personal_fact）・制約（constraint）・習慣（habit）・他人についての覚え書き（other_person_note）の 5 種。同じ対象・種類・意味の鍵で有効なものは 1 件だけ |
| Records | 外部から取得した資料（text・markdown・json）。会話の原文は入れない。再生成できる資料には鮮度と未使用の期限がある |
| 時間 | 精度つきの成立期間を保存するだけ。今有効かどうかはホストが判定する |

### 持たないもの

- embedding・ベクトル検索・全文検索（全文索引は schema 8 で削除済み）
- 会話の原文のコピー
- 目標・決定・未解決の問い（Continuity）の正本
- World・Consolidation。別リポジトリで、接続部は ExternalDependent と変更の feed だけです
- Rule・Skill（Procedure）。指示の権限を持つので Eumenes が扱います
- モデルの呼び出しと資格情報

### Eumenes との分担

- 保存・要約・統合・忘却の判断は、Eumenes の steward（LLM の step）が持ちます。
- 会話への注入は Eumenes の ContextWindow、turn の想起は Eumenes の turn のベクトル（multilingual-e5、得点 0.8 以上）が担います。
- Eumenes の memory ドメインの約 20 ファイルが本体の API を使います。Records は web 調査の cache（`retainRecord`）や agency（`captureRecord`）からも使います。

## 設計の強み

### 1. 判断とコードの境界がはっきりしている

- 本体はモデルを呼びません。host でも、LLM が判断するのは意味・分類・同義・対象の選択だけです。引用の完全一致、byte 範囲、ID、版、権限、CAS、依存閉包はコードが決め、語句で分岐する処理は足さないと明記しています（`spec/host/implementation.md`）。
- この分け方は、eumenes_knowledge の方針（LLM が判断し、コードが照合する）とも揃っています。

### 2. 訂正と忘却の語彙が細かい

- 状態が 7 種あります（active・inactive・superseded・disputed・retracted・invalidated・forgotten）。可逆の停止（deactivate）と不可逆の忘却を、名前で区別しています。
- 書込みは CAS（`replaces`）で、他の書込みとの競合を検出します。
- どの記憶にも、本人が確かめたか（`user_confirmed`）、本人が直したか（`user_edited`）、エージェントが推し量ったか（`agent_inferred`）を残します。本人が同じ値を確かめると、由来だけを上げ、確認の根拠を追記します。

### 3. 忘却が「消えたこと」まで保証しようとしている

- 忘却は 2 相です。`planForget`（読み取りのみ）で計画を作り、ホストが journal に追記して fsync し、`applyForget` で適用します。
- 依存の閉包を計算し、記憶・出典・派生物（host の計画や出典、別リポジトリの World など）まで忘却を届けます。
- 墓標は永久で、同じ ID の再挿入を trigger で拒否します。
- 起動時に journal と DB を突き合わせ、古い DB を戻しても忘れたものが見えないようにします。整合しなければ止まります（fail closed）。
- 外部への削除の依頼を、pending・unverified・confirmed・failed で追います。
- 物理的な消去は保証しないと正直に書き、host では `secure_delete` を有効にしています。

### 4. 出典を照合できる

- State は出典の参照と UTF-8 の byte 範囲だけを持ち、引用が範囲の bytes と完全に一致しなければ受け付けません。
- 根拠の状態（current・stale・missing・unverified）を、ID・版・digest の照合で決めます。

### 5. 矛盾を自動で片付けない

- host の計画は、新しい記憶と既存の記憶の関係を new・same・supersedes・coexists・conflicts・forget の 6 種で提案します。same と conflicts は実行せず、確認に回します。
- 保存のまとまりは原子的に、忘却のまとまりは再開できる形で適用し、両者を混ぜた計画は拒否します。
- mem0 の旧方式のように LLM が黙って記憶を書き換えることも、新方式のように矛盾した記憶が並んで溜まることも、設計の上では起きません。

### 6. 検証の規律

- 事前登録、凍結、採用・不採用の判定を繰り返し、改善しなかった変更を採らなかった記録が残っています（2026-10-16 の一連）。
- API の費用に上限（10 USD）を置き、予約の台帳で超えないようにしています。評価が終わらなければ、終わっていないと記録しています。
- 性能を件数ごとに測り、運用の条件での予算を決めています。

## 弱点とリスク

### 1. 想起が記憶の量に追いつかない

いちばん大きな弱点です。host の自然文 recall は、許可された範囲の State を全部、1 回でモデルに渡します。送信全体が上限を超えると、モデルを呼ぶ前に `MODEL_INPUT_TOO_LARGE` で拒否します。切り捨てはしません。

256 件までは 16 問すべてが上限に収まり、1,001 件では 16 問すべてが収まりません。

- 本体にはベクトル検索も全文検索もなく（全文索引は schema 8 で削除）、`listState` は更新の新しい順に 1,000 件ずつ返すだけです。量が増えたときに候補を絞る手段がありません。
- Eumenes の中には、想起の経路が別に 2 つあります。turn のベクトル（multilingual-e5）と、会話で使う `read_memory`（2 字の重なりで当たるものを最大 16 件）です。host の recall とは方式が揃っていません。
- この値は合成の fixture でのもので、実際の記憶の平均ではありません。どの件数で上限に当たるかは、本文の長さと付帯情報で変わります。

### 2. 回答の品質の受入が終わっていない

quality-80 の評価（2026-11-05）は、技術の点数 80.4 で目標に達しましたが、品質の目標は未達のまま止まっています。

- 自然文の回答は、予定 80 件のうち 30 件を生成した所で、API の予算（上限 10 USD、使用 9.95 USD）が尽きました。2 つの評価器の両方で採点できたのは 29 件、両方が忠実と判定したのは 26 件、評価器の意見が割れたのは 3 件です。
- 根拠のない断定が 1 件以上あります。たとえば N013 では、「姉が 305 を借りている」という記憶から、本人は借りていないと断定しました（合成の例）。
- 判定は実装と同じエージェントが行い、独立した人のレビューではないと、記録自身が書いています。
- 取得から回答までを通した性能は未測定です。
- standalone の指示 v25 の測定は 90 件中 75 件で、前の v22 の 81 件より下がりました。

### 3. 実際の利用での確かめがない

- 2026-11-07 の稼働確認では、Eumenes の有効な記憶は再起動の前後とも 0 件でした。保存・訂正・忘却・出典は、個人データを使わない結合試験だけで確かめています。
- 実モデルの評価はすべて合成データで、LoCoMo や LongMemEval のような公開ベンチマークでは測っていません。他の記憶システムと比べる物差しがありません。

### 4. 配布と取り込みの管理

- 同じ版番号で中身の違う tgz があります。Eumenes の vendor には 0.0.4 が 2 つ（hash の先頭 `9c0e85aa2fa3` と `30721f30aa19`）あります。host 0.1.0 は、Eumenes の vendor（`3b6091d1b1ea`）と eumenes_memory の artifacts（`2635c13f033c`）で中身が違います。
- Eumenes 側では、新しい tgz の manifest、host の取り込み（`api/application/memory-host.ts`）、`package.json` の変更が未コミットです。
- どの tgz がどの commit から作られたかを、版番号だけでは追えません。

### 5. 文書の食い違い

- README は「会話履歴から抽出した 50 件、State 候補 28 件」の Seed を案内しています。実際に同梱しているのは合成の 18 件で、State に入るのは 10 件です。実データの Seed はすでに外しています。

### 6. 設計が自ら認めている制約

- 利用者が 1 人（単一 principal）である前提です。墓標は principal をまたいで効きます。
- 物理的な消去（空き領域・WAL・OS のスナップショット）は保証しません。
- 復元した直後の DB を、本体だけでは検出できません。外部への削除の確認状況は DB の中にしかなく、古い DB を戻すと pending に戻ります。
- 大きな忘却では、1 つの transaction が長くなります。
- journal は鍵なしの hash の鎖で、偶然の破損だけを検出します。悪意ある書換えを防ぐのはホストの責任です。

## 検証の状態

記録された値をそのまま載せます。測定の日と対象の source が行ごとに違うので、行どうしを足したり比べたりはできません。

### 試験

| 時点・対象 | 結果 |
| --- | --- |
| 2026-11-06 `bun run verify`（本体） | 837 件、失敗 0 |
| 2026-11-06 Eumenes の記憶関連 | 112 ファイル、577 件 |
| 2026-11-07 全体（commit 13f6f47 の source） | 898 件成功、3 件省略、失敗 0 |
| 最新の source の host | 63 件成功、3 件省略（実際の Eumenes を使う任意の試験）、失敗 0 |
| Eumenes 側 `verify --domain memory` | 187 件、失敗 0 |

CI は Linux と macOS で、verify:all・verify:package・verify:host を実行します。

### 実モデルの評価（すべて合成データ）

| 評価 | 結果 |
| --- | --- |
| quality-80 の取得（2026-11-05、各 3 回） | gpt-6-luna: 新しい 120 件で 342/360、既知の回帰 80 件で 237/240。claude-sonnet-5-5: 350/360、234/240 |
| quality-80 の回答 | 予定 80 件中 30 件で停止（「弱点とリスク」の 2） |
| 事前登録の比較（2026-10-16、gpt-6-luna） | 実行の制御 52→96 で採用。同一性の分類 86→99 で保留。候補の選択 78→89 は一括取得と同点で不採用 |
| host の稼働（2026-11-07） | 合成 4 件と、出典の有効性 2 件が合格。記録自身が「小標本」と明記 |

### 性能

| 記憶の件数 | 読み出しの p95 | 出典からの忘却の p95 | 条件 |
| --- | --- | --- | --- |
| 100 | 0.81 ms | 11.9 ms | 運用 |
| 1,000 | 2.98 ms | 59.6 ms | 運用 |
| 10,000 | 29.5 ms | 765 ms | 負荷。忘却の予算 200 ms は運用の条件にだけ適用 |

台帳としての読み書きは速く、1,000 件までは忘却も予算の内に収まります。弱いのは「弱点とリスク」の 1 で示した想起の入力の量で、台帳の速さではありません。

### 未達の受入

- quality-80: 回答の評価が未完了（`answerEvaluationComplete: false`）。品質の目標のすべては達成していない（`allPlanQualityGoalsMet: false`）。根拠のない断定を 0 にする目標も未達（`zeroUnsupportedAssertionGoalMet: false`）。
- 取得から回答までを通した性能と、より大きな本番の負荷は未確認（記録の remaining）。
- 実データでの利用は 0 件。

## mem0 の転換と並べて

mem0 の調査は「[mem0 のアーキテクチャ転換が何をもたらすか](https://claude.ai/artifact/S9HwwfJK7hFTuujn1RBmfz)」にまとめています。同じ問いに、両者がどう答えているかを並べます。

| 問い | mem0（2026 年 4 月以降の OSS） | eumenes_memory |
| --- | --- | --- |
| 何を記憶にするか | 会話から LLM が取り出した事実。エージェントの発言も同じ重み | 本人についての State（5 種）と外部の資料。誰の発言かを origin で区別 |
| いつ判断するか | 書込みでは判断しない（追加だけ）。読み出しの順位で | 書込みの前に plan で判断し、確かめてから apply |
| 矛盾 | 新旧が並んで残る。順位と回答するモデルが選ぶ | conflicts は保存せず確認に回す。同じ鍵で有効なのは 1 件 |
| 訂正 | 明示の `update`。自動の訂正はない | CAS つきの訂正。古いものは superseded として版が残る |
| 忘却 | `delete`（履歴に記録）。派生物への伝播は確かめていない | 依存閉包・墓標・journal・DB の復元まで |
| 取り出し | 意味・BM25・実体を融合。1 回に約 7,000 token | 許可範囲の全件をモデルへ。131,072 bytes を超えると拒否 |
| 関係 | 実体による順位の加点だけ | 持たない（World は別リポジトリ） |
| 時間 | Platform だけ: state key で古い状態を終わらせ、質問の意図で並べ替える | 精度つきの成立期間を保存。今有効かはホストが判定 |
| 評価 | 公開ベンチマーク（自社の測定） | 合成データの事前登録つき評価。公開ベンチマークはなし |

### 読み取れること

- **判断の置き場所が逆**: mem0 は「書込みで判断すると誤って消すし、費用もかかる」として、判断を読み出しへ移しました。eumenes_memory は判断を書込みの前に置き、それを LLM の自動の操作ではなく、確認つきの計画にしました。誤って消す危険は、確認と CAS で抑えています。
- **mem0 の新旧どちらの弱点も設計で避けている**: 旧方式の弱点（LLM が黙って書き換える）も、新方式の弱点（矛盾が溜まる、訂正と忘却がアプリケーション任せ）も、eumenes_memory の設計にはありません。mem0 が残る課題に挙げたプライバシーと削除は、eumenes_memory がいちばん厚く作った部分です。
- **時間の扱いは同じ方向へ近づいている**: mem0 が Platform に足した state key（同じ鍵の新しい状態が来ると古い状態を終わらせる）は、eumenes_memory の「同じ鍵で有効なのは 1 件、古いものは superseded」とほぼ同じ考え方です。mem0 も、書込み時の構造化に一部戻っています（解釈）。
- **取り出しは mem0 が先を行っている**: mem0 が力を入れた「多くの記憶から小さな予算で取り出す」部分は、eumenes_memory が持たない部分そのものです。mem0 は 1 回に約 7,000 token で答えるのに対し、eumenes_memory は全件を送るので、記憶が増えるほど不利になります。
- **評価の物差しが合わない**: mem0 の数値は公開ベンチマーク、eumenes_memory は合成データの独自の評価です。今は、両者の品質を数字で比べることができません。

## 根拠

ファイルを読んだだけで、試験もモデルも実行していません。件数と数値は記録の値です。個人データと資格情報は読んでいません。

**eumenes_memory**（`/Users/y.noguchi/Code/eumenes_memory`、HEAD `2966c06`、未コミットの変更なし）

- 設計と状態: `README.md`、`spec/full-system-design.md`、`spec/improvement-design.md`、`spec/verification-status.md`、`spec/host/implementation.md`、`spec/host/contracts.md`
- 利用の手引き: `docs/host-guide.md`、`docs/cli-mcp.md`
- 契約と保存: `src/domains/state/contracts/index.ts`、`src/infrastructure/sqlite/migrations/`
- host: `packages/host/src/meaning/planning.ts`、`retrieval.ts`、`storage.ts`、`mcp.ts`、`service.ts`
- 実験の記録: `examples/quality/RESULTS.md`、`examples/standalone/README.md`、`examples/seeds/README.md`
- 検証の記録（git の管理外）: `verification-reports/quality-80/` の `completion.json`・`answer-summary.json`・`model-metrics.json`・`performance.json`、`verification-reports/host/`
- 配布物: `artifacts/` の tgz と sha256

**Eumenes**（`/Users/y.noguchi/Code/eumenes`）

- `docs/memory.md`（役割の分担、`read_memory`）
- `api/domains/memory/service/turn-recall.ts`（turn の想起）
- `vendor/eumenes-memory/`、`vendor/eumenes-memory-host/`（manifest と tgz）、`git status` の結果
- `spec/verification/memory-live-2026-11-07/README.md`（稼働確認。未コミット）
- `spec/memory-cli-mcp-package-adoption-2026-11-07.md`

**mem0** の側の根拠は、「[mem0 のアーキテクチャ転換が何をもたらすか](https://claude.ai/artifact/S9HwwfJK7hFTuujn1RBmfz)」の出典を参照してください。
