# eumenes_knowledge 開発計画

作成日: 2026-11-07

状態: 計画案。今回の作業はディレクトリと本書の作成まで。ライブラリ、examples、CLI、MCP、tgz、Eumenesへの接続は未実装。以下の詳細契約は実装前に確定する。

## 1. 目的と合意済みの前提

Eumenesに集約した文書を、会話・制作・coding agentから同じ知識として利用する。文書の検索、対象と関係の抽出、関連文書の探索、引用根拠の取得を担う。

- プロジェクト名・パッケージ名は `eumenes_knowledge`。先に検討したAriadneという名前は使わない。
- 独立ディレクトリで開発・検証し、実行用JavaScriptと型定義を含むtgzとしてEumenesへ導入する。
- Markdown文書の正本はDocling Desk。独自の文書編集画面、文書ライブラリ、正本となる版履歴を追加しない。
- 本番の索引・グラフ・取り込み状態はEumenesが所有する。利用者やcoding agentごとに別の知識インスタンスを作らない。
- Eumenesはライブラリを直接利用する。CLIとMCPはEumenesの認証付き公開APIを呼び、同じ知識を利用する。MCPは初期リリースの範囲に含める。
- Eumenesの技術スタック、単一writer、既存queue、認証、LARM接続を再利用する。汎用化のための大きな抽象層を先行導入しない。
- examplesには、Eumenesが本番で提供する環境をmockでエミュレートする検証用ホストを用意する。これは合成資料を使う開発環境であり、本番の別データインスタンスではない。

## 2. 所有境界とデータの流れ

```text
Eumenes Web／会話 ──────────────┐
coding agent → MCPクライアント ─┼→ Eumenesの認証付きAPI
CLIクライアント ───────────────┘           │
                                          ▼
                              eumenes_knowledge（tgz）
                                │                 │
                         索引・グラフ        ホストから渡す機能
                                │                 ├─ Docling文書取得
                      Eumenes所有のSQLite          ├─ LARM推論・埋め込み
                                                  └─ queue・writer・認可
```

| 担当 | 所有するもの |
| --- | --- |
| Docling Desk | Markdown本文、文書ID、外部の版情報。編集用recoveryは検索対象にしない |
| 本パッケージ | 文書処理・検索の契約、抽出指示、索引とグラフのSQL・migration、根拠追跡、更新・失効処理 |
| Eumenes backend | 接続設定と秘密、認証・認可、DB接続とtransaction、queue、実行・取消、API公開、回答への根拠採用 |
| CLI・MCP | 公開APIのクライアント。別DB・別索引・独自の推論接続を持たない |
| examplesのホスト | 合成資料、mock外部機能、一時SQLite、テスト用認証・実行制御。本番環境を変更しない |

索引に必要な文書断片・抽出結果・処理用スナップショットは派生データとして保存できる。原文の独立した編集・正本管理には使わず、元の文書ID・版・digestへ結び付け、再構築と失効の対象にする。

Memoryが担う個人情報や好み、Worldが担う採用済みの主張・条件・依存推論は移管しない。文書由来の関係をWorldの確定事実へ自動昇格させない。初期版は会話全履歴や既存Memoryを自動取り込みしない。

## 3. 技術スタックの方針

| 分野 | 採用方針 |
| --- | --- |
| 実行環境 | Bun。Eumenesの採用版に揃えて検証し、Pythonランタイム・別のPythonサービスを必須にしない |
| 言語・モジュール | TypeScript、ESM。配布はビルド済みJavaScriptと `.d.ts`。初期版でNode互換まで保証しない |
| 保存 | `bun:sqlite`。本番はEumenesのDB接続・単一writerを利用し、パッケージから別接続やtransactionを勝手に作らない |
| 入出力契約 | Eumenesと同系統のZod 4。ライブラリ・API・CLI・MCPで同じ契約を共有する |
| HTTP | ホスト用の接続とexamplesはHono・標準Request/Response・fetch。coreにはHTTPサーバーを持ち込まない |
| MCP | Eumenesで採用しているMCP SDK系列を確認して揃える。MCP依存は入口へ閉じ込める |
| LLM・埋め込み | ホストから関数と実行条件を渡す。Eumenesの保存済みLARM設定・catalog・確保／解放・取消を再利用する |
| 指示の管理 | 抽出・検索に使う指示を版付き資源として管理する。Eumenesの既存SystemContext構成・ビルドとの接続を確認する |
| 試験・静的検査 | `bun test`、Eumenesと同系統の型検査・oxlint・formatter。必要なツールだけ導入しlockで固定する |
| ログ | ホストへ構造化イベントを渡し、Eumenesでは既存loggerへ接続する。本文・秘密・Provider生応答を通常ログへ出さない |

