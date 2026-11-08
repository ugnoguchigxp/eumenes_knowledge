# P0 配布・build・manifest・Eumenes導入接点

作成日: 2026-11-07

状態: P0の判断資料。製品コードは未作成。`p0/spikes/package/` は配布構成の検証用spikeで、製品の雛形ではない（スタブのみ）。計画書の該当は plan §1, §3, §6, §8, §9 P5, §10。

## 0. 結論

| 項目 | 結論 |
| --- | --- |
| 型検査 | `bun check`（Bun 1.4.4 組込み。`tsc`と同じ診断を出す）。`tsc -p tsconfig.build.json` の emit とは別。Eumenes の `typecheck: bun check` と同系統 |
| format | `bun fmt`（Bun 組込み）。設定は Eumenes の `bunfig.toml [fmt]` をそのまま写す。`format:check` は `bun fmt --check` |
| lint | `oxlint --deny-warnings`（1.86.0、Eumenes と同一版・同系統の `.oxlintrc.json`） |
| build | **TypeScript 7.0.2 の `tsc`（`tsc -p tsconfig.build.json`）で ESM JS と `.d.ts` を出力できる**。`bun build`・別 d.ts 生成は不要。`@typescript/typescript6` の `tsc6` でも出力はバイト一致 |
| 構成 | 1 package・`exports` 7本（`.` `./sqlite` `./client` `./cli` `./mcp` `./distribution-manifest.json` `./package.json`）・`bin` 2本・`sideEffects:false`・`files` ホワイトリスト |
| 指示資源 | `.md` 原本から**生成した TS モジュール**を JS として同梱（ファイル読込みなし）。パス解決問題が起きない |
| pack/導入 | `bun pm pack` → clean consumer へ `file:` で導入 → import・型検査（`skipLibCheck:false`）・bin 起動・manifest 照合が通った |
| import副作用 | 静的 import グラフ検査＋別プロセスの実行時ガードで、core/sqlite/client/cli/mcp の import が副作用ゼロであることを確認。陽性対照5件も検出 |
| 再現性 | 同じ入力から2回 build+pack して tgz が**バイト一致**（tar mtime 固定、manifest に時刻なし） |

## 1. 型検査・format・lint（Bun 1.4.4）

```text
$ bun --version
1.4.4
$ bun check --help     # "Type check a TypeScript project. Uses the nearest tsconfig.json and reports the same errors as tsc, using all CPU cores."
$ bun fmt --help       # "Format JavaScript, TypeScript, CSS, HTML, JSON, YAML, Markdown and more." (-c/--check あり)
```

- `bun check` は Bun 組込みの型検査器。`node_modules/typescript` を呼ぶわけではない（プロジェクトに `check` script があればそれを実行し、`--no-script` で回避）。意図的な型エラー1件を入れると `bun check` と `node_modules/.bin/tsc --noEmit`（7.0.2）がどちらも同じ TS2322 を報告、終了コード1。spike 全体で 66ms（15 files）。**組込みの TypeScript 版は未確認**（`--version` 相当なし）。診断の一致は上の1例で確認しただけで、全規則の同一性は未確認。
- `bun fmt` も組込み（`--doctor` で "formatted natively" と表示）。`bunfig.toml` の `[fmt]` で tabs / printWidth 80 / trailingComma all 等を指定する。Eumenes は `**/*.md` を ignore しているので spike も同じ。
- `bun lint` は `package.json` の `lint` script（`oxlint --deny-warnings`）を実行するだけで、組込み linter ではない。oxlint はクリーンだと何も出力せず終了コード0（`debugger;` を入れると `no-debugger` で終了コード1）。
- `bun check -p tsconfig.build.json` で build 設定側も型検査できる（Eumenes の `eumenes-pipeline` の `typecheck: bun check && bun check -p tsconfig.build.json` と同じ形）。
- 先例: `eumenes_router` は formatter に `oxfmt 0.71.0`、typecheck に `tsc 5.9.3`。新しい `eumenes-pipeline` は `bun check` / `bun fmt`。本パッケージは後者に合わせた。

spike の実行結果（最終版）:

| コマンド | 結果 |
| --- | --- |
| `bun fmt --check` | 31 files formatted |
| `oxlint --deny-warnings` | 0 件、終了コード0 |
| `bun check` / `bun check -p tsconfig.build.json` | No type errors（26 / 12 files） |
| `bun test` | 1 pass / 0 fail |

## 2. spike の構成

`p0/spikes/package/`

