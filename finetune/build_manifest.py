#!/usr/bin/env python3
"""Build a Piper training manifest from the Arabic Speech Corpus.

- corpus transcript is Buckwalter ASCII -> convert to diacritized Arabic script
  so piper's espeak-`ar` phonemizer produces the same token stream the eBL
  normalizer targets (t̪/s̪, aː, χ, q, ʔ ...).
- emits metadata.csv  ->  `utt_id|arabic_text`  (utt_id = wav filename w/o .wav)
"""
import re, sys, os

# Tim Buckwalter transliteration -> Arabic (Unicode)
B2A = {
    "'": "ء", "|": "آ", ">": "أ", "&": "ؤ", "<": "إ", "}": "ئ",
    "A": "ا", "b": "ب", "p": "ة", "t": "ت", "v": "ث", "j": "ج",
    "H": "ح", "x": "خ", "d": "د", "*": "ذ", "r": "ر", "z": "ز",
    "s": "س", "$": "ش", "S": "ص", "D": "ض", "T": "ط", "Z": "ظ",
    "E": "ع", "g": "غ", "_": "ـ", "f": "ف", "q": "ق", "k": "ك",
    "l": "ل", "m": "م", "n": "ن", "h": "ه", "w": "و", "Y": "ى",
    "y": "ي", "F": "ً", "N": "ٌ", "K": "ٍ", "a": "َ", "u": "ُ",
    "i": "ِ", "~": "ّ", "o": "ْ", "`": "ٰ", "{": "ٱ",
    "^": "ث",  # this corpus encodes ث (theth) as ^ (nonstandard); standard is 'v'
}

def buck2ar(s: str) -> str:
    return "".join(B2A.get(ch, ch) for ch in s)

def main():
    corpus = sys.argv[1]  # .../arabic-speech-corpus
    trans = os.path.join(corpus, "orthographic-transcript.txt")
    wavdir = os.path.join(corpus, "wav")
    out = sys.argv[2]     # metadata.csv path
    line_re = re.compile(r'^"(?P<fn>[^"]+)"\s+"(?P<txt>.*)"\s*$')
    n_ok = n_miss = 0
    with open(trans, encoding="utf-8") as f, open(out, "w", encoding="utf-8") as o:
        for raw in f:
            raw = raw.replace("\r", "").rstrip("\n")
            if not raw.strip():
                continue
            m = line_re.match(raw)
            if not m:
                continue
            fn = m.group("fn")                       # "ARA NORM  0002.wav"
            utt = fn[:-4] if fn.lower().endswith(".wav") else fn
            wavpath = os.path.join(wavdir, fn)
            if not os.path.exists(wavpath):
                n_miss += 1
                continue
            ar = buck2ar(m.group("txt")).strip()
            # collapse whitespace; drop the corpus' bare " - " dash spacers
            ar = re.sub(r"\s+", " ", ar).replace(" - ", " ").strip()
            if not ar:
                n_miss += 1
                continue
            o.write(f"{utt}|{ar}\n")
            n_ok += 1
    print(f"wrote {out}: {n_ok} utterances, {n_miss} skipped")

if __name__ == "__main__":
    main()