着手時の参照値はEumenesの `package.json`（Bun 1.4.4、TypeScript 7.0.2、Zod 4.4.3、Hono 4.12.34）。将来の「最新版」を独自に追わず、導入先との互換性を基準に更新する。開発ツールと型定義も含め、実装開始時に整合を再確認する。

検索用の保存もSQLiteを基本とし、Neo4j等の別DBサーバーやベクトル用native拡張を初期必須にしない。全文検索・ベクトル検索の具体方式、対象規模、予算はP0で測定条件とともに確定する。日本語の分かち書きや表記差について、SQLite全文検索だけで意味検索を満たしたと判断しない。

## 4. LightRAGの利用範囲

LightRAGをそのまま梱包せず、必要な処理・指示を選んでTypeScriptへ移植する。部分移植の対象と、独自実装する接続・保存契約を区別する。

| 対象 | 方針 |
| --- | --- |
| 文書からの対象・関係抽出 | 抽出プロンプトと根拠へ戻る設計を評価・部分採用する |
| 対象・関係・文書断片を組み合わせる検索 | 必要な検索経路を比較し、効果のある範囲を移植する |
| 文書分割 | Markdownの見出し・本文位置を保持する。分割は構造・容量の処理とし、意味上の分類はLLMが行う |
| 保存・排他・実行 | EumenesのSQLite・writer・queue・LARM契約へ合わせて実装する |
| UI・FastAPI・Provider管理・PDF変換・最終回答生成 | 移植しない。既存のEumenes・Doclingの機能を利用する |

移植前にupstreamのcommit、対象ファイル、ライセンス、変更点を固定して記録する。コピー・翻案した部分の著作権表示とMITライセンスを配布物へ含める。本パッケージ全体のライセンスと第三者表示はP0で確定する。

LightRAGのグラフは基本的に無向の関係を扱う。これをWorldの方向を持つ依存・因果へそのまま適用しない。初期版の関係型・方向性・出典との対応は文書探索の用途に合わせてP0で定義する。

Python版と同等の性能・精度、LightRAG全機能への互換性は約束しない。検索方式の比較は同じ資料・質問・推論条件で行い、品質と費用を測定して採用範囲を決める。

## 5. 公開契約と取り込み・検索

### 5.1 ライブラリ境界

次の少数の公開操作・依存を定義し、プラグイン基盤や独自の実行フレームワークを作らない。以下は契約候補であり、関数名・schema・上限はP0で固定する。

- 文書入力: source namespace、認可されたscope、文書ID、版、本文digest、Markdown本文、参照先。
- 推論入力: 版付き指示、参照文書、出力schema、期限、AbortSignal。対象の解釈・関係の分類・検索方針はLLMが担う。
- 埋め込み入力: query／passageの用途、本文、期限、AbortSignal。応答はベクトルと、その空間を識別する情報・次元を持つ。
- 保存: ホストの接続を使う読み取り操作と、ホストtransaction内で呼ぶ同期の更新操作。Eumenes内部の実装をパッケージからimportしない。
- 公開操作: 取り込み準備、抽出結果の適用、検索、関連文書取得、根拠取得、取り込み状態確認、索引上の失効・取り下げ。
- 検索結果: 文書ID・版・digest・引用範囲・該当原文と、検索の完全性・未処理範囲・失効状態を返す。得点だけを事実の正しさとして返さない。

