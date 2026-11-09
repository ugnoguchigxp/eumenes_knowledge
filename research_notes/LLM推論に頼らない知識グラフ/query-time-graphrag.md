# Low-indexing-cost graph RAG: deferring LLM work to query time, or building the graph with cheap NLP

Scope note: research date 2026-11-09. Web research only; primary sources (arXiv HTML/abs pages, official repos and docs, Microsoft Research blog) are preferred. Pre-2025 facts are marked "(2024)". Where a number comes only from a search-result snippet or a secondary review, it is marked "unverified".

## Q1. Microsoft LazyGraphRAG and GraphRAG "fast" (NLP-based) indexing: what is indexed, what is deferred, cost and quality, release status

### Takeaway
LazyGraphRAG indexes with NLP noun-phrase extraction plus co-occurrence and graph statistics (no LLM), at a reported cost equal to vector RAG and 0.1% of full GraphRAG, and moves all LLM work (subquery generation, sentence-level relevance tests, claim extraction, map/reduce) to query time under a tunable "relevance test budget". As of late 2026 it is not released in the open-source `microsoft/graphrag` repo: the README says the project is "largely in maintenance mode" and neither the README nor the indexing-methods docs mention LazyGraphRAG. Microsoft says the technology went into Microsoft Discovery and an Azure Local public preview instead. The open-source "fast" method (NLTK/spaCy noun phrases plus co-occurrence edges, with LLM community reports kept) is documented only qualitatively as "noisier". Microsoft publishes no numeric quality loss for it.

### Cited Findings
**LazyGraphRAG: indexing (Microsoft Research blog, Nov 2024 with a June 2025 editor's note)**
- Indexing uses NLP noun-phrase extraction to find concepts and their co-occurrences, then graph statistics to optimize the concept graph and extract a hierarchical community structure. No LLM is used at index time. — [MSR blog: LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- "LazyGraphRAG data indexing costs are identical to vector RAG and 0.1% of the costs of full GraphRAG." — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)

**LazyGraphRAG: deferred to query time**
- Query refinement: an LLM generates 3–5 subqueries and matches them to concepts in the concept graph. — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- Relevance tests: an LLM-based sentence-level relevance assessor scores the top-k untested chunks. The total number of tests is a "relevance test budget" split across subqueries. — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- Iterative deepening: the search "recurses into relevant sub-communities after z successive communities yield zero relevant text chunks". — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- Claims extraction: an LLM extracts subquery-relevant claims from grouped chunks, then ranks and filters them to fit a context window. A final reduce step answers from those claims. — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)

**LazyGraphRAG: reported cost ratios and quality**
- Global queries: quality comparable to GraphRAG Global Search at "more than 700 times lower query cost". At "4% of the query cost of GraphRAG global search" it significantly outperforms all competing methods on both local and global queries. Local queries: it outperforms all competitors at query cost comparable to vector RAG. — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- Benchmark setup: 5,590 AP news articles and 100 synthetic queries (50 local, 50 global). Pairwise LLM-judged comprehensiveness, diversity and empowerment. Budgets of 100 (Z100_Lite), 500 and 1,500 relevance tests. Competitors: GraphRAG C1/C2/C3_Dynamic, local search, DRIFT, vector RAG SS_8K/SS_64K, and RAPTOR. Z100_Lite uses a low-cost LLM for every step. Z500/Z1500 use a low-cost LLM for relevance tests and a stronger LLM for refinement and map/reduce. No model names and no numeric win rates are given (charts only). — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- Caveat: these are Microsoft's own results on a single news dataset with LLM-as-judge metrics. — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/); the same caveat appears in secondary coverage, [beri.net](https://www.beri.net/article/graphrag-vs-vector-rag-indexing-query-cost-lightrag-lazygraphrag-2026)

