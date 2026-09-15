#!/usr/bin/env python3
"""
omnivoice_render.py — the OmniVoice neural stage for @ebl/akkadian-phonemes.

This is the Python side of src/omnivoice.ts. It exists because OmniVoice
(k2-fsa/OmniVoice, Apache-2.0) is a PyTorch/MPS model with no Node binding: the
TypeScript adapter shells out to this script, which loads the model, generates
audio from an ARPABET phoneme string, extracts the first clean burst (OmniVoice
routinely repeats an isolated word after ~1 s of internal silence — measured),
and writes a mono PCM16 WAV the TS side reads back.

What it does NOT do — deliberately, so the hybrid stays intact:
  * no emphatics: pharyngealization is unrepresentable in ARPABET, so ṭ/ṣ words
    are routed to espeak by synthesize.ts BEFORE this script is ever called
    (emphatics:'auto'). This script only ever sees non-emphatic segmental frames.
  * no vowel-length stretch: the extra-long (â/ê/î/û) contrast is applied by the
    package's WSOLA stretch in dsp.ts, AFTER this script returns raw neural audio.
So the OmniVoice path is phonologically faithful for exactly the same reasons the
Piper path is: espeak owns the emphatics, dsp owns the length.

CLI (all args are passed by src/omnivoice.ts):
  --arpabet "AA1 N AH0"     ARPABET phones, space separated (no brackets)
  --ref-audio PATH          voice-clone reference WAV (clean provenance)
  --ref-text  STR           transcript of the reference audio
  --output    PATH          output WAV (mono, PCM16, the model's native SR)
  --device    mps|cpu|cuda  default mps
  [--num-step 32] [--guidance-scale 2.0]
  [--position-temperature 1.0] [--class-temperature 0.0]
  [--attempts 3]            generations to try; best clean burst wins

On success prints one line of JSON to stdout: {"sampleRate":..,"durationSeconds":..,"attempts":..,"burst":true}
On failure exits non-zero with a message on stderr.
"""
import argparse
import json
import os
import sys

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def first_burst(x, sr, thr_db=-38.0, min_sil=0.12, lead_pad=0.012, tail_pad=0.04):
    """Return the first contiguous voiced span, cutting at the first >=min_sil
    silence gap. This is what removes OmniVoice's self-repetition. Ported from
    omnivoice/select_gen2.py (the reproducer that generated the v1 samples).

    lead_pad is deliberately tight (~12 ms, was 40 ms): OmniVoice emits a short
    broadband onset transient (the audible 'burp') just before the first phone,
    and the wide pre-onset pad was dragging it into the burst. Tail keeps 40 ms."""
    import numpy as np

    if x.ndim > 1:
        x = x.mean(1)
    x = x.astype(np.float32)
    win = int(0.02 * sr)
    if win <= 0:
        return x
    n = len(x) // win
    if n == 0:
        return x
    e = np.array([np.sqrt(np.mean(x[i * win:(i + 1) * win] ** 2) + 1e-9) for i in range(n)])
    edb = 20 * np.log10(e + 1e-9)
    active = edb > thr_db
    if not active.any():
        return None
    i0 = int(np.argmax(active))
    sil = int(min_sil / 0.02)
    j = i0
    gap = 0
    end = i0
    while j < len(active):
        if active[j]:
            end = j
            gap = 0
        else:
            gap += 1
            if gap >= sil:
                break
        j += 1
    s = max(0, int((i0 * 0.02 - lead_pad) * sr))
    ee = min(len(x), int(((end + 1) * 0.02 + tail_pad) * sr))
    return x[s:ee]


def apply_fades(x, sr, fin_ms=45.0, fout_ms=40.0):
    """Raised-cosine fade in/out on the extracted burst. The fade-in ramps
    through whatever burp residue survives the tight lead_pad so the clip opens
    on a clean attack; the fade-out softens the hard boundary cut that reads as
    a 'skippy' click at word edges. Segmental content is untouched."""
    import numpy as np

    x = x.astype(np.float32).copy()
    n = len(x)
    fi = min(int(sr * fin_ms / 1000.0), n // 2)
    fo = min(int(sr * fout_ms / 1000.0), n // 2)
    if fi > 0:
        x[:fi] *= np.sin(np.linspace(0.0, np.pi / 2, fi)) ** 2
    if fo > 0:
        x[-fo:] *= np.sin(np.linspace(np.pi / 2, 0.0, fo)) ** 2
    return x


def mean_energy(x):
    import numpy as np

    if x is None or len(x) == 0:
        return 0.0
    return float(np.sqrt(np.mean(x.astype(np.float32) ** 2) + 1e-12))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arpabet", required=True)
    ap.add_argument("--ref-audio", required=True)
    ap.add_argument("--ref-text", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--device", default="mps")
    ap.add_argument("--num-step", type=int, default=32)
    ap.add_argument("--guidance-scale", type=float, default=2.0)
    ap.add_argument("--position-temperature", type=float, default=1.0)
    ap.add_argument("--class-temperature", type=float, default=0.0)
    ap.add_argument("--attempts", type=int, default=3)
    ap.add_argument("--min-burst", type=float, default=0.12, help="reject bursts shorter than this (s)")
    ap.add_argument("--max-burst", type=float, default=2.5, help="reject bursts longer than this (s)")
    args = ap.parse_args()

    if not os.path.exists(args.ref_audio):
        sys.stderr.write(f"omnivoice_render: ref audio not found: {args.ref_audio}\n")
        sys.exit(2)

    import numpy as np
    import soundfile as sf
    import torch
    from omnivoice.models.omnivoice import OmniVoice

    dtype = torch.float16 if args.device in ("mps", "cuda") else torch.float32
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=args.device, dtype=dtype)
    sr = model.sampling_rate

    text = f"[{args.arpabet}]"
    lo = int(args.min_burst * sr)
    hi = int(args.max_burst * sr)

    best = None  # (in_window:int, energy:float, samples)
    for _ in range(max(1, args.attempts)):
        au = model.generate(
            text=text,
            language="English",
            ref_audio=args.ref_audio,
            ref_text=args.ref_text,
            num_step=args.num_step,
            guidance_scale=args.guidance_scale,
            position_temperature=args.position_temperature,
            class_temperature=args.class_temperature,
        )
        w = np.asarray(au[0], dtype=np.float32)
        fb = first_burst(w, sr)
        if fb is None or len(fb) == 0:
            continue
        in_window = 1 if (lo <= len(fb) <= hi) else 0
        cand = (in_window, mean_energy(fb), fb)
        if best is None or (cand[0], cand[1]) > (best[0], best[1]):
            best = cand
        if in_window and cand[1] > 0.02:
            break  # a confident in-window burst is good enough; stop early

    if best is None:
        sys.stderr.write("omnivoice_render: no usable audio produced\n")
        sys.exit(3)

    fb = apply_fades(best[2], sr)
    peak = float(np.max(np.abs(fb))) or 1.0
    fb = (fb / peak) * 0.95  # peak-normalize so downstream trim thresholds are stable
    pcm16 = np.clip(fb, -1.0, 1.0)
    sf.write(args.output, pcm16, sr, subtype="PCM_16")
    sys.stdout.write(
        json.dumps(
            {
                "sampleRate": int(sr),
                "durationSeconds": len(fb) / sr,
                "attempts": args.attempts,
                "inWindow": bool(best[0]),
            }
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
