# 明示的構造と人手キュレーションによる Markdown 知識グラフ（自動抽出との組み合わせを含む）

調査日: 2026-11-09。一次情報（公式ドキュメント、GitHub README、論文）を優先した。二次情報や集約サイトに頼った箇所はその旨を書いた。英語の引用は原文のまま残している。2025 年より前の事実には「(旧)」を付けた。

---

## 1. wikilink・backlink・tag・見出しから作るグラフ（Obsidian / Logseq / Foam / Dendron / Org-roam / Quartz / Tana）と、型付きリンク（Dataview inline fields, Breadcrumbs, Juggl, ExcaliBrain, Semantic MediaWiki）

### Takeaway
主要ツールはどれも、人が書いた明示的構造をそのままエッジにしている。対象は wikilink、タグ、YAML front matter の properties、ID 付き見出し、ファイル名の階層、フォルダで、各エッジは文書内の特定の行やフィールドを指せる。型付きリンクの書き方は 3 系統に収束している。(a) front matter のキーに `"[[Note]]"` を書く、(b) `Key:: [[Note]]` 形式の inline field、(c) `- relation [[Note]]` 形式のリスト行。これらに加えて、構造から規則で導く「暗黙エッジ」（逆方向、推移、兄弟など）を別扱いで生成するツールが多い（Breadcrumbs、ExcaliBrain）。2025〜2026 年には型とプロパティが製品の中核機能になった（Obsidian Bases、Logseq DB 版の tag＝class、Tana supertags）。

