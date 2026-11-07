# LightRAG 参照 commit の固定と移植範囲の判定

作成日: 2026-11-07

状態: P0 の調査資料（判断材料）。移植コードは未作成。上流のコードは読んだだけで、インストール・実行・import はしていない。コード読解で確認した挙動は、実行して確かめたものではない（実行確認は §9 に「未確認」として列挙）。

## 0. 固定した参照

| 項目 | 値 |
| --- | --- |
| リポジトリ | https://github.com/HKUDS/LightRAG |
| 固定 commit（完全SHA） | `aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a` |
| commit 日時 | 2026-10-14T22:55:37+08:00（`Merge pull request #4210 from ModestXin/fix/pgvector-filtered-ann`） |
| 取得日時 | 2026-11-07T10:54:17Z |
| 取得方法 | scratch の空ディレクトリへ `git clone --depth 1 https://github.com/HKUDS/LightRAG.git`（ブランチ `main`、取得時点の先頭）。読み取りと `shasum -a 256` / `git rev-parse HEAD:<path>` のみ実施 |
| 上流の版表記 | `lightrag/_version.py`: `__version__ = "1.5.8"`、`__api_version__ = "0347"` |
| URL の作り方 | `https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/<path>#L<start>-L<end>`。本書の `<path>:<行>` はこの形式の行番号 |

参照した上流ファイルの固定（sha256 は blob 内容、blob は git の object id）。manifest の「元commitとsource digest」はこの形で記録できる。

| path | sha256 | git blob |
| --- | --- | --- |
| `LICENSE` | `0c16924564059e493c86854574660a47ed1dcc2a476ba7b5f949d3f2f73a1984` | `ff0c29b4790f767e8abdc14f43ca0495330e89e4` |
| `lightrag/prompt.py` | `db0cf2d0f5d420a8372fac2b33043d8b4f14c84ec0a60653862e4e53a27047e1` | `ad0ced922fbab01551c258c3f7099790f936c4ab` |
| `lightrag/operate.py` | `176585e3f686574ab98657b666982302ce47d58229baacb529ef601bd6799326` | `910802339139b0344920c1e589913f0251f05525` |
| `lightrag/base.py` | `e7f0ec700659071d616b4c81c8711626d512d356d0036ce6f8da8d9a37a19f28` | `c0d88ee9a529ba029069b48632ab4f8c7e00b9ba` |
| `lightrag/lightrag.py` | `f92e25bf1bf8082dba64f604fe22badaeaa69ef2eaa34d23c5058059be8031d3` | `e80cf7b85a82d126743e60bbd0ebca5209f3ca7c` |
| `lightrag/utils.py` | `8c49d4b0150fdfc3343d85770a46c0c49da5b6c6a81c09eb5ca10a997c8dcdbe` | `1e301b36540b23939a7b23abca61824257db46b9` |
| `lightrag/utils_pipeline.py` | `fcd8e4155bc9d6850246caa83fcb2bcffe65e364efac178dfe3e1e54d1d74c90` | `edf24c4603e0540fb29309431d469c6ed8ee8421` |
| `lightrag/pipeline.py` | `aa32ffeee11032019aee0009afe5d4a1bebcb9d51ab8b3104b6b74f98dc636d2` | `d370e9d648496aa98cfa16783ce258858a2f6779` |
| `lightrag/constants.py` | `5733c48cae561d940a8b1f2e8998689e90c4270e95baf610edc7893bdc31258e` | `4f7259cb1751640453d439c5c9b838f0a0474a7b` |
| `lightrag/chunk_schema.py` | `f90f42171bbfaf2d0e1c09e62da50373141e80b76b3221848167d3d8919b604d` | `3a15c4847fd922d11e19ea05699db718fb4684c8` |
| `lightrag/chunker/token_size.py` | `f121ae47281f09367b6c199fb84d2aee6e7ce040e8019e3dbcc4fcee14171572` | `fff8fcf69e3c9f2267fa66bc85e799c473683c37` |
| `lightrag/chunker/paragraph_semantic.py` | `4338bd02e12b57886561fb967a90b0761008d446ac55ff4c5832b14ffb0d6c18` | `3e1a9ee8175899ed8d766b0e1ecf34723f561853` |
| `lightrag/chunker/recursive_character.py` | `3e4dbdee180414e8c9cb27f366d635b57d89f42d2591da995924cf07719f3018` | `eb3e1b433bf404d253198146baad66954adf6381` |
| `lightrag/chunker/semantic_vector.py` | `7c15d5d42ada3ee30037b2f855c232f63189465d8b5395067271d357b527bf1f` | `4045863b748516c6a99f2d622e61f38db18ead56` |
| `lightrag/kg/networkx_impl.py` | `451bb427d46c8047b52531c211366084f97e455d675a0bdd316ec87f315f9da7` | `9118d3c67484fbcc24179178a3a26d88be26c073` |
| `lightrag/rerank.py` | `b919d3452cffca75fdfea09507dc329e3afc77bf655e7abc965f3f6c28b653f9` | `51601c41c5cd0dbbc11a28ca3de8a84ee9d59573` |
| `lightrag/namespace.py` | `7f9d75d743f6335748d8bd57242a457789b90f0ea4a32670538096b4a75b82cb` | `eccd168df2dfb61f3c9402a1065ae66f1ac203aa` |

## 1. 要点

- 上流は plan.md の想定より大きく変わっている（`operate.py` 7126行、`lightrag.py` 8431行、`pipeline.py` 8228行）。処理は `operate.py` / `prompt.py` / `base.py` だけに収まらず、`lightrag.py`（文書削除）、`chunker/`、`utils.py`、`utils_pipeline.py`、`chunk_schema.py` に分かれる。plan §12 の参照先を増やす必要がある（§8）。
- 抽出には、区切り文字 tuple 形式（既定）と JSON 形式（`ENTITY_EXTRACTION_USE_JSON`、既定 false。`lightrag.py:1045`）の二系統が既にある。移植の骨子は JSON 形式の指示（`prompt.py:175-295`）に取る。ただし JSON 形式も schema 制約ではなく `response_format={"type":"json_object"}` と `json_repair` による復元に頼る。
- 一文書の削除は、候補の逆索引から文書の寄与を引き、残る断片のキャッシュ済み抽出結果から再計算する構造を持つ（`lightrag.py:6015-6725`）。plan §5.2 の骨格に近い。ただし再計算の入力が「LLM応答キャッシュ」であり、キャッシュが無いと派生説明が古い文書の内容を残したまま根拠だけ付け替わる経路がある（§4.2）。
- 根拠は断片単位（`source_id` = chunk id の列、`file_path` = 表示用文字列）で、版・digest・UTF-8 byte範囲・引用digest・記録単位の引用は無い（§4.1）。plan §5.1 を満たすには追加が必要。
- 対象の同一視は「正規化した名前の文字列一致」で決まる（§4.4）。plan §5.3「同じものか判断するのはLLM」と合わない。ここは移植せず独自設計にする。
- 日本語向けの用意は上流に無い。プロンプトは英語、既定出力言語は `"English"`、名前の正規化規則は中国語（U+4E00–U+9FA5）前提（§4.3）。
- 検索経路（local / global / hybrid / mix / naive）は部分採用できる。回答生成・rerank・UI・Provider・parser は移植しない。