```text
package.json  bunfig.toml  tsconfig.json  tsconfig.build.json  .oxlintrc.json  bun.lock
LICENSE  THIRD_PARTY_NOTICES.md          (プレースホルダー。ライセンスの決定ではない)
src/
  contracts/index.ts   Zod 4.4.3 の契約（searchRequest/Response）と CONTRACT_VERSION=1
  core/index.ts        ホストの port を受ける純関数 search（試験は近接 core.test.ts）
  sqlite/index.ts      migrations: readonly string[]（2本）と構造的 HostDatabase（bun:sqlite を import しない）
  client/index.ts      fetch 注入可能な API client（Zod 契約を共有）
  cli/index.ts, bin.ts runCli() と shebang 付き bin（スタブ、終了コード0）
  mcp/index.ts, bin.ts runMcp() と bin（スタブ。MCP SDK はここにだけ置く想定）
  contexts/sources/extract-entities.v1.md   指示原本（<id>.v<N>.md）
  contexts/generated.ts, index.ts            生成物と公開 API（instruction(id), instructions）
  version.ts           PACKAGE_VERSION（build が package.json と一致を検査）
examples/mock-host.ts  tgz に入らないことの確認用ダミー
scripts/               build.ts generate-contexts.ts manifest.ts pack.ts verify-package.ts import-probe.ts import-guard.ts probe-fixtures/
```

ソース内の相対 import は `.js` 拡張子付きで書く（`./index.js`）。理由は §3。

## 3. build

`tsconfig.build.json`: `extends ./tsconfig.json`、`noEmit:false`、`allowImportingTsExtensions:false`、`rootDir:src`、`outDir:dist`、`declaration:true`、`exclude: src/**/*.test.ts`。`module: ESNext`、`moduleResolution: Bundler`、`target ES2022`。

```text
$ node_modules/.bin/tsc --version   → Version 7.0.2
$ tsc -p tsconfig.build.json        → 終了コード0、dist/ に *.js と *.d.ts（12 module × 2）
$ tsc6 -p tsconfig.build.json       → 終了コード0。dist と diff -r で差分なし（tsc6 は "Version 6.0.3" と表示。package は 6.0.2 で、表示差は未調査）
```

判断:

- **TS 7.0.2 の tsc をそのまま build に使う**。代替の `tsc6`・`bun build`＋別 d.ts は不要。`typescript@7.0.2` は npm の `latest`（確認日 2026-11-07）。
- 拡張子: ソースを `./x.ts` で書き `rewriteRelativeImportExtensions` で JS を `.js` に直す方式を試したところ、**JS は `.js` に書き換わるが `.d.ts` は `.ts` のまま残る**。consumer 側の TS 7.0.2・6.0.x（Bundler／NodeNext）では型検査が通ったが、他ツールでの安全が確認できないため、先例（`eumenes_router` の dist）どおり**ソースを `.js` 拡張子で書く**方式に決めた。`bun` は `./x.js` を `x.ts` へ解決するので `bun test` もそのまま動く。
- `types` は build でも `bun`（CLI の `process`/`console` 用）。`.d.ts` は `bun-types` に依存しない（HostDatabase は構造的型、fetch は標準）。
- `verbatimModuleSyntax:true` で型 import を明示。
- bin の実行権限は build 後に `chmod 755`（`bun pm pack` が保持する。tar 内 `-rwxr-xr-x` を確認）。

## 4. package.json / exports / bin

要点（全文は spike の `package.json`）:

- `"type":"module"`, `"sideEffects":false`, `"packageManager":"bun@1.4.4"`, `"private":true`（Eumenes の先例どおり。公開 npm には出さない）
- `files`: `dist`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `distribution-manifest.json`
- `exports`: 各入口 `{ "types": "./dist/.../index.d.ts", "default": "./dist/.../index.js" }`。`./sqlite`・`./client`・`./cli`・`./mcp` と `./distribution-manifest.json`・`./package.json`
- `bin`: `eumenes-knowledge` → `dist/cli/bin.js`、`eumenes-knowledge-mcp` → `dist/mcp/bin.js`（`#!/usr/bin/env bun`）
- `dependencies`: `zod: "4.4.3"`（完全固定。Eumenes 本体と同じ版。先例の `eumenes-pipeline`/`agency` は 4.6.7 を nested で持ち、重複は許容されている。同版なら dedupe される）
- `devDependencies`: `@types/bun 1.3.14`, `@typescript/typescript6 6.0.2`, `oxlint 1.86.0`, `typescript 7.0.2`（Eumenes と同版）
- lifecycle: `preinstall/install/postinstall/prepare` なし。`prepack`（build＋manifest 生成）のみ。bun は依存先の `prepack` を導入時に実行しない
- MCP SDK は未導入。入口に閉じ込める規則は、静的 import グラフ検査（§6）で「`.` `./sqlite` `./client` から `dist/mcp`・`dist/cli` に到達しない」ことを機械的に検査できる。**実 SDK を入れた時の型・サイズ・読込み時間は未確認**（P4）
- Node 互換: bin は `bun` shebang。Node での import・実行は**未確認**（計画上も保証しない）