### Cited Findings
**Obsidian（Properties / Bases / tags）**
- Properties は note 先頭の YAML に保存される。型は Text, List, Number, Checkbox, Date, Date & time, Tags。`tags`, `aliases`, `cssclasses` がデフォルトのプロパティ。property 内に内部リンクを書くときは引用符が必要で、例は `link: "[[Episode IV]]"`。property 内のリンクが backlink やグラフに数えられるかは、このページに書かれていない — [Obsidian Help: Properties](https://obsidian.md/help/properties)
- Bases は core plugin で、notes とその properties をデータベースのように表示・編集・ソート・フィルタする。ページには "All the data in Obsidian Bases is stored in your local Markdown files and their properties." とある。ビュー定義は `.base` ファイルか、Markdown 内のコードブロックに置く。ビューは Table / List / Cards / Kanban / Map — [Obsidian Help: Bases](https://obsidian.md/help/bases)
- Bases は desktop v1.9.0（2025-05-21）で early beta の core plugin として登場した。properties でフィルタでき、formula で動的なプロパティを導出できる — [Obsidian changelog 1.9.0（検索結果の要約）](https://obsidian.md/sv/changelog/2025-05-21-desktop-v1.9.0/)
- Bases の関数には `file.hasLink(otherFile)`, `file.hasTag(...)`（ネストしたタグにもマッチ）, `file.inFolder(folder)`, `file.hasProperty(name)`, `file.links`, `link.linksTo(file)`, `link.asFile()` などがあり、リンクグラフを関数で問い合わせられる — [Obsidian Help: Bases functions](https://obsidian.md/help/bases/functions)
- タグに使える文字は英字、数字、`_`, `-`, `/`（ネスト用）と "Commonly accepted Unicode characters, including emojis and other symbols"。空白は不可、大小文字は区別しない。front matter では list 形式で書く。日本語は明記されていないが、Unicode の一般的な許容範囲に入る — [Obsidian Help: Tags](https://obsidian.md/help/tags)

**Logseq DB 版（2026）**
- tag は class として働き、tag に付けた properties を tagged node が継承する。ドキュメントには "Using tags this way is known in other applications as types, classes or supertags." とある。property の型は Text, Number, Date, Checkbox, Url, Node の 6 種。Node 型は他の page や block を参照し、選択肢を特定の tag の node に絞れる。`Extends` で親 tag から継承する（例: Audiobook が Book と MediaObject を継承）。"File to DB graph" importer は Markdown を変換し、property の型を自動判定する。Markdown export は存在するが全データは表せず、完全に表せるのは EDN export だけ（2026-04-28 時点のドキュメント） — [logseq/docs db-version.md](https://github.com/logseq/docs/blob/master/db-version.md)
- 2.0.1 リリースは "Desktop APP 2.0.1 (Beta Testing)" / "Logseq 2.0 Beta (DB version) is here!" で、日付は 7 月 13 日。年はリリースページに書かれていないが、二次情報では 2026-07-13 — [GitHub release 2.0.1](https://github.com/logseq/logseq/releases/tag/2.0.1)。二次情報によると、2.0.2 は 2026-10-07 に出た。Markdown 版は "Logseq OG" に改名されて maintenance mode に入り、DB 版はまだ stable ではない — [kompozy.io](https://kompozy.io/news/logseq-2-0-db-version-beta), [issoh.co.jp](https://www.issoh.co.jp/md/tech/4954)（どちらも二次情報で、公式ブログは未確認）
- 旧 Markdown 版のプロパティは `tags:: #Tag1 #Tag2` のようなテキストだった。DB 版では型付きの値になり、移行時に混乱が出ているというフォーラム報告がある — [Logseq forum](https://discuss.logseq.com/t/confused-about-tags-inside-property-values-in-db-version/33416)

**Tana supertags**
- supertag は "turns a node into an object" で、"is a" で判定する（例: "Marisha" *is a* Person）。template に既定の Fields と既定値を持たせられ、Extend で他の supertag の template を "projection" として継承する。AI が title / fields / description を autofill する設定がある。同じ supertag を持つ node はコレクションになり、Search nodes で問い合わせられる — [Tana: Supertags](https://outliner.tana.inc/learn/features/supertags)

**Dendron（旧）**
- schema は `{name}.schema.yml` に書き、"an **optional type system** for your notes" と説明されている。`id`, `children`, `pattern`, `namespace`, `template`, `parent: root` で、ドット区切りのファイル名階層（例 `journal.2020.09.12`）を記述する。強制ではなく助言的（"Dendron doesn't force you to use schemas"）で、どの schema にも合わない note は `?` 付きで表示される。主な用途は template の自動挿入と子 note の候補提示 — [Dendron Schemas](https://wiki.dendron.so/notes/c5e5adde-5459-409b-b34d-a0d75cbb1052/)（プロジェクトの保守状況はページから判断できなかった）

**Org-roam**
- SQLite を "cache" として使い、Org ファイルが正本。node は "any headline or top level file with an ID" で、ID のない見出しは node にならない。node 間の関係を作るのは `id:` リンクだけで、その他のリンクも "for external use" としてキャッシュされる。`ROAM_ALIASES`（別名）、`ROAM_REFS`（URL や citekey などの一意キー）、`#+filetags` に加え、citation テーブルもある。`org-roam-db-autosync-mode` では保存のたびにそのファイル分だけ DB を更新する。`org-roam-db-sync` は "only reprocess modified files"。Unlinked references（title や alias とテキストの一致）は遅いため既定で無効 — [Org-roam manual](https://www.orgroam.com/manual.html)

**Quartz**
- グラフの node は notes、edge は内部リンク。node の半径は入出リンク数に比例する。local graph の既定 depth は 1、global は -1。グラフは `contentIndex.json` を読む。Graph View は現在 community plugin（`github:quartz-community/graph`）で、`quartz.config.yaml` で設定する — [Quartz: Graph View](https://quartz.jzhao.xyz/features/graph-view)

**Cosense（旧 Scrapbox、日本発）**
- 2-hop link の公式説明は "any links up to two hops (clicks) away from the current page"。直接リンクがなくても、共通のリンク先を持つページが下部に出る — [Scrapbox help: 2-hop link](https://scrapbox.io/help/2-hop_link)。ページ・行・リンクの 3 層構造で、2-hop link は行と行を共通リンクで結ぶ関係だという解釈がある — [nishio-en](https://scrapbox.io/nishio-en/Scrapbox's_2-hop_link_connects_rows_to_rows)。related を共通リンク数で並べてほしいというユーザー要望もある — [yozba](https://scrapbox.io/yozba/Cosense%E3%81%AB%E5%AF%BE%E3%81%99%E3%82%8B%E4%B8%8D%E6%BA%80%E7%82%B9)

**型付きリンク**
- Dataview: front matter（ページ全体に効く）と inline field の 2 系統がある。inline field は `Key:: Value`（行末まで）、`[Key:: Value]`（文中や 1 行に複数）、`(Key:: Value)`（Reader でキーを隠す）の 3 形式。"Bracketed inline fields are the only way to explicitly add fields to specific list items." なので、list item や task 単位で位置を持てる。暗黙フィールドに `file.outlinks`, `file.etags`, `file.lists`, `file.tasks` などがある — [Dataview: Adding Metadata](https://blacksmithgu.github.io/obsidian-dataview/annotation/add-metadata/)
- Breadcrumbs: typed links の取り込み元は front matter properties、tags、Markdown リスト、命名規則（Dendron の `parent.child`、Johnny.Decimal、日付、custom regex）、folder notes、Dataview クエリ。暗黙関係として "if A is `up` from B, then B is `down` from A" を導き、ユーザーが "define your own transitive rules" できる。ビューは Trail / Tree / Matrix（入出の関係を型ごとに表示）、Canvas export。"makes no automatic network requests"。2026 年 5 月時点で michaelpporter が保守しており、4.15.0 は Obsidian 1.13 以上が必要。846 stars — [Breadcrumbs README](https://github.com/SkepticMystic/breadcrumbs)
- ExcaliBrain: 明示的な関係は Dataview field で書く（例 `Author:: [[Isaac Asimov]]`）。field がない場合の推論規則は "A forward-link is inferred as a child", "A backlink is inferred as a parent", 相互リンクは friend、親の子は sibling。links、Dataview fields、tags、YAML front matter、folder を解釈する。open issues は 145 件 — [ExcaliBrain README](https://github.com/zsviczian/excalibrain)
- Neo4j Graph View（Juggl の前身、旧）: `- linkType [[note 1]], [[note 2|alias]]` の行が型付きエッジになり、通常の wikilink は `inline` 型。tags は entity type、YAML front matter は entity properties として扱う。変更は Neo4j に自動反映されるが "this is still very buggy" とされ、その後 Juggl として書き直された（Neo4j と Python が不要になった） — [obsidian-neo4j-graph-view README](https://github.com/HEmile/obsidian-neo4j-graph-view)
- Semantic MediaWiki（旧、2005 年〜）: 注釈はページ本文に書く `[[Has capital::Berlin]]` のような主語・述語・目的語の三つ組。開発者の推定では "99% of SMW data" が template 経由で保存され、手書きの inline 注釈は少ない。Page Forms でフォーム入力できる。1,600 以上の公開 wiki で使われている。2012 年以降は Wikidata が Wikipedia での用途を置き換えた — [Wikipedia: Semantic MediaWiki](https://en.wikipedia.org/wiki/Semantic_MediaWiki)（semantic-mediawiki.org はボット対策で取得できなかった）

### Inferences
- 明示的エッジの精度は「書き手の意図」として定義上ほぼ 1 で、リンクの位置（ファイル、行、front matter キー）をそのまま根拠として引用できる。根拠と照合できること（evidence 互換性）は、自動抽出よりはるかに高い。ただし「リンクがある」ことと「関係の意味」は別物である。素の wikilink は「弱い関連」にすぎず（ブログ記事でも、関係の型付け機能が出るまでは "links will only ever denote weak associations" と述べられている — [Tim Connors](https://itstimconnors.medium.com/a-builders-guide-to-note-taking-44e5880ef997)）、意味を持つのは typed field やタグに限られる。
- エッジは 3 層に分けて保存するのが自然である。(1) 明示エッジ（wikilink / md link / front matter のリンク / inline field / tag / 見出し・ID の階層 / folder）、(2) 規則から導いた暗黙エッジ（逆方向、推移、兄弟、2-hop、Breadcrumbs や ExcaliBrain と同じ考え方）、(3) 提案エッジ（埋め込みや LLM による）。(2) は根拠となる明示エッジ群への参照を持てる。
- 日本語への対応で言えば、wikilink、タグ、front matter はどれも文字列が完全一致すれば成立するので、言語に依存しない。日本発の Cosense で 2-hop link 文化が根付いていることも、明示リンク中心の関連発見が日本語ユーザーに受け入れられる傍証になる。
- Logseq DB 版や Tana は「型」をアプリの DB 側に持つ。そのため Markdown が正本という前提とは相性が悪い（Logseq DB の Markdown export は lossy）。今回のライブラリが対象にすべきなのは、Obsidian Properties、Dataview inline field、Breadcrumbs 形式、Dendron 風のファイル名階層、Org-roam 風の ID や alias など、Markdown 本文の中に書かれる構造である。

### Gaps
- Foam のグラフ（placeholder や tag の扱い）は、公式ドキュメントの URL が移転して 404 になり、確認できなかった。
- Obsidian で front matter properties 内のリンクがグラフビューや backlink に数えられるかは、公式ページに記載がなかった。
- Juggl と ExcaliBrain の現在の保守状況（最終リリース日）は README から読み取れなかった。
- Semantic MediaWiki 公式の Help:Properties_and_types は Anubis（ボット対策）に阻まれ、データ型の一覧は一次情報で確認できていない。

---

## 2. Markdown vault をクエリ可能なグラフや DB に変換するツールと、その抽出内容

### Takeaway
既存の変換ツールが抽出するのは、ほぼ決まった集合である。files（パス、URL）、front matter のメタデータ、タグ、リンク（md link と wikilink、backlink と dead link）、tasks で、型付きリンクは一部のツールだけが扱う。どれもファイル単位の再構築（watch や保存時）で増分更新している。Markdown を正本、DB を cache とする設計は Org-roam、MarkdownDB、Quartz に共通しており、今回のライブラリの「派生インデックスだけを持つ」方針と同じ型である。

### Cited Findings
- MarkdownDB（Datopian）: "Turn markdown files into structured, queryable data with JS."。SQLite に files、front matter のメタデータ、tags（front matter は v0.1、本文の `#tag` は v0.5 予定）、links（md link と wikilink、v0.2 で backlink と dead link）、tasks（v0.4）を格納する。`files` と `file_tags` を join する例がある。`--watch` でフォルダを監視して再構築する（"If the file keeps updating, it waits indefinitely" という注意書きあり）。front matter の `type` による document type、`computedFields`（例: 最初の見出しを title にする）に対応。548 stars で、Releases は空 — [MarkdownDB README](https://github.com/datopian/markdowndb)
- Org-roam: SQLite の cache に node（file、hash、mtime、id、level、point、todo、title、properties、olp、tags、aliases、refs など）、links、citation を持つ。保存時にそのファイルだけ更新する。`org-roam-graph` は SQL と Graphviz で、全体グラフまたは N ステップ近傍を描く — [Org-roam manual](https://www.orgroam.com/manual.html)
- Obsidian → Neo4j（Neo4j Graph View、旧）: notes を node（`name`, `content`）、wikilink を `inline` エッジ、`- linkType [[...]]` を型付きエッジ、tags を entity type、YAML を properties として扱う。同期は "very buggy" で、Juggl に置き換わった — [README](https://github.com/HEmile/obsidian-neo4j-graph-view)
- Quartz: ビルド時に `contentIndex.json` を出力し、それを読んでグラフを描く — [Quartz Graph View](https://quartz.jzhao.xyz/features/graph-view)
- Logseq DB 版の importer は Markdown のタグを tag（class）に変換し、property の型を自動判定する。ただし複数のクエリ、embed、quote を含むブロックは最初の 1 つだけを取り込む — [logseq/docs db-version.md](https://github.com/logseq/docs/blob/master/db-version.md)
- 対比として、LLM 抽出型の Neo4j LLM Knowledge Graph Builder では chunk が document に、entity が抽出元の chunk に結び付く。local entity retriever は "The chunks and documents from where the entities were extracted" を返し、説明可能性を確保している（2025-02-05 の記事） — [Neo4j blog](https://neo4j.com/blog/developer/knowledge-graph-builder-first/)

### Inferences
- 今回のライブラリでも、決定的パーサが同じ抽出集合（リンク、タグ、front matter、見出し階層、inline field）を SQLite に入れるのが基本になる。各行に doc id、byte offset または行番号、元の文字列を持たせれば、そのまま引用可能な evidence になる。LLM なしでファイル単位に増分更新できる。
- 既存ツールで「見出し」をノードとして扱うのは Org-roam（ID 付き見出しのみ）くらいである。Markdown の見出しパスをノードやアンカーにする設計（Obsidian の `[[Note#Heading]]` に相当）は、根拠の粒度をそろえるうえで有効だと考える。

### Gaps
- Obsidian → Neo4j の現行エクスポータ（2025〜2026 年に保守されているもの）は見つけられなかった。MarkdownDB の実際の SQLite スキーマ全体（links テーブルのカラム）も README からは確認できなかった。

---

## 3. ローカルモデルによる自動リンク提案（Smart Connections、similar notes、unlinked mentions）とその有用性

### Takeaway
自動提案系のツールは「提案だけ行い、リンクの作成は人が行う」設計が標準である。Smart Connections は約 96 万ダウンロードあり、需要は大きい。ただし既定の埋め込みモデルは英語寄りとされ、日本語の vault には多言語モデルへの切り替えが推奨されている。unlinked mentions（タイトルや alias とテキストの一致）は、Org-roam が遅いという理由で既定無効にしている。日本語では語境界がないため、誤検出への対策が別途必要になる。有用性を定量的に評価した資料は見つからなかった。

### Cited Findings
- Smart Connections: "ships with a local embedding model that just works"、"Embeddings are created locally by default"、"Private and offline by default"。Connections view で関連 note と抜粋をスコア付きで表示し、hide / pin ができる。リンクの自動作成はしない（"Drag a result into a note to create a link."）。Pro 版の inline connections は block ごとに強い一致の件数を示す。5.5k stars — [Smart Connections README](https://github.com/brianpetro/obsidian-smart-connections)
- Smart Connections の配布数は約 959k ダウンロード（Obsidian community directory、検索結果の要約）。別ディレクトリの値は 964K — [community.obsidian.md](https://community.obsidian.md/plugins/smart-connections)（スナップショットの日時は不明）
- 既定モデルについて、サードパーティの Smart Connections MCP サーバーは 384 次元の `TaylorAI/bge-micro-v2` を使っており、英語向けのモデルである。関連プラグイン Open Connections は既定が `Xenova/bge-micro-v2` で、多言語 vault には `Xenova/bge-m3` を推奨している — [Open Connections README（ghproxy 経由）](https://ghproxy.net/https://raw.githubusercontent.com/goberomsu/open-connections/master/README.md)（Smart Connections 公式の既定モデル名と多言語対応は一次情報で確認できていない）
- Org-roam の Unlinked references は "off by default because it can be slow" — [Org-roam manual](https://www.orgroam.com/manual.html)
- 日本語・CJK の語境界について、Obsidian（CodeMirror）のダブルクリック選択や Ctrl+Backspace はスペースの入らない日本語の連続を 1 語として扱う、という要望がフォーラムに出ている。Bamboo、Japanese Word Splitter（tiny-segmenter）、Word Scalpel（`Intl.Segmenter`）などのプラグインで補われている — [Obsidian forum](https://forum.obsidian.md/t/better-word-boundary-implementation-better-double-clicking/58720), [Bamboo](https://community.obsidian.md/plugins/bamboo), [Japanese Word Splitter](https://community.obsidian.md/plugins/japanese-word-splitter)
- UAX #29 の基本レベルでは CJK を 1 文字 1 語として扱い、実用的な分かち書きには MeCab や Sudachi などの辞書が必要になる — [unicodefyi（二次情報の用語集）](https://unicodefyi.com/glossary/word-boundary/)
- Karpathy の LLM Wiki では、リンク付けをローカル埋め込みではなく LLM エージェントの "lint"（missing cross-references、orphan pages の検出）に任せている。規模が大きい場合は qmd（BM25 とベクトルのハイブリッド検索に LLM re-rank）を挙げている — [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

### Inferences
- 埋め込み類似度による提案は、「関連文書の発見」の UI（候補リスト）には向く。一方で、型付きの関係エッジとしての精度は低く、根拠も「両文書の全体または chunk が似ている」程度しか示せない。そのため提案エッジとして別の層に置き、人が受理したものだけを昇格させる設計が業界の標準と一致する。
- multilingual-e5-small は bge-micro より日本語に強いと推測され、今回の構成は既存プラグインの既定構成よりも日本語では有利だと考えられる。ただし直接比較した評価は見つかっていない。
- 日本語の unlinked mention 検出は、タイトルや alias の部分文字列一致でしか実装できず、短いタイトル（「AI」「設計」など）の誤検出が多くなる。最小長の制限、Sudachi などの形態素境界での一致、alias の明示登録を組み合わせ、提案として出すにとどめるのが妥当である。この誤検出についての実測報告は見つからなかった。

### Gaps
- Smart Connections や similar notes の有用性（受理率、精度、ユーザーの満足度）を定量的に評価した一次資料は見つからなかった。レビュー記事（promptquorum など）はあるが、取得・検証していない。
- Obsidian 本体の unlinked mentions が CJK をどう照合しているかは、資料が見つからなかった。

---

## 4. 知識グラフ構築における人手の修正（merge / split の提案、accept / reject の UI、労力、再インデックス後も修正を残す保存方法）

### Takeaway
実用的なパターンは 4 つある。(a) 候補をスコア付きで提示し、閾値で自動確定し、残りを人がまとめて確認する（OpenRefine、Neo4j LLM Graph Builder の閾値）。(b) 人の判断を match / distinct のラベルペアとして外部ファイルに保存し、再学習や再実行で再利用する（dedupe）。(c) 「別物である」という否定の判断を明示データとして残し、誤った merge の再提案を防ぐ（Wikidata P1889）。(d) 元の文字列と判断結果を一緒に保持する（OpenRefine のセル）。研究では、LLM と人のハイブリッドが最良とされ、少ない人手で F1 が改善すると報告されている。LLM 単独では precision は上がるが recall が下がる。

### Cited Findings
- OpenRefine reconciliation は "Reconciliation is semi-automated" で、明確な一致は 1 つのリンクとして表示し、そうでなければ "one or more candidates are displayed, together with their reconciliation score"。その場で 1 セルだけ確定するか、同じ元文字列を持つ全セルに一括適用するかを選べる。"Create new item" もある。判断状態は matched / new / none。"the cell is storing both the original string and the matched entity link at the same time"（`cell.recon.judgment`, `cell.recon.matched`）。judgment facet で none だけを表示し、"best candidate's score" の数値 facet で高スコアの候補を絞って一括承認する — [OpenRefine manual: Reconciling](https://openrefine.org/docs/manual/reconciling)
- dedupe（Python の entity resolution ライブラリ）: `uncertain_pairs()` が "Dedupe is most curious to have labeled" なペアを返す（active learning）。`mark_pairs({'match': [...], 'distinct': [...]})` でラベルを追加する。`write_training(file_obj)` は "Write a JSON file that contains labeled examples"、`prepare_training(data, training_file=...)` は既存ラベルを読み込む。`write_settings` / `StaticDedupe` は学習済みモデルを再利用する — [dedupe API docs](https://docs.dedupe.io/en/latest/API-documentation.html)
- Wikidata P1889（different from）は、混同しうる別のアイテムとの区別を示し、merge を防ぐ制約として使われる。merge gadget は、どちらかのアイテムがもう一方に P1889 などで結ばれていないかを確認する — [Phabricator T141845](https://phabricator.wikimedia.org/T141845)。同名の別人には P1889 を付けて、"any system reading Wikidata" に merge してはいけないことを伝えるよう勧める実務記事もある — [Bodleian blog (2018, 旧)](https://blogs.bodleian.ox.ac.uk/digital/2018/02/12/a-reconciliation-recipe-for-wikidata/)。Wikidata Game には merge の衝突検出を求める issue がある — [bitbucket issue](https://bitbucket.org/magnusmanske/wikidata-game/issues/220/detect-merge-conflicts-and-prevent-merging)
- Neo4j LLM Graph Builder: 重複検出のパラメータは `DUPLICATE_TEXT_DISTANCE`（既定 5）と `DUPLICATE_SCORE_VALUE`（既定 0.97）。post processing 用に `GRAPH_CLEANUP_MODEL` がある。README には人が merge を確認する UI の説明がない — [llm-graph-builder README](https://github.com/neo4j-labs/llm-graph-builder)。サードパーティのフロントエンド文書には、重複一覧と `/merge_duplicate_nodes` の endpoint の記述がある — [ultrarepo docs（二次情報）](https://ultrarepo.github.io/graph-rag/frontend/frontend_docs)。公式ブログは schema を事前に与えるよう推奨している（与えないと型が "counting into the thousands"）。label や relationship type を LLM で統合する graph consolidation は "Since we're not 100-percent happy with the reduction, we didn't enable it by default" とされている — [Neo4j blog 2025-02-05](https://neo4j.com/blog/developer/knowledge-graph-builder-first/)。コミュニティでは builder の重複処理方法が質問されているが、公式回答は見つからなかった — [Neo4j community](https://community.neo4j.com/t/validating-knowledge-graphs-created-using-llm-graph-builder/71401)
- Graphiti / Zep: entity 名を 1024 次元で埋め込み、cosine 類似と全文検索で候補を集め、LLM が重複かどうかを判定する。書き込みには LLM が生成したクエリではなく事前定義の Cypher を使う（"to ensure consistent schema formats and reduce the potential for hallucinations"）。fact の重複除去は "between the same entity pairs" に限定する。t_valid / t_invalid の bi-temporal で矛盾する古い edge を無効化し、"Graphiti consistently prioritizes new information"。episode を "non-lossy data store" として扱い、episodic edge で出典に遡れるが、この点は評価対象外 — [Zep paper arXiv 2501.13956](https://arxiv.org/html/2501.13956)。custom entity / edge type は Pydantic で定義し、`edge_type_map` で型のペアごとに許す edge を指定する。マップにないペアは "keeps the extracted predicate as the edge name" — [Graphiti docs](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types)（手動の merge や delete の API はこのページに記載がない）
- Tsaneva, Dessì, Osborne, Sabou「Knowledge graph validation by integrating LLMs and human-in-the-loop」（Information Processing & Management 62(5) 104145, 2025）: CS-KG（4,100 万 statements）を対象に 9 つの検証方式を比べた。LLM を加えると precision は +12% だが recall が下がり、F1 は −5%。人と LLM のハイブリッドが最良で、"improving F1 score by 5% with minimal human involvement" — [ORO 書誌ページ](https://oro.open.ac.uk/103792), [unimib OA PDF](https://www.boa.unimib.it/retrieve/b33d79d4-138c-4b90-9445-f2fa655929e5/Tsaneva-2025-Information%20Processing%20and%20Management-VoR.pdf)（数値は検索結果に出た abstract から取った。PDF 本文は 403 で取得できず未確認）。2024 年の前身ワークショップでは、ハイブリッドで F1 が 77% から 81% に上がったと報告されている（検索結果の要約）
- SCI 3.0（schema curation interface, 2024, 旧）: キュレーションで最も時間がかかるのは Wikidata への entity grounding だとしている — [arXiv 2405.09733](https://arxiv.org/pdf/2405.09733)（検索結果の要約）
- Atlas of Human-AI Interaction（2025）: LLM による claim 抽出と entity resolution で 126,240 の canonical entity と 204,973 の alias を作り、relational claim の slot の 99.8% を解決した。出典へのリンクは保持している — [arXiv 2509.25499](https://arxiv.org/html/2509.25499)（検索結果の要約）
- Semantic MediaWiki の注釈の大半（推定 99%）は template や Page Forms 経由で入力されている。人が型付きの関係を書くときの労力は、フォームや template に吸収させるのが実証済みの方法である — [Wikipedia: SMW](https://en.wikipedia.org/wiki/Semantic_MediaWiki)
- Obsidian の `aliases`、Org-roam の `ROAM_ALIASES` / `ROAM_REFS`（一意キー）は、人が文書の中で同一性を宣言する仕組みである — [Obsidian Properties](https://obsidian.md/help/properties), [Org-roam manual](https://www.orgroam.com/manual.html)

### Inferences
- 再インデックス後も修正を残すために、人の判断（provenance=person）は文書から派生する ID ではなく、内容に基づくキーで保存すべきである。具体的には、正規化した表層文字列（OpenRefine の original string に相当）、doc id、アンカーの引用文（quote）、またはそのハッシュである。文書が変わったら、quote を再照合して判断を付け直す。照合できなければ「孤立した判断」として確認待ちのキューに入れる。
- 判断は、肯定（same / match、edge accept）と否定（distinct / P1889 型、edge reject）の両方を保存する。否定の判断は、同じ提案を再生成しないためのフィルタとして働く。dedupe のように match / distinct のペアを JSON などで蓄積すれば、将来、閾値や軽量分類器の学習データにもなる。
- 労力を減らすには、候補をスコア順に並べ、閾値で自動確定し、facet で一括承認する OpenRefine 型の UI が実績のある形である。今回のビューアを UI artifact 化するなら、最低限「same / distinct / skip」と「edge accept / reject / 型変更」の操作があれば足りる。
- Graphiti のように LLM の判定へ全面的に頼る方式は、今回すでに「遅く、モデルの判断に依存する」と判明している方式と同類である。候補生成（埋め込みと全文検索）までは決定的に行い、最終判定を人（または高閾値の自動確定）に委ねる構成のほうが、精度と再現性で有利だと考える。

### Gaps
- 典型的な労力（1 時間あたりの判定件数、全候補のうち人が見る割合）の定量値は、Tsaneva らの "minimal human involvement" 以上の具体値を確認できなかった。
- Neo4j LLM Graph Builder の UI における重複 merge の実際の操作（候補の選択方法）、Graphiti の手動修正 API、修正が再取り込みでどう扱われるかは、一次資料で確認できなかった。
- Wikidata の Mix'n'match が P1889 を参照して提案を抑制するかどうかは不明。

---

## 5. 個人やチームのノートで、ユーザーは実際にどの程度リンク・タグ・front matter を書くか（期待できる明示的構造の量）

### Takeaway
信頼できる母集団規模の統計は見つからなかった。手に入るのは、熟練ユーザー 1 人の vault の自己分析（約 8,000 notes、平均約 8 リンク / note、3.7 タグ / note）と、研究者 7 人のインタビュー研究（検索戦略がノートの構築方法を左右する）程度である。熟練ユーザーでも、通常の note のリンク数は 2.9 にとどまる。リンクは MOC や定期ノート（週次、月次）に集中し、ばらつきが大きい。

### Cited Findings
- dsebastien の vault 自己分析（2025-02 時点、2026-10 更新）: 8,053 notes、内部リンク 64,890（平均約 8 / note）、外部リンク 11,953、ユニークなタグ 2,141、平均 3.7 タグ / note、92 folders。種類別のリンク数は MOC 90.1、週次ノート 45.7、月次ノート 161.6、日次ノート 11.5、book notes 5.4、"Regular notes" 2.9。YAML front matter を使っているが、使用率は書かれていない。記事内で数値の食い違いがある（notes 7,957 / 8,053 など） — [dsebastien.net](https://www.dsebastien.net/personal-knowledge-management-at-scale-analyzing-8-000-notes-and-64-000-links/)
- Ferreira ら「How People Manage Knowledge in their "Second Brains"」（arXiv 2509.20187, 2025-09、Springer の DOI 10.1007/978-3-032-05008-3_15）: ブラジルの産業研究所の Obsidian ユーザー 7 人を対象にしたケーススタディで、参加者は自分の vault を見せた。主な発見は、参加者の知識検索戦略がコンテンツの構築・維持のしかたに影響するということ — [arXiv](https://arxiv.org/abs/2509.20187)（リンクやタグの使用量に関する数値は abstract になく、本文は未確認）
- Logseq DB 版が tags を class に、properties を型付きに移行したり、Obsidian が Bases を core にしたりしているのは、製品側が型付きメタデータをユーザーに書かせる方向に投資している証拠である — [logseq/docs](https://github.com/logseq/docs/blob/master/db-version.md), [Obsidian Help: Bases](https://obsidian.md/help/bases)
- 自動提案の需要の代理指標として、Smart Connections は約 959k ダウンロード — [community.obsidian.md](https://community.obsidian.md/plugins/smart-connections)

### Inferences
- 明示的構造の量は、ユーザーとノートの種類によって桁違いに変わる。熟練した PKM ユーザーの通常ノートでも 3 本前後、一般的な個人メモやチームの議事録・設計メモではそれより少ないと予想される（推測で、根拠となる統計はない）。したがって、明示エッジだけで十分な密度のグラフができる前提は置けない。明示エッジを「高精度な骨格」とし、提案エッジで補う構成が現実的である。
- 一方、タグやフォルダ、ファイル名の階層、見出し構造は、リンクより書かれる頻度が高い可能性が高い。たとえば見出しは Markdown 文書のほぼすべてにある。これらを「弱い構造」として使う価値は大きい（推測）。

### Gaps
- Obsidian、Logseq、Roam などの利用者全体について、リンク密度、front matter の使用率、タグの使用率を示す調査や論文は見つからなかった（CHI / CSCW で該当するものは未発見。ACM DL を直接検索する必要がある）。
- チーム用ノート（Confluence、Notion、社内 wiki）のリンク密度に関するデータは見つからなかった。
- Dataview、Breadcrumbs などのメタデータ系プラグインのダウンロード数は取得できなかった。

---

## 6. 2025〜2026 年の動向（ネイティブの property / Bases、エージェントが保守する wiki やノート）

### Takeaway
2025〜2026 年の変化は 2 つある。1 つは、型付きプロパティとデータベースビューが標準機能になったこと（Obsidian Bases 2025-05、Logseq 2.0 DB 版ベータ 2026-07）。もう 1 つは、LLM エージェントがリンクや索引を書く「エージェントが保守する wiki」パターンが流行したこと（Karpathy の LLM Wiki gist、2026-04）。後者は「生の資料は不変、wiki はエージェントが所有する層、schema は人とエージェントが共同で育てる」という 3 層構成で、正本に書き込まない今回のライブラリの方針と構造が同じである。

### Cited Findings
- Karpathy「LLM Wiki」gist（2026-04-04）は 3 層構成である。Raw sources は "the LLM reads but never modifies" な不変の正本、Wiki は LLM が所有する Markdown（要約、entity / concept ページ、相互参照）、Schema は CLAUDE.md や AGENTS.md のような規約で、人と LLM が共同で改善する。操作は Ingest（1 つの source で 10〜15 ページを更新）、Query（引用付きで回答し、有用なものは wiki に戻す）、Lint（矛盾、古い主張、orphan、missing cross-references の点検）。`index.md` はカタログで、"~100 sources, ~hundreds of pages" まで機能する。`log.md` は `## [2026-04-02] ingest | Title` 形式の追記専用ログ。人の役割は "You're in charge of sourcing, exploration, and asking the right questions"。Obsidian をグラフビュー、Dataview、Web Clipper とともに閲覧用に使う。大規模になれば qmd（BM25 とベクトル、LLM re-rank、MCP）を使う — [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- この gist が 1,600 万回閲覧されたという報道や、多数のコミュニティ実装（Claude Code skill など）、Hermes Agent への同梱がある — [Implicator（二次情報）](https://implicator.ai/karpathys-llm-wiki-got-16-million-views-the-code-isnt-the-point-2/), [GitHub topic karpathy-llm-wiki](https://github.com/topics/karpathy-llm-wiki), [Hermes Agent docs（二次情報）](https://hermesagent.org.cn/docs/user-guide/skills/bundled/research/research-llm-wiki)
- Obsidian Bases は 1.9.0（2025-05）でベータ投入された — [changelog](https://obsidian.md/sv/changelog/2025-05-21-desktop-v1.9.0/)。Breadcrumbs 4.15.0 は Obsidian 1.13 以上を前提に "the new declarative settings API" を使っている（2026-05） — [Breadcrumbs README](https://github.com/SkepticMystic/breadcrumbs)。Obsidian のリリース統計ページには 1.14.0 までのデータがある — [obsidian-stats](https://www.moritzjung.dev/obsidian-stats/releasestats/downloads)。kepano 名義の `obsidian-skills`（obsidian-bases など、エージェントに Bases や Markdown を書かせる skill）が skill 集約サイトに載っている — [skillselion（集約サイト）](https://skillselion.com/skills/kepano/obsidian-skills/obsidian-bases)
- Logseq 2.0 Beta（DB 版）: 2.0.1 は 7 月 13 日、2.0.2 は 2026-10-07（二次情報）。旧 Markdown 版は Logseq OG として maintenance mode に入った（二次情報） — [GitHub release](https://github.com/logseq/logseq/releases/tag/2.0.1), [kompozy.io](https://kompozy.io/news/logseq-2-0-db-version-beta)
- Tana は supertag の field を AI で autofill でき、新しい supertag の field 候補も AI が提案する — [Tana Supertags](https://outliner.tana.inc/learn/features/supertags)
- Neo4j LLM Graph Builder（2025）は schema の事前指定を推奨し、community summary（Leiden と LLM 要約）を post processing として提供している — [Neo4j blog](https://neo4j.com/blog/developer/knowledge-graph-builder-first/)

### Inferences
- エージェントが保守する wiki では、エージェントが自分の層にリンクを書くので、「人が書いた明示リンク」と「エージェントが書いたリンク」の区別が曖昧になる。今回のライブラリでは、ソース上のリンクを書いたのが人かエージェントかを区別できない。そのため、明示エッジの provenance は「文書に書かれていた（authored-in-source）」とし、人がビューアで行った判断（decided-by-person）とは別の値にするのがよい。
- 正本に書き込めない制約の下では、Karpathy パターンの wiki 層にあたるものを、ライブラリ内の overlay（承認済みエッジ、alias、同一性の判断）として持つことになる。ソースへの反映（wikilink や alias の追記）を行うなら、それはホストのドキュメントサービスの責務として分けておく。
- 型付き property が普及しつつあるので、今後は front matter の Node / Link 型の値（例: `project: "[[X]]"`）が増えると見込まれる。front matter のリンク値を型付きエッジとして取り込めるようにしておく価値は大きい（推測）。

### Gaps
- Obsidian Bases の GA 時期や、1.10〜1.14 での変更内容（API や property 型の追加）は一次情報で確認できなかった。
- エージェントが保守する wiki のリンク精度、重複ページの発生率、人によるレビューの負担を評価した研究は見つからなかった。
- Logseq 2.0 のリリース年と OG 版の扱いは、公式ブログで確認できていない（二次情報のみ）。