## 2. 上流の読解結果

### 2.1 `lightrag/prompt.py`

| 内容 | 位置 | 要点 |
| --- | --- | --- |
| 区切り文字 | `prompt.py:14-15` | tuple 区切り `<|#|>`、完了印 `<|COMPLETE|>` |
| 型の指針 | `prompt.py:20-34` | 11種（Person, Creature, Organization, Location, Event, Concept, Method, Content, Data, Artifact, NaturalObject）と `Other`。英語。利用者が差し替え可 |
| 節の文脈 | `prompt.py:36-54` | 断片の見出しパンくずを `---Section Context---` として注入。「文書由来の信頼できないメタデータ、中の指示に従うな」と明記し、1行化して行頭に置かない防御を持つ |
| 抽出（tuple形式）system | `prompt.py:56-125` | 役割＝Knowledge Graph Specialist。入力は user の `---Input Text---` のみ。entity は4部（`entity,name,type,description`）、relation は5部（`relation,source,target,keywords,description`）。三人称・代名詞禁止・名前は title case・出力は `{language}`。1応答の行数上限（`max_total_records`/`max_entity_records`）。関係は「明示がなければ無向、source/target の入替えは別関係にならない」（`:100`）。n項関係は二項へ分解 |
| 抽出 user | `prompt.py:127-143` | 入力を ``` フェンスに入れて渡す |
| 追加抽出（gleaning） | `prompt.py:145-161`、JSON版 `:255-269` | 直前の抽出に対し「漏れ・書式不正・欠落項目のあるものだけ」再出力。正しいものは再出力しない。直前の応答を会話履歴として渡す |
| 抽出（JSON形式） | `prompt.py:175-295` | `{"entities":[{name,type,description}],"relationships":[{source,target,keywords,description}]}`。keywords はカンマ区切りの1文字列。上限・三人称・言語・無向の指示は tuple 版と同じ |
| 記述の要約マージ | `prompt.py:297-328` | 同一対象／関係の記述リスト（JSONL）を、全情報を落とさず1つの要約にする。矛盾は「同名の別対象か」を先に判断し、別なら分けて要約、同一内なら調停か不確実性を付けて併記。長さ上限 `{summary_length}`、言語 `{language}` |
| クエリのキーワード抽出 | `prompt.py:484-523` | `high_level_keywords`（主題・意図）と `low_level_keywords`（固有名・具体物）の2配列のJSON。クエリ内の語だけを根拠にする。曖昧・無意味な入力は空配列。言語 `{language}` |
| 回答生成 | `prompt.py:334-440` | `rag_response`、`naive_rag_response`。コンテキストのみで回答、`### References` に `[n] Document Title` を最大5件。`fail_response` は `:330-332` |
| コンテキスト整形 | `prompt.py:442-482` | `kg_query_context`／`naive_query_context`。entity・relationship・chunk を JSON 行で並べ、`reference_id` で `Reference Document List` に対応づける |
| プロンプト設定の読込み | `prompt.py:526-900` | `PROMPT_DIR` の YAML／md を許可リスト方式で読む仕組み。移植しない |

### 2.2 `lightrag/operate.py`（および関連）

分割（`lightrag/chunker/`、`lightrag/lightrag.py:791-840`）

- 既定戦略 F は固定トークン窓。`chunking_by_token_size(tokenizer, content, split_by_character, split_by_character_only, chunk_overlap_token_size=100, chunk_token_size=1200)`（`chunker/token_size.py:133-`）。実効値は環境変数（`CHUNK_SIZE` 既定1200、`lightrag.py:1475`）。重なりの実効既定値は未確認。
- tokenizer は `tiktoken`（既定モデル名 `gpt-4o-mini`、`lightrag.py:835`、`utils.py:3783`）。`tiktoken>=0.7.0` が依存（`pyproject.toml:49`）。トークン列を窓で切り、`decode` で本文に戻す。
- 分割結果の `_source_span` は Python の文字（code point）オフセットで、`.strip()` 後の範囲（`token_size.py:25-34`）。`decode` が UTF-8 境界で非連結になるため ±32 の `find` で補正し、見つからなければ `None`（`token_size.py:73-77`）。この span は保存前に捨てられる（`utils_pipeline.py:194`）。
- 他の戦略: R（LangChain の再帰文字分割）、V（LangChain の SemanticChunker。文の埋め込み類似度で切れ目を決める）、P（見出し駆動のブロックを `blocks.jsonl` サイドカーから読み、表を保ち、小ブロックを階層で併合。`paragraph_semantic.py:1-80`、約2400行。parser が作るサイドカーが前提で、無ければ R に退避）。
- 断片の保存形: `content`、`tokens`、`chunk_order_index`、`full_doc_id`、`file_path`、`llm_cache_list`、任意で `heading`／`sidecar`（`base.py:79-84`、`utils_pipeline.py:150-205`）。chunk id は `"{doc_id}-chunk-{order:03d}"`、無ければ内容の MD5（`utils_pipeline.py:170-183`、`:428`）。doc id は `file_path` の MD5（`doc-` 接頭）か内容の MD5（`pipeline.py:1073-1085`）。

抽出（`operate.py:3942-4660`）