## 5. pack と clean 導入

### 実行

```text
$ bun run release            # prepack(build+manifest) → bun pm pack --filename out/pack-tmp.tgz → sha256 名へ rename
pack: eumenes_knowledge-0.0.0-spike.1-41b09fce219c.tgz
pack: sha256 41b09fce219c528ed873a6490a583dfc50ee7e4d63dbd834761e4b72852b3a85
```

注: script 名を `pack` にすると npm 規約の `prepack` が二重に走るため `release` にした。`bun pm pack` は `--filename` と `--destination` を同時に指定できない。

consumer: `/private/tmp/claude-660782498/-Users-y-noguchi-Code-eumenes-knowledge/cd3a51c4-1a47-44f7-8284-c6bfb9396722/scratchpad/package-consumer/`（新規の空ディレクトリから作成）

```text
vendor/knowledge/{tgz, tgz.sha256, manifest.json}     ← Eumenes の vendor/<name>/ と同じ配置
package.json: "eumenes_knowledge": "file:vendor/knowledge/eumenes_knowledge-0.0.0-spike.1-41b09fce219c.tgz", "zod": "4.4.3"
$ bun install  → 8 packages installed（eumenes_knowledge は tgz のみから。postinstall なし）
bun.lock: "eumenes_knowledge": ["eumenes_knowledge@vendor/knowledge/<tgz>", { dependencies: { zod: "4.4.3" }, bin: {...} }, "sha512-..."]
node_modules/.bin/{eumenes-knowledge, eumenes-knowledge-mcp, tsc}
```

### tgz

- sha256 `41b09fce219c528ed873a6490a583dfc50ee7e4d63dbd834761e4b72852b3a85`、6060 bytes、tar 28 エントリ
- distribution.digest `448ee8a082eb0034d6e1495013b68785128bb7f5ae7373e6b714476a0b3cd7c8`、source.digest `5ff1a780b961f49d758d2a9cead9d53dcc8e294326532044891936b2cd2f7934`（spike の `src/ scripts/ package.json bun.lock bunfig.toml tsconfig*.json` が対象）

```text
package/package.json  package/LICENSE  package/THIRD_PARTY_NOTICES.md  package/distribution-manifest.json
package/dist/index.{js,d.ts}  version.{js,d.ts}
package/dist/contracts/index.{js,d.ts}   core/index.{js,d.ts}   sqlite/index.{js,d.ts}   client/index.{js,d.ts}
package/dist/contexts/index.{js,d.ts}    contexts/generated.{js,d.ts}
package/dist/cli/{index,bin}.{js,d.ts}   mcp/{index,bin}.{js,d.ts}     (bin.js のみ 755)
```

`tar -tzf` で `src/` `examples/` `scripts/` `out/` `*.test.*` `mock` `fixture` を含まないこと、`dist` 内の相対 import がすべて `dist` 内に収まり実在すること、宣言外の bare import がないこと（`zod` のみ）を `verify-package.ts` で確認した。ソース・mock・合成資料・検証出力は本体 dist に混ざらない（`tsconfig.build.json` が `src` のみ、テストを除外。`files` がホワイトリスト）。

### consumer での検査結果