引用範囲は固定したMarkdown本文のUTF-8 byte範囲で表し、引用digestで照合する。分割・正規化・表示用の整形から元の範囲を復元できるようにする。文書と節の位置、条件・否定・未確認状態を落とさない。

### 5.2 取り込みと失効

1. ホストがDoclingから文書と版情報を取得し、権限を確定する。本文と編集用recoveryを分離する。
2. 短い読み書きで処理対象の版・digest・失効世代を固定する。
3. transactionの外で分割・推論・埋め込みを実行する。ホストの実行予算・取消・優先度を引き継ぐ。
4. 同じ版・digest・権限・失効世代であることを再検査し、単一writerのtransactionで索引と状態を反映する。途中失敗は全体を巻き戻す。
5. 新版への更新、利用範囲の変更、取り下げ、取消後に返った古い推論結果は採用しない。同じ版の再投入は重複を増やさない。
6. 検索結果を回答等へ採用する時にも、出典の有効性・認可・版をホストが確認する。外部の更新をまだ確認できていない状態を「最新」と表示しない。

共有対象・関係の根拠は文書・版・断片ごとに追跡する。一つの文書を外した際は、その寄与だけを除き、残る根拠で必要な再計算を行う。原資料を失った派生説明を残存文書の根拠へ付け替えない。

現在確認したDocling文書APIは一覧・GET・PUTを提供し、削除APIや完全な変更feedの存在は確認していない。削除endpointを仮定せず、Eumenesでの明示的な利用除外と、外部の削除・権限変更の検知を区別する。404・一時的な取得失敗・部分一覧だけを根拠に、文書削除や全件照合完了と判断しない。検知と再確認の契約はP0の必須確定事項とする。

### 5.3 意味判断と機械的な処理

コードは入力schema、引用一致、参照、版、容量、認可、transaction、数値計算と実行制御を担当する。特定のユーザー発話・語句・対象名に反応する辞書や正規表現で、意味の判断を置き換えない。

文書内の指示は参照データとして扱い、実行権限へ変えない。別の文書や対象が同じものか、関係が何を意味するかはLLMが判断し、出典と判断の由来を保持する。語句が変わるたびに専用分岐が必要になる設計を採用しない。

## 6. CLI・MCPとEumenesへの集約

- 本番のCLI・MCPは同じAPIクライアントを使う。DBパスを受け取ってEumenesの製品DBを直接開く機能は付けない。
- 初期の利用操作は検索、関連文書、根拠、索引状態とし、明示した取り込み・再索引要求は同じホストの受付・queueへ渡す。受付と処理完了を分けて返す。
- 文書の作成・更新を公開する場合も、既存のDocling保存契約・競合検査と取り込み経路を通す。MCP専用の文書保存先を作らない。最初のCLI/MCP受入に編集操作までは含めない。
- Eumenesが停止中なら接続不能を返す。別のローカル索引や推論サービスを自動作成して代替しない。
- 同じ知識基盤でも、利用者・接続元へ与えられた参照範囲だけを返す。scopeやprincipalをツール入力だけで変更できない。
- MCPの初期transportはローカルのstdioを想定する。MCPプロセスはAPIクライアントだけを持ち、知識データを所有しない。遠隔公開や独自OAuthサーバーは初期範囲に含めない。
- ライブラリのimportでCLI・MCP・HTTP待受・migration・モデル取得を起動しない。入口を明示実行した場合だけ動作させる。

tgzはcore・SQLite操作・API契約／client・CLI・MCPを必要な入口から利用できる構成にする。core利用時にMCPサーバー等を初期化せず、初期から多数のnpmパッケージへ分割しない。

## 7. examples: Eumenes環境のエミュレーター

### 7.1 目的と構成

Eumenes、実Docling、実LARM、製品DB、秘密を必要とせず、配布する公開契約を使って処理を再現できる環境を作る。examples専用の検索・保存ロジックは作らず、本体と同じ関数を呼ぶ。