- 断片ごとに system（固定）＋user（断片）を1回。gleaning は `MAX_GLEANING`（既定1、`constants.py:17`）が0より大きいと1回だけ行う（コードのコメントは「1 time」。回数としては使われない。`operate.py:4252-4253`）。1応答の上限は既定100行／entity 40（`constants.py:26-27`）。gleaning は履歴（初回 user＋応答）を再送し、入力が `MAX_EXTRACT_INPUT_TOKENS`（既定20480、`constants.py:38`）を超えると tokenizer で数えて打ち切る（`operate.py:4253-4290`）。
- 統合: 同名の対象は「記述が長いほう」を採用（`operate.py:4327-4365`。長さによる機械的選択）。
- 解析（tuple形式）`operate.py:1508-1647`、`:710-875`: `\n` と完了印で行に分割し、`<|#|>` で項に分ける。4／5項でなければ捨てる。LLMが relation を `entity` 接頭で出す既知の失敗を救済（`:854-875`）。欠けた区切り文字の補正（`fix_tuple_delimiter_corruption`）もある。
- 解析（JSON形式）`operate.py:907-1099`: `tolerant_load_json_dict`（`utils.py:6525`、`json_repair`）で復元し、各行を同じ清掃に通す。
- 清掃・正規化: `normalize_entity_name`／`normalize_extracted_info`（`utils.py:5833-5964`）。全角英数→半角、全角記号・括弧・ダッシュ→半角、全角スペース→空白、CJK字（U+4E00–U+9FA5）間／CJKと英数記号間の空白除去、外側の引用符除去、3文字未満の数字だけの名前を除外。entity type は `'()<>|/\` を含むと棄却、カンマなら最初の語、空白除去＋小文字化（`operate.py:662-707`）。

対象・関係のマージ（`operate.py:2384-3470`）

- 対象の同一性は `entity_name`（正規化後の文字列）。関係は `(src,tgt)` で、保存キー・ベクトルIDは並べ替え済み（`utils.py:7383`、`operate.py:3378-3395`）。
- description: 既存の記述（`<SEP>` 区切り）と新規を内容一致で重複排除して結合（`:2384-2427`）。断片数が `FORCE_LLM_SUMMARY_ON_MERGE`（既定8）以上か、トークンが `SUMMARY_MAX_TOKENS`（既定1200）以上なら LLM で要約（`:372-530`）。コンテキスト `SUMMARY_CONTEXT_SIZE`（12000）を超えると map-reduce（`constants.py:30-38`）。
- weight: 新しい source ごとに1.0を加算し、既存値と合算。「根拠の個数以上」に引き上げる（`:2954-3000`）。keywords: カンマ区切りの語を集合化して並べ替え。type: 件数の多数決（`:2576-2590`）。
- source_id／file_path: chunk id を `<SEP>` で連結。上限 `MAX_SOURCE_IDS_PER_ENTITY/RELATION`（既定200、KEEP／FIFO、`constants.py:71-78`）と `MAX_FILE_PATHS`（75、`constants.py:84`）。全 chunk id は別 KV（`entity_chunks`／`relation_chunks`）が持つ（`namespace.py:7-13`）。
- 関係の端点が無ければ、関係の description をそのまま記述に持つ `UNKNOWN` 型の対象を作る（`operate.py:3150-3200`）。
- 埋め込み入力: 対象 = `"{name}\n{description}"`、関係 = `"{keywords}\t{src}\n{tgt}\n{description}"`（`operate.py:2319-2323`）。長さは tokenizer で切詰め（`:297-350`）。

検索（`operate.py:4693-7126`）

- 既定 mode は `mix`（`base.py:93`）。mode は local / global / hybrid / naive / mix / bypass。
- キーワード抽出（`:4975-5220`）: クエリから hl／ll キーワードをLLMに抽出させる。両方空で `len(query) < 50` なら、ll にクエリ全体を入れる（`:4755-4765`）。
- local: ll キーワードを埋め込み、entities ベクトルで top_k（既定40）→ 近傍の関係を次数・weight 順に並べる（`:6200-6314`）。global: hl キーワードで relationships ベクトル top_k → 両端の対象を取得（`:6529-6620`）。hybrid: 両方を round-robin で結合。mix: hybrid ＋ chunks ベクトル（`:5280-5498`）。naive: chunks ベクトルのみ（`:6827-`）。
- 対象／関係から断片を引く（`:6350-6830`）: `source_id` の chunk を集め、出現回数で重複を除き、方法 WEIGHT（線形傾斜の重み付き巡回、`utils.py:6642`）か VECTOR（クエリとの類似度、`utils.py:6724`、既定 VECTOR）で `related_chunk_number`（既定5）まで選ぶ。
- 予算（`:5501-6070`）: entity 6000／relation 8000／全体 30000 トークン、断片の予算は「全体 − (system＋KG文脈＋クエリ＋200)」（`constants.py:57-64`）。tokenizer で切詰め、切詰めは通常ログに出るだけで結果に「切り詰めた」とは載らない。
- rerank（`utils.py:7055-7133`、`rerank.py`）: 外部の rerank API（HTTP、aiohttp）を呼び、最小スコア未満を落とし、`chunk_top_k`（既定20）で切り、最後にトークン切詰め。`DEFAULT_RERANK_BINDING = "null"`（`constants.py:68`）。
- 回答: 断片を `reference_id` でファイル単位にまとめ、`[n] file_path` の参照一覧を作る（`utils.py:7735-`）。回答キャッシュのキーは query・mode・各上限・キーワード・prompt・LLM識別（`operate.py:4860-4890`）で、principal／scope／索引世代を含まない。

### 2.3 `lightrag/base.py`

- 保存の抽象: `BaseVectorStorage`（`:334`、`cosine_better_than_threshold` 既定0.2、embedding_func必須）、`BaseKVStorage`（`:535`）、`BaseGraphStorage`（`:671`）、`DocStatusStorage`（`:1558`）。保存名前空間は `full_docs`、`text_chunks`、`llm_response_cache`、`full_entities`、`full_relations`、`entity_chunks`、`relation_chunks`、ベクトル3種、グラフ、`doc_status`（`namespace.py:7-19`）。
- 無向の根拠: `BaseGraphStorage` の docstring「All operations related to edges in graph should be undirected.」（`base.py:672`）、既定実装が `nx.Graph()`（`kg/networkx_impl.py:177`、無向）、関係キー・ベクトルIDを並べ替えて保存、プロンプトが「無向として扱う、入替えは別関係にならない」（`prompt.py:100`、`:197`）。マージ時の `has_edge(src,tgt)` も無向前提。したがって、LLMが向きを出しても保存では残らず、同じ対の逆向きは同じ辺に潰れる。
- 埋め込み関数は `context="document"`（索引）／`"query"`（検索）を区別する（`utils.py:666-667`）。plan §5.1 の passage／query に対応。

### 2.4 文書削除・再取り込み

| 項目 | 位置 | 内容 |
| --- | --- | --- |
| 入口 | `lightrag.py:6727-` `adelete_by_doc_id(doc_id, delete_llm_cache=False)` | pipeline の排他を取り、doc_status から `chunks_list` を得て `_purge_kg_contributions` を呼ぶ。最後に doc_status／full_docs を消す |
| 候補の求め方 | `lightrag.py:6303-6350` | 文書ごとの逆索引 `full_entities`／`full_relations`（取り込み時に先に書く write-ahead anchor、`operate.py:3514-` の Phase 0）から候補を得る |
| 寄与を除く | `lightrag.py:6387-6550`、`utils.py:7347` | 各候補の chunk id 列（`entity_chunks`／`relation_chunks`。無ければグラフの `source_id`）から、その文書の chunk id を引く。残りが空なら削除、残るなら再構築対象 |
| 再構築 | `operate.py:1102-1330`、`:1755-2025`、`:2027-2380` | 残る chunk の「LLM応答キャッシュ」（断片の `llm_cache_list` から取得）を再解析して断片ごとの記述を得る。残る断片分だけで description を結合し、必要なら再要約（LLM）。type は多数決、keywords は和集合、weight は再計算、file_path は残る断片から作り直す |
| 順序 | `lightrag.py:6145-6263` | 派生（グラフ・ベクトル・追跡）の修復→flush→chunk削除→anchor削除。journal（`doc_status.metadata.kg_purge`）で再開可能。「グラフが削除済みchunkを指さない」順序 |
| LLMキャッシュ | `lightrag.py:6727-` | `delete_llm_cache=False` が既定。キャッシュ自体は KG の正本ではなく別扱い |
| 再取り込み | `pipeline.py:1249-1260`（`:1055-1130`） | 同名（同 file_path）の記録は状態を問わず重複として扱う。版の更新は「削除→再投入」。同一 doc の差分更新・版管理は無い |
| 関係・対象の削除 | `lightrag.py:6572-6686` | 残る根拠の無い対象を削除する際、付随する辺とそのベクトル・追跡も消す |

## 3. LICENSE

- 種別: MIT License。`LICENSE` の著作権表記の原文は次の1行。
  `Copyright (c) 2025 LightRAG Team`
- `pyproject.toml:13` は `license = {text = "MIT"}`、`authors` は `Zirui Guo`（`lightrag/__init__.py` の `__author__` も同じ）。LICENSE の著作権者は「LightRAG Team」であり、配布物へ載せる表記は LICENSE の原文に従う。
- このツリー内に、ファイル単位の著作権ヘッダ、`NOTICE`、`THIRD_PARTY_NOTICES` は無い。`Copyright` と `nano-graphrag` で検索した結果は LICENSE 以外に該当なし（README の `nano-graphrag` は取得用サンプルデータのURLのみ）。上流自身が他プロジェクトから取り込んだコードの帰属は、このツリーからは確認できない（§9）。

## 4. 重点論点

### 4.1 根拠追跡: LightRAG の表現と plan の差

| plan の要求（§5.1, §5.2, §7.3） | LightRAG | 差分・追加が必要なもの |
| --- | --- | --- |
| 文書ID | `full_doc_id`＝`file_path` の MD5（`doc-`）または内容MD5 | Docling の文書ID（`wiki-…`）を使う。上流の ID 規則は使わない |
| 版 | 無い。同名は重複扱い、更新は削除→再投入（`pipeline.py:1249-1260`） | 版（`markdownSha256`、p0.md §2.1）を断片・根拠・記録に持たせる |
| 本文digest | `compute_text_content_hash`（MD5。正規化してから。`utils_pipeline.py:969`）。重複検知用 | 版の識別用に SHA-256。MD5 は引用の照合に使わない |
| 断片の位置 | 見出しパンくず（`heading`）と `chunk_order_index`。窓位置は `_source_span`（文字オフセット）だが保存されない（`utils_pipeline.py:194`） | 固定した Markdown 本文の UTF-8 byte範囲 `[start,end)` を断片ごとに保存 |
| 断片の本文 | `.strip()` 済み、トークン窓を `decode` した文字列。元本文の逐語的な部分列である保証が無い（`token_size.py:61-77`、`:93-100`） | 断片＝元本文の byte 範囲そのもの。strip・正規化・整形をしない。範囲から本文を復元できることを不変条件にする |
| 引用digest | 無い | 引用範囲のバイト列の SHA-256 を保存し、取得時に照合 |
| 記録（対象・関係）→根拠 | 断片単位。`source_id` は chunk id の列で、どの文のどの記述かは分からない。記述は断片ごとに1つのみ（同名なら長いほうを残す）。断片内の位置は無い | 記録ごとに引用（原文の連続部分）を出力させ、コードが断片の byte 列内での一致位置を機械的に求めて範囲を保存する（§5.4）。一致しない記録は保存しない |
| 条件・否定・未確認状態 | 専用の項目が無い。description に自然文で入るだけで、要約マージ（`prompt.py:297-328`）で落ち得る | 記録のschemaに条件・否定・確度の項目（LLMが埋める）を置き、要約結果にも原記録への参照を残す |
| 共有対象・関係の根拠を文書・版・断片ごとに追跡 | `entity_chunks`／`relation_chunks`（chunk id の全列）は有る。ただしグラフ上の `source_id` は上限200で切られ（KEEP/FIFO）、`file_path` は75件で切られる（`operate.py:2524-2530`、`:2634-2680`、`constants.py:71-84`）。`<SEP>` 区切りの文字列に詰める | 切詰めを保存層に持ち込まない（上限は取得時の予算にだけ置く）。根拠は行として持ち、区切り文字連結（`<SEP>`、`constants.py:49`）は使わない |
| 検索結果に文書ID・版・digest・引用範囲・該当原文・完全性・失効状態 | 断片本文＋`file_path`の参照一覧。切詰めは結果に載らない（ログのみ） | 結果型を独自に定義。切詰め・未処理・失効を返す |
| 得点だけを事実の正しさとして返さない | `weight` は根拠の個数（新しい source ごとに+1、`operate.py:2954-3000`）で確度ではない | 並べ替えの特徴量に留め、確度として表示しない |

### 4.2 削除・失効が plan §5.2 を満たすか

結論: 構造は満たす方向（寄与を引く、残る根拠から再計算、再要約あり）。ただし上流のままでは次の点で §5.2 を満たさない。

- 満たす点: 文書→派生の逆索引（`full_entities`／`full_relations`）から候補を出し、その文書の chunk id だけを根拠列から引いて、残りが空なら削除、あれば残る断片から description・type・keywords・weight・file_path を作り直す（`lightrag.py:6387-6550`、`operate.py:1755-2380`）。再要約は残る断片の記述だけを対象にする。要約済みの文字列から差し引くのではなく、断片ごとの記述から作り直すため、map-reduce の中間要約に他文書の寄与が混ざる問題は避けている。
- 満たさない点（コード読解で確認。実行は未確認）:
  1. 断片ごとの記述の正本が「LLM応答キャッシュ」（`llm_response_cache`）で、解析済みの記録としては保存されない（`operate.py:1415-1500`、`:1649-1720`）。キャッシュが消えている／読めない断片があると、対象の記述が再計算されない。
  2. その場合の挙動: `rebuild_policy="best_effort"`（削除の既定）でキャッシュが全く無ければ、再構築せずに戻る（`operate.py:1192-1199`）。一部だけ無い場合は、関係の記述から対象の記述を作る経路（`:1887-1940`）か、現行の記述をそのまま残して出典だけ更新する経路（`rollback` ポリシーの structural fallback、`:1866-1880`、`KGRebuildReport` の docstring `:137-170`）に入る。関係の weight は「引けないので据え置き」と明記されている（`:140-148`）。いずれも、外した文書に由来する説明文が、残る文書を出典とする記録の中に残り得る。これは §5.2 の「原資料を失った派生説明を残存文書の根拠へ付け替えない」に反する。
  3. 取り込み時の対象マージが「名前の文字列一致」で、断片ごとの記述が1つに畳まれ、`<SEP>` で連結される（§4.4）。取り下げ単位が文書ではなく断片＋名前になるため、別文書の同名対象を取り違えた場合の影響範囲を追えない。
  4. 版の概念が無い。同じ文書の新版は「削除→再投入」で、旧版を失効世代として残して検索から外す、といった扱いは無い（p0.md §2.2 の失効世代は独自実装）。
  5. 取り下げは同期的な破壊的削除。plan §5.2 の「transactionの外で推論→再検査→単一writerのtransactionで反映」とは構造が異なる（上流は LLM 再要約を途中で行いつつ順次書く。journal で再開する）。
- 移植するなら: アルゴリズム（候補の逆索引、寄与の減算、残る根拠からの再計算、派生→断片→逆索引の順で消す、journalで再開）は採るが、再計算の入力は「検証済み記録の行（文書ID・版・断片・byte範囲付き）」とし、LLM応答キャッシュは使わない。再計算が済むまでは対象・関係を partial として返す（p0.md §2.4 と整合）。再要約はtransactionの外で行い、適用時に失効世代を再検査する。

### 4.3 日本語

| 観点 | 上流の状態 | 影響 |
| --- | --- | --- |
| プロンプトの言語 | 指示文は英語。出力言語は `{language}` で、既定 `"English"`（`constants.py:16`、設定は `SUMMARY_LANGUAGE`、`addon_params.py:48`） | 既定のままだと日本語資料の名前・説明が英訳／音写され、原文の表記と合わなくなる。引用位置の照合にも使えない。出力言語は版付き指示の入力として明示し、名前は原文の表記のまま出させる |
| 英語前提の指示 | 「各語の先頭を大文字（title case）」「`this article`, `I`, `he/she` を避ける」（`prompt.py:63`、`:106-107`） | 日本語では意味を持たない。日本語向けの指示を別に書く |
| 型の語彙 | 英語の11種＋Other。検証は `'()<>|/\` を含むと棄却、カンマなら先頭語、空白除去と小文字化（`operate.py:662-707`） | `組織/団体` のような型が棄却される。型を符号で縛らず、長さと文字種の上限だけにするか、型の語彙を指示の版として管理する |
| 名前の正規化 | 全角英数→半角、CJK字（U+4E00–U+9FA5）間の空白除去など（`utils.py:5838-5964`）。ひらがな・カタカナ（U+3040–U+30FF）は対象外 | 日本語（かな漢字混じり）に対して一貫しない。名前は原文どおり保存し、同一視は別途LLMが判断する（§4.4） |
| tuple形式の脆さ | 区切り `<|#|>`。解析は `\n` で行分割し、項数4／5を要求。`"entity" in record[0]` の部分文字列判定（`operate.py:716`、relation は `:779-781`）、relation を entity 接頭で出す失敗の救済（`:854-875`） | 日本語の説明文に改行・箇条書き・Markdown表が入ると行が分断される。区切り文字の文面が説明に混ざると項数が崩れる。復旧用の分岐が増え続ける設計 |
| tokenizer 依存 | `tiktoken`（`gpt-4o-mini` 用エンコーディング）で分割窓・予算・ゲーティング・埋め込み前の切詰めを決める（`token_size.py`、`operate.py:5501-`、`:297-350`） | ネイティブ依存（Python）をBun配布に持ち込めない。LARM が使うモデルの tokenizer とも一致しない。トークン数は目安にすぎない |
| 文字オフセット | Python の code point。tokenizer の decode が UTF-8 境界で非連結（`token_size.py:61-77`） | plan は UTF-8 byte範囲で表す。TypeScript の文字列は UTF-16 のため、byte範囲は UTF-8 の Uint8Array 上で数える |
| 既定のクエリ | 両キーワードが空かつ `len(query) < 50` で ll にクエリ全体（`operate.py:4755-4765`） | 50「文字」の意味が言語で違う（日本語は短い文でも情報が多い）。閾値による分岐は採らず、キーワードが空なら常にクエリ全体を使い、結果に「キーワード抽出は空だった」と載せる |