| 検査 | 結果 |
| --- | --- |
| `.` `./sqlite` `./client` `./cli` `./mcp` の import と実行（`check-exports.ts`） | 成功。契約 parse、sqlite の migration 2本、client（fetch 注入）、指示資源、cli/mcp 戻り値0 |
| `./package.json` `./distribution-manifest.json` の import（JSON） | 成功 |
| 型検査（consumer `tsconfig`: strict, `skipLibCheck:false`, Bundler） | `tsc 7.0.2` と `bun check` ともに 0 エラー。型の効果を確認する負例（誤った型・必須欠落・未公開 subpath `eumenes_knowledge/dist/core/index.js` の import）が `@ts-expect-error` で全件エラーになる |
| bin | `node_modules/.bin/eumenes-knowledge` → "cli stub: ok"、終了コード0。`eumenes-knowledge-mcp` 同様。`--version` 付きも0。`bun x eumenes-knowledge-mcp --version` も0 |
| 指示資源 | `instruction("extract-entities")` が版1の本文を返す。インストール後のコピーからのパス解決は発生しない（JS に埋込み） |
| `verify-package.ts`（§7 の照合を含む113検査） | 全通過 |
| 改ざん試験 | dist ファイル追記・未記載ファイル追加・vendor manifest の sha256 変更の3種を入れると FAIL 5件（`tgz sha256`、`.sha256`、artifact 名、ファイル sha256、未記載ファイル）。検査が実際に効く |
| 再現性 | `rm -rf out; release` を2回 → `diff -r` 差分なし（tgz 同一） |

## 6. import 副作用の検査方法

`scripts/import-probe.ts [packageRoot]`（packageRoot 省略時は spike の dist、consumer では `node_modules/eumenes_knowledge` を渡す）。2段構え。

1. **静的 import グラフ**（dist の JS を再帰的に辿る）
   - `.` は `dist/cli` `dist/mcp` `dist/client` に、`./sqlite` は cli/mcp/client/core に、`./client` は cli/mcp/core/sqlite に、`./cli` は mcp に、`./mcp` は cli に到達しない。
   - `.` `./sqlite` `./client` は `node:`・`bun:` の組込み（fs, net, `bun:sqlite` 等）を一切 import しない。宣言外の bare import は禁止（許可は `zod` のみ）。
2. **実行時ガード**（`bun --preload import-guard.ts -e 'await import(<entry>)'`、空の一時 cwd、別プロセス）
   - 次を「記録して何もしない」スタブに差し替える: `fetch` / `WebSocket` / `XMLHttpRequest`、`Bun.serve/listen/connect/udpSocket`、`node:net`・`http(s)`・`dns`、`setTimeout/Interval/Immediate`、`Bun.spawn(Sync)`・`node:child_process`、`node:fs` の書込み系、`Bun.write`、`bun:sqlite.Database` の `query/prepare/exec/run/transaction/serialize`。
   - 判定: 違反記録0、cwd に新規ファイルなし、プロセスが 5 秒以内に終了コード0（待受・interval が残れば終了しない）。
3. **陽性対照5件**（fetch / Bun.serve / setInterval / `new Database().exec` / `writeFileSync`）をガード下で import し、検出されることを確認する。ガード未設定なら fixture は自分で例外を投げ、実行されない（実際の待受・通信は起こさない）。

結果（spike 直下と、clean 導入した consumer の `node_modules/eumenes_knowledge` の両方で 15/15 PASS）:

```text
PASS graph . / ./sqlite / ./client / ./cli / ./mcp
PASS import .        exit 0 in 48ms, no side effect, no file
PASS import ./sqlite / ./client / ./cli / ./mcp   （30〜48ms）
PASS control fetch / serve / timer / sqlite / write-file
```

限界（未確認・既知）:

- Bun 1.4.4 では組込み `bun:sqlite` を plugin で差し替えられない（`module()` が "cannot be used to override builtin" で失敗、`onResolve` も呼ばれない）。そのため Database の**コンストラクタ**は実行時には捕捉できず、`prototype` の使用、静的 import 禁止、ファイル非作成で代替する。`:memory:` を `new` するだけの副作用は静的規則でのみ防ぐ。
- `node:fs` の名前付き import（`import { writeFileSync } from "node:fs"`）はスタブをすり抜ける（陽性対照ではファイルが作られることで検出）。cwd 外への書込みは検出できない。いずれも core/sqlite/client では組込み import 禁止で補う。cli/mcp 入口は組込み import を許す代わりに、実装時に「import しただけでは何も実行しない（`bin.ts` だけが実行）」を保つ規則を P4 で検査に足す。
- モデル取得は専用の検知なし（取得手段は fetch/spawn/書込みのどれか）。migration の「実行」は DB 接続を経由するので、Database 使用の検知に含まれる。
- ネットワークは OS レベルでは遮断していない（グローバル API のスタブ検知のみ）。

## 7. manifest 案

先例の比較:

| 項目 | memory（package内 `dist/release-manifest.json`） | world（package内 `distribution-manifest.json`） | router/agency（`vendor/*/manifest.json`） |
| --- | --- | --- | --- |
| package・version | あり | あり | あり |
| 契約版 | なし | worldContractVersion | contractVersions, INSTRUCTION_VERSION |
| migration | なし（dbSchemaVersion は vendor 側） | id と sha256（7本） | dbSchemaVersion（件数） |
| 元 commit・source digest | baseCommit・sourceHash | gitCommit・sourceDigest・srcDirtyFiles | gitSha/commit・dirty・treeDigest・patch |
| 配布ファイルごとの hash | `files`（全ファイル sha256） | exports 一覧 | なし |
| tgz sha256 | なし（vendor 側） | なし（vendor 側） | vendor 側 `sha256`、`.sha256` ファイル |

本パッケージの案（spike 実装済み）は、package 内のものを「何が入っているかの自己記述」、vendor 側のものを「Eumenes がどの tgz を採用したか」の記録に分ける。**tgz 自体の sha256 は package 内 manifest に入れられない**（自己参照）ので vendor 側に置く。

### 7.1 package 内 `distribution-manifest.json`（spike 生成物。決定的、時刻なし）

| キー | 内容 |
| --- | --- |
| `kind`, `manifestVersion` | `eumenes-knowledge-distribution`, 1 |
| `package` | name, version, license |
| `contract.version` | `CONTRACT_VERSION`（公開 schema の形が変わると上げる） |
| `instructions` | `setDigest`（全指示の `id@version:sha256` の sha256）と `entries[]`（id, version, sha256） |
| `schema` | `migrationCount` と `migrations[]`（`ordinal`, `id`=4桁, `sha256`）。sha256 は Eumenes の `schema_migrations_v2.checksum` と同じ「SQL 文字列の sha256 hex」 |
| `exports`, `bin`, `dependencies` | package.json から複写（入口の増減を差分で検出） |
| `source` | `gitCommit`, `dirty`, `digest`, `digestScope`, `fileCount`。digest は `src/** scripts/** package.json bun.lock bunfig.toml tsconfig*.json` の「パス NUL sha256」を改行連結して sha256。`dist/` は含めない（`src/contexts/generated.ts` は src 内にあるが、build の `--check` で原本 `.md` との一致を強制する） |
| `distribution` | `digest`（配布ファイルのパス＋sha256 の sha256）, `digestScope`, `files{path: sha256}`（`dist/**`, `package.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`。manifest 自身は除外） |
| `toolchain` | bun 版、typescript 版（再現確認用。時刻は入れない） |
| `lightrag` | 後で埋める欄。`status`（unfilled/filled）, `upstream`, `commit`, `license`, `files[]`, `note` |

`lightrag.files[]` の案（P2 で移植時に埋める）: `{ upstreamPath, upstreamCommit, upstreamBlobSha256, portedTo（dist 内パス）, change: "adapted"|"copied", noticeId }`。`noticeId` は `THIRD_PARTY_NOTICES.md` の節と対応させ、`verify:package` が「全 entry に節があり、dist の該当ファイル先頭コメントに出典 commit が残る」ことを検査する（P2 で実装、現状は未実装）。

### 7.2 Eumenes 側 `vendor/knowledge/manifest.json`（案。spike の `out/vendor-manifest.json`）

```text
package, version, artifact(<name>-<version>-<sha12>.tgz), sha256, size,
contractVersion, instructionSetDigest, dbSchemaVersion, migrations[{ordinal,id,sha256}],
sourceGitCommit, sourceDirty, sourceDigest, distributionDigest, lightrag{...}
+ dirty の場合のみ adoptionSource{ baseCommit, patchFile, patchSha256, apply }（router/agency と同じ）
+ verifiedWith（実行した verify の記録）
```

隣に `<artifact>.sha256`（`sha256  filename`）と、dirty 時の `adoption-source.patch`。tgz のファイル名に sha256 先頭12桁を入れる（既存6件と同じ）。**P5 受入では dirty でない commit からの build を要件にする案**（dirty を許すと patch と source digest で別途拘束が必要で、router/agency の運用負荷が大きい）。

### 7.3 生成手順

1. `bun run contexts:generate`（`src/contexts/sources/<id>.v<N>.md` → `generated.ts`。`--check` を verify に入れ、原本と不一致なら失敗）
2. `bun run build`（`generate-contexts --check` → `rm -rf dist` → `tsc -p tsconfig.build.json` → `PACKAGE_VERSION == package.json version` 検査 → bin に chmod）
3. `bun run manifest`（`dist` から契約版・指示・migration を **実際に import した値**で記録。表と実体のずれを防ぐ）
4. `bun pm pack`（`prepack` が 2→3 を実行）→ sha256 で rename、`.sha256`、vendor manifest 草稿
5. 導入側: tgz を `vendor/knowledge/` に置く → `package.json`・`bun install`（lock の sha512 integrity）→ `vendor.test.ts` が照合

