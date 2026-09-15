#!/usr/bin/env python3
"""synth_ebl_from_ckpt.py — synthesize the eBL demo words on the OWNED fine-tuned
Arabic Piper voice, feeding the exact tokens the eBL normalizer emits
(`@ebl/akkadian-phonemes` -> normalizeForPiper / scripts/ebl-to-piper.mjs).

Run AFTER a checkpoint has been exported to ONNX:
  .venv-train/bin/python -m piper.train.export_onnx \
      --checkpoint runs/akkadian-ar/lightning_logs/version_3/checkpoints/last.ckpt \
      --output-file akkadian-ar.onnx
  # akkadian-ar.onnx.json (the voice config) is already written by training.

Then:
  ./venv/bin/python synth_ebl_from_ckpt.py --voice akkadian-ar.onnx --out samples_arabic

The tokens below are produced by the eBL normalizer (NOT hand-authored here) —
they are the natural-word IPA token streams, matching espeak-`ar` output.
"""
import argparse, json, wave, os, sys
import numpy as np
from piper import PiperVoice
from piper.config import SynthesisConfig

# Output of: node scripts/ebl-to-piper.mjs   (the 4 fast-proof words)
DEMO = [
    {"word": "abalu",  "tokens": ["a", "ˈ", "b", "a", "ː", "l", "u"],       "hasUltralong": False},
    {"word": "sharru", "tokens": ["ˈ", "ʃ", "a", "r", "r", "u"],            "hasUltralong": False},
    {"word": "bitu",   "tokens": ["ˈ", "b", "i", "ː", "t", "u"],            "hasUltralong": False},
    {"word": "ilu",    "tokens": ["ˈ", "i", "l", "u"],                       "hasUltralong": False},
]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", required=True, help="exported .onnx (needs matching .onnx.json)")
    ap.add_argument("--tokens", help="JSON file from ebl-to-piper.mjs (else built-in 4 words)")
    ap.add_argument("--out", default="samples_arabic")
    ap.add_argument("--length-scale", type=float, default=1.1)
    ap.add_argument("--speaker", type=int, default=0)
    a = ap.parse_args()

    items = json.load(open(a.tokens, encoding="utf-8")) if a.tokens else DEMO
    os.makedirs(a.out, exist_ok=True)
    V = PiperVoice.load(a.voice)
    SR = V.config.sample_rate
    gap = np.zeros(int(SR * 0.45), dtype=np.float32)
    allparts = []
    for it in items:
        toks = it["tokens"]
        ids = V.phonemes_to_ids(toks)
        cfg = SynthesisConfig(speaker_id=a.speaker, length_scale=a.length_scale, normalize_audio=True)
        audio = np.asarray(V.phoneme_ids_to_audio(ids, cfg), dtype=np.float32)
        fn = os.path.join(a.out, f"akk_{it['word']}.wav")
        _save(fn, audio, SR)
        print(f"{it['word']:10s} tokens={toks} dur={len(audio)/SR:.2f}s -> {fn}")
        allparts += [audio, gap]
    _save(os.path.join(a.out, "ALL4_arabic.wav"), np.concatenate(allparts), SR)
    print("wrote", os.path.join(a.out, "ALL4_arabic.wav"))

def _save(fn, a, sr):
    a = np.clip(a, -1, 1)
    with wave.open(fn, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((a * 32767).astype(np.int16).tobytes())

if __name__ == "__main__":
    main()