tokenizer を使わない置換の候補（ネイティブ依存なし。割合は未測定で、実測してから固定する）:

- 分割の容量: Markdown 本文の UTF-8 byte 数で上限を持つ（`maxChunkBytes`）。境界は構造を優先する（見出し、空行区切りの段落、フェンス付きコード、表、リスト）。1つの構造が上限を超えるときだけ、行境界、それも超えるときは UTF-8 の code point 境界（必要なら grapheme 境界。`Intl.Segmenter` が Bun 1.4.4 で使えるかは未確認）で切る。句点などの文区切りで切るかは「構造・容量の処理」の範囲に収まるかをレビューして決める（意味分類はしない）。切れ目ごとの重なり（上流は100トークン）は、重複した記録が増えるため、初期は0とし測定して決める。
- 入力の見積り: 呼出しごとに host の `InferenceUsage.inputTokens`（`ports.d.ts` の `InferenceUsage`）と送った byte 数を記録し、モデルごとの byte→token 比を実測で更新する。見積りが外れて超過した場合の扱い（分割し直す／部分結果として返す）は host の上限と合わせて P0 で決める。ホストが `estimateTokens` を渡せるなら優先する。
- 予算: 検索結果の予算は要素数と byte 数で持ち、切詰めたら結果に `truncated` と件数を載せる。上流の「トークンで切って黙って捨てる」挙動は採らない。
- 日本語の評価: 語句・表記・場面を変えた未見の日本語資料で、同一対象の取りこぼし（表記ゆれ）、引用位置の一致率、分割による記述の欠落を測る（plan §10）。

