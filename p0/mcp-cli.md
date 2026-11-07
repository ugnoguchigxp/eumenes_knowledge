# P0: MCP SDK系列とCLI/MCP接続方式

作成日: 2026-11-07

状態: P0の判断資料。製品コードは未作成。spikeは `p0/spikes/mcp/`（`v1/` と `v2/`）。Eumenes本体・APIには接続していない。

## 1. 結論

- 推奨は **`@modelcontextprotocol/server` 2.3.1（v2系列）**。stdio入口は `@modelcontextprotocol/server/stdio` の `serveStdio`、tgzの実行時依存はserver・core・zodの3パッケージ。client（`@modelcontextprotocol/client` 2.3.1）は試験専用のdevDependencyにする。
- 旧 `@modelcontextprotocol/sdk` 1.31.0（v1系列）も同じ試験を全て通った。機能差ではなく依存の重さ（約92パッケージ、express・hono・cors・ajv等を含む）とEumenesの新規採用方向（dots-mcpがv2）で選ぶ。
- CLI/MCPの接続設定は既存Eumenes CLIの規約（`EUMENES_URL`、`EUMENES_API_TOKEN`、終了コード0/2/3/4/5、stdout=結果・stderr=診断）に揃え、**data ディレクトリ・DBパス・`data/keys` を探索する既存の `readApiToken` 既定経路は使わない**（§5）。

## 2. 候補の比較

### 2.1 レジストリ情報（`npm view`、2026-11-07）

| 項目 | (a) v2: server/client/core 2.3.1 | (b) v1: sdk 1.31.0 |
| --- | --- | --- |
| パッケージ構成 | `server`・`client`・`core` に分割。server → core + zod、client → core + zod + jose・cross-spawn・eventsource・pkce-challenge・eventsource-parser | 単一 `sdk` |
| 直接依存 | server: 2（zod ^4.2.0, core）／client: 7 | 17（ajv, zod, cors, hono, jose, express ^5.2.1, raw-body, ajv-formats, cross-spawn, eventsource, content-type, pkce-challenge, @hono/node-server, json-schema-typed, eventsource-parser, express-rate-limit, zod-to-json-schema）。peer: zod ^3.25 \|\| ^4.0 |
| stdio server | `@modelcontextprotocol/server/stdio`: `serveStdio(factory)`、`StdioServerTransport` | `sdk/server/stdio.js`: `StdioServerTransport` |
| stdio client | `@modelcontextprotocol/client/stdio`: `StdioClientTransport` | `sdk/client/stdio.js`: `StdioClientTransport` |
| インメモリー | `InMemoryTransport.createLinkedPair()`（server・client両方からexport） | `sdk/inMemory.js`: `InMemoryTransport.createLinkedPair()` |
| Zod 4 | StandardSchema。`z.strictObject` を `inputSchema` へ直接渡す | zod 3/4 両対応（zod-to-json-schema を同梱）。同じschemaが通った |
| engines | node >=20 | node >=18 |
| 公開日 | 2.3.1: 2026-10-05（2.4.0: 2026-10-23 が最新） | 1.31.0: 2026-09-28（1.32.2: 2026-10-23 が最新） |
| 位置付け | READMEが「v2 is the stable release line」と明記 | v2の前身。保守方針は未確認 |

### 2.2 実測（Bun 1.4.4、Zod 4.4.3、macOS arm64）

| 項目 | v2 | v1 |
| --- | --- | --- |
| 実行時依存パッケージ数（devDependency除外、別ディレクトリで `bun install`） | server のみ 3、server+client 14 | 約92（`node_modules` 24MB） |
| 同 `node_modules` サイズ | server のみ 14MB／server+client 22MB | 24MB |
| `bun build --target bun` の stdio 入口 | 0.74MB | 0.69MB（express等は読み込まれず、差は配布物でなく install のみ） |
| stdio server 起動→stdin終了まで | 約0.03〜0.04秒 | 約0.05秒 |
| `bun test`（spike、§3） | 11 pass / 0 fail（5回連続で安定） | 11 pass / 0 fail（5回連続で安定） |
| `tsc` 7.0.2 strict（spike一式） | エラー0 | エラー0 |
| 試験後の残存子プロセス（`pgrep`） | なし | なし |

Eumenesでの現況（読み取りのみ）: `packages/dots-mcp` は `@modelcontextprotocol/server` 2.3.1（HTTP、`createMcpHandler` stateless）、`packages/coding-runner` は `@modelcontextprotocol/sdk` 1.31.0（`sdk-git-mcp.ts` が `McpServer` + `StdioServerTransport`）。同一リポジトリに両系列が既にある。

