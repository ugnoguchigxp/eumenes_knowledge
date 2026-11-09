"""Mentions without a model, for scripts/kg-alt.ts (kg.md section 9).

Reads a JSON list of texts (UTF-8) on stdin and writes, for each text, the list of mention
candidates as [surface, key, kind] on stdout (ASCII JSON). Tokens come from Sudachi (SplitMode C,
dictionary core). A candidate is a run of adjacent tokens that are nouns (名詞, 接頭辞, 名詞的な
接尾辞) or ASCII words; ASCII words separated by one space join while each starts with a capital
("Temporal Reasoning"). The key is the run's normalized forms joined (kg-alt.ts squashes it).
kind is "proper" when the run holds a proper noun (固有名詞) or an ASCII word other than a common
English function word (STOPWORDS: "the", "and", "use", "we", ...; mem0, eumenes_memory, steward and
LongMemEval stay proper). URLs are blanked out first; a sentence's full stop
is not part of a name ("M1." is M1); runs of one character or of digits and symbols only are left
out. Paths under a home or temporary directory (/Users/..., ~/...) are blanked out like URLs.

Version 4 (kg2.md G6) adds, with general lists only (no name of a subject):
- full-width ASCII and the ideographic space become ASCII first (the length stays, so offsets do;
  the full-width ．！？ stay, as sentence ends);
- a formal noun (こと, もの, ため, ...) ends a run and is no name;
- a run of one English function word or note marker (STOPWORDS, MARKERS: TODO ...) is no name;
- a command-line option (--full) and a number with a unit (16GB, 500k) are no names; a leading
  dot before a letter is dropped (.values is values);
- a lower-case English word (letters only) is proper only outside an English sentence (one with
  no kana): in a Japanese sentence it is a term (steward), in an English one an ordinary word.
  A Japanese line without kana (a heading, a table row, "構成: nginx + redis") counts as English
  here, so its lower-case words are not proper (they stay noun candidates).

Version 5 (kg2.md G3, the same rules as src/core/extract/names.ts):
- the full-width ASCII becomes ASCII before anything is blanked out, and a blanked text keeps its
  length (spaces of the same length);
- a URL or a path is blanked out by its ASCII characters only (the Japanese text written right
  after one stays), and a trailing full stop or comma stays; a Windows drive path is blanked too;
- e-mail addresses and secret-like strings (API keys of a known form, JWTs, the value after
  password= and the like) are blanked out;
- a token-like ASCII string (32 characters or more of hexadecimal digits, or of letters and digits
  with upper case, lower case and a digit) is no name.
"""

import json
import re
import sys

from sudachipy import Dictionary, SplitMode