### 4.4 出力形式と対象の同一視

構造化出力へ置き換える影響（参考: `/Users/y.noguchi/Code/eumenes/node_modules/eumenes-pipeline/dist/ports.d.ts` の `InferenceRequest`／`InferencePort`）:

- `InferenceRequest` は `{purpose, system?, prompt, outputSchema?}`。`outputSchema` は「プロバイダが制約付き出力に対応するとき」の任意項目で、応答は `text`。したがって schema を渡しても、返った本文を `JSON.parse` して Zod 4 で検証する層は必須。上流の `json_repair` による復元は採らず、検証に落ちた断片は「失敗・partial」として記録し、既存の正常な索引を壊さない（plan §7.3 の不正JSON）。再試行の回数は host の予算に従う。
- 会話履歴（`history_messages`）を渡す口が `ports.d.ts` には無い。上流の gleaning は直前の user／応答を履歴として再送する（`operate.py:4290-`）。移植では「直前の抽出結果をプロンプト本文へ入れる」形になり、入力が増える。gleaning の採否は費用と取りこぼし率の測定で決める（既定は1回追加）。
- 期限（plan §5.1）は `InferenceRequest` に項目が無く、`CancelSignal` は `{aborted}` のみ。plan の「期限・AbortSignal」と合わせる必要がある（port は P0 で別途確定）。
- JSON schema にできること: 項目の型・必須・列挙・件数上限（上流の100行／40件上限は `maxItems`）。Zod 4 から JSON Schema を作れるが、LARM 経由のモデルがどの schema 機能まで制約できるかは未確認。
- 区切り文字 tuple をやめる利点: 説明文の改行・区切り文字混入・項数崩れが構文エラーにならない。欠点: 出力長の増加、制約付き出力が使えない場合は閉じ括弧の欠落（途中切れ）が全体の失敗になり、tuple の「行単位で救える」性質を失う。1断片あたりの件数上限を小さく保つ。
- schema 案（確定ではない。P0 の公開 schema で固定する）:
  - 記録は局所 ID を持つ。関係は名前の文字列ではなく、同一応答内の対象の局所 ID を参照する（コードが参照の存在を機械的に検査する）。
  - 対象: `id`、`name`（原文の表記）、`type`（短い自由記述）、`description`、`evidence`（原文の連続した引用、1件以上）。
  - 関係: `source`、`target`（局所 ID）、`directed`（真偽。無向がLightRAG既定）、`relation`（短い自由記述）、`description`、`keywords`（配列）、`qualifiers`（条件・否定・確度。LLMが記述）、`evidence`。
  - コードが行うのは: schema 検証、局所 ID の存在、`evidence` が断片の byte 列に一致する位置の特定（一致なし・複数位置は規則で扱う）、digest と byte範囲の保存。意味の判断はしない。
