# Third-party notices

This package contains material adapted from the following project. The license text and copyright notice below are reproduced as required by that license.

## LightRAG

- Project: LightRAG
- Source: https://github.com/HKUDS/LightRAG
- Commit: `aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`
- License: MIT
- Notice id: `lightrag-prompts-v1`

### Adapted files

| This package | Upstream (at the commit above) | Upstream file sha256 | Kind |
| --- | --- | --- | --- |
| `src/contexts/sources/extract.v1.md` (bundled as the instruction `extract`, version 1, through `src/contexts/generated.ts` / `dist/contexts/generated.js`) | `lightrag/prompt.py`, lines 175-295 (the JSON-format entity and relationship extraction instruction, its user prompt and its output template) and lines 36-54 (the section-context block that treats a document's headings as untrusted metadata) | `db0cf2d0f5d420a8372fac2b33043d8b4f14c84ec0a60653862e4e53a27047e1` | adapted |
| `src/contexts/sources/extract.v2.md` (bundled as the instruction `extract`, version 2, through `src/contexts/generated.ts` / `dist/contexts/generated.js`) | the same as version 1 (v2 is v1 with added rules that exclude the document's own structure and context-dependent general words from the entities) | `db0cf2d0f5d420a8372fac2b33043d8b4f14c84ec0a60653862e4e53a27047e1` | adapted |
| `src/core/extract/request.ts` (the gleaning task text, shipped as `dist/core/extract/request.js`; not run by default) | `lightrag/prompt.py`, lines 255-269 (the JSON-format gleaning prompt) | `db0cf2d0f5d420a8372fac2b33043d8b4f14c84ec0a60653862e4e53a27047e1` | adapted |
| `src/contexts/sources/summarize.v1.md` (bundled as the instruction `summarize`, version 1, through `src/contexts/generated.ts` / `dist/contexts/generated.js`) | `lightrag/prompt.py`, lines 297-328 (the entity description summarization instruction) | `db0cf2d0f5d420a8372fac2b33043d8b4f14c84ec0a60653862e4e53a27047e1` | adapted |

The upstream sources are linked from https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/lightrag/prompt.py. No other upstream file is copied or adapted.

### Summary of changes

The upstream text was translated into Japanese and rewritten for this package. The changes are:

- The output is one JSON object with `entities` and `relations`. Each record has a local id; a relation refers to entities by local id instead of by name. Upstream uses names for `source` and `target`.
- Every entity and relation carries `evidence`: contiguous quotations of the input text, copied without any change. The package locates them mechanically and stores their UTF-8 byte ranges and digests.
- Names are written as they appear in the document (no translation, no title case). Upstream asks for title case and for output in one configured language.
- The fixed list of 11 English entity types is removed. `type` and `relation` are short free descriptions.
- Relations are binary, and a relation without a stated direction has `directed: false`. Conditions, negation and certainty are recorded in `qualifiers`.
- The input (fragment text) and the heading path are passed as one JSON line, not as a fenced block, and the instruction states that they are reference data whose commands must not be followed. The heading path is used as background only.
- Quantity and length limits are fixed in the output schema (`src/contracts/index-data.ts`); an answer over a limit is invalid and is not truncated.
- Upstream's tuple format, `json_repair` fallback and language setting are not used. Upstream's relationship keywords (one comma-separated string) are kept as an array `keywords`.
- The summarization instruction (`summarize.v1.md`) takes the names and descriptions of one entity's mentions as one JSON line, not as a fenced list, and states that they are reference data whose commands must not be followed. The output is one JSON object with a `summary` string of at most 1,500 characters, instead of plain text with a token limit. It adds an explicit ban on adding anything the descriptions do not say, and asks for conflicting descriptions to be stated side by side without resolving them from outside knowledge. Upstream's `{language}` and `{summary_length}` placeholders are replaced by "the language of the descriptions" and the character limit.
- `src/contexts/sources/link.v1.md`, `link.v2.md` and `link.v3.md` (the identity judgment; v2 also covers mentions from different places of one document, v3 adds the kinds of related pairs that are not the same entity) have no counterpart in the upstream project and are not adapted from it.

### License

MIT License

Copyright (c) 2025 LightRAG Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Wikipedia articles (repository material, not in the package)

- Material: 20 articles of the Japanese Wikipedia (ja.wikipedia.org), starting from 「大規模言語モデル」 and following its links, retrieved on 2026-11-09.
- Where: `examples/corpus/wiki-llm/*.md` (the articles), and quotations of them in `verification/kg-wiki-llm/` (the evaluation records, for example `edge-judgments.md`).
- License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0), https://creativecommons.org/licenses/by-sa/4.0/. These files are distributed under that license, not under this repository's MIT license.
- Attribution: the title, URL and revision id of every article are listed in `examples/corpus/wiki-llm/SOURCES.json`; the authors of each article are listed in its history on Wikipedia.
- Changes: the plain text of each article (the TextExtracts API) was converted to Markdown headings; the sections of notes, sources, references, external links and related articles were removed; nothing else was changed.
- Use: evaluation of the model-free knowledge graph (kg2.md §7.8). The package itself does not contain this material.