指示版の付け方: ファイル名 `<id>.v<N>.md` の `N` を指示版とし、本文を変えたら新しい `vN` ファイルを足す（旧版は残すか削除かは P2 で決める）。`setDigest` は本文変更を版上げ忘れとして検出する材料（`id@version` が同じで sha256 が違えば、manifest 差分で見える）。

### 7.4 consumer 側の最小照合スクリプト

`scripts/verify-package.ts <consumerRoot>`（Eumenes の `vendor.test.ts` と同じ項目 113 検査）:

- vendor manifest の `sha256`・`size` と tgz 実体、`.sha256` ファイル、artifact 名の sha 接頭辞
- consumer `package.json` の依存が `file:vendor/knowledge/<artifact>`、`bun.lock` に `eumenes_knowledge@vendor/knowledge/<artifact>` と `sha512` integrity
- インストール済み `package.json` version、`distribution-manifest.json` の全ファイル sha256、未記載ファイルがないこと、`distribution.digest` の再計算
- vendor manifest と package 内 manifest の契約版・指示 digest・migration・source digest・distribution digest・commit の一致
- 実際に import した `CONTRACT_VERSION`・`PACKAGE_VERSION`・`INSTRUCTION_SET_DIGEST`・指示 entries・指示本文の sha256・migration の sha256 と manifest の一致
- tar の全パスが許可リスト内、lifecycle script なし、`trustedDependencies` なし、dist 内の相対 import が dist 内に実在、bare import が宣言済み、`exports`/`bin` の対象ファイルが存在、`sideEffects:false`、`type:module`

## 8. Eumenes 側の導入接点（一覧。編集はしていない）