- 対象の同一視（plan §5.3 との不一致）: 上流は `entity_name` の文字列一致でマージする（`operate.py:2429-`）。正規化規則が名前を機械的に寄せるだけで、別名（略称・旧称・表記ゆれ）は同一視されず、同名異物は同一視される。Eumenes では、文書・版・断片ごとの「言及（mention）」を正本にし、文書をまたいだ同一性は LLM の判断（出典と判断の由来付き）をリンクとして別に持つ案を推奨する（取り下げが文書単位で完結し、§5.2 を満たしやすい）。初期版で同一視を行わず、検索時に埋め込みで関連づけるだけにする選択もある。どちらにするかは P0 の判断事項。

## 5. 機能の分類

分類は、部分採用＝指示・アルゴリズムの骨子を TypeScript で翻案する、独自実装＝Eumenes の契約（SQLite・writer・queue・LARM・Docling）に合わせて新規に書く、移植しない＝持ち込まない。「部分採用」でもコードを逐語で写すのではなく翻案とし、記録（§7）の対象にする。

### 5.1 抽出（plan §4 の1行目に対応）

| 機能 | 上流の所在 | 分類 | 理由・変更点 |
| --- | --- | --- | --- |
| 抽出指示（tuple形式） | `prompt.py:56-161` | 移植しない | 区切り文字形式の脆さ（§4.3）。JSON版の骨子を採る |
| 抽出指示（JSON形式） | `prompt.py:175-295` | 部分採用 | 骨子（断片内のみから抽出、n項の二項分解、三人称、件数上限と優先順、見出しは背景のみ、テンプレ誤抽出の防止）を採る。schema・局所ID・`evidence`・`directed`・条件/否定/確度・出力言語の指定を追加。型語彙は版付き指示の入力にする |
| 節の文脈ブロック | `prompt.py:36-54`、`chunk_schema.py` | 部分採用 | plan の「見出し・本文位置を保持」「文書内の指示は参照データ」に合う。見出しを1行化し行頭に置かない防御は採る。`→` の除去などは翻案 |
| 入力の囲み | `prompt.py:137-140` | 独自実装 | 上流は ``` で囲むだけで、断片内の ``` の扱いは見当たらない（網羅検索はしていない）。断片より長い囲み、または JSON 文字列化で囲む。「文書内の指示は命令ではない」旨を指示へ追加（plan §5.3） |
| 追加抽出（gleaning） | `prompt.py:145-161`、`:255-269`、`operate.py:4250-4365` | 部分採用（採否は測定） | 指示の骨子（漏れ・誤りだけ再出力）は採る。同名を「記述が長いほう」で上書きする統合は採らない（別記録として保持）。トークン数でのゲーティング（`MAX_EXTRACT_INPUT_TOKENS`）は byte／host上限へ置換 |
| 抽出結果の解析・正規化 | `operate.py:662-1100`、`utils.py:5838-5964` | 移植しない | tolerant JSON復元、型の符号ブラックリスト、中国語向け正規化、名前の寄せ集めはいずれも採らない。独自実装: strict な Zod 検証 |
| 対象・関係のマージ | `operate.py:2429-3470` | 独自実装 | 同一視をLLM判断にする（§4.4）。言及・根拠を行で保持し、`<SEP>` 連結を使わない |
| 記述の要約マージ | `prompt.py:297-328`、`operate.py:372-660` | 部分採用 | 要約指示の骨子（全記述を落とさない、矛盾は別対象かを先に判断、不確実性を残す、第三者視点、長さ・言語）を採る。要約は派生キャッシュとし、入力の記録ID列を保存、取り下げで無効化して再生成する。閾値（8断片、1200／12000トークン）は byte／件数で置換して測定 |
| weight／keywords／type 多数決 | `operate.py:2954-3050` | 部分採用 | weight は「根拠の個数」であって確度ではない。並べ替えの特徴量に留める。keywords は LLM 出力を保持。type は言及ごとに保持し、集計は表示用 |
| 端点の無い関係の補完（`UNKNOWN` 対象） | `operate.py:3150-3200` | 移植しない | 関係の記述を対象の記述に流用する（出典も関係のもの）。端点は同一応答内の局所 ID で必ず存在させる |
| 抽出キャッシュ | `llm_response_cache`（`lightrag.py`、`operate.py:1415-`） | 移植しない | 再計算の正本にしない（§4.2）。検証済み記録を正本とし、LLM応答の再利用は host の判断 |

### 5.2 検索経路

| 機能 | 上流の所在 | 分類 | 理由・変更点 |
| --- | --- | --- | --- |
| クエリのキーワード抽出（hl／ll） | `prompt.py:484-523`、`operate.py:4975-5220` | 部分採用 | 骨子（主題と具体語の2区分、クエリ内の語だけを根拠にする、空を許す）を採る。出力は schema 付き。`len(query)<50` の分岐は採らず、空なら常にクエリ全体を使い、完全性に記録 |
| naive（断片ベクトル検索） | `operate.py:6827-`、`:5223-5277` | 独自実装 | 現行検索との比較基準（plan §10）。SQLite の検索方式は別担当のP0で決める |
| local（ll→対象ベクトル→近傍関係→断片） | `operate.py:6200-6314`、`:6350-6527` | 部分採用 | 経路の構造を採る。無向前提の近傍取得は、関係の向き・種別を持つ schema に合わせて作り直す |
| global（hl→関係ベクトル→端点→断片） | `operate.py:6529-6620`、`:6621-6830` | 部分採用 | 同上。関係の埋め込み入力は `keywords\tsrc\ntgt\ndescription`（`:2319`）が参考 |
| hybrid／mix | `operate.py:5280-5498` | 部分採用（採否は測定） | local＋global の round-robin ＋断片ベクトル。公開APIに mode を増やさず、内部の経路として評価（plan §4「効果のある範囲を移植」） |
| 対象・関係から断片を選ぶ | `operate.py:6350-6830`、`utils.py:6642`、`:6724` | 部分採用 | WEIGHT（傾斜巡回）と VECTOR を比較候補にする。類似度の閾値（0.2）は埋め込みモデル依存で持ち込まない |
| 予算配分・切詰め | `operate.py:5501-6070`、`constants.py:57-64` | 部分採用 | 「KG文脈を先に確保し、残りを断片へ」の考え方を採る。トークンではなく件数・byte。切詰めを結果に載せる（上流はログのみ） |
| rerank | `rerank.py`、`utils.py:7055-7133` | 移植しない | 外部 rerank API の HTTP クライアント（Provider管理にあたる）。LARM に rerank があるかは未確認で、初期範囲に含めない |
| 回答生成・参照一覧 | `prompt.py:330-440`、`utils.py:7735-` | 移植しない | plan が除外（最終回答生成）。参照はファイル単位でbyte範囲を持たない。返すのは構造化した結果 |
| 回答キャッシュ | `operate.py:4693-4972` | 移植しない | キーに principal／scope／索引世代が無い。認可・失効と両立しない |
| bypass／会話履歴 | `base.py:93`、`:144` | 移植しない | plan が会話全履歴の自動取り込みをしない。履歴は検索に使われず回答生成にだけ渡される |