**LazyGraphRAG: independent results (GraphRAG-Bench, ICLR 2026, GPT-4o-mini generator)**
- Novel dataset accuracy, Lazy-GraphRAG vs RAG with rerank: fact retrieval 51.65 vs 60.92; complex reasoning 49.22 vs 42.93; contextual summarize 58.29 vs 51.30; creative generation 43.23 vs 38.26. — [GraphRAG-Bench, arXiv 2506.05690](https://arxiv.org/html/2506.05690)
- Medical dataset accuracy, Lazy-GraphRAG vs RAG with rerank: fact 60.25 vs 64.73; reasoning 47.82 vs 58.64; summarize 57.28 vs 65.75; creative 62.22 vs 60.61. On Medical it is below plain RAG on three of the four task types. — [GraphRAG-Bench](https://arxiv.org/html/2506.05690)
- Conflict: GraphRAG-Bench's indexing-cost table (Appendix, Novel book) lists LAZY-GraphRAG at 253.59 s and 591,150 total tokens. That contradicts Microsoft's "no LLM at index time" description, which suggests the benchmark used a re-implementation or configuration that calls an LLM during indexing. — [GraphRAG-Bench appendix](https://arxiv.org/html/2506.05690); vs [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)

**LazyGraphRAG: release status**
- Editor's note (June 6, 2025): the technology "has been integrated into Microsoft Discovery" (an agentic science platform on Azure), and also into Azure Local services as a public preview. The blog links the GraphRAG GitHub repo but does not say LazyGraphRAG is released there. — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- The GraphRAG 1.0 announcement (Dec 2024) said LazyGraphRAG would be added to the core codebase as an option. — [MSR blog: Moving to GraphRAG 1.0](https://www.microsoft.com/en-us/research/blog/moving-to-graphrag-1-0-streamlining-ergonomics-for-developers-and-users/) (via search summary)
- The current `microsoft/graphrag` README does not mention LazyGraphRAG and states: "This project is largely in maintenance mode, and won't be accepting new PRs or implementing new features." — [GitHub microsoft/graphrag](https://github.com/microsoft/graphrag)
- The official indexing-methods docs page lists only Standard and Fast, with no mention of LazyGraphRAG. — [GraphRAG docs: Indexing methods](https://microsoft.github.io/graphrag/index/methods/)

**GraphRAG "fast" indexing method (open source, `graphrag index --method fast`)**
- Entities are "noun phrases extracted using NLP libraries such as NLTK and spaCy". Relationships are "text unit co-occurrence between entity pairs". Entities have no descriptions (the source text unit is used instead). Entity/relationship summarization and claim extraction are skipped. Community reports still use the LLM, prompted with the text units that contain each noun phrase. — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)
- Microsoft estimates "graph extraction to constitute roughly 75% of indexing cost". The fast method removes that part but keeps LLM community reports. — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)
- Stated trade-off: "the graph tends to be quite a bit noisier", while "FastGraphRAG provides high quality summarization with much lower language model cost" for global-search summary questions. No numeric quality loss is published. — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)
- Extractor options: NLTK plus regex (default), which is "very fast but primarily suitable for English". spaCy semantic parsing and CFG options are also available, with default model `en_core_web_md` and "any supported model" allowed. — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)

### Inferences
- LazyGraphRAG's index (noun phrases, co-occurrence, communities) is structurally close to GraphRAG fast without community reports. The quality comes from query-time LLM relevance testing. That cost scales with the budget (100–1,500 LLM relevance calls per query), which matters if the same ~52 s/fragment small local model must also run query time. With a strong cloud agent at query time, the trade-off is favorable.
- LazyGraphRAG's final context is LLM-extracted "claims", not verbatim spans. Byte-range citations would need claims to keep pointers to the source sentences or chunks. Relevance tests are sentence-level, so those pointers are available in principle, but the blog does not describe citation output.
- The relation-free index means LazyGraphRAG has no relation-naming problem. It also means a viewer would show co-occurrence edges (concept–concept, concept–chunk), not semantic relations.

### Gaps
- No exact LazyGraphRAG win-rate numbers, model names, or per-query dollar costs were found (the blog gives charts only).
- No public open-source LazyGraphRAG implementation from Microsoft was found. A secondary claim that `graphrag` reached v3.1.1 in July 2026 with no "lazy" mentions in the docs was seen only in a search summary and not verified.
- No Microsoft-published numeric quality comparison of `--method fast` vs `--method standard` was found.
- Note on naming: GraphRAG-Bench's "Fast-GraphRAG" row is very likely circlemind's `fast-graphrag` library, not Microsoft's `--method fast` (it uses about 252k LLM tokens to index). It should not be read as a measurement of Microsoft's NLP method. This is inferred, not confirmed in the paper text read.

## Q2. Method-by-method: KET-RAG, LinearRAG, MiniRAG, HippoRAG 2, RAPTOR, LightRAG, fast-graphrag, PathRAG, NodeRAG, E2GraphRAG, and 2025–2026 cost-focused successors

### Takeaway
The truly LLM-free indexers are LinearRAG (spaCy NER, entity–sentence–passage "Tri-Graph", 0 LLM tokens, ICLR 2026), LazyGraphRAG/GraphRAG-fast (noun phrases), KET-RAG's keyword-bipartite half, and the 2026 LiteSemRAG (zero LLM tokens). On multi-hop QA, LinearRAG matches or beats LLM-extracted graphs (HippoRAG 2, LightRAG) at about a fifth of HippoRAG 2's indexing time. LightRAG is the most expensive indexer in independent measurements (e.g. 35.5M prompt plus 51.2M completion tokens on 2Wiki) and also uses about 100k prompt tokens per query. HippoRAG 2 and fast-graphrag still need LLM OpenIE/extraction, but cost much less than LightRAG or MS-GraphRAG.

### Cited Findings
**Head-to-head indexing cost (LinearRAG paper, Table 2, 2WikiMultiHopQA; time in s, tokens in millions)**
- G-retriever 2745.94 s / 6.05M prompt / 2.26M completion; RAPTOR 1323.57 / 0.81 / 0.03; E2GraphRAG 534.60 / 0.78 / 0.08; LightRAG 4933.22 / 35.52 / 51.16; HippoRAG 936.00 / 3.05 / 0.98; GFM-RAG 1202.77 / 3.05 / 0.98; HippoRAG2 1147.01 / 4.98 / 1.22; **LinearRAG 249.78 / 0 / 0**. Average retrieval time: LinearRAG 0.093 s, E2GraphRAG 0.053 s, RAPTOR 0.062 s, LightRAG 10.963 s, HippoRAG2 1.694 s. — [LinearRAG, arXiv 2510.10114](https://arxiv.org/html/2510.10114)
- Large scale (ATLAS-Wiki): at 10M tokens, RAPTOR 46,430.96 s (16.62M prompt), HippoRAG 13,815 s (28.04M prompt), LinearRAG 3,084.38 s (0 tokens). — [LinearRAG](https://arxiv.org/html/2510.10114)
- Internal inconsistency: the LinearRAG text attributes 3.05M/0.98M tokens to HippoRAG2, while Table 2 gives HippoRAG2 4.98M/1.22M. — [LinearRAG](https://arxiv.org/html/2510.10114)

**Head-to-head indexing cost (GraphRAG-Bench, Appendix Table 10, one Novel-corpus book; time / total tokens)**
- MS-GraphRAG 292.45 s / 654,673; LightRAG 710.32 s / 474,172; Fast-GraphRAG 281.74 s / 251,817; HippoRAG 77.42 s / 177,961; HippoRAG2 96.71 s / 329,993; KGP 32.01 s / 89,215; RAPTOR 135.21 s / 115,541; KET-RAG 350.43 s / 517,551; LAZY-GraphRAG 253.59 s / 591,150. — [GraphRAG-Bench appendix](https://arxiv.org/html/2506.05690)
- Average prompt tokens per query (Novel): vanilla RAG 879; HippoRAG2 1,008; RAPTOR 3,441; Fast-GraphRAG 4,204; HippoRAG 7,208; MS-GraphRAG local 38,707; LightRAG 100,832; MS-GraphRAG global 331,375. Medical values are similar. — [GraphRAG-Bench](https://arxiv.org/html/2506.05690)
- Graph density (Novel, average degree / clustering coefficient): HippoRAG2 8.75 / 0.657; Fast-GraphRAG 3.19 / 0.324; LightRAG 2.10 / 0.212; MS-GraphRAG 1.48 / 0.315; HippoRAG 1.73 / 0.100. — [GraphRAG-Bench](https://arxiv.org/html/2506.05690)

**Head-to-head (RAGSearch, arXiv 2604.09666, Apr 2026; NQ, per 1M corpus tokens, GPT-4o-mini builds graphs)**
- Construction time / cost / average retrieval time / average context tokens: LinearRAG 0.68 h / $0 / 1.18 s / 4,600; HippoRAG2 1.19 h / $2.85 / 1.00 s / 3,229; HypergraphRAG 1.37 h / $3.93 / 0.77 s / 1,680; RAPTOR 1.70 h / $6.38 / 8.4 s / 814; GraphRAG 1.72 h / $13.19 / 1.16 s / 22,160. — [RAGSearch, arXiv 2604.09666](https://arxiv.org/html/2604.09666v1)

**LinearRAG (Oct 2025, ICLR 2026)**
- Graph: passages are split into sentences, and "lightweight models (e.g., spaCy)" do NER. Nodes are entities, sentences and passages. Edges come from sparse contain (passage–entity) and mention (sentence–entity) matrices. "No relation triples". Embeddings: all-mpnet-base-v2. 0 prompt and 0 completion tokens at indexing. — [LinearRAG](https://arxiv.org/html/2510.10114); [GitHub DEEP-PolyU/LinearRAG](https://github.com/DEEP-PolyU/LinearRAG)
- Retrieval: two stages. Relevant entities are activated via local semantic bridging, then global importance scores are aggregated to rank passages. — [arXiv abs 2510.10114](https://arxiv.org/abs/2510.10114)
- Quality (GPT-4o-mini, Contain-Acc / GPT-Acc): HotpotQA 64.30/66.50 vs vanilla top-5 55.70/58.60 vs HippoRAG2 62.90/64.30; 2Wiki 70.20/63.70 vs vanilla 48.60/43.00; MuSiQue 33.90/37.00 vs vanilla 26.10/29.60 vs HippoRAG2 31.00/35.00; Medical GPT-Acc 63.72 vs vanilla 61.68 vs HippoRAG2 60.77. — [LinearRAG](https://arxiv.org/html/2510.10114)
- Motivation: the authors argue that relation extraction is "unstable and costly", which the LinearRAG abstract cites as the reason for replacing it with entity extraction plus semantic linking. — [arXiv abs 2510.10114](https://arxiv.org/abs/2510.10114)

**KET-RAG (Feb 2025, arXiv preprint)**
- Two indexes. (1) A KG "skeleton" built by an LLM only on core chunks: chunks are ranked by PageRank on a KNN chunk graph (shared keywords or embedding similarity) and the top β fraction is kept, with β = 0.8 by default. (2) A text–keyword bipartite graph over all chunks, where keywords are the words remaining after stop-word removal (no LLM) and each keyword's description is the set of sentences containing it. — [KET-RAG, arXiv 2502.09304](https://arxiv.org/html/2502.09304)
- Cost (USD, low/high configs): MuSiQue Text-RAG 0.02/0.05, MS-Graph-RAG 2.30/24.94, HippoRAG 1.49/8.70, LightRAG 1.80/excluded, KET-RAG-P 1.89/20.04. HotpotQA: MS-Graph-RAG 2.30/21.29, KET-RAG-P 1.87/17.10. — [KET-RAG](https://arxiv.org/html/2502.09304)
- The headline "over an order of magnitude" reduction holds only when comparing low-cost KET-RAG with high-performance MS-GraphRAG. In the same setting the saving is "around 20%". — [KET-RAG](https://arxiv.org/html/2502.09304)
- Quality (low-cost config, GPT-4o-mini, text-embedding-3-small), MuSiQue coverage / EM / F1: KET-RAG-P 77.0/14.0/18.9 vs MS-Graph-RAG 47.6/11.4/15.8 vs HippoRAG 51.6/9.2/14.2 vs Text-RAG 26.4/3.0/5.4. HotpotQA: KET-RAG-P 81.6/28.6/38.7 vs HippoRAG 64.0/29.2/38.3. — [KET-RAG](https://arxiv.org/html/2502.09304)

**MiniRAG (Jan 2025)**
- Heterogeneous graph of text-chunk nodes (1,200 tokens) and entity nodes, with entity–entity and entity–chunk edges. A language model still does "basic entity extraction" at indexing and writes edge descriptions. At query time a small model extracts query entities and predicts answer types. Embeddings: all-MiniLM-L6-v2. Claims "only 25% of the storage space" of LightRAG. — [MiniRAG, arXiv 2501.06713](https://arxiv.org/html/2501.06713)
- Retrieval is designed for "reducing reliance on complex semantic understanding". — [arXiv abs 2501.06713](https://arxiv.org/abs/2501.06713)
- Small-model results are in Q4 below.

**HippoRAG 2 (Feb 2025, ICML 2025)**
- Indexing: an LLM (Llama-3.3-70B-Instruct) extracts schema-free OpenIE triples, so relations are free text. Synonym edges link phrase nodes whose embedding similarity exceeds 0.8. Passage nodes are linked to their phrases by "contains" edges. Removing passage nodes drops multi-hop recall@5 from 87.1 to 81.0. — [HippoRAG 2, arXiv 2502.14802](https://arxiv.org/html/2502.14802)
- Quality vs NV-Embed-v2 dense retrieval (QA F1): average 59.8 vs 57.0; 2Wiki 71.0 vs 61.5; MuSiQue 48.6 vs 45.7; NQ 63.3 vs 61.9; HotpotQA 75.5 vs 75.3. Recall@5 average 78.2 vs 73.4. — [HippoRAG 2](https://arxiv.org/html/2502.14802)
- Cost (MuSiQue corpus, 11,656 passages): indexing 99.5 min with 9.2M input and 3.0M output tokens, vs NV-Embed-v2 at 12.1 min. QA takes 1.2 s/query vs 0.3 s, and 9.9 GB vs 1.7 GB of GPU memory. — [HippoRAG 2](https://arxiv.org/html/2502.14802)

**LightRAG (2024; its own cost)**
- Uses GPT-4o-mini for all LLM steps. Entities are typed by the extraction prompt (organization, person, location, event, ...). Relations are free-text descriptions with strength scores and LLM-generated keywords; there is no fixed relation schema. — [LightRAG, arXiv 2410.05779](https://arxiv.org/html/2410.05779v1)
- Claimed query-time saving vs GraphRAG on the Legal dataset: fewer than 100 tokens and one API call for keyword generation, vs about 610 communities × 1,000 tokens (about 610k tokens) for GraphRAG global search. — [LightRAG](https://arxiv.org/html/2410.05779v1)
- Independent measurements contradict "cheap": 4,933 s and 35.52M prompt plus 51.16M completion tokens to index 2Wiki, the highest of all methods in LinearRAG's Table 2 ([LinearRAG](https://arxiv.org/html/2510.10114)); about 100k average prompt tokens per query in GraphRAG-Bench ([GraphRAG-Bench](https://arxiv.org/html/2506.05690)); "over 757M tokens on HotpotQA versus 62M for naive RAG" per TGS-RAG (unverified search snippet, [arXiv 2605.05643](https://arxiv.org/pdf/2605.05643)).

**fast-graphrag (circlemind, open source)**
- An LLM extracts entities of user-specified `entity_types` (domain, example queries). Retrieval uses "the personalized pagerank algorithm to explore the graph". The README claims "Supports real-time updates as your data evolves" and that `with_references=True` returns references. Its own cost claim is "$0.08 vs. graphrag $0.48" ("6x costs saving") on The Wizard of Oz. It works with OpenAI-compatible LLMs, with `CONCURRENT_TASK_LIMIT` noted as "helpful when running local models". — [GitHub circlemind-ai/fast-graphrag](https://github.com/circlemind-ai/fast-graphrag)
- GraphRAG-Bench (GPT-4o-mini): Fast-GraphRAG has the best Medical contextual-summarize accuracy (67.88 vs RAG-rerank 65.75) and uses about 4.2k prompt tokens per query. — [GraphRAG-Bench](https://arxiv.org/html/2506.05690)

**E2GraphRAG (May 2025)**
- Builds an LLM summary tree plus an entity graph made with SpaCy, with bidirectional entity↔chunk indexes. Adaptive local/global retrieval. Claims "up to 10 times faster indexing than GraphRAG" and a "100 times speedup over LightRAG in retrieval". — [E2GraphRAG, arXiv 2505.24226](https://arxiv.org/abs/2505.24226)
- Independent: 534.6 s, 0.78M prompt / 0.08M completion tokens on 2Wiki, and the fastest retrieval (0.053 s), though LinearRAG's authors say it trades off accuracy. — [LinearRAG](https://arxiv.org/html/2510.10114)

**RAPTOR (2024)**
- Builds a recursive LLM summary tree. Independent costs: 1,323.57 s and 0.81M prompt tokens on 2Wiki ([LinearRAG](https://arxiv.org/html/2510.10114)); $6.38 per 1M corpus tokens ([RAGSearch](https://arxiv.org/html/2604.09666v1)). GraphRAG-Bench Novel: highest creative-generation faithfulness (70.85) but weak fact retrieval (49.25 vs 60.92 for RAG-rerank). — [GraphRAG-Bench](https://arxiv.org/html/2506.05690)

**NodeRAG (Apr 2025)**
- Heterogeneous-node graph. Its Table 3 reports index time, storage, query time and retrieval tokens under default settings. — [NodeRAG, arXiv 2504.11544](https://arxiv.org/abs/2504.11544)
- Secondary review numbers (unverified): HotpotQA indexing 21 min vs GraphRAG 66 min and LightRAG 39 min; 89.50% accuracy with about 5k retrieved tokens. — [Liner review](https://liner.com/review/noderag-structuring-graphbased-rag-with-heterogeneous-nodes)

**2025–2026 cost-focused successors**
- **TERAG** (Sep 2025): minimizes LLM output tokens during graph construction and uses HippoRAG-style Personalized PageRank. It uses "only 3%-11% of the output tokens" of other graph RAG methods while reaching "at least 80% of the accuracy". — [TERAG, arXiv 2509.18667](https://arxiv.org/abs/2509.18667)
- **LiteSemRAG** (Mar 2026): LLM-free at both indexing and query. It builds a heterogeneous semantic graph from "contextual token-level embeddings" with dynamic sense nodes for polysemy, and uses co-occurrence weighting with "isolated semantic recovery". It "consumes zero LLM tokens" and reports the best MRR@10 on three datasets (not named on the abstract page). — [LiteSemRAG, arXiv 2604.16350](https://arxiv.org/abs/2604.16350)
- **EffiRAG** ("When Is Graph Structure Worth Its Cost?", Sep 2026): the graph is used only to locate passages, and the answer is generated from the original text. On UltraDomain (120 questions) it was preferred over LightRAG-hybrid on 93 questions (LightRAG 7, splits 20). Total system cost fell 57% ($0.952 → $0.408, ingestion plus query). At 10/20 documents per domain, a non-LLM salience filter skips chunks, giving 4.2×/4.5× lower cost. — [arXiv 2609.18099](https://arxiv.org/abs/2609.18099)
- **LiteRAG** (Sep 2026): reuses MS-GraphRAG indexing and changes only retrieval and context construction. Reportedly matches LinearRAG at about 14× fewer tokens on UltraDomain (search snippet, unverified). — [arXiv 2609.10239](https://arxiv.org/html/2609.10239v1)
- **TGS-RAG** (May 2026): no precomputed global summaries, with on-demand retrieval at inference. About 37% of GraphRAG's tokens on MuSiQue (search snippet, unverified). — [arXiv 2605.05643](https://arxiv.org/pdf/2605.05643)
- **FG-RAG** (Apr 2025): indexing tokens on Mix are about 7.7M for GraphRAG, 5.1M for LightRAG and 4.9M for FG-RAG, so only a modest gain over LightRAG (search snippet, unverified). — [arXiv 2504.07103](https://arxiv.org/pdf/2504.07103)

### Inferences
- For this project's pain points (free-text relations that never merge, LLM-judged identity, 2 h per 60 KB), the evidence favors relation-free structural graphs: entity/noun phrase ↔ sentence ↔ passage containment (LinearRAG), keyword ↔ chunk bipartite (KET-RAG), or concept co-occurrence plus communities (LazyGraphRAG). Cross-document links then come from shared normalized surface forms and embedding similarity (HippoRAG 2's synonym edges, threshold 0.8) rather than pairwise LLM judgment.
- LinearRAG's sentence nodes map naturally onto verbatim-quote citations: each retrieved unit is a source sentence or passage whose byte range is known at indexing, with no LLM paraphrase in between.
- Speed is not quality-neutral. E2GraphRAG and RAPTOR are faster at retrieval but lose accuracy, and LazyGraphRAG underperforms plain RAG on GraphRAG-Bench Medical. A cheap graph is a retrieval aid, not a guaranteed improvement.

### Gaps
- **PathRAG**: no source was retrieved in this session. From background knowledge (unverified here), PathRAG (arXiv 2502.14902, Feb 2025) reuses a LightRAG-style LLM-extracted index and adds flow-based path pruning at query time, so its indexing cost would be about LightRAG's. This needs verification.
- NodeRAG's Table 3 numbers could not be read from the primary source.
- LiteSemRAG's datasets, baselines and timing, and TERAG's datasets and models, were not visible on the abstract pages.
- No primary comparison of KET-RAG at very low β (e.g. 0.1–0.3) was read. The paper's default is β = 0.8, so most chunks still go through LLM extraction.

## Q3. Systematic 2025–2026 evaluations: when does graph RAG beat plain vector or hybrid RAG?

### Takeaway
The consistent finding across GraphRAG-Bench (ICLR 2026), Han et al. "RAG vs. GraphRAG" (2025, revised 2026) and RAGSearch (2026) is that graphs help multi-hop reasoning and contextual summarization, and do not help, or hurt, simple fact lookup. Agentic iterative search narrows the gap but does not close it on multi-hop QA. Larger backbone models also shrink the gap. Separately, a 2025–2026 memory study finds that replacing verbatim text with LLM-extracted artifacts loses 16–22 accuracy points.

### Cited Findings
- **GraphRAG-Bench** ("When to use Graphs in RAG", arXiv 2506.05690, ICLR 2026) has four task levels: fact retrieval, complex reasoning, contextual summarize and creative generation. "Basic RAG is comparable to or better than GraphRAG on fact retrieval", because graph processing "may introduce redundant or noisy information for simpler queries". GraphRAG shows "a clear advantage in complex reasoning, Contextual Summarize, and creative generation". — [GraphRAG-Bench](https://arxiv.org/html/2506.05690); [GitHub GraphRAG-Benchmark](https://github.com/GraphRAG-Bench/GraphRAG-Benchmark)
- GraphRAG-Bench Novel (GPT-4o-mini): RAG-rerank wins fact retrieval (60.92 vs HippoRAG2 60.14 and MS-GraphRAG 49.29). HippoRAG2 wins complex reasoning (53.38 vs 42.93). Medical: RAG-rerank summarize 65.75 vs HippoRAG2 63.08, and MS-GraphRAG is far below RAG on every Medical task (e.g. fact 38.63 vs 64.73). — [GraphRAG-Bench](https://arxiv.org/html/2506.05690)
- GraphRAG-Bench also finds that prompt size grows with task difficulty (MS-GraphRAG global from about 7.8k to 40k tokens), which can add noise. The authors recommend precise retrieval and "better graphs rather than simply larger ones". — [GraphRAG-Bench](https://arxiv.org/html/2506.05690); [search summary of ICLR paper](https://proceedings.iclr.cc/paper_files/paper/2026/file/6c9e01d6cefbbf4cdd265032550e767f-Paper-Conference.pdf)
- A second benchmark, also named "GraphRAG-Bench" (arXiv 2506.02404, domain-specific reasoning), is a different paper; the two are easily confused. — [arXiv 2506.02404](https://arxiv.org/pdf/2506.02404)
- **Han et al., "RAG vs. GraphRAG: A Systematic Evaluation and Key Insights"** (arXiv 2502.11371, Feb 2025, revised Oct 2025 and Mar 2026): RAG is better on single-hop and detail questions, and GraphRAG on multi-hop. In query-based summarization RAG captures fine details while GraphRAG produces more diverse, multi-faceted summaries. The authors propose hybrid Selection (route per query) and Integration (merge results). Detailed numbers were not retrieved (search summary). — [arXiv 2502.11371](https://arxiv.org/abs/2502.11371)
- **RAGSearch** (arXiv 2604.09666, Apr 2026): single-shot GraphRAG gains +0.47 on average on general QA (NQ, PopQA, TriviaQA) but +27.23 on multi-hop (HotpotQA, MuSiQue, 2Wiki). With the GraphSearch agent the multi-hop gap only moves from +27.23 to +26.59. "dense RAG remains a practical and competitive choice for general QA due to its lower construction cost". GraphRAG gives higher document hit rates and lower run-to-run variance. — [RAGSearch](https://arxiv.org/html/2604.09666v1)
- **LinearRAG** results also show the largest gap over vanilla RAG on 2Wiki (70.20 vs 48.60 Contain-Acc) and a small gap on Medical (63.72 vs 61.68). — [LinearRAG](https://arxiv.org/html/2510.10114)
- **Fidelity Before Structure** (arXiv 2601.00821, Dec 2025, v4 Jul 2026): same pipeline, with only the stored representation changed. Verbatim chunks beat LLM-extracted typed artifacts 43.9% vs 28.0% on LoCoMo and 67.4% vs 45.4% on LongMemEval-S. A 1-hop semantic graph does not close the gap. Accuracy tracks "how much source text survives in the store". Adding artifacts alongside chunks preserves accuracy. — [arXiv 2601.00821](https://arxiv.org/abs/2601.00821)
- **EffiRAG** (arXiv 2609.18099, Sep 2026) argues that graph structure is most useful when it "locates and preserves source evidence", and that graph RAG should be judged on quality and cost together. — [arXiv 2609.18099](https://arxiv.org/abs/2609.18099)
- **FinSage** (financial filings QA): GraphRAG had a 42.50% faithfulness pass rate with a 16.09 s mean response time, and LightRAG had the poorest pass rate at 13.67% (search snippet). — [FinSage, arXiv 2504.14493](https://arxiv.org/pdf/2504.14493)

### Inferences
- For personal and team notes, which are mostly lookups ("where did I write X", "what was decided about Y") plus some cross-document "related" questions, the evidence says the default path should be hybrid vector/BM25 over verbatim chunks. The graph should serve as a re-ranking or expansion signal for multi-hop and related-document queries, with routing (Han et al.'s "Selection") rather than graph-only retrieval.
- The Fidelity and EffiRAG results support keeping verbatim chunks as the answer substrate, with graph nodes acting only as pointers. That matches the byte-range citation requirement.

### Gaps
- No systematic evaluation was found that isolates "related-document discovery" or "browsing" as a task. All benchmarks are QA or summarization.
- Han et al.'s full numeric tables, and arXiv 2506.06331 ("How Significant Are the Real Performance Gains?", an unbiased GraphRAG evaluation framework), were seen only by title or snippet and not read.

## Q4. Which methods report results with small (under ~10B) local models?

### Takeaway
Only a few. MiniRAG is designed and evaluated for 1.5–4B SLMs, where LightRAG and GraphRAG degrade or fail outright. GraphRAG-Bench tested Qwen2.5 3B/7B/14B and found that graph RAG is more sensitive to model size, with about 7B as the practical threshold. RAGSearch uses Qwen2.5 3B/7B agents, but GPT-4o-mini built the graphs. LLM-free indexers (LinearRAG, LiteSemRAG, LazyGraphRAG/fast indexing) avoid the small-model extraction quality problem entirely at index time.

### Cited Findings
- **MiniRAG**, LiHuaWorld accuracy (NaiveRAG / LightRAG / MiniRAG): Phi-3.5-mini 41.22 / 39.81 / 53.29; GLM-Edge-1.5B 42.79 / 35.74 / 52.51; Qwen2.5-3B 43.73 / 39.18 / 48.75; MiniCPM3-4B 43.42 / 35.42 / 51.25; gpt-4o-mini 46.55 / 56.90 / 54.08. GraphRAG "fails" with every SLM. On MultiHop-RAG, LightRAG falls to 19–27% or fails with SLMs while MiniRAG stays at 47–51%. — [MiniRAG](https://arxiv.org/html/2501.06713)
- MiniRAG: LightRAG accuracy falls "from 56.90% to 35.42% during LLM to SLM transition". — [MiniRAG](https://arxiv.org/html/2501.06713)
- **GraphRAG-Bench**, Medical average accuracy by Qwen2.5 size (3B / 7B / 14B): HippoRAG2 57.08 / 61.50 / 63.91 vs standard RAG 56.13 / 56.79 / 59.10. "GraphRAG exhibits a higher sensitivity to model capacity than Standard RAG", with 7B as an "inflection point" and practical "minimum size". (The text quotes 57.59 for the starting value but the table shows 57.08.) — [GraphRAG-Bench appendix](https://arxiv.org/html/2506.05690)
- **GraphRAG-Bench** with Qwen2.5-14B: Fast-GraphRAG reaches 60.08% on Novel fact retrieval vs 46.74% for RAG-rerank. RAG-rerank also drops on Medical (57.56 vs 64.73 under GPT-4o-mini), so graph methods look relatively stronger with the smaller generator. — [GraphRAG-Bench appendix](https://arxiv.org/html/2506.05690)
- **RAGSearch**: training-free agents use Qwen2.5-7B/32B and RL agents Qwen2.5-3B/7B, but GPT-4o-mini handled graph construction. Moving the RL agent from 3B to 7B shrinks the GraphRAG–dense gap from 14.70 to 9.75. — [RAGSearch](https://arxiv.org/html/2604.09666v1)
- **HippoRAG 2** reports only Llama-3.3-70B and GPT-4o-mini, with no sub-10B results. — [HippoRAG 2](https://arxiv.org/html/2502.14802)
- **LinearRAG, KET-RAG and LightRAG** report GPT-4o-mini only for generation and extraction (LinearRAG needs no LLM for indexing). — [LinearRAG](https://arxiv.org/html/2510.10114); [KET-RAG](https://arxiv.org/html/2502.09304); [LightRAG](https://arxiv.org/html/2410.05779v1)
- **fast-graphrag** mentions local models only via the `CONCURRENT_TASK_LIMIT` setting and OpenAI-compatible endpoints, with no reported results. — [fast-graphrag README](https://github.com/circlemind-ai/fast-graphrag)

### Inferences
- When the query-time consumer is the same small local model, two results point the same way: (a) MiniRAG shows SLMs cannot reliably drive LightRAG-style extraction or retrieval, and (b) GraphRAG-Bench shows graph-context benefits shrink below about 7B. Together these favor cheap structural graphs used for retrieval, with verbatim chunk context, over graph-summarized context that the small model must interpret.
- LazyGraphRAG-style query-time relevance testing (hundreds of LLM calls per query) is likely impractical with a local model at about 52 s per 2 KB extraction-scale call. With a strong cloud coding agent at query time it becomes feasible, so the system could expose the graph as a tool and let the agent decide how far to expand.

### Gaps
- No paper was found that evaluates LinearRAG, KET-RAG or LazyGraphRAG with a sub-10B generator.
- MiniRAG does not make explicit whether indexing in the SLM rows was also done by the SLM, or only querying and generation.

## Q5. Incremental updates: cost of adding or changing documents

### Takeaway
Methods whose graph is a union of per-chunk local structures (LinearRAG, KET-RAG's keyword graph, LightRAG, HippoRAG 2, fast-graphrag, GraphRAG fast entities) support cheap appends. Methods with global LLM summaries (GraphRAG community reports, RAPTOR trees, LazyGraphRAG's communities to a lesser degree) need recomputation. No primary source surveyed describes efficient handling of a changed or deleted document. They describe appends only.

### Cited Findings
- **LinearRAG**: "When new passages arrive, only those passages undergo sentence segmentation, NER, and edge construction", which keeps total complexity linear. No further update discussion. — [LinearRAG](https://arxiv.org/html/2510.10114)
- **LightRAG**: a new document is indexed with the same steps and merged by "taking the union of the node sets" and edge sets, "eliminating the need to rebuild the entire index graph". GraphRAG must instead regenerate community reports, estimated at about 1,399 × 2 × 5,000 tokens for the Legal dataset. Modification and deletion are not described. — [LightRAG](https://arxiv.org/html/2410.05779v1)
- **HippoRAG 2**: synonym edges integrate "both old and new knowledge". A corpus-expansion experiment (adding NQ/MuSiQue segments) shows its gain over NV-Embed-v2 holding steady, with figures only. — [HippoRAG 2](https://arxiv.org/html/2502.14802)
- **fast-graphrag**: "Supports real-time updates as your data evolves", and reinitializing from the same working directory "will retain all the knowledge automatically". — [fast-graphrag README](https://github.com/circlemind-ai/fast-graphrag)
- **KET-RAG**: incremental updates are not discussed. Future work mentions "adaptive paradigms for real-world scalable deployment". — [KET-RAG](https://arxiv.org/html/2502.09304)
- **NodeRAG**: the abstract does not mention incremental updates. A third-party summary lists dynamic graph updates as future work (secondary). — [NodeRAG abs](https://arxiv.org/abs/2504.11544); [Liner review](https://liner.com/review/noderag-structuring-graphbased-rag-with-heterogeneous-nodes)
- **GraphRAG docs**: the methods page does not mention an update path. — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)

### Inferences
- For a changed Markdown document, an LLM-free containment graph (entity/noun phrase ↔ sentence ↔ passage) allows exact diff-based maintenance. Rows for the changed fragments are deleted and the new ones re-run through NER and embedding in seconds, because no edge depends on an LLM judgment spanning documents. Only derived global structures (communities, similarity/synonym edges, PageRank scores) need a cheap recomputation.
- LazyGraphRAG's community hierarchy is computed with graph statistics, not an LLM, so recomputing it after an update is cheap compute rather than LLM tokens. Stable community IDs for a viewer would need extra work. (Inferred; Microsoft does not describe updates.)

### Gaps
- No source found quantifies re-indexing cost for a modified or deleted document in any of these systems.
- RAPTOR's update behavior was not covered by a primary source in this session. Rebuilding cluster summaries is the expected cost, but this is unverified.

## Q6. Cross-cutting criteria: typed relations, traceable citations, Japanese/multilingual

### Takeaway
Few of the low-cost methods need typed relations. LinearRAG, KET-RAG's keyword graph, LazyGraphRAG and GraphRAG-fast, and LiteSemRAG are explicitly relation-free. HippoRAG 2 and LightRAG use free-text relations, and fast-graphrag uses typed entities. Citations are strongest where retrieval returns original passages or sentences (LinearRAG, HippoRAG 2, EffiRAG, fast-graphrag `with_references`). No Japanese or multilingual evaluation of any of these graph RAG methods was found. The NLP extractors in the defaults (NLTK, spaCy `en_core_web_md`) are English-oriented.

### Cited Findings
- **Typed relations**: LinearRAG explicitly drops relation extraction as "unstable and costly", and its edges are contain/mention matrices ([LinearRAG](https://arxiv.org/html/2510.10114)). GraphRAG fast uses co-occurrence edges ([GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)). LazyGraphRAG uses concept co-occurrence ([MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)). KET-RAG's bipartite graph uses keyword–chunk edges ([KET-RAG](https://arxiv.org/html/2502.09304)). HippoRAG 2 uses schema-free OpenIE triples ([HippoRAG 2](https://arxiv.org/html/2502.14802)). LightRAG uses free-text relation descriptions plus keywords, with typed entities ([LightRAG](https://arxiv.org/html/2410.05779v1)). fast-graphrag uses user-declared `entity_types` ([fast-graphrag](https://github.com/circlemind-ai/fast-graphrag)).
- **Citations**: fast-graphrag supports `with_references=True` ([fast-graphrag](https://github.com/circlemind-ai/fast-graphrag)). EffiRAG generates answers from the original text after graph-based passage location ([arXiv 2609.18099](https://arxiv.org/abs/2609.18099)). LazyGraphRAG's context consists of LLM-extracted claims ([MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)). GraphRAG fast keeps the source text unit as the entity "description" ([GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)). HippoRAG 2's passage nodes are retrieved directly, and removing them lowers recall ([HippoRAG 2](https://arxiv.org/html/2502.14802)).
- **Faithfulness**: in financial QA, LightRAG had the lowest faithfulness pass rate (13.67%) vs GraphRAG (42.50%) (snippet). — [FinSage](https://arxiv.org/pdf/2504.14493)
- **Language**: the GraphRAG fast default NLTK extractor is "primarily suitable for English", and the spaCy default is `en_core_web_md`, though "any supported model" may be configured. — [GraphRAG docs](https://microsoft.github.io/graphrag/index/methods/)
- LinearRAG evaluates only English datasets and does not discuss multilingual use. — [LinearRAG](https://arxiv.org/html/2510.10114)
- A Japanese-language search found no Japanese-specific quantitative comparison of GraphRAG, LightRAG or vector RAG, only general explainer articles recommending hybrid setups. — [jisaku.com glossary](https://jisaku.com/glossary/graph-rag-vs-vector-rag)

### Inferences
- For mixed Japanese/English notes, noun-phrase or NER extraction needs a Japanese-capable pipeline. spaCy-compatible Japanese pipelines (e.g. GiNZA / `ja_core_news_*`) exist to my knowledge, but this was not verified in this session. NLTK's regex noun-phrase chunker would not work for Japanese. An alternative that avoids language-specific NLP is LiteSemRAG-style contextual token embeddings, or a multilingual embedding model (such as the e5 the project already uses) for similarity-based "synonym" edges as in HippoRAG 2.
- Byte-range citations are easiest when graph nodes point to sentence spans (LinearRAG's sentence nodes) recorded at indexing. LLM-produced claims or summaries (LazyGraphRAG, RAPTOR, GraphRAG community reports) need a second grounding step.

### Gaps
- No Japanese or multilingual benchmark results were found for LazyGraphRAG, GraphRAG-fast, LinearRAG, KET-RAG, MiniRAG, HippoRAG 2, LightRAG, fast-graphrag, NodeRAG or E2GraphRAG.
- Whether WildGraphBench (arXiv 2602.02053) or RAGU (arXiv 2607.11683, which cites Russian benchmarks) include non-English evaluation was not confirmed.