| # | 場所 | 内容（案） |
| --- | --- | --- |
| 1 | `package.json` dependencies | `"eumenes_knowledge": "file:vendor/knowledge/eumenes_knowledge-<ver>-<sha12>.tgz"`。zod は package 側が `4.4.3` 完全固定で本体と同版 |
| 2 | `bun.lock` | `eumenes_knowledge@vendor/knowledge/<tgz>` の entry と `sha512` integrity（`bun install` で生成）。`bunfig.toml` の `minimumReleaseAge` は `file:` に影響しない |
| 3 | `vendor/knowledge/` | tgz、`.sha256`、`manifest.json`（§7.2）、dirty なら `adoption-source.patch`。旧 tgz は残す慣行（world の先例） |
| 4 | `api/application/vendor.test.ts` | router のブロックを雛形に knowledge 用を追加: tgz sha256・`.sha256`・`package.json` 依存・version・`bun.lock` integrity・`CONTRACT_VERSION == manifest.contractVersion`・`knowledgeSql.length == dbSchemaVersion`・migration ごとの sha256・`INSTRUCTION_SET_DIGEST`・インストール済みの `distribution-manifest.json` と全ファイル hash（memory/world ブロックの形） |
| 5 | `api/application/migrations.ts` | `import { migrations as knowledgePackageSql } from "eumenes_knowledge/sqlite"` と `...packageMigrations("knowledge-package", knowledgePackageSql, ["queue/0001-init"])` を `catalog` に追加（owner 名は既存の `memory-package` `world-package` `router-package` に揃えた案）。ID は `knowledge-package/0001`…。`after` の起点は、knowledge のテーブルが他テーブルを外部参照しない前提では既存の安定 ID 1つで足りる（`pursuit-core` は `queue/0001-init`）。`resolve()` が未登録 ID に `legacyOrder.at(-1)` を自動で足すので、`legacyOrder`（凍結）には**触れない**。ホスト側の追加テーブルは別 owner（`knowledge/0001-…`）を `knowledge-package/<末尾>` の後に置く（world の形）。適用済み SQL は checksum 固定なので、**一度配布した migration は編集せず末尾に足す**規則を package 側の試験で強制する必要がある（P1） |
| 6 | `scripts/domains.ts`（と生成物 `docs/domains.md`） | `knowledge` 新設。`backend: "api/domains/knowledge"`、`web: null`、`components: null`、`integrationTests: ["api/application/knowledge/…test.ts"]`。依存候補: `docling`(Tier1)・`larm`(0)・`queue`(0)・`resources`(0) → **Tier 2 候補**。`inference`(2)・`tool-runtime`(1) などを足すと Tier 3 以上。上位 domain（agent-runtime Tier3、dialogue Tier5）が知識を使う接続は application 層の adapter で行い、domain 間の逆依存を作らない。`bun scripts/domain-docs.ts` で表を再生成（`verify` が `--check`）。Tier は `scripts/boundaries.ts` が検査するため、実依存が決まってから確定する |
| 7 | `api/domains/knowledge/` | ホスト側 domain: store・認可 scope・principal・失効世代・queue 登録・writer transaction の呼出し。package は DB 接続／transaction を作らない（plan §5.1） |
| 8 | `api/application/knowledge/knowledge-adapter.ts` ほか | toolchain の `DomainAdapter`（docs/toolchain-extension.md §5.1）。登録は `api/application/toolchain/toolchain.ts` の `createAdapterRegistry([...])` に1件、`toolchain-adapters.ts` の `hostAdapterDescriptions` に1件（と必要なら `domainSchemas`）。bundle は `api/domains/capabilities/bundles/knowledge.bundle.json`（`adapter:knowledge@1`、definitions/bindings/artifacts/schemas、`pins` は `bun run toolchain:bundle -- pins …`）。会話の検索・根拠取得 tool を command/instant binding で結ぶ。コードで書くのは adapter のみ（パッケージ内部に登録処理を持ち込まない） |
| 9 | Docling 取得 | 既存 `api/domains/docling`（`contracts/documents.ts`）と `api/application/docling/docling-composition.ts` の取得経路を host が呼び、文書・版・digest を package の「文書入力」に変換して渡す。Docling の削除／変更 feed は未確認（plan §5.2）なので、検知契約は P0 の別項目 |
| 10 | LARM embedder | `api/application/world/larm-embedder.ts` の `createSavedEmbedder(config, settings, activity)` は `server-services.ts` で1つ作られ、toolchain 検索と memory が共有している。型は `Embed = (texts, type: "query"\|"passage", signal) => Promise<{ vectors, space }>`（`toolchain-vectors.ts`）で、**plan §5.1 の埋め込み入力（用途・本文・AbortSignal、応答は vectors と空間識別・次元）とほぼ同形**。knowledge adapter はこの共有 `embedder` を受け取り、package の埋め込み port へ薄く変換する（別の LARM client を作らない） |
| 11 | queue・writer | `server-tasks.ts` の `core.queue`・`store.write` を adapter に渡す。取込みは受付と処理完了を分ける（plan §6） |
| 12 | `server-services.ts` / `server-world.ts` 相当の組立て | 組立ては `api/application/` 側で行う。import しただけでは何も起動しない package の性質（§6）を前提に、有効化は設定（`world.enabled` の形に倣う）で決める。具体は P6 |
| 13 | HTTP API・認証 | CLI/MCP が呼ぶ認証付き公開 route（`api/application/app.ts`/`app-modules.ts` への登録）。client は package の `./client` を使う。API 形は P0 の別担当 |
| 14 | 指示（SystemContext） | package は `instruction(id).text` を返すだけ。Eumenes の s11tnext 管理（`s11tnext.config.toml` の `source_dir = "api/domains"`）に載せるか、host が文字列として LARM 呼出しに渡すかは**未確認**（P6 の設計合意事項）。`INSTRUCTION_VERSION` を持つ agency の `vendor.test.ts` の形が先例 |

### `bun run verify -- --domain knowledge --domain docling --domain markdown` が成立するために必要なもの

- `scripts/domains.ts` に `knowledge` があり、`depends` が下位 Tier のみを指す（`checkTiers`）。
- `scripts/test-domain.ts` が選ぶ試験が1件以上ある（`api/domains/knowledge/test/` または `integrationTests`。0件だと終了コード3）。
- `docs/domains.md` が再生成済み（`domain-docs --check` が verify に含まれる）。
- `api/domains/knowledge/index.ts` が存在し、他 domain への import が許可リスト内。
- `vendor.test.ts` の knowledge ブロックが通る（verify の対象 domain に含まれるかは未確認。含まれない場合は `bun test api/application/vendor.test.ts` を別途実行）。
- 実 Docling / LARM を要する確認は fixture の verify とは別（plan §10）。

## 9. ライセンス（選択肢。決定は利用者）

Eumenes 配下の先例: `eumenes-memory`（MIT、`LICENSE`＋`THIRD_PARTY_NOTICES.md` 同梱）、`eumenes_router`・`eumenes-pipeline`・`eumenes-agency`（MIT）、`eumenes-world-model`（`license` 欄なし、LICENSE 非同梱）。いずれも `private:true` で npm 公開はしていない。