### 5.3 分割

| 機能 | 上流の所在 | 分類 | 理由・変更点 |
| --- | --- | --- | --- |
| F（固定トークン窓） | `chunker/token_size.py` | 独自実装 | 容量処理は byte 上限へ。窓の位置は元本文の byte 範囲を直接持つ。tiktoken と decode 補正は不要になる |
| R（再帰文字分割） | `chunker/recursive_character.py` | 移植しない | LangChain 依存。区切り階層で落とす発想は、構造優先→行→code point の順（§4.3）として独自に持つ |
| V（埋め込みによる意味分割） | `chunker/semantic_vector.py` | 移植しない | 切れ目を埋め込み類似度で決める＝意味判断をコードに置く（plan §4／§5.3 に反する） |
| P（見出し駆動・表保持・小ブロック併合） | `chunker/paragraph_semantic.py` | 部分採用（概念のみ） | 見出し単位のブロック化、表を分割しない、小ブロックを階層で併合、見出しだけのブロックは子へ連結、の考え方を Markdown の構造（行単位）で再実装。`blocks.jsonl` サイドカー、parser、100文字以下の段落を分割点に昇格する等の閾値は採らない。名称は「semantic」だが処理は構造・容量で、plan の方針と矛盾しない |
| 断片ID・文書IDの規則 | `utils_pipeline.py:150-205`、`pipeline.py:1073-1085` | 独自実装 | 文書ID・`markdownSha256`・byte範囲から決定的に作る |
| 見出しパンくずの保持 | `chunk_schema.py`、`operate.py:5719-5765` | 部分採用 | 位置メタ情報として保存し、抽出プロンプトと検索結果に使う |

### 5.4 保存・排他・実行

| 機能 | 上流の所在 | 分類 | 理由・変更点 |
| --- | --- | --- | --- |
| 保存抽象（KV／vector／graph／doc_status） | `base.py:193-1316`、`namespace.py` | 移植しない | 抽象と各バックエンド（NetworkX, Neo4j, Postgres, Milvus, Qdrant 等 `kg/`）はいずれも持ち込まない。SQLite の表と migration を独自に設計。責務の分け方（根拠列、文書→派生の逆索引、状態）は参考にする |
| グラフ（無向） | `base.py:672`、`kg/networkx_impl.py:177` | 独自実装 | 関係の向きと種別を保持（§4.4）。無向は `directed=false` の場合の表現とし、World の依存・因果へ流用しない（plan §4） |
| pipeline・doc_status・キュー・ロック | `pipeline.py`、`kg/shared_storage.py` | 移植しない | Eumenes の queue・単一writer・取消を使う（plan §3, §4） |
| 文書削除・再構築 | `lightrag.py:6015-6725`、`operate.py:1102-2380` | 部分採用 | アルゴリズムは採る（§4.2）。入力を検証済み記録に、反映を単一writerのtransaction＋失効世代の再検査に置換。journal 再開は writer の再実行契約に合わせる |
| write-ahead anchor（`full_entities`／`full_relations`） | `operate.py:3514-3600` | 部分採用 | 文書→派生の逆索引として採る。単一transactionで原子的に書けるなら「先に書く」手順自体は不要 |
| 埋め込みの扱い | `utils.py:666-667`、`operate.py:297-350` | 部分採用 | `document`／`query` の区別は plan の passage／query と同じ。空間識別・次元はホストが返す情報で検査（plan §5.1）。切詰めは byte／host上限 |
| Web UI | `lightrag_webui/` | 移植しない | plan が除外 |
| FastAPI・Ollama互換API | `lightrag/api/` | 移植しない | plan が除外（認証付き公開APIは Eumenes） |
| LLM／埋め込み Provider 接続 | `lightrag/llm/`、`llm_roles.py` | 移植しない | plan が除外（LARM を使う） |
| 文書変換（PDF・docx・MinerU 等）・画像・数式 | `lightrag/parser/`、`sidecar/`、`prompt_multimodal.py`、`multimodal_context.py` | 移植しない | plan が除外（Docling が正本） |
| 評価・再現スクリプト | `lightrag/evaluation/`、`reproduce/` | 移植しない | 独自の同条件比較（plan §10）を用意する |

## 6. plan §4 の各行への対応

| plan §4 の行 | 判定 |
| --- | --- |
| 文書からの対象・関係抽出: 抽出プロンプトと根拠へ戻る設計を評価・部分採用 | 指示は JSON版の骨子を部分採用。「根拠へ戻る設計」は上流が断片単位で粗く、byte範囲・引用digest・記録単位の引用を追加する必要がある（§4.1） |
| 対象・関係・文書断片を組み合わせる検索: 必要な検索経路を比較し移植 | local／global／hybrid／mix／naive は部分採用の候補。比較は P3 |
| 文書分割: 見出し・本文位置を保持、構造・容量の処理 | F／R／V／P のうち、P の概念だけ部分採用。F は byte上限で独自実装、V は移植しない |
| 保存・排他・実行: Eumenes の契約へ合わせて実装 | 独自実装（上流の保存抽象・pipeline は移植しない）。削除・再構築のアルゴリズムは部分採用 |
| UI・FastAPI・Provider管理・PDF変換・最終回答生成: 移植しない | 上流に対応物が有り、いずれも移植しない（§5.4） |

## 7. 配布物の著作権表示と THIRD_PARTY_NOTICES

要件（MIT）:

- 翻案・コピーした部分を含む配布物（tgz）には、`LICENSE` の著作権表示と許諾文の全文を含める（MIT は「著作権表示と許諾文を全てのコピー、または実質的な部分に含める」を条件とする）。上流 LICENSE の原文は §3 のとおり。本パッケージ自体は MIT（p0.md §1）。
- 着想だけを得て独自に書いた部分の表示義務は、上流コードの表現を写していない限り生じない。ただし判断を後から追えるよう、分類（§5）を記録の対象にする。プロンプトの文面を翻訳・翻案した版付き指示は、翻案として表示の対象にする。
- 上流が他プロジェクトのコードを含む場合の帰属は、このツリーでは確認できていない（§9）。確認できるまで、THIRD_PARTY_NOTICES の上流側の帰属は LightRAG の LICENSE に限る。