| 本番でEumenesが提供するもの | examplesでの再現 |
| --- | --- |
| Docling文書取得 | 合成Markdownと文書ID・ETag・digest、一覧ページを返すmock文書サービス。契約の再現はHonoのin-processリクエストで行う |
| LARM推論 | scenarioごとに明示した構造化出力を返すscripted mock。入力schema・期限・取消の伝達も検査する |
| LARM埋め込み | 合成の固定ベクトルと空間識別情報・次元を返すmock。query／passage、空間変更、次元不一致を再現する |
| DBと単一writer | 一時的な実SQLiteと直列writer。SQL・migration・rollback・排他をmockで隠さない |
| queue・実行・時刻 | 明示的にstepを進める最小ホスト。注入時計で待機・取消・遅延応答を再現し、Eumenesの汎用queueを再実装しない |
| 認証付き公開API | 実Honoルートと共通client。テスト用権限を持つ複数のクライアントが同じserviceとDBを共有する |
| MCP接続 | 実SDKとインメモリーtransportでtool discovery、入力検証、tool呼出しを確認する。stdio入口も別の疎通試験で確認する |

mockは外部機能の境界に限定する。schema、公開操作、SQL、API変換、CLI/MCPの変換を通す。fixtureの選択は明示したscenario IDや操作順で制御し、文中の語句から答えを作る疑似LLMを製品コードへ入れない。

### 7.2 実行方法と隔離

- 標準のexamplesはネットワーク不要・待受不要とし、in-processのHTTP transportを注入する。外部通信は許可したmock先以外へ出さない。
- 手動のCLI/MCP接続確認が必要なときだけ、明示的なexampleコマンドでloopbackの検証用ホストを起動する。本番サーバーを停止・起動・再起動しない。
- 一時DBと合成資料は専用の一時ディレクトリに作り、処理終了時に接続を閉じて片付ける。確認用に残す場合だけ明示オプションを使う。
- 個人の環境設定・製品の接続先・秘密・実文書を自動読込みしない。examples起動時にEumenesのdataディレクトリを探索しない。
- 複数のMCP/CLIクライアントが一つのexampleホストへ接続する。クライアントごとのSQLiteを作る方法では検証しない。
- 実接続モードは後段のopt-in試験とし、mockモードの失敗を実接続への自動切替で隠さない。

### 7.3 必須シナリオ

| シナリオ | 確認する結果 |
| --- | --- |
| 取り込み→検索→関連文書→根拠取得 | 同じ文書ID・版・引用範囲に戻れる。候補一覧だけを引用根拠にしない |
| 同じ版の再取り込み | 索引・関係・受付を重複させない |
| 新版への更新 | 新版の適用後に旧版を現在の根拠として返さない |
| 外部更新が検索と根拠採用の間に発生 | 古い参照の採用を拒否し、再取得が必要な状態を返す |
| 共有関係の根拠を一部取り下げ | 残る資料を保持し、外した資料にしかない説明を失効させる |
| 推論中の版変更・取消・権限変更 | 遅れて返った結果を適用しない |
| 保存途中の例外・再起動後の再実行 | transactionが巻き戻り、確定済み状態から重複なく継続できる |
| 不正JSON・範囲外の引用・埋め込み次元不一致 | 保存を拒否し、既存の正常な索引を壊さない |
| 複数クライアント・権限の差 | 同じserviceを利用し、権限外の文書・関係・根拠を返さない |
| API停止・認証失敗・timeout | エラーを返し、別インスタンスを作らない |
| 部分一覧・部分検索・未処理文書 | 未完了の範囲を返し、全件不存在・全件削除と断定しない |
| 日本語・Unicode・リンク・frontmatter | byte範囲とdigestが一致し、元の本文とメタ情報を改変しない |

scripted mockや合成ベクトルの成功は、実LLMの意味理解や日本語検索品質の証明にしない。試験結果をfixture、実接続、実モデル品質、実利用受入に分けて記録する。

