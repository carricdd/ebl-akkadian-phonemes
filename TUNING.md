# Tuning and review guide

This guide controls the rendering layer only. It does not turn a synthetic voice
into evidence for a recovered ancient accent.

## 1. Freeze the reading before rendering

For every clip, record the source edition and lines, language, textual dialect,
copy period, IPA, and reconstruction convention. Keep the composition date,
findspot, and the narrator separate from those fields. Do not generate from ATF,
logograms, English respellings, or unexamined restorations.

The package accepts `dialect: 'OB' | 'OA' | 'SB' | 'NA' | 'NB'`, but this is
metadata only in v0.3.1. It is retained for compatibility and audit trails; it
does not apply a dialect-specific pronunciation. A dialect change requires a
cited IPA change and new review, not a voice or pitch change.

## 2. Choose the engine deliberately

`--engine piper` is the default and remains the reproducible choice for a
dictionary: it takes the eBL IPA directly and runs in Node. `--engine omnivoice`
is a local Python model route for more natural connected speech. It maps IPA to
ARPABET first and is therefore lossier: ḫ becomes h, q becomes k, and a glottal
stop cannot be represented. Those losses appear in `--detail` output.

Both routes use the same hybrid safeguards by default:

* `--emphatics auto` routes words containing ṭ or ṣ to the espeak reference
  engine, because neither neural route reliably produces the contrast.
* `--lengths 3tier` keeps eBL's extra-long vowel as a distinct duration by
  WSOLA stretching the identified vowel after neural rendering.
* `--emphatic pharyngealized` is the default reconstruction. Use
  `--emphatic ejective` only where the project has chosen that analysis; it
  routes to the reference engine.

Never choose `--emphatics neural` merely to keep one timbre: it deliberately
flattens a contrast and reports that compromise.

## 3. Set up OmniVoice

Install OmniVoice and its dependencies in a Python 3.12 environment, then point
the package at that interpreter. The bundled `assets/kristin-reference.wav` is a
clean-provenance voice-clone reference with the transcript `abalu sharru bitu ilu`.

```shell
export EBL_OMNIVOICE_PYTHON=/path/to/omnivoice/.venv/bin/python
export EBL_OMNIVOICE_DEVICE=mps                 # or cpu / cuda
ebl-tts --ipa "[na.ˈbuːː]" --engine omnivoice --detail -o nabu.wav
```

To use another reference voice, set `EBL_OMNIVOICE_REF_AUDIO` and
`EBL_OMNIVOICE_REF_TEXT` together. Record permission, source, transcript,
language, and a SHA-256 hash of the WAV. Do not use paid-TTS output or a person's
voice without a license that permits cloning and redistribution.

The renderer defaults to 32 flow steps, guidance scale 2.0, position temperature
1.0, class temperature 0.0, and three attempts. It keeps the best clean first
burst and removes OmniVoice's observed repeated-tail behavior. Change one control
at a time, retain the candidate audio and `--detail` output, and compare against
the same frozen IPA.

For programmatic tuning, pass those controls with the render call rather than
changing source code:

```javascript
await synthesizeDetailed('[na.ˈbuːː]', {
  engine: 'omnivoice',
  omnivoice: { numStep: 32, guidanceScale: 2.0, positionTemperature: 1.0, attempts: 3 },
});
```

## 4. Acceptance review

For every accepted clip, preserve:

1. source/line and IPA hashes;
2. package version, engine, model, reference-voice provenance, settings and output hash;
3. `--detail` result and any approximation notes;
4. a listening review for text coverage, phonetic contrasts, naturalness, joins,
   clipping and silence; and
5. the reviewer, date and decision.

Use the reference engine when a contrast must be heard exactly. A pleasant
neural timbre does not compensate for an omitted or substituted phoneme.