THIRD_PARTY_NOTICES に書く項目:

1. 上流: 名称 `LightRAG`、URL、ライセンス種別 `MIT`、著作権表示の原文 `Copyright (c) 2025 LightRAG Team`、MIT 許諾文の全文。
2. 固定した版: commit SHA（§0）、commit日時、上流の版表記（1.5.8）、取得日。
3. 対象ファイル: 上流の path、固定 commit での blob と sha256（§0の表）、参照した行範囲、移植先ファイル（本パッケージの path）。
4. 関係の区分: 「翻案（コード）」「翻案（プロンプト文面）」「着想のみ（独自実装）」「移植しない」。
5. 変更点: 移植先ごとに、変更の要約（例: 区切り文字形式→JSON schema、tokenizer→byte上限、同一視をLLM判断へ、`<SEP>` 連結→行保持、削除の入力をLLM応答キャッシュ→検証済み記録）。
6. 変更の記録方法: (a) THIRD_PARTY_NOTICES に上の表、(b) 翻案ファイルの先頭コメントに `Derived from HKUDS/LightRAG@aaebfe1 <path>:<lines> (MIT). Changes: …`、(c) 配布 manifest に `upstream: {repo, commit, files[{path, sha256, blob}]}` を記録（plan §10「元commitとsource digest、LightRAGの由来」）、(d) 上流を更新して再移植するときは、新しい commit で上記を更新し、旧 commit との差分の判断を `verification/` に残す。
7. 同梱しないもの: 上流の依存（tiktoken、json_repair、LangChain、aiohttp 等）は使わない。使う依存が増えたら、その依存の著作権表示を別項目で追加する。

配布検査（plan §10 の `verify:package`）に、LICENSE 全文と著作権表示の有無、manifest の upstream 記録の有無を加える。

## 8. plan.md との矛盾・不足

| 箇所 | 内容 |
| --- | --- |
| §12 参照資料 | `operate.py`／`prompt.py`／`base.py`／`LICENSE` だけでは足りない。削除・再構築は `lightrag.py`（`adelete_by_doc_id`、`_purge_kg_contributions`）、分割は `chunker/`・`chunk_schema.py`、断片・文書IDは `utils_pipeline.py`・`pipeline.py`、補助は `utils.py`。固定commitのURLへ差し替えが必要 |
| §4 の表 | 行が足りない: 追加抽出（gleaning）、記述の要約マージ、クエリのキーワード抽出、rerank、回答キャッシュ、削除・再構築。本書 §5 に追加した |
| §4 文書分割 | 上流に4戦略（F/R/V/P）があり、V は埋め込みで切れ目を決める。plan の「構造・容量の処理」に反するため V は移植しない旨を明記する |
| §4 無向グラフ | 確認済み（`base.py:672`、`networkx_impl.py:177`、`prompt.py:100`）。ただしプロンプトは「明示がなければ無向」と書きつつ、向きを出す項目が schema に無い。plan の「関係型・方向性」は schema に `directed` と種別を持たせて定義する必要がある（P0 の別担当と整合） |
| §5.1 引用範囲・byte | 上流にUTF-8 byte範囲・引用digest・記録単位の引用は無い（§4.1）。上流の `_source_span` は文字オフセットで保存されない。plan の不変条件（範囲から原文を復元できる）は断片の切り方から作り直す必要がある |
| §5.2 取り下げ | 上流の削除は構造上は近いが、再計算の入力がLLMキャッシュで、欠けると古い説明が残る（§4.2）。plan の「付け替えない」を満たすには、検証済み記録を正本にする必要がある。これは §3「保存」の設計に影響する（記録の表が必要） |
| §5.3 同一視 | 上流は名前の文字列一致（§4.4）。plan は「同じか判断するのはLLM」。移植せず設計し直す。初期版で同一視を行うか否かを決める必要がある |
| §3／P0 全文検索 | 上流に全文検索・語彙検索の経路は無い（`bm25`／`fts5`／`tsvector` の語は見つからなかった）。SQLite全文検索の評価は上流と無関係に行う |
| §5.1 推論port | 参考の `ports.d.ts` は `outputSchema` が任意で履歴・期限の項目が無い。gleaning・期限の扱いに影響（§4.4） |
| §10 現行検索との比較 | 上流の評価資源（`lightrag/evaluation/`、`reproduce/`）は使わない前提だが、上流が示す品質数値を移植後の期待値に使えない（plan §4 のとおり）。比較の閾値は P0 で固定する |

## 8.1 P0 で決める項目

1. 記録（対象・関係）の schema: `directed`、種別、条件・否定・確度、`evidence`（§4.4）。
2. 同一視の方式: 言及を正本としLLMでリンクするか、初期版では同一視を行わないか（§4.4）。
3. 断片の容量: byte 上限、重なりの有無、構造優先の境界規則、句点を境界に使うか（§4.3）。
4. gleaning の採否と回数（費用・取りこぼし率で測定）。
5. 検索経路の初期セット（local／global／hybrid／mix／naive のうちどれを P3 で比較するか）。
6. 要約の閾値（断片数・byte）と再生成の予約方法。
7. 引用digest・本文digest のアルゴリズム（SHA-256 を推奨。MD5 は上流が重複検知に使っているだけ）。
8. 翻案する指示の版管理（版付き資源に `derivedFrom` を持たせるか）。

## 9. 未確認

- 上流を実行・インストールしていないため、本書の挙動はすべてコード読解による。特に §4.2 の失敗経路（キャッシュ欠落時に説明文が残る）は実行で確かめていない。
- 読み切っていない部分: `operate.py` の `merge_nodes_and_edges` 本体（`:3514-3940`）と `extract_entities` の末尾（`:4420-4660`）、`utils.py` の `pick_by_vector_similarity`・`process_chunks_unified` の切詰め関数、`chunker/` の R／V／P の内部（P は冒頭の説明のみ）、`parser/`・`sidecar/`・`utils_graph.py`（管理用の対象編集・統合）・`llm/`・`kg/` の各実装・`docs/`。
- 取得は `--depth 1` のため、機能の導入時期・変更履歴・過去の版との差分は見ていない。上流のコードが nano-graphrag や Microsoft GraphRAG など他プロジェクトに由来するか、プロンプト文面の出典は、このツリーから確認できない。
- `main` が取得後に進んだかどうか（固定 commit は取得時点の先頭）。
- 実効の分割既定値（重なりのトークン数）。環境変数由来で、`lightrag.py:1440-1500` の解決順を全部は追っていない。
- LARM が制約付き出力（JSON schema）・rerank に対応するか、どの schema 機能まで使えるか。
- 日本語での byte→token 比、`Intl.Segmenter` の Bun 1.4.4 での可否。
- 文書内の ``` が上流の抽出プロンプトのフェンスを破る件は、該当経路の読解のみで、網羅的な検索はしていない。