## 8. 想定ディレクトリ

以下は将来の配置案。今回作るのは `plan.md` だけであり、このツリーの実装済みを意味しない。

```text
eumenes_knowledge/
  plan.md
  package.json / bun.lock / tsconfig.json
  src/
    contracts/       文書・推論・検索・根拠・ホスト機能の契約
    core/            取り込み・検索・失効（試験は近接配置）
    sqlite/          SQL・migration・transaction内の公開操作
    contexts/        版付き抽出指示と検索用指示
    client/          Eumenes公開API用client
    cli/            CLI入口
    mcp/            MCP入口
  examples/
    host/            Hono・一時SQLite・writer・実行制御
    mocks/           Docling・推論・埋め込み・時刻
    fixtures/        合成Markdownと構造化応答
    scenarios/       更新・取消・共有根拠・複数クライアント
    README.md        mockでの実行方法と実接続との差
  scripts/           検証・build・配布検査
  verification/      結果と測定条件（実データ・秘密は除外）
  THIRD_PARTY_NOTICES / LICENSE
  dist/              生成物
```

## 9. 段階と依存関係

| 段階 | 作業 | 依存 | 完了条件 |
| --- | --- | --- | --- |
| P0 契約・採用範囲 | LightRAG参照commit、公開schema、関係の表現、検索方式・規模、Doclingの更新／失効確認、資源予算・認可、配布とライセンスを確定 | 本書のレビュー | 実装前の判断事項と受入値を固定。根拠のない設計拡張を残さない |
| P1 配布骨格・exampleホスト | ESM/型定義/build、実SQLiteとwriter、mock文書・推論・埋め込み、Honoの共通入口を作る | P0 | 合成文書を同じ公開契約で受け渡せ、失敗・取消を制御できる |
| P2 取り込み・根拠追跡 | 分割、抽出、ベクトル、版・引用・共有根拠、更新と失効を実装 | P1 | 部分試験で新版・取消・rollbackを確認し、exampleから通せる |
| P3 検索・関連探索 | 文書検索、対象／関係経由の探索、根拠取得、完全性と予算を実装 | P2 | 合成データで追跡可能性を確認。既存検索との同条件比較を行える |
| P4 CLI・MCP | 同じAPI clientを使う入口、エラー、JSON出力、実SDKのMCP疎通を実装 | P3 | 複数クライアントが一つのexampleホストの同じ索引を利用する |
| P5 tgz受入 | export、型、migration、指示資源、第三者表示、manifestを梱包 | P4 | cleanなBun環境へtgzだけを導入し、同じexampleを実行できる |
| P6 Eumenes統合・受入 | domainとadapter、Docling取得、LARM、writer、queue、API・toolchainを接続 | P5・Eumenes側の設計合意 | 固定結合→影響domain→実Docling/LARM→Web／coding agentの順で確認 |

順序は部分→結合→通しを守る。未実装段階の失敗を不具合として追わず、各段階が完了してから次の通し確認へ進む。

## 10. 検証・配布の受入条件

### 固定検証

- 将来のコマンド名として `bun run verify` に型・lint・format・部分／結合試験をまとめる。現在は未作成。
- `bun run examples:verify` で7.3のシナリオをネットワークなしで実行し、終了後に待受・子プロセス・一時DB接続が残らないことを確認する。
- `bun run verify:package` でtgzをclean環境へインストールし、公開import・型・migration・指示資源・CLI/MCP入口を検査する。ソースへの相対参照、未宣言依存、postinstallによる起動に頼らない。
- 配布manifestにpackage版、契約版、指示版、migration IDとchecksum、元commitとsource digest、配布内容hash、LightRAGの由来を記録する。tgz自体のchecksumは別途保持する。
- import時にDB接続・migration・ネットワーク・サーバー・モデル取得が起こらないことを検査する。mock・合成資料・検証出力を本体distに混ぜない。

### 品質と実接続

