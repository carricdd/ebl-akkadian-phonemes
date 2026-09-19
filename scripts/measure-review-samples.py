#!/usr/bin/env python3
"""measure-review-samples.py — Praat measurements for demo/review-0.3.2 (0.3.2 review set).

  uv run --with praat-parselmouth --with numpy python3 scripts/measure-review-samples.py

Per clip: total duration; for consonant pairs the following vowel's F1/F2 (Burg, 5 formants
to 5 kHz, median over the middle half of the first voiced run) and the pre-voicing onset's
spectral centre of gravity; writes demo/review-0.3.2/measurements.md.
"""
import json, os, sys
import numpy as np, parselmouth
from parselmouth.praat import call

d = os.path.join(os.path.dirname(__file__), '..', 'demo', 'review-0.3.2')
idx = json.load(open(os.path.join(d, 'index.json')))

def measure(p):
    snd = parselmouth.Sound(p)
    pitch = snd.to_pitch(time_step=0.005)
    form = snd.to_formant_burg(time_step=0.005, max_number_of_formants=5, maximum_formant=5000)
    ts = pitch.ts(); voiced = [t for t in ts if not np.isnan(pitch.get_value_at_time(t))]
    if not voiced: return dict(dur=snd.duration)
    runs = [[voiced[0]]]
    for t in voiced[1:]:
        (runs[-1].append(t) if t - runs[-1][-1] <= 0.011 else runs.append([t]))
    v = runs[0]; mid = v[len(v)//4: 3*len(v)//4] or v
    F1 = np.nanmedian([form.get_value_at_time(1, t) for t in mid]); F2 = np.nanmedian([form.get_value_at_time(2, t) for t in mid])
    onset = v[0]; cog = None
    if onset > 0.02:
        cog = call(snd.extract_part(from_time=0, to_time=onset).to_spectrum(), "Get centre of gravity", 2)
    return dict(dur=snd.duration, F1=F1, F2=F2, cog=cog, onset_ms=onset*1000)

rows = []
for e in idx:
    m = measure(os.path.join(d, e['file'])); e.update(m); rows.append(e)

lines = ['# Review set 0.3.2 — measurements', '',
 'Renders with noiseW 0 (deterministic durations) and the voice-default noiseScale through the public API. F1/F2 = median formants of the vowel after the',
 'onset consonant (Praat Burg). CoG = spectral centre of gravity of the pre-voicing onset (the sibilant/burst). Emphatic',
 '(pharyngealized) consonants lower the following vowel\'s F2 and the sibilant CoG; this is the contrast a listener hears.', '']
for group in dict.fromkeys(e['group'] for e in rows):
    lines += [f'## {group}', '', '| clip | gloss | render | total s | onset CoG Hz | vowel F1 | vowel F2 | extra-long span ms |', '|---|---|---|---|---|---|---|---|']
    for e in [r for r in rows if r['group'] == group]:
        cog = f"{e['cog']:.0f}" if e.get('cog') else ''
        lines.append(f"| {e['file']} | {e['gloss']} | {e['render']} | {e['dur']:.3f} | {cog} | {e.get('F1',0):.0f} | {e.get('F2',0):.0f} | {e['ultralongSpanMs'] or ''} |")
    lines.append('')
open(os.path.join(d, 'measurements.md'), 'w').write('\n'.join(lines))
print('\n'.join(lines))