ASCII_WORD = re.compile(r"^[A-Za-z0-9_\-./+#]+$")
HAS_LETTER = re.compile(r"[A-Za-z]")
IDENTIFIER_MARK = re.compile(r"[0-9_\-./+#]")
# Common English function words: in an English sentence every word is a noun to the Japanese
# dictionary, so these are kept out of "proper".
STOPWORDS = frozenset(
    """a about above after again all also am an and any are as at be because been before being
    below between both but by can could did do does doing down during each few for from further
    had has have having he her here hers him his how i if in into is it its just me more most my
    no nor not now of off on once only or other our out over own same she should so some such
    than that the their them then there these they this those through to too under until up us
    use used uses using very was we were what when where which while who whom why will with
    would you your""".split()
)
ONLY_DIGITS_OR_SYMBOLS = re.compile(r"^[\d\W_]+$")
MARKERS = frozenset("todo fixme tbd wip xxx".split())
FORMAL_NOUNS = frozenset("こと もの ため ところ よう とき はず わけ ほう うち まま つもり".split())
NUMBER_UNIT = re.compile(r"^\d+(?:[.,]\d+)?[A-Za-z]{1,3}$")
LOWER_WORD = re.compile(r"^[a-z]+$")
# Full-width ASCII (U+FF01..FF5E) and the ideographic space, one for one to ASCII; the full-width
# full stop, exclamation and question marks stay (they end Japanese sentences).
WIDE = {i: i - 0xFEE0 for i in range(0xFF01, 0xFF5F) if i not in (0xFF01, 0xFF0E, 0xFF1F)}
WIDE[0x3000] = 0x20
ASCII_LETTERS = re.compile(r"^[A-Za-z]+$")
SENTENCE_END = re.compile(r"[。．！？!?\n]|\.(?=\s)")
KANA = re.compile(r"[\u3041-\u309f\u30a0-\u30ff]")
# ASCII only, so a Japanese text written right after one is not taken with it.
URL = re.compile(r"(?:https?://|www\.)[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
# Paths under a home or temporary directory or a drive name a machine, not a subject (and must
# not leak).
LOCAL_PATH = re.compile(
    r"(?:~/|/(?:Users|home|private|var/folders|tmp)/|(?<![A-Za-z0-9])[A-Za-z]:\\)[A-Za-z0-9._\-/\\~+@%]*"
)
SECRET = re.compile(
    r"(?<![A-Za-z0-9])(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)"
)
SECRET_VALUE = re.compile(
    r"(?<![A-Za-z0-9])((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)([!-~]+)",
    re.IGNORECASE,
)
TRAILING_PUNCTUATION = re.compile(r"[.,;:!?']+$")
TOKEN_LIKE = re.compile(r"(?:[0-9A-Fa-f]{32,}|(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{32,})")


def blank_out(text: str) -> str:
    """The text the rules read (blankOut of src/core/extract/names.ts): the length stays."""

    def blank(m) -> str:
        return " " * len(m.group(0))

    def blank_body(m) -> str:
        whole = m.group(0)
        body = TRAILING_PUNCTUATION.sub("", whole)
        return " " * len(body) + whole[len(body) :]

    text = text.translate(WIDE)
    text = URL.sub(blank_body, text)
    text = EMAIL.sub(blank, text)
    text = LOCAL_PATH.sub(blank_body, text)
    text = SECRET.sub(blank, text)
    return SECRET_VALUE.sub(lambda m: m.group(1) + " " * len(m.group(2)), text)


def nounish(m) -> bool:
    pos = m.part_of_speech()
    if pos[0] in ("名詞", "接頭辞"):
        return True
    return pos[0] == "接尾辞" and pos[1] == "名詞的"


def ascii_word(m) -> bool:
    return bool(ASCII_WORD.match(m.surface()))


def ascii_proper(m) -> bool:
    s = m.surface()
    if not ascii_word(m) or not HAS_LETTER.search(s):
        return False
    return bool(IDENTIFIER_MARK.search(s)) or s.lower() not in STOPWORDS


def english_sentence(text: str, start: int, end: int) -> bool:
    """Whether the sentence around text[start:end] is English: it has letters and no kana (a
    Japanese sentence nearly always has hiragana or katakana; kanji alone may sit in English)."""
    left = 0
    for m in SENTENCE_END.finditer(text, 0, start):
        left = m.end()
    right = SENTENCE_END.search(text, end)
    sentence = text[left : right.start() if right else len(text)]
    if not any(c.isascii() and c.isalpha() for c in sentence):
        return False
    return KANA.search(sentence) is None


def capitalized(m) -> bool:
    s = m.surface()
    return bool(s) and s[0].isascii() and s[0].isupper()


def candidates(tokenizer, text: str):
    # URLs, paths and secret-like strings are not names: blanked out before tokenizing.
    text = blank_out(text)
    morphemes = [m for m in tokenizer.tokenize(text)]
    runs = []
    current = []

    def close():
        if current:
            runs.append(list(current))
            current.clear()

    for i, m in enumerate(morphemes):
        if m.surface().isspace():
            # One space between two capitalized ASCII words keeps the run ("Temporal Reasoning").
            prev = current[-1] if current else None
            nxt = morphemes[i + 1] if i + 1 < len(morphemes) else None
            if (
                m.surface() == " "
                and prev is not None
                and nxt is not None
                and ascii_word(prev)
                and ascii_word(nxt)
                and capitalized(prev)
                and capitalized(nxt)
            ):
                current.append(m)
                continue
            close()
            continue
        if m.surface() in FORMAL_NOUNS:
            close()
            continue
        if nounish(m) or ascii_word(m):
            if current and current[-1].end() != m.begin():
                close()
            current.append(m)
        else:
            close()
    close()
    out = []
    seen = set()
    for run in runs:
        # Leading prefixes and trailing suffixes alone are not names.
        while run and run[0].part_of_speech()[0] == "接頭辞":
            run = run[1:]
        while run and run[-1].part_of_speech()[0] == "接尾辞":
            run = run[:-1]
        if not run:
            continue
        surface = text[run[0].begin() : run[-1].end()]
        # A full stop that ends the sentence is not part of the name.
        trimmed = surface.rstrip(".")
        cut = len(surface) - len(trimmed)
        surface = trimmed
        # The sentence is found from the name's end without the full stop.
        name_end = run[0].begin() + len(trimmed)
        if surface.startswith("-") or NUMBER_UNIT.match(surface):
            continue
        lead = 1 if len(surface) > 1 and surface[0] == "." and surface[1].isalpha() else 0
        surface = surface[lead:]
        if len(surface) < 2 or ONLY_DIGITS_OR_SYMBOLS.match(surface):
            continue
        if ASCII_LETTERS.match(surface) and surface.lower() in (STOPWORDS | MARKERS):
            continue
        # A hash, a key or another token-like string is no name (and may be a secret).
        if TOKEN_LIKE.fullmatch(surface):
            continue
        key = "".join(
            m.surface() if ascii_word(m) or m.surface().isspace() else m.normalized_form()
            for m in run
        )
        if cut:
            key = key[: len(key) - cut] if key.endswith("." * cut) else key.rstrip(".")
        key = key[lead:]
        english = english_sentence(text, run[0].begin(), name_end)
        proper = any(
            m.part_of_speech()[1] == "固有名詞"
            or (
                ascii_proper(m)
                and not (english and LOWER_WORD.match(m.surface().strip(".")))
                and m.surface().lower() not in MARKERS
            )
            for m in run
        )
        if surface in seen:
            continue
        seen.add(surface)
        out.append([surface, key, "proper" if proper else "noun"])
    return out


def main() -> None:
    texts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        raise SystemExit("expected a JSON list of strings")
    tokenizer = Dictionary(dict="core").tokenizer(mode=SplitMode.C)
    sys.stdout.write(json.dumps([candidates(tokenizer, t) for t in texts], ensure_ascii=True))


if __name__ == "__main__":
    main()