- 現行検索を基準に、同じ資料と質問で、必要な資料の取得率、引用の正確性、関連資料の発見、遅延、推論呼出し数、取り込み費用を比較する。閾値と対象規模はP0で固定する。
- 語句・対象・場面を変えた未見の日本語資料を含める。fixtureに合わせた専用分岐を追加せず、結果が不明・partialの場合を正しく返すことも評価する。
- Eumenes統合時は本体の既存Docling取得・LARM embedder・単一writer・queueを使う。必要なtoolchainは既存のデータドリブン登録手順に従い、パッケージ内部へ登録処理を持ち込まない。
- Eumenes側の固定確認は `bun run verify -- --domain knowledge --domain docling --domain markdown` を計画上の出発点とする。`knowledge` は新設予定であり、現時点で実行可能なコマンドではない。実差分に応じてdialogue・tool-runtime・agent-runtime・capabilities・実行機構の所有domainを追加する。
- fixture成功、実接続成功、意味品質、Webとcoding agentが同じ知識を使う受入を別々に記録する。実接続先はEumenesの保存済み設定を利用し、例示用の固定設定や環境変数を本番へ移さない。
- 現在の作業にはサーバー操作の許可は含まれない。実接続受入時にも、必要な停止・起動・再起動は別途明示許可を得る。

実装中に同じ目的の「仮説・実施・結果確認」が3ラウンド続いた場合、または証拠の増えない同一失敗が続いた場合は、次の編集・再試行の前に目的・残作業・検証条件を見直す。検証中の編集で結果が無効になった場合も同様とし、条件が変わっていない再試行を繰り返さない。

## 11. 今回の成果と残作業

- [x] `/Users/y.noguchi/Code/eumenes_knowledge` を新規作成する。
- [x] 技術親和性、データの集約、LightRAG部分利用、examples、CLI/MCP、tgz、検証と段階を本書へ記録する。
- [ ] P0の詳細契約・採用範囲・測定条件を確定する。
- [ ] P1〜P5を実装し、mock環境とclean tgz受入を通す。
- [ ] Eumenes側の統合設計を合意し、P6の実装と固定・実接続・実利用受入を行う。

本書の作成をもって、各機能の実装・配布・本番接続が済んだとは扱わない。今回、Eumenesのソース、製品DB、設定、サーバーには変更を加えない。

## 12. 参照資料

### Eumenesの既存設計・実装

- [依存と実行環境](../eumenes/package.json)
- [Docling文書APIとの接続](../eumenes/spec/markdown-larm-documents-integration-2026-11-07.md)
- [Docling文書の契約](../eumenes/api/domains/docling/contracts/documents.ts)
- [SQLite・単一writer](../eumenes/api/infrastructure/sqlite/index.ts)
- [保存済みLARM接続による埋め込み](../eumenes/api/application/world/larm-embedder.ts)
- [World tgzと根拠保持の受入](../eumenes/spec/world-evidence-integration-2026-10-31.md)
- [既存CLIのAPIクライアント方式](../eumenes/cli/index.ts)
- [toolchain登録手順](../eumenes/docs/toolchain-extension.md)
- [toolchain検証手順](../eumenes/docs/toolchain-extension-verification.md)

### 上流の仕様・実装

- [LightRAG](https://github.com/HKUDS/LightRAG)
- [LightRAGの抽出・検索処理](https://github.com/HKUDS/LightRAG/blob/main/lightrag/operate.py)
- [LightRAGの抽出指示](https://github.com/HKUDS/LightRAG/blob/main/lightrag/prompt.py)
- [LightRAGの保存契約・無向グラフ](https://github.com/HKUDS/LightRAG/blob/main/lightrag/base.py)
- [LightRAG MITライセンス](https://github.com/HKUDS/LightRAG/blob/main/LICENSE)
- [Open Knowledge Format仕様](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)

上流リンクは調査用であり、移植元の固定を意味しない。P0でcommit URLに固定する。OKFは任意の入出力形式として検討し、既存Docling文書の一括変換やfrontmatter書換えを初期要件にしない。
