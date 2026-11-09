"""Sudachi normalized form of each name, for the key graph of kg.md section 8 (scripts/kg-keys.ts).

Reads a JSON list of strings (UTF-8) on stdin and writes a JSON list of the same length on stdout
(ASCII, non-ASCII escaped, so the locale's encoding plays no part): each
string's morphemes (SplitMode C, dictionary core) replaced by their normalized form and joined,
white-space morphemes left out. kg-keys.ts runs it through `uv` with pinned versions.
"""

import json
import sys

from sudachipy import Dictionary, SplitMode


def main() -> None:
    names = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise SystemExit("expected a JSON list of strings")
    tokenizer = Dictionary(dict="core").tokenizer(mode=SplitMode.C)
    out = []
    for name in names:
        morphemes = tokenizer.tokenize(name) if name.strip() else []
        out.append(
            "".join(
                m.normalized_form() for m in morphemes if not m.surface().isspace()
            )
        )
    sys.stdout.write(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()