## 3. spike

場所: `p0/spikes/mcp/v2/`、`p0/spikes/mcp/v1/`（各 `package.json`、exact version固定、`bun.lock`、`src/`、`test/`）。`node_modules` は `bun install` で再生成できる。

構成（両系列で同形）:
- `src/server.ts`: `createServer(api)` が `search` tool（入力 `z.strictObject({query: string 1..200, limit?: int 1..50})`）を登録して返す。import時は何も起動しない。tool本体は例外を `^knowledge_[a-z_]+$` の安全なコードへ丸め、それ以外は `knowledge_operation_failed` に固定する。比較用に丸めない `raw_throw` tool も置く（製品には入れない）。
- `src/stdio-main.ts`: 明示実行した時だけstdioで待受する入口。

試験（`cd p0/spikes/mcp/v2 && bun test`、`v1` も同じ）:

| 試験 | 内容 | v2 | v1 |
| --- | --- | --- | --- |
| inmemory | 実clientとlinked pairで接続。tools/list（JSON Schemaの `required`・`maximum`・`additionalProperties:false`）、正常なtools/call、schema違反5種（型・下限・非整数・未知キー・必須欠落）の拒否、server例外を安全コードで返却（`secret-token` を含まない）、丸めない例外の観察 | 5 pass | 5 pass |
| import-side-effect | serverモジュールを子プロセスでimport。stdinを開いたままでも自力で終了し、終了コード0、stdout空 | 1 pass | 1 pass |
| stdio | 実client（`StdioClientTransport`）が `bun src/stdio-main.ts` を起動し、tools/list・tools/call・server例外の丸めを確認。`finally` で `client.close()` し、pidが消えたことを確認（残れば自分が起動した子だけSIGKILL）。stdin終了で子が終了コード0・非signalで自発終了 | 2 pass | 2 pass |
| stdio-raw | 生JSON-RPCで旧era `initialize`（2024-11-05、2025-06-18、2025-11-25）→ tools/list → tools/call。stdoutの全行がJSON-RPCであることも検査 | 3 pass | 3 pass |

観察（試験出力）:
- schema違反は両系列とも例外ではなく `isError: true` のtool結果で返る。本文はSDK生成で、v1は `MCP error -32602: Input validation error: ... at query`、v2は `Input validation error: Invalid arguments for tool search: query: ...`。**文言は系列で異なるので、試験は `isError` と有無だけを検査し、文言を契約にしない。**
- 丸めない例外（`raw_throw`）は、両系列とも例外の文言（`secret-token-abc123 leaked`）がそのままtool結果に出る。**SDK既定では内部文言が漏れる。全toolを共通のラッパーで登録し、丸め忘れを試験で検出する。**
- `StdioClientTransport.close()` は2ms程度で子を終了させた（両系列）。
- クライアント既定のリクエストtimeoutは両系列とも60秒（`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`）。

実行コマンド（再現用）:

```text
bun --version                                  # 1.4.4
cd p0/spikes/mcp/v2 && bun install && bun test # 11 pass / 0 fail
cd p0/spikes/mcp/v1 && bun install && bun test # 11 pass / 0 fail
npm view @modelcontextprotocol/{server,client,core}@2.3.1 / @modelcontextprotocol/sdk@1.31.0
tsc -p .（TypeScript 7.0.2、spike外に導入）     # 両方エラー0
```

## 4. 推奨と理由

推奨: v2系列（`@modelcontextprotocol/server` 2.3.1、exact固定）。

1. 「MCP依存は入口へ閉じ込める」に合う。実行時依存が3パッケージで、express・hono・corsを持ち込まない。v1は同じ機能に約92パッケージを要し、`verify:package` のclean install対象が増える。
2. Zod 4をStandardSchemaとして直接扱う。zod-to-json-schema等の変換層が要らない。
3. 新規採用の方向がEumenes（dots-mcp）と一致し、READMEがstable lineと明記している。
4. 機能面ではv1と差がなく（§3）、v1にある実績（coding-runnerのstdio）が必須の根拠にならない。

v1を選ぶ場合の条件: v2 API変更への追従を避けたい、またはEumenes側でv1に統一する方針が決まった場合。試験はそのまま移せる（差は `import` 先と `serveStdio` の有無のみ）。

残るリスク:

| リスク | 内容 | 対応 |
| --- | --- | --- |
| v2の変化 | 2.3.1 の約3週間後に 2.4.0 が出ている。minorでのAPI変更の程度は未確認 | exact固定。更新はEumenesの採用版と一緒に行い、spikeを回帰試験に流用する |
| 実clientとの互換 | 自前のv2 clientと生JSON-RPC（旧era 3版）での疎通のみ。Claude Code・Codex等の実agentからの接続は未確認 | P4で実agentのstdio設定による疎通を別に記録する |
| v2のera選択 | `serveStdio` は旧era（2025系）のinitializeを既定で受ける（生JSON-RPCで確認）。新era（2026-07-28）のclient側の挙動は未確認 | `legacy` オプションの扱いを変えない。変える場合はP4で試験する |
| 例外文言の漏洩 | SDK既定では漏れる（§3） | 共通ラッパー必須。試験で `secret-token` 相当を投げて確認 |
| 検証エラー文言 | SDK生成で系列間差あり。入力値がエラー文へ入る型（enum等）は未確認 | 文言を契約にしない。入力値を含み得る検証はAPI側でも行い、MCP側は固定コードへ丸める余地を残す |
| 待機とtimeout | clientの既定60秒が、Eumenes CLIの起動待ち60秒（`STARTING_WAIT_MS`）と同じ | MCPの起動待ちは短くする（§5.4） |
| 重複する系列 | Eumenesの`bun.lock`にv1とv2が共存する。tgzを導入した時の解決・重複は未確認（P5・P6） | `@modelcontextprotocol/server` を exact依存にし、zodはEumenesの4.4.3と一致させる |
| 環境 | Bun 1.4.4 + macOSのみ確認。Windows、Node実行は範囲外・未確認 | 範囲外のまま |
| キャンセル | MCPのcancel通知からAPI fetchのAbortSignalへ伝わるかは未確認 | P4で試験 |

## 5. CLI/MCPの接続設定案

### 5.1 設定の渡し方

| 項目 | 案 | 備考 |
| --- | --- | --- |
| URL | `--url <URL>`、なければ `EUMENES_URL` | 既存CLIと同名。**パッケージに既定値を埋め込まない**（未指定は引数エラー2）。既存CLIは `http://127.0.0.1:8787` が既定。揃えるかは判断事項 |
| トークン（値） | `EUMENES_API_TOKEN`（24文字以上） | 既存と同名・同検証。コマンド引数で値を渡す `--token` は付けない（`ps` に出る） |
| トークン（ファイル） | `--token-file <path>` または `EUMENES_API_TOKEN_FILE`。**利用者が明示したパスだけ**読む | 内容はtrimして既存形式（64桁hex）を検査。パスはエラー・ログへ出さない。ファイル権限が広い場合の警告は任意 |
| 優先順位 | 引数 > 環境変数。トークンは「ファイル指定」と「値」が両方あれば引数エラー2 | 曖昧な暗黙選択をしない |
| 検査 | 既存 `createTransport` と同じ（http/https、userinfo禁止、`127.0.0.1`・`localhost`のみ） | 遠隔公開は初期範囲外 |
| MCPの設定 | stdio起動する側（agentの設定）が上の環境変数を子プロセスへ渡す。`StdioClientTransport` は既定で安全な変数だけ継承するので、明示的に渡す | 設定ファイルへ値を置くより `EUMENES_API_TOKEN_FILE` のパスを置く方を推奨 |

探索しないもの（既存CLIとの差）: 既存CLIの `readApiToken` は `EUMENES_API_TOKEN` が無いと、`EUMENES_DB`・`EUMENES_KEY_DIR`、さらにリポジトリ相対の `data/eumenes.sqlite3` を基点に `keys/api.token` を探す。この経路は**使わない**。使うのは `createTransport`／`ApiError`／`ApiConnectionError` に相当するclient部分だけにする。examples起動時も、環境変数・ホームの設定・dataディレクトリを自動読込みしない（設定は呼出し側がオブジェクトで渡す）。トークン未設定時のエラーに、探索したパスを含めない（既存は `api_token_not_found:<path>`）。

### 5.2 トークンを出さない

- `Authorization` ヘッダ、トークン値、トークンファイルのパス、環境変数の一覧をログ・エラー・tool結果へ出さない。例外オブジェクトを `String(error)` で丸ごと出力しない。
- API応答の `error`（コード文字列）と `X-Request-Id` だけを診断へ出す。応答bodyの `message`・`detail`・生bodyはMCP tool結果へ転送しない（CLIのstderrは既存どおりコードとrequest IDまで）。
- MCP tool結果は §3 の丸めを通す。許可する形は `^knowledge_[a-z_]+$` のコードのみ。
- 試験で既知のダミートークンを設定し、stdout・stderr・tool結果・例外に含まれないことを検査する（未実装）。

### 5.3 出力の分離