| 選択肢 | 内容 | LightRAG（MIT）との関係 |
| --- | --- | --- |
| A. MIT | 同系 package と揃う。`license: "MIT"`、`LICENSE` に MIT 全文と著作権者表記 | 互換。LightRAG の MIT 表示は `THIRD_PARTY_NOTICES.md` に別節で併記 |
| B. 非公開（UNLICENSED／プロプライエタリ） | `license: "UNLICENSED"` または独自文面を `LICENSE` に。npm 公開しない前提 | MIT は再配布・改変・サブライセンスを許すので配布物へ組み込める。条件は「著作権表示と許諾表示を、コピー／実質的部分に含めること」のみ。`THIRD_PARTY_NOTICES.md` が必須 |
| C. Apache-2.0 等 | 特許条項が欲しい場合 | MIT 部分は互換。NOTICE の扱いを別途決める |

LightRAG 由来部分の表示を tgz に含める方法（案）:

1. `THIRD_PARTY_NOTICES.md` を `files` に入れる（spike で同梱を確認済み）。節ごとに: 上流 repository、固定 commit、移植した上流ファイル、変更内容（翻案／コピー）、**上流 `LICENSE` の著作権表示と MIT 全文**（上流 commit 時点の LICENSE からそのまま転記する。著作権者名は本書では確認していない）。
2. 移植した各 TS ファイルの先頭コメントに出典 commit・上流パス・変更概要（memory の SAAA 先例と同じ）。tsc は先頭コメントを dist に残す。
3. `distribution-manifest.json` の `lightrag.files[]` と `THIRD_PARTY_NOTICES.md` の節、および dist 内コメントを `verify:package` で相互検査する（P2 で実装、現状は未実装）。
4. 同梱はコピー・翻案が発生した時点で必須。参考にしただけの設計は memory のように「コードのコピーはしない」と明記する。
5. 他の依存（zod は MIT）は `dependencies` で導入されるため再配布対象外。tgz に第三者コードを同梱（bundle）しない構成を保つ限り、追加の表示は不要。

spike の `LICENSE`・`THIRD_PARTY_NOTICES.md` は同梱確認用のプレースホルダーで、どの選択肢も採用していない。

## 10. 未確認・既知の制約・次工程

- `bun check` が使う TypeScript の版・全診断の同一性（上記の1例のみ確認）。
- `tsc6` が "6.0.3" と表示される件（package.json 6.0.2 との差）。
- Node での import／実行（保証しない方針）。実 MCP SDK 導入後の読込み・サイズ・型。
- 指示を SystemContext（s11tnext）に載せる接続。長文の指示を `.md` から生成する方式の運用（版の付け方・旧版の扱い）は spike の最小形のみ。ファイル読込み方式（`import.meta.url` 相対）は採用しなかったため未検証。
- 元 commit の記録: spike は git 管理外のため `gitCommit:null`。実装リポジトリで commit／dirty の取得と、clean 要件を P1 で検証する。
- Eumenes 側の実導入（`bun install`、`vendor.test.ts` の追加、migration の適用順序の golden 試験）は編集禁止のため未実施。`packageMigrations` の `after` 起点は案で、実際のテーブル参照が決まってから確定する。
- DB コンストラクタの実行時検知は Bun 1.4.4 では不可（§6）。
- `verify:package`（plan §10）の本実装は、spike の `verify-package.ts`（導入後の照合）と `import-probe.ts` に加え、clean 環境の作成（一時ディレクトリ＋`bun install`）を P5 で足す。spike では consumer を手順で作成した。

## 11. 再現コマンド

```sh
cd p0/spikes/package
bun install
bun fmt --check && node_modules/.bin/oxlint --deny-warnings && bun check && bun check -p tsconfig.build.json && bun test
bun scripts/import-probe.ts              # 15 PASS
bun run release                          # out/ に tgz, .sha256, vendor-manifest.json

C=<scratch>/package-consumer             # tgz を vendor/knowledge/ に置き package.json の file: を合わせて bun install
bun check && bun check-exports.ts        # consumer 側
bun scripts/verify-package.ts $C         # 113 checks
bun scripts/import-probe.ts $C/node_modules/eumenes_knowledge
$C/node_modules/.bin/eumenes-knowledge; $C/node_modules/.bin/eumenes-knowledge-mcp
```

consumer 側の検査ファイル: `check-exports.ts`、`type-negative.ts`、`tsconfig.json`（consumer ディレクトリ直下）。