- CLI: 結果のJSONはstdoutのみ（`--json` は1行、省略時は整形）。診断・エラーはstderr。エラー時にstdoutへ何も出さない。既存の規約どおり。
- MCP（stdio）: stdoutはプロトコル専用。`console.log` を使わない。診断はstderr。spikeの `stdio-raw` 試験が、stdoutの全行がJSON-RPCであることを検査している。
- tool成功: `content`（JSON文字列）と `structuredContent`。失敗: `isError: true` と安全コード1つ。

### 5.4 状態と応答の対応表

既存の `cli/failure.ts` の写像（起動中503を待った後→5、401→2、他のApiError→3、接続不能→5、入力違反→2）を出発点にする。★は既存との差または新設。

| 状況 | 検出 | CLI終了コード・stderr | MCP tool結果（`isError`のtext） | 再試行 |
| --- | --- | --- | --- | --- |
| 正常 | 2xx | 0 | 成功（structuredContent） | - |
| 引数・schema違反 | CLI: 自前検査。MCP: SDKの入力検証 | 2 | SDK生成の検証エラー（`isError`。文言は契約にしない）★固定コードへ丸めるかは判断事項 | 不可 |
| 起動中（503 `server_starting`） | 待機後も503 | 5。「起動中。準備後に再実行」 | `knowledge_server_starting` | 可 |
| 停止中・接続不能 | `ApiConnectionError` | 5。接続先URLのみ表示（トークンなし） | `knowledge_unavailable`。別インスタンス・代替索引は作らない | 可（Eumenes起動後） |
| 認証失敗（401） | `ApiError` 401 | 2 | `knowledge_auth_failed` ★ | 設定修正後 |
| 権限外（403等） | `ApiError` | 3（既存の「他のApiError」） | `knowledge_forbidden` ★。存在有無を漏らさない文言はAPI契約（P0別項）で決める | 不可 |
| 処理失敗（4xx/5xx） | `ApiError` | 3。`error` コードと `API request ID` | `knowledge_request_failed` + API側の安全コード（allow-list通過分） | 内容次第 |
| timeout（読み取り：検索・関連・根拠・状態） | `TimeoutError`/`AbortError` | 4（待機結果不明）★既存はweb操作のみ4 | `knowledge_timeout` | 可 |
| timeout（取り込み・再索引要求） | 同上 | 4。受付の有無は不明。`--request-id` で同じ要求を照会・再試行（既存`send`の方式） | `knowledge_timeout`。受付不明であることを本文に含める | request IDで可 |
| 応答が契約と不一致（Zod parse失敗） | `callJson` のparse失敗 | 3 ★（既存は一般例外のfallbackで2になる） | `knowledge_invalid_response` ★ | 不可 |
| 想定外の例外 | 上記以外 | 2（既存fallback）。3へ寄せるかは判断事項 | `knowledge_operation_failed` | - |

起動中の待機: CLIは既存どおり60秒（`STARTING_WAIT_MS`）。MCPはclientの既定timeoutが60秒なので、同じ60秒だと待機中にclient側が先に切れる。MCPの待機は20秒以内にして `knowledge_server_starting` を返す（20秒は提案値で未実測）。待機中も別インスタンスは作らない。

## 6. 判断事項

1. SDK系列: v2を採用してよいか（推奨）、またはv1に統一するか。
2. URLの既定値: パッケージには埋め込まない案（推奨）か、既存CLIに合わせて `http://127.0.0.1:8787` を既定にするか。
3. `EUMENES_API_TOKEN_FILE` と `--token-file` を新設してよいか（既存CLIにない）。
4. 引数・schema違反をMCPで固定コードへ丸めるか、SDK生成文言のままにするか。
5. 契約不一致・想定外例外の終了コードを3にするか（既存は2）。
6. MCPの起動待ち時間（提案20秒）。

## 7. 未確認

- 実agent（Claude Code、Codex等）からのstdio接続。
- v2の新era（2026-07-28）でのhandshakeと、`serveStdio` の `legacy` 設定の影響。
- MCP cancel通知からAPI fetchの取消への伝播。
- 入力値がエラー文へ入る検証型（enum、literal等）での値の露出。
- Eumenes（`bun.lock`にv1・v2共存）へtgzを導入した時のSDKの解決・重複。
- Windows・Node実行。
- v1系列の保守方針。2.4.0・1.32.2への更新で壊れるか（本spikeは2.3.1・1.31.0のみ）。
- 20秒の起動待ちの妥当性、およびトークン非出力の自動試験（設計のみで未実装）。
- Eumenesの実API（稼働中も含め接続していない）。HTTPの401・503の実形は既存clientコードの読み取りに基づく。
