# @ebl/akkadian-phonemes

Turn the IPA the **electronic Babylonian Library** dictionary already renders into
spoken Akkadian.

```text
eBL IPA          normalizer        engine                    audio
[a.ˈbaː.lu]  ──►  (pure TS)   ──►  Piper VITS (neural)   ──►  22.05 kHz WAV
                                   espeak-ng  (reference)
```

It consumes eBL's exact `transcriptionToIpa.json` contract — including the
non-committal emphatic placeholders `ᵵ`/`ᵴ` and the stacked extra-long vowels
`aːː` — so nothing on the eBL side has to change to feed it. No API keys, no
network calls at runtime, no cost per word.

> **Reading the code blocks.** Every block below is labelled. Blocks marked
> **shell** go in a terminal. Blocks marked **JavaScript** go in a `.js`/`.ts`
> file or a Node REPL. Pasting a JavaScript line into a shell will fail with
> something like `bad floating point constant` — that means you pasted the wrong
> kind of block, not that the package is broken.

---

## Contents

1. [Install](#1-install)
2. [Quick start — CLI](#2-quick-start--cli)
3. [Quick start — API](#3-quick-start--api)
4. [The two engines](#4-the-two-engines-and-why-there-are-two)
5. [Tuning and review](#tuning-and-review)
6. [API reference](#5-api-reference)
7. [CLI reference](#6-cli-reference)
8. [The eBL IPA contract](#7-the-ebl-ipa-contract)
9. [Acceptance criteria — measured](#8-acceptance-criteria--measured)
10. [Integrating with the eBL frontend `<Ipa>` component](#9-integrating-with-the-ebl-frontend-ipa-component)
11. [Troubleshooting](#10-troubleshooting)
12. [Licensing](#11-licensing)
13. [Mapping to the original Trello card](#12-mapping-to-the-original-trello-card)
14. [Roadmap and honest limitations](#13-roadmap-and-honest-limitations)

---

## 1. Install

**Prerequisites**

| Requirement | Why |
|---|---|
| **Node.js ≥ 18.17** | native `fetch`, `node:test`, ESM. Tested on Node 26. |
| macOS, Linux, or Windows on x64/arm64 | `onnxruntime-node` ships prebuilt binaries for these |
| ~61 MB disk | the neural voice file (downloaded separately, see below) |

**Install the package** — shell:

```shell
npm install @ebl/akkadian-phonemes
```

**Download the neural voice** (one time, ~61 MB) — shell:

```shell
npx ebl-tts --fetch-voice
```

That writes `en_US-kristin-medium.onnx` and `en_US-kristin-medium.onnx.json` into
`~/.cache/ebl-akkadian-phonemes/voices/` and verifies both SHA-256 hashes.

**Why isn't the voice bundled?** A 61 MB binary blob in an npm tarball (or a git
repository) is a burden on everyone who does not need it, and it would tie the
package version to the voice version. It is fetched once from the canonical
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) repository —
no account, no API key, no cost.

**Manual download**, if your environment blocks the fetch — shell:

```shell
mkdir -p ~/.cache/ebl-akkadian-phonemes/voices
cd ~/.cache/ebl-akkadian-phonemes/voices
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kristin/medium/en_US-kristin-medium.onnx
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kristin/medium/en_US-kristin-medium.onnx.json
shasum -a 256 en_US-kristin-medium.onnx
# expect: 5849957f929cbf720c258f8458692d6103fff2f0e3d3b19c8259474bb06a18d4
```

**Point at a voice you already have** — shell:

```shell
export EBL_PIPER_VOICE=/path/to/en_US-kristin-medium.onnx
```

**Check what is installed** — shell:

```shell
npx ebl-tts --check-voice
```

The **reference engine (espeak-ng) needs no download at all** and works
immediately after `npm install`, so you can evaluate the package before fetching
anything.

---

## 2. Quick start — CLI

These are the commands to try first. All of them are **shell**:

```shell
npx ebl-tts --ipa "[a.ˈbaː.lu]" -o abalu.wav
```

```shell
npx ebl-tts --ipa "[ˈʃar.ru]" -o sharru.wav --detail
```

```shell
npx ebl-tts --ipa "[ba.ˈnuːː]" --explain
```

The first two write a WAV; the third prints the phoneme mapping as JSON and
generates no audio.

---

## 3. Quick start — API

**JavaScript** (or TypeScript — types are bundled):

```javascript
import { synthesize } from '@ebl/akkadian-phonemes';
import { writeFileSync } from 'node:fs';

const wav = await synthesize('[a.ˈbaː.lu]'); // abālu — the Trello card's example
writeFileSync('abalu.wav', wav);
```

`synthesize()` returns a `Buffer` of 22.05 kHz mono PCM16 WAV bytes. Write it to
disk, stream it, or hand it to an `<audio>` element as a Blob.

If you want to know *how* the audio was made — which engine ran, how the
extra-long vowel was realized, what phonetic compromises were taken — use
`synthesizeDetailed()` instead. **JavaScript**:

```javascript
import { synthesizeDetailed } from '@ebl/akkadian-phonemes';

const r = await synthesizeDetailed('[ba.ˈnuːː]'); // bānû
console.log(r.engine);               // 'neural'
console.log(r.voice);                // 'en_US-kristin-medium'
console.log(r.durationSeconds);      // e.g. 0.885
console.log(r.ultralong);            // 'nucleus-stretch'
console.log(r.ultralongSpanSeconds); // e.g. 0.299 — the vowel, before stretching
console.log(r.notes);                // [] — nothing was approximated
```

---

## 4. The two engines, and why there are two

| | `mode: 'neural'` (default) | `mode: 'reference'` |
|---|---|---|
| Engine | Piper (VITS) via `onnxruntime-node` | espeak-ng (WASM) |
| Voice | `en_US-kristin-medium` | espeak `ar` / `am` |
| Sounds like | a person | a formant synthesizer |
| Needs a download | yes, ~61 MB, once | no |
| Speed | ~29 ms per word, CPU only | ~44 ms per word |
| True pharyngealized ṭ/ṣ | **no** — see [criterion 1](#criterion-1--glottalised-consonants-ṭ-and-ṣ) | **yes** |
| True ejective ṭʼ/ṣʼ | **no** — not representable | **yes** |
| Third vowel length | yes, by duration post-processing | yes, by duration post-processing |

**The neural voice is the default because voice quality is the point.** A
dictionary pronunciation button that sounds like a 1990s screen reader will not
be used. espeak-ng is kept because it is the only engine here whose phoneme model
has *explicit* pharyngealized, ejective and length features — it is the
guaranteed-compliance floor, the scholarly reference voice, and the honest answer
whenever the neural voice cannot make a distinction.

The package routes between them automatically. By default
(`emphatics: 'auto'`), a word containing ṭ or ṣ is rendered on the reference
engine so its emphatic contrast is genuine; every other word is rendered
neurally. `synthesizeDetailed().engineReason` always tells you when and why a
switch happened. Set `emphatics: 'neural'` if a single consistent voice across
the whole dictionary matters more to you than a guaranteed emphatic — that is a
legitimate editorial choice and it is yours, not ours.

### 4a. Selecting the neural voice: Piper (default) or OmniVoice

The *neural* stage has two interchangeable voice backends, chosen with
`--engine` (CLI) or `engine:` (API). **This selects only the voice.** The hybrid
around it is identical either way: emphatic-bearing words still route to espeak,
and the third vowel length is still applied by the same WSOLA duration stretch.
So the OmniVoice output is the *hybrid* — phonologically faithful in exactly the
places the Piper hybrid is — not raw OmniVoice.

```bash
ebl-tts --ipa "[a.ˈbaː.lu]"                      # Piper (default)
ebl-tts --ipa "[a.ˈbaː.lu]" --engine omnivoice   # OmniVoice
```

| | `--engine piper` (default) | `--engine omnivoice` |
|---|---|---|
| Model | Piper VITS via `onnxruntime-node` | OmniVoice (k2-fsa), Apache-2.0 |
| Runs | in-process, Node + ONNX | a local Python service (PyTorch/MPS) |
| Phoneme input it consumes | IPA (the eBL contract, directly) | CMU/**ARPABET** (mapped down from the IPA) |
| Determinism | deterministic (set `noiseW:0`) | stochastic; best clean burst is auto-selected |
| Naturalness | good neural voice | more natural / expressive |
| Speed | ~29 ms/word, CPU | near real-time on MPS (~3 s/clip incl. burst selection); one model load per process |
| Emphatics ṭ/ṣ | espeak (auto) | espeak (auto) — **same route** |
| Vowel length â/ê/î/û | WSOLA stretch | WSOLA stretch — **same route** |
| Segmental fidelity of the neural frame | higher (IPA in) | lower (ARPABET in) — see below |

**Why Piper is the default.** It ships in-process, needs no Python, and consumes
the eBL IPA directly, so its segmental mapping is the more faithful of the two
and its output is reproducible. OmniVoice is the option you reach for when a more
natural, expressive voice matters more than determinism, and you are willing to
run the Python service.

**Where the ARPABET path is honestly lossier than Piper.** OmniVoice takes
ARPABET, which has fewer distinctions than the IPA Piper reads. Inside the neural
frame (i.e. before espeak/WSOLA correct emphatics and length), three mappings
lose information, and every one is reported in `notes` / `--detail`:

| eBL sound | Piper (IPA) | OmniVoice (ARPABET) |
|---|---|---|
| ḫ [x] | `h` (English voice has no [x]) | `HH` — same loss, different route |
| uvular q | `k` | `K` — same loss |
| glottal stop ʔ | `ʔ` (trained) | **dropped** (no ARPABET symbol) — Piper keeps it, OmniVoice cannot |
| vowel length | one ː token, then WSOLA | vowel *quality* proxy (AH→AA …), then WSOLA |

The one place OmniVoice is *strictly* worse than Piper on the neural frame is the
**glottal stop**: Piper has a trained `ʔ`, ARPABET has no symbol for it, so a
word-internal glottal stop is dropped on the OmniVoice path. For emphatics and
for the extra-long vowels the two are equal, because both defer those to espeak
and WSOLA respectively.

#### Installing and running the OmniVoice option

OmniVoice is **not** an npm dependency — it is a local model service you point
the package at. Set up once:

1. A Python 3.12 env with `omnivoice` importable (PyTorch, `soundfile`, `numpy`;
   Apple Silicon uses MPS). On the reference machine this is
   `…/omnivoice/.venv`.
2. A clean-provenance voice-clone reference clip and its transcript (see
   *Provenance* below).

The package includes a small clean-provenance reference clip, so no path is
needed for the supplied voice. To use a different reference, set these env vars
(all are optional overrides):

| Env var | Default | Meaning |
|---|---|---|
| `EBL_OMNIVOICE_PYTHON` | a local `omnivoice/.venv/bin/python`, else `python3` | interpreter that can `import omnivoice` |
| `EBL_OMNIVOICE_HELPER` | `<package>/scripts/omnivoice_render.py` | the render helper shipped with the package |
| `EBL_OMNIVOICE_REF_AUDIO` | the packaged Kristin reference | voice-clone reference WAV |
| `EBL_OMNIVOICE_REF_TEXT` | `"abalu sharru bitu ilu"` | transcript of that reference |
| `EBL_OMNIVOICE_DEVICE` | `mps` | `mps` \| `cpu` \| `cuda` |

```bash
export EBL_OMNIVOICE_PYTHON=/path/to/omnivoice/.venv/bin/python
ebl-tts --ipa "[a.ˈbaː.lu]" --engine omnivoice -o abalu-omni.wav
```

The helper (`scripts/omnivoice_render.py`) loads the model, generates, extracts
the first clean burst (OmniVoice repeats an isolated word after ~1 s of internal
silence — measured; the burst extractor removes that), peak-normalizes, and
returns a WAV the package reads back and then trims + length-stretches like any
neural output. If the Python env or reference clip is missing, the package throws
a named `OmniVoiceError` telling you exactly what to set — it never silently falls
back to a different voice.

### Tuning and review

`TUNING.md`, included in the package archive, separates a source-reading decision
(edition, language, textual dialect, copy period, IPA and reconstruction
convention) from a rendering decision. `dialect` is recorded but does not
currently change any phones; it must never be presented as dialect synthesis.
OmniVoice is stochastic and should be reviewed with `--detail`, which records the
actual engine, ARPABET input, and every known loss such as q → k, ḫ → h, or a
dropped glottal stop.

#### Provenance of the OmniVoice reference voice (clean)

The OmniVoice voice is cloned from **`en_US-kristin-medium` (Piper) output** —
the same public-domain, LibriVox-lineage voice this package already ships for the
Piper engine. **No ElevenLabs or other paid-TTS audio is used as a clone
reference**, so nothing here is encumbered by a "do not train/clone on our
output" clause. The clone reference is a synthetic, owned, redistributable voice;
the OmniVoice engine itself is Apache-2.0. Both neural voices therefore trace to
the same clean lineage.

---

## 5. API reference

### `synthesize(ipa, options?) → Promise<Buffer>`

Renders eBL IPA to WAV bytes.

- `ipa` — the IPA string eBL's dictionary already shows, e.g. `'[a.ˈbaː.lu]'`.
  Enclosing brackets `[ ]` and slashes `/ /` are optional and ignored. Syllable
  dots `.` and the stress marks `ˈ` `ˌ` are understood.
- Returns a `Buffer`: mono 16-bit PCM WAV at 22050 Hz.

#### Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `mode` | `'neural'` \| `'reference'` | `'neural'` | Which engine renders the word. `'neural'` = a neural voice (see `engine`), human-sounding. `'reference'` = espeak-ng (robotic, phonetically exact, no download). |
| `engine` | `'piper'` \| `'omnivoice'` | `'piper'` | Which neural voice runs the neural stage. Swaps the **voice only** — espeak still owns emphatics and WSOLA still owns vowel length, so both stay phonologically faithful. `'omnivoice'` needs the local Python service (§4a). |
| `omnivoice` | `OmniVoiceOptions` | env-resolved | **OmniVoice only.** Overrides for the local service: `python`, `helper`, `refAudio`, `refText`, `device`, `numStep`, `guidanceScale`, `positionTemperature`, `attempts`. Each also has an `EBL_OMNIVOICE_*` env var (§4a). |
| `emphatics` | `'auto'` \| `'neural'` \| `'reference'` | `'auto'` | Only applies when `mode` is `'neural'`. `'auto'` sends words containing ṭ/ṣ to the reference engine so the emphatic is real (for **both** neural engines). `'neural'` keeps one voice and accepts that the emphatic is approximate. `'reference'` always uses espeak-ng. |
| `emphatic` | `'pharyngealized'` \| `'ejective'` | `'pharyngealized'` | Which reconstruction of the emphatics to voice. `'pharyngealized'` is the Arabic-style ṭ = [tˤ]. `'ejective'` is the Ethiosemitic-style glottalic ṭ = [tʼ] and **always** uses the reference engine (no Piper voice has an ejective in its phoneme inventory). We deliberately did not choose for you. |
| `lengths` | `'2tier'` \| `'3tier'` | `'3tier'` | `'3tier'` honors eBL's extra-long â/ê/î/û as a distinct third length. `'2tier'` collapses them to ordinary long vowels — a clean opt-out if you consider the third length unwarranted. |
| `ultralongFactor` | `number` | `1.8` | How much longer an extra-long vowel is than a long one. Applied exactly (verified: a requested 1.80× is delivered as 1.80×). |
| `dialect` | `'OB'` \| `'OA'` \| `'SB'` \| `'NA'` \| `'NB'` | none | **Reserved.** Accepted and recorded, but no dialect-specific behaviour is implemented yet. Documented so you can pass it now without a later breaking change. |
| `wpm` | `number` | `150` | **Reference engine only.** Speaking rate in words per minute. Lower is slower and clearer. |
| `voicePath` | `string` | auto-resolved | **Neural only.** Absolute path to a Piper `.onnx` voice. Its `.onnx.json` must sit beside it. |
| `lengthScale` | `number` | from voice config (`1.0`) | **Neural only.** VITS speaking rate. Higher is slower. `1.1`–`1.2` is a good slower reading for a dictionary. |
| `noiseScale` | `number` | from voice config (`0.667`) | **Neural only.** VITS acoustic variation. `0` makes the render deterministic. |
| `noiseW` | `number` | from voice config (`0.8`) | **Neural only.** VITS duration-predictor noise. `0` makes durations deterministic and repeatable — use this when you need reproducible audio or measurements. |
| `speakerId` | `number` | `0` | **Neural only.** For multi-speaker voices. `en_US-kristin-medium` has one speaker. |

Voice file resolution order, first hit wins:

1. `options.voicePath`
2. `$EBL_PIPER_VOICE`
3. `$EBL_VOICE_DIR/en_US-kristin-medium.onnx`
4. `~/.cache/ebl-akkadian-phonemes/voices/en_US-kristin-medium.onnx`
5. `<package>/voices/en_US-kristin-medium.onnx`
6. `./voices/en_US-kristin-medium.onnx`

If none exists, a `VoiceNotFoundError` is thrown listing every path tried and how
to fix it. It never silently degrades to the robotic voice — that would be the
kind of surprise that ends up in a published corpus.

### `synthesizeDetailed(ipa, options?) → Promise<SynthesisResult>`

Same rendering, same options, but returns an account of what happened.

| Field | Type | Meaning |
|---|---|---|
| `wav` | `Buffer` | the audio, identical to what `synthesize()` returns |
| `engine` | `'neural'` \| `'reference'` | which engine actually ran |
| `engineReason` | `string?` | present only when the engine differs from the requested mode, explaining why |
| `sampleRate` | `number` | 22050 (Piper / espeak) or 24000 (OmniVoice) |
| `durationSeconds` | `number` | measured length of the returned audio |
| `neuralEngine` | `'piper'` \| `'omnivoice'?` | which neural voice ran, when `engine` is `'neural'` |
| `voice` | `string?` | the neural voice used, when `engine` is `'neural'` |
| `ultralong` | `'none'` \| `'nucleus-stretch'` \| `'segment-stretch'` \| `'word-stretch'` \| `'disabled'` | how the extra-long vowel was realized. `'none'` = the word has none. `'disabled'` = `lengths:'2tier'`. `'nucleus-stretch'` = neural, the located vowel was stretched. `'segment-stretch'` = reference, the vowel was rendered separately and spliced. `'word-stretch'` = fallback, the vowel could not be located and the whole word was stretched instead (this is reported in `notes`). |
| `ultralongFactor` | `number` | the factor applied (`1` when nothing was stretched) |
| `ultralongSpanSeconds` | `number?` | neural only: the located vowel's duration *before* stretching. The word therefore grew by `span × (factor − 1)`, which you can verify against the file. |
| `notes` | `string[]` | every phonetic approximation made. Empty means the word was rendered entirely from phones the voice actually knows. |
| `phonemes` | `string` | exactly what was handed to the engine |

### `explain(ipa, options?) → object`

Returns the full mapping **without synthesizing anything**. This exists so a
philologist can audit how every symbol was interpreted instead of trusting a
black box.

**JavaScript**:

```javascript
import { explain } from '@ebl/akkadian-phonemes';

const info = explain('[ba.ˈnuːː]');
```

Produces:

```json
{
  "ipa": "[ba.ˈnuːː]",
  "mode": "neural",
  "voice": "ar",
  "emphatic": "pharyngealized",
  "lengths": "3tier",
  "hasUltralong": true,
  "espeak": "ba'nu:",
  "neural": {
    "voice": "en_US-kristin-medium",
    "tokens": ["b", "a", "ˈ", "n", "u", "ː"],
    "ultralongVowelIndices": [1],
    "vowelCount": 2,
    "approximations": []
  },
  "units": [
    { "ipa": "b", "espeak": "b", "neural": ["b"], "kind": "consonant" },
    { "ipa": "a", "espeak": "a", "neural": ["a"], "kind": "vowel" },
    { "ipa": ".", "espeak": "",  "neural": [],    "kind": "syllable" },
    { "ipa": "ˈ", "espeak": "'", "neural": ["ˈ"], "kind": "stress" },
    { "ipa": "n", "espeak": "n", "neural": ["n"], "kind": "consonant" },
    { "ipa": "uːː", "espeak": "u:", "neural": ["u", "ː"], "kind": "vowel" }
  ]
}
```

Field notes:

- `voice` is the **espeak** voice the reference engine would use (`ar` for
  pharyngealized, `am` for ejective). The neural voice is under `neural.voice`.
- `espeak` is the espeak phoneme-mnemonic string. Note `uːː` becomes `u:` — the
  engine gets one length mark and the true third length comes from the duration
  stretch, because no synthesizer stacks a second `ː`.
- `neural.ultralongVowelIndices` are 0-based indices among the word's vowels, so
  `[1]` means the second vowel is the extra-long one.
- `neural.approximations` lists every place the neural voice had to substitute.
  An empty array is a guarantee that nothing was fudged.
- `units[].note` appears on any unit that was approximated on the neural path.

### `normalize(ipa, options?) → NormalizeResult`

The lower-level mapping step, exported for testing and for anyone building their
own engine on top. Options are `emphatic` and `lengths` only.

| Returns | Type | Meaning |
|---|---|---|
| `units` | `PhonemeUnit[]` | ordered phoneme units (see below) |
| `voice` | `'ar'` \| `'am'` | the espeak voice this stream must be rendered with |
| `hasUltralong` | `boolean` | true when a vowel is extra-long **and** `lengths` is `'3tier'` |
| `emphatic` | `'pharyngealized'` \| `'ejective'` | the resolved setting |
| `lengths` | `'2tier'` \| `'3tier'` | the resolved setting |

Each `PhonemeUnit`:

| Field | Meaning |
|---|---|
| `kind` | `'consonant'` \| `'vowel'` \| `'stress'` \| `'syllable'` \| `'space'` |
| `ipa` | the original eBL-IPA slice this unit came from |
| `espeak` | espeak mnemonic(s) for this unit |
| `piper` | neural token(s) for this unit |
| `piperNote` | set when the neural token is an approximation |
| `length` | vowels only: `0` short, `1` long, `2` extra-long |
| `ultralong` | vowels only: true when `length === 2` and 3-tier is on |
| `emphatic` | consonants only: the resolved emphatic realization, or `null` |

Companion exports: `toEspeakString(units)`, `toPiperPhonemes(units)`, and
`normalizeForPiper(ipa, options?)` which returns `{ tokens, espeakVoice,
hasUltralong, ultralongVowelIndices, vowelCount, notes, units }`.

### Other exports

| Export | Purpose |
|---|---|
| `voiceAvailable(path?)` | `true` if a neural voice is installed. Useful for feature-gating a UI button. |
| `resolveVoicePath(path?)` | the resolved voice path, or throws `VoiceNotFoundError` |
| `loadVoice(path?)`, `renderPiperTokens(tokens, opts?)`, `phonemesToIds(tokens, map)` | direct Piper access, if you want to drive the engine yourself |
| `parseWav`, `encodeWav`, `durationSeconds`, `trimSilence`, `wsolaStretch`, `stretchSpan`, `concatCrossfade`, `findVowelNuclei` | the DSP helpers, all dependency-free |
| `DEFAULT_VOICE` | `'en_US-kristin-medium'` |

---

## 6. CLI reference

Installed as `ebl-tts`. Run it with `npx ebl-tts` (or `./node_modules/.bin/ebl-tts`).

| Flag | Argument | Default | Effect |
|---|---|---|---|
| `--ipa`, `-i` | string | — | The eBL IPA to speak. Also accepted as a bare positional argument. |
| `--out`, `-o` | path | `out.wav` | Where to write the WAV. |
| `--mode` | `neural` \| `reference` | `neural` | Engine selection. |
| `--engine` | `piper` \| `omnivoice` | `piper` | Which neural voice runs when `--mode neural`. Swaps the voice only; espeak still owns emphatics and WSOLA still owns length. `omnivoice` needs the local Python service (§4a). |
| `--emphatics` | `auto` \| `neural` \| `reference` | `auto` | How ṭ/ṣ are handled in neural mode. |
| `--emphatic` | `pharyngealized` \| `ejective` | `pharyngealized` | Which emphatic reconstruction to voice. |
| `--lengths` | `2tier` \| `3tier` | `3tier` | Whether extra-long â/ê/î/û get a third length. |
| `--ultralong-factor` | number | `1.8` | Extra-long ÷ long duration. |
| `--voice` | path | auto | Use a specific `.onnx` voice. |
| `--length-scale` | number | `1.0` | Neural speaking rate; higher is slower. |
| `--wpm` | number | `150` | Reference speaking rate. |
| `--dialect` | `OB`\|`OA`\|`SB`\|`NA`\|`NB` | — | Reserved; accepted, no effect yet. |
| `--explain` | — | — | Print the mapping as JSON; write no audio. |
| `--detail` | — | — | Also print engine, phonemes, extra-long strategy and notes. |
| `--fetch-voice` | — | — | Download the neural voice and exit. |
| `--check-voice` | — | — | Report whether a voice is installed; exit 1 if not. |
| `--version` | — | — | Print the package version. |
| `--help`, `-h` | — | — | Print usage. |

### Worked examples

Every command below is **shell**, and every one is exercised verbatim by the
project's own verification run.

One-time setup:

```shell
npx ebl-tts --fetch-voice
```

```shell
npx ebl-tts --check-voice
```

The card's canonical word:

```shell
npx ebl-tts --ipa "[a.ˈbaː.lu]" -o abalu.wav
```

The same word on the OmniVoice neural voice (needs the local service, §4a):

```shell
npx ebl-tts --ipa "[a.ˈbaː.lu]" --engine omnivoice -o abalu-omni.wav --detail
```

See which engine ran and why:

```shell
npx ebl-tts --ipa "[ˈʃar.ru]" -o sharru.wav --detail
```

An emphatic word — note that this routes to the reference engine by default:

```shell
npx ebl-tts --ipa "[ˈsˤaː.bu]" -o sabu.wav --detail
```

The same word forced onto the neural voice, accepting the approximation:

```shell
npx ebl-tts --ipa "[ˈsˤaː.bu]" --emphatics neural -o sabu-neural.wav --detail
```

The ejective reconstruction (always the reference engine):

```shell
npx ebl-tts --ipa "[ˈtˤaː.bu]" --emphatic ejective -o tabu-ejective.wav
```

An extra-long vowel, lengthened more than the default:

```shell
npx ebl-tts --ipa "[ba.ˈnuːː]" --ultralong-factor 2.0 -o banu.wav
```

Turn the third length off:

```shell
npx ebl-tts --ipa "[ba.ˈnuːː]" --lengths 2tier -o banu-2tier.wav
```

Force the reference engine, no download needed:

```shell
npx ebl-tts --ipa "[a.ˈbaː.lu]" --mode reference -o abalu-espeak.wav
```

Slower neural reading, for a dictionary entry:

```shell
npx ebl-tts --ipa "[a.ˈbaː.lu]" --length-scale 1.25 -o abalu-slow.wav
```

Audit the mapping without generating audio:

```shell
npx ebl-tts --ipa "[ˈt͡sˤaː.bu]" --explain
```

### Repository scripts

If you cloned this repository rather than installing from npm — **shell**:

```shell
npm install
npm run build
npm run fetch-voice
npm test
npm run demo
```

`npm run demo` writes every sample in `demo/` **through the package's own public
API** and prints the acceptance-criteria measurement table reproduced in §8.

---

## 7. The eBL IPA contract

The input this package accepts is exactly what
`ebl-frontend/src/akkadian/domain/transcription/transcriptionToIpa.json` emits.
Reproduced verbatim from the live file:

| eBL row | Transliteration → IPA |
|---|---|
| `basic` | `y`→`j` · `'`→`ʔ` · `ʾ`→`ʔ` · `ḫ`→`x` · `h`→`x` · `š`→`ʃ` · `ṭ`→`ᵵ` · `ṣ`→`ᵴ` |
| `basic` (long) | `ā`→`aː` · `ē`→`eː` · `ī`→`iː` · `ū`→`uː` |
| `basic` (extra-long) | `â`→`aːː` · `ê`→`eːː` · `î`→`iːː` · `û`→`uːː` |
| `affricative` | `s`→`t͡s` · `ṣ`→`t̴͡s̴` · `z`→`d͡z` |
| `pharyngealized` | `ṭ`→`tˤ` · `ṣ`→`sˤ` |
| `pharyngealized-affricative` | `ṣ`→`t͡sˤ` |

Two properties of that contract drive the whole design:

**1. eBL's default emphatics are deliberately non-committal.** `ᵵ` (U+1D75 LATIN
SMALL LETTER T WITH MIDDLE TILDE) and `ᵴ` (U+1D74) are placeholders that decline
to choose between pharyngealized and ejective. Only with the `pharyngealized`
switch on does eBL emit `tˤ`/`sˤ`. This package therefore accepts **every**
notation for each emphatic and resolves the realization at synthesis time via the
`emphatic` option — the choice stays yours.

**2. eBL writes the extra-long vowels as a stacked double `ː`** — two U+02D0
characters. That is a literal token no speech engine treats as a third length;
espeak reads `a::` as "long plus a stray colon", and a stock neural voice
*shortens* it (measured below). Handling it is the real engineering content of
criterion 2.

### Every emphatic notation this package accepts

| eBL IPA input | Codepoints | Reference engine | Neural engine |
|---|---|---|---|
| `ᵵ` | U+1D75 | `t[` → [t̪] pharyngealized | `t` + `ˤ` (approximate) |
| `tˤ` | U+0074 U+02E4 | `t[` → [t̪] | `t` + `ˤ` (approximate) |
| `ᵴ` | U+1D74 | `s[` → [s̪] | `s` + `ˤ` (approximate) |
| `sˤ` | U+0073 U+02E4 | `s[` → [s̪] | `s` + `ˤ` (approximate) |
| `t̴͡s̴` | U+0074 U+0334 U+0361 U+0073 U+0334 | `ts[` → affricate [t͡s̪] | `s` + `ˤ` (approximate) |
| `t͡sˤ` | U+0074 U+0361 U+0073 U+02E4 | `ts[` → affricate [t͡s̪] | `s` + `ˤ` (approximate) |
| with `emphatic: 'ejective'` | any of the above | `t\`` → [tʼ], `s?` → glottalized [s] | **not representable** → reference engine |
| `aːː` `eːː` `iːː` `uːː` | base + U+02D0 U+02D0 | single `ː` + 1.8× duration stretch | single `ː` + 1.8× duration stretch |

### Neural substitution table

The neural voice is an English one (see [Licensing](#11-licensing) for why). Its
phoneme id map is Piper's 157-symbol default IPA map, so every Akkadian symbol is
a *valid* id — but a valid id is not a *trained* one. The rule this package
follows is to stay inside the phones the voice actually learned, and to declare
every substitution rather than hide it. Substitutions surface in
`explain().neural.approximations` and in `synthesizeDetailed().notes`.

| eBL IPA | Neural token | Loss | Reference engine |
|---|---|---|---|
| `ʃ` (š) | `ʃ` | none — English "sh" | `S` |
| `ʔ` (ʾ, ') | `ʔ` | none — English glottal stop | `?` |
| `j` (y) | `j` | none | `j` |
| `a e i o u` | same | none — all occur in English diphthongs | same |
| `aː eː iː uː` | base + `ː` | none | base + `:` |
| `x` (ḫ) | **`h`** | velar fricative → glottal. Akkadian has no contrasting /h/, so no distinction is lost, but the sound is anglicized. | `x` — true [x] |
| `q` | **`k`** | the /k/ ~ /q/ contrast is **lost** on the neural path | `q` — true uvular |
| `ᵵ ᵴ tˤ sˤ` | `t`/`s` + `ˤ` | see [criterion 1](#criterion-1--glottalised-consonants-ṭ-and-ṣ) — not verified genuine | `t[` / `s[` — true dental emphatics |
| ejective | — | not representable | `t\`` / `s?` |
| `t͡s` (affricative s) | `t` + `s` | no single affricate token; rendered as a sequence | `ts` |
| `d͡z` (affricative z) | `d` + `z` | as above | `dz` |

The four sample words shipped in `demo/` — abālu, šarru, bītu, ilu — contain **no
substitutions at all**; `notes` is empty for every one of them, and there is a
test asserting that stays true.

---

## 8. Acceptance criteria — measured

The Trello card listed three acceptance criteria, all unchecked. Here is each one
with a measured result rather than a claim. Reproduce any of these — **shell**:

```shell
npm run demo
```

### 0.3.2 review result — Enrique Jiménez, 2026-09-17

> "the emphatics are not yet distinguishable from non-emphatics, and the
> extra-long vowels are not yet represented."

He was right, and 0.3.2 exists to answer it with measurements rather than
claims. Praat (Burg formants, median over the vowel after the onset consonant;
spectral centre of gravity of the onset noise) on `demo/review-0.3.2/`,
regenerated by `node scripts/gen-review-samples.mjs` and measured by
`scripts/measure-review-samples.py`:

| Contrast | espeak reference (0.3.1 "genuine" path) | English voice + `ˤ` (0.3.1 neural) | **Arabic voice `ar_JO-kareem-medium` (0.3.2)** |
|---|---|---|---|
| sābu → ṣābu, following-vowel F2 | 1405 → 1404 Hz (no change) | 1890 → 1843 Hz (noise) | 1341 → 1320 Hz; sibilant CoG **3864 → 1282 Hz** |
| tābu → ṭābu, F2 | 1405 → 1404 Hz | 1959 → 2037 Hz (wrong direction) | **1426 → 1287 Hz** |
| tuppu → ṭuppu, F2 | 872 → 875 Hz | 2141 → 2015 Hz | **919 → 844 Hz** |
| kātu → qātu, F2 / burst CoG | 1406 → 1406 Hz | q folded to k (identical) | **1624 → 1328 Hz**, burst 411 → 157 Hz |
| šarru / šarrū / šarrû total | 0.42 / 0.71 / 1.19 s (robotic) | 0.56 / **0.54** / 0.90 s (long ≈ short) | **0.25 / 0.30 / 0.47 s** |
| bana / banā / banâ | 0.35 / 0.67 / 1.19 s | 0.48 / 0.43 / 0.75 s | **0.22 / 0.28 / 0.42 s** |

What that table says: espeak's `s[`/`t[` (dental) mnemonics never pharyngealized
anything — the following vowel is byte-identical — so 0.3.1's "genuine emphatic"
route was not; the English voice cannot say ṭ ṣ q ḫ or hold a long vowel; and
the Arabic-trained Piper voice does all of it because espeak-ng `ar` writes
ص as `s̪` (s + U+032A) with a backed vowel allophone `a.`, ط as `t̪`, ق as `q`,
خ as `χ`, and the voice was trained on exactly those tokens. 0.3.2 therefore:

* emits those tokens on an Arabic-trained voice (`toPiperPhonemesFor(units, 'arabic')`);
* routes every word containing ṭ ṣ q or ḫ to `ar_JO-kareem-medium` under
  `emphatics: 'auto'` when it is installed (`ebl-tts --fetch-voice arabic`),
  falling back to the espeak route only when it is not;
* fixes the extra-long stretch: the nucleus detector often returned a 30-70 ms
  sliver for a word-final û/ê, so 1.8× added ~40 ms. A word-final ultralong
  vowel now stretches from its nucleus onset to the end of the word (≥120 ms);
* accepts the transliteration forms ṭ ṣ (U+1E6D/U+1E63, or t/s + U+0323) as
  emphatic input alongside eBL's ᵵ ᵴ tˤ sˤ.

**Reviewer verdict (Enrique Jiménez, eBL, 2026-09-21):** listening to minimal
pairs rendered by ElevenLabs v3 from Arabic-script spellings
(https://gesztu.com/review/akkadian-clips-2026-09-19/): "it sounds correct to me.
I would go with the Arabic-style pharyngealized." So `emphatic: 'pharyngealized'`
stays the default for what a dictionary should play; the ejective reconstruction
argued in the literature (Geers' Law, Kouwenberg 2003) remains available as
`emphatic: 'ejective'` for anyone rendering the reconstruction rather than the
reading convention.

On the voices: `--voice arabic` gives the trained emphatics and all three vowel
lengths but was judged robotic by the project owner; for human-quality output the
route that passed review is the ElevenLabs v3 voice fed Arabic-script spellings
plus this package's WSOLA stretch for the extra-long tier. NOTE on licensing:
`ar_JO-kareem-medium` is fine-tuned from non-commercial Blizzard-2011 data
(project audit 2026-07); it is not license-clean for redistribution and stays a
local experiment, contrary to the "same license terms" wording in earlier drafts.

### Criterion 1 — "glottalised consonants (ṭ and ṣ)"

**Status (0.3.2): met on the Arabic-trained neural voice, measured above. The
0.3.1 text below is kept because its measurements still describe the English
voice and the espeak route.**

espeak-ng has explicit phoneme features for both reconstructions, so both are
genuinely distinct segments rather than a filtered approximation:

| Contrast | Files | Waveform RMS difference (0 = identical) |
|---|---|---|
| ṣ pharyngealized [s̪] vs plain [s] | `demo/sabu_emphatic.wav` vs `demo/sabu_plain.wav` | **1.42** |
| ṭ ejective [tʼ] vs plain [t] | `demo/tabu_ejective.wav` vs `demo/tabu_plain.wav` | **1.36** |

Both reconstructions are offered because the reconstruction itself is unsettled,
and we did not want to make that choice on eBL's behalf. If you have a conviction
about which is right for Akkadian, it is a one-word change.

**On the neural path, honestly: this does not work, and we are not going to
pretend otherwise.** `ˤ` (U+02E4) *is* in the voice's phoneme id map, and
inserting it *does* change the output — but that is not evidence of
pharyngealization. We inserted a control token the English voice has certainly
never seen (`ǀ`, a dental click) in the same position and it perturbed the render
by a comparable amount, while the vowel's spectral centroid moved in inconsistent
directions across ṣ and ṭ (1031→984 Hz for ṣ, but 590→1193 Hz for ṭ). A genuine
pharyngealized consonant lowers adjacent F2 consistently. The conclusion is that
`ˤ` is an untrained embedding on this voice.

Ejectives are worse than untrained: `ʼ` (U+02BC) **is absent from Piper's phoneme
id map entirely**, so no stock Piper voice can produce one at all.

That is why `emphatics: 'auto'` is the default. The cost is a voice change on
emphatic-bearing words; the benefit is that eBL never publishes a pronunciation
whose defining consonant is a guess. Both `emphatics: 'neural'` (one voice,
approximate emphatic) and `mode: 'reference'` (one voice, robotic, exact) are one
option away. The real fix is a fine-tune on clean Arabic data — see
[Roadmap](#13-roadmap-and-honest-limitations).

### Criterion 2 — "extra-long vowels (â /aːː/)"

**Status: met on both engines, by duration post-processing, with the neural
figure reported honestly.**

First, the problem, measured on the shipped voice: feeding the stacked `ːː`
straight to the neural model **shortens** the vowel rather than lengthening it.

| Input tokens | Result |
|---|---|
| `baˈnuː` | 0.566 s (baseline) |
| `baˈnuːː` | 0.407 s — **0.72× the long vowel** |

So the second `ː` is worse than useless. Instead, the word is rendered in a
single neural pass (preserving coarticulation — splicing separate renders is what
makes synthetic speech sound stitched together), the flagged vowel is located
acoustically in that render, and only that span is WSOLA time-stretched by
`ultralongFactor`.

Measured with deterministic VITS scales (`noiseW: 0`) so the figures repeat exactly:

| Word | Vowel span located | After stretching | **Vowel ratio** | Whole-word ratio | Δ cross-check |
|---|---|---|---|---|---|
| bānû `[ba.ˈnuːː]` | 0.299 s | 0.539 s | **×1.80** | ×1.36 | +223 ms vs +239 ms predicted |
| rabû `[ra.ˈbuːː]` | 0.259 s | 0.467 s | **×1.80** | ×1.36 | +192 ms vs +208 ms predicted |
| ibnû `[ib.ˈnuːː]` | 0.354 s | 0.638 s | **×1.80** | ×1.60 | +267 ms vs +283 ms predicted |
| ilû `[i.ˈluːː]` | 0.249 s | 0.449 s | **×1.80** | ×1.37 | +184 ms vs +200 ms predicted |

Reference engine, same words, whole-word measurement:

| Word | Long | Extra-long | **Word ratio** |
|---|---|---|---|
| bānû | 0.657 s | 1.195 s | **×1.82** |
| rabû | 0.724 s | 1.205 s | **×1.67** |
| ibnû | 0.700 s | 1.186 s | **×1.69** |
| ilû | 0.609 s | 1.166 s | **×1.92** |

**Reading these numbers honestly.** Two different ratios are reported because the
two engines lengthen different things:

- The **vowel ratio** is the phonetic claim, and it is exactly ×1.80 on the
  neural path because the stretch is applied to the located vowel and nothing
  else. `ultralongSpanSeconds` in the result lets you verify it against the file.
- The **whole-word ratio** on the neural path is **×1.36–1.60, lower than the
  reference engine's ×1.67–1.92**. This is not the neural path underperforming —
  it is the arithmetic of only stretching the vowel. The reference path's words
  are shorter overall, so the same absolute added time is a larger fraction of
  them. If you measure whole files and expect ≥1.4 everywhere, the neural path
  will read below that bar on short words, and you should know that before you
  measure it yourself.
- The **Δ cross-check** confirms the mechanism end to end: the file really did
  grow by span × (factor − 1), within ~16 ms. That residual is the two 8 ms
  equal-power crossfades used to splice the stretched span back in.

One correctness note found while measuring this: the WSOLA implementation
originally under-delivered, returning ×1.70 for a requested ×1.80, because its
analysis loop stopped one frame early. That is fixed and there is a test
asserting the delivered factor matches the requested one to within 0.005.

`lengths: '2tier'` is a genuine opt-out — the two IPA strings then produce an
identical phoneme stream and the measured ratio is exactly ×1.00.

### Criterion 3 — "available as npm package"

**Status: met.** This is that package: ESM, TypeScript types bundled, a `bin`
entry (`ebl-tts`), no network access at runtime, MIT licensed. Verified by a
clean-room install from `npm pack` into an empty directory.

---

## 9. Integrating with the eBL frontend `<Ipa>` component

The insertion point is `ebl-frontend/src/akkadian/ui/akkadianWordAnalysis.tsx`.
It is the single choke point through which every IPA render in the dictionary
(`WordTitle`) and the corpus reader (`ChapterViewSideBar`) passes, so one change
there covers both.

The component as it stands today:

```javascript
export function Ipa(props: {
  segments: Segment[]
  enclose?: boolean
}): JSX.Element {
  const ipaTranscription = props.segments
    .map((segment) => segment.ipa)
    .join(' ')
  return (
    <div className="ipa-display">
      {props.enclose ? `[${ipaTranscription}]` : ipaTranscription}
    </div>
  )
}
```

**The key fact: `ipaTranscription` is already exactly the string this package
consumes.** Nothing needs to be re-derived, and no backend change is required —
eBL computes IPA client-side from `word.lemma`, so the audio can be produced
client-side too.

### Choosing browser or server

This package renders in **Node**. `onnxruntime-node` is a native module and does
not run in a browser, so there are two integration shapes:

| Shape | How | When to choose it |
|---|---|---|
| **Server route** (recommended first step) | a small endpoint in `ebl-api` that takes an IPA string and returns `audio/wav`; cache by IPA string | no frontend bundle growth, no 61 MB download for visitors, audio cacheable at the CDN, and it is the same code path used to pre-render a whole dictionary corpus |
| **Pre-rendered corpus** | run the package over all ~20,865 dictionary lemmas once, publish the WAV/MP3 files as static assets | zero runtime cost, works offline, and the audio becomes a citable versioned artifact |
| **Browser** | port to `onnxruntime-web` + a WASM espeak build | only if audio must work with no server round-trip; not implemented here |

For a play button, the server route is the least invasive: `<Ipa>` gets a button,
the button hits one endpoint.

### Worked example — adding the speaker button

**Server side** — an Express-style route in `ebl-api`. **JavaScript**:

```javascript
import { synthesize } from '@ebl/akkadian-phonemes';

const cache = new Map(); // swap for Redis or a CDN in production

app.get('/pronunciation', async (req, res) => {
  const ipa = String(req.query.ipa ?? '');
  if (!ipa || ipa.length > 200) return res.status(400).end();

  let wav = cache.get(ipa);
  if (!wav) {
    wav = await synthesize(ipa, { lengthScale: 1.15 }); // slightly slower reading
    cache.set(ipa, wav);
  }
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(wav);
});
```

**Frontend side** — the modified component. **JavaScript** (TSX):

```javascript
import React, { useCallback, useRef, useState } from 'react'
import { AkkadianWord } from 'transliteration/domain/token'
import {
  PhoneticProps,
  Segment,
  tokenToPhoneticSegments,
} from 'akkadian/application/phonetics/segments'

function PronounceButton(props: { ipa: string }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')

  const play = useCallback(async () => {
    try {
      if (!audioRef.current) {
        setState('loading')
        const url = `/api/pronunciation?ipa=${encodeURIComponent(props.ipa)}`
        audioRef.current = new Audio(url)
      }
      setState('idle')
      await audioRef.current.play()
    } catch {
      setState('error')
    }
  }, [props.ipa])

  return (
    <button
      type="button"
      className="ipa-pronounce"
      onClick={play}
      disabled={state === 'loading'}
      aria-label={`Play reconstructed pronunciation of ${props.ipa}`}
      title="Reconstructed pronunciation (synthesized)"
    >
      {state === 'error' ? '⚠' : '🔊'}
    </button>
  )
}

export function Ipa(props: {
  segments: Segment[]
  enclose?: boolean
  pronounce?: boolean
}): JSX.Element {
  const ipaTranscription = props.segments
    .map((segment) => segment.ipa)
    .join(' ')
  return (
    <div className="ipa-display">
      {props.enclose ? `[${ipaTranscription}]` : ipaTranscription}
      {props.pronounce && <PronounceButton ipa={ipaTranscription} />}
    </div>
  )
}
```

Then opt in where you want it — in `WordTitle.tsx`, **JavaScript** (TSX):

```javascript
<Ipa segments={segments} enclose pronounce />
```

Three deliberate choices in that snippet, for review:

1. **The button is opt-in via a prop**, so the corpus reader's per-line IPA does
   not sprout hundreds of buttons unless you want it to.
2. **The `<Audio>` element is created lazily and cached in a ref**, so repeated
   clicks do not re-request.
3. **The `title` says "reconstructed"**, because it is. Every pronunciation here
   is a reconstruction with switchable parameters, not a recording, and the UI
   should say so where a user can see it.

If you pre-render the corpus instead, the button becomes a plain
`new Audio('/audio/akkadian/abalu.mp3')` and the server route disappears.

---

## 10. Troubleshooting

**`bad floating point constant`, `command not found: import`, or `syntax error near unexpected token`**
You pasted a **JavaScript** block into a shell. Put it in a `.js` file and run
`node file.js`, or use the `ebl-tts` CLI instead.

**`VoiceNotFoundError: Piper voice "en_US-kristin-medium" not found`**
The neural voice is not installed. Run `npx ebl-tts --fetch-voice`. The error
message lists every path that was searched. To work without it right now, pass
`{ mode: 'reference' }` — espeak-ng needs no download.

**`Piper voice config not found: ....onnx.json`**
The `.onnx` is there but its companion `.onnx.json` is not. Both files are
required; the JSON holds the phoneme id map. Download both.

**`sha256 mismatch`**
The download was truncated, or the upstream file changed. Delete the file in
`~/.cache/ebl-akkadian-phonemes/voices/` and retry. Do not ship audio built from
a file that failed this check.

**`Neural mode needs the optional peer 'onnxruntime-node', which failed to load`**
The native binary did not install. Common on unusual platforms, or when npm
blocked install scripts. Try `npm rebuild onnxruntime-node`, or fall back to
`{ mode: 'reference' }`.

**The word switched to a robotic voice and I did not ask for it**
It contains ṭ or ṣ, and `emphatics` defaults to `'auto'`. That is documented
behaviour, not a bug — see [criterion 1](#criterion-1--glottalised-consonants-ṭ-and-ṣ).
`synthesizeDetailed().engineReason` says so explicitly. Pass
`{ emphatics: 'neural' }` to keep one voice.

**The same word has a different duration every time**
VITS samples its duration predictor, so renders vary by roughly ±15%. Pass
`{ noiseW: 0, noiseScale: 0 }` for deterministic, byte-stable output — which is
what you want when pre-rendering a corpus.

**A word sounds unusually long or has an odd rhythm**
Some phoneme sequences are far outside English and the model handles them
awkwardly. `[ʃum.ˈʃaː]` (two `ʃ` in a short word) reliably renders around 1.7 s
against a 0.5–0.7 s norm. Options: pass a lower `lengthScale`, or render that
entry with `mode: 'reference'`. A fine-tune on Semitic-shaped data is the real
fix.

**`notes` is non-empty and I want to know what was approximated**
That is what it is for. Each entry names the substitution. Use
`explain(ipa).units` to see it per symbol.

**Audio plays but sounds clipped at the start or end**
Report it. The neural path trims silence at 0.4% of full scale with 15 ms of
padding, chosen so a quiet fricative onset survives; if a word is still being
clipped, the threshold needs revisiting.

---

## 11. Licensing

**This package: MIT.** All the code here — the normalizer, the DSP, the Piper id
encoding — was written from scratch for this project. No GPL code was copied or
linked into it.

**Runtime dependencies, and what each implies:**

| Dependency | License | Implication |
|---|---|---|
| `onnxruntime-node` | **MIT** | none — permissive |
| `espeak-ng` (WASM npm build) | **GPL-3.0** | see below |
| `en_US-kristin-medium` voice | **public-domain training data** | see below |

**The espeak-ng question, stated plainly.** espeak-ng is GPL-3.0. This package
depends on it as a *separate npm package* which it invokes at runtime — our code
is not a derivative work of it, and this package remains MIT. But if you
**redistribute a bundle** that includes espeak-ng (for example, a webpack build
with the WASM inlined, or a Docker image), the GPL's terms attach to that
combined distribution, which for eBL's open academic stack is very likely fine
but is a decision your institution should make knowingly rather than inherit by
accident. Two ways to avoid the question entirely: use `mode: 'neural'`
exclusively and drop the dependency, or ship only the pre-rendered audio files,
which carry no code license at all.

**Why this specific neural voice.** The voice was chosen for *redistributability*
first and quality second, because audio destined for eBL's CC-licensed corpus has
to be publishable without a rights question.

`en_US-kristin-medium`'s model card states its dataset is **LibriVox.org,
license: public domain**, and that it was **trained from scratch** for 2000
epochs on ~11.5 hours of recordings (trainer: Bryce Beattie). "Trained from
scratch" is the load-bearing phrase. The obvious alternative — the Arabic
`ar_JO-kareem-medium` voice, whose accent would suit Akkadian far better — is
**not** usable for a public corpus: its model card records that it was finetuned
from the English "lessac" voice, which derives from Blizzard Challenge 2011
Lessac data restricted to research/non-commercial use, on a dataset
(`arabicttstrain`) that carries **no license file at all**, i.e. all rights
reserved. A voice built on those foundations cannot be the basis of a CC-BY-NC-SA
release.

So the trade is explicit: **an English-accented voice with clean public-domain
lineage, instead of an Arabic-accented voice with a licensing defect.** The
phonetic cost of that trade is the substitution table in §7 and the emphatic
limitation in §8, both of which the reference engine covers. The right long-term
answer is a fine-tune on genuinely clean Arabic data — see below.

**The OmniVoice option.** The optional `--engine omnivoice` voice uses OmniVoice
(k2-fsa), which is **Apache-2.0**, driven from a local Python service you install
yourself — it is not bundled in the npm tarball and adds no dependency to the
default path. Its voice is cloned from the **same `en_US-kristin-medium` (Piper)
public-domain output** the Piper engine uses; no paid-TTS (ElevenLabs etc.) audio
is used as a clone reference, so it carries no third-party voice-rights question.
Both neural voices trace to the same clean lineage.

**Audio you generate is yours.** Neither the Piper engine's license nor the
voice's public-domain training data places any restriction on the WAVs this
package produces. They can be published under CC-BY-NC-SA, or more openly,
without asking anyone.

---

## 12. Mapping to the original Trello card

The card ("Phoneme Synthesis", label *Dictionary*, list *To do*) asked for a
module and listed three acceptance criteria, all at 0%.

| Card item | Status | Where |
|---|---|---|
| "the functionality needs to be made available as a **module**" | **done** — npm package, ESM + types + CLI | this package |
| AC 1: "Synthesised pronunciation supports **glottalised consonants**" | **done** on the reference engine (both pharyngealized and ejective reconstructions, switchable); **not achievable** on a stock neural voice, and the package routes around that by default | [§8 criterion 1](#criterion-1--glottalised-consonants-ṭ-and-ṣ) |
| AC 2: "Synthesised pronunciation supports **extra long vowels**" | **done** on both engines — ×1.80 on the vowel, by duration post-processing, because no stock voice stacks a second `ː` | [§8 criterion 2](#criterion-2--extra-long-vowels-â-aːː) |
| AC 3: "Synthesised pronunciation is **available as npm package**" | **done**, verified by clean-room install | [§8 criterion 3](#criterion-3--available-as-npm-package) |
| "See also espeak-phonemizer" | the reference engine **is** espeak-ng, the maintained successor of the eSpeak engine the original prototype used | §4 |
| "Arabic would be perhaps the best voice" (Polly `arb`) | **agreed phonetically, rejected on licensing.** The one available Arabic Piper voice has an unlicensed dataset and a research-only base. A clean Arabic fine-tune is the roadmap item. | §11, §13 |
| "Azure Speech phonetic alphabets" | not needed — this runs offline with no vendor | §4 |

The prototype the card hyperlinked ("Phoneme Synthesis PROJECT") is, with high
confidence, [`itinerarium/phoneme-synthesis`](https://github.com/itinerarium/phoneme-synthesis)
— a single-file meSpeak.js browser demo, English voice only, no emphatics, no
third length, not a module. That identification is inferred from the card's
description rather than read from the private Trello link, and one sentence of
confirmation would close it.

---

## 13. Roadmap and honest limitations

**What is not solved**

- **Genuine emphatics on a good-sounding voice.** The current answer is an engine
  switch. The real fix is a Piper fine-tune on a CC0/CC-BY Arabic corpus
  (Mozilla Common Voice Arabic is CC0; the Arabic Speech Corpus is CC BY 4.0) —
  a bounded one-time GPU job whose output would be clean to redistribute and
  which would carry native `ˤ`, `q`, `χ` and `ʕ`. Scaffolding for this lives in
  `finetune/`.
- **A native third vowel length.** Both engines reach it by post-processing. A
  fine-tune trained with an explicit `ːː` token and 1.5–1.8× duration labels
  would make it a property of the model rather than of the DSP.
- **The k ~ q contrast on the neural path**, lost to the substitution table.
- **Vowel-nucleus location is acoustic, therefore approximate.** It correctly
  separates two vowels across a sonorant in most test words but merges them in
  some (`awīlu`, `ilu`). Because Akkadian's extra-long vowels are almost always
  the final stressed vowel — the loudest, longest, easiest to find — this rarely
  bites, and there is a documented `word-stretch` fallback with a `notes` entry
  when detection fails outright.
- **Browser support.** Node only today; a browser build needs `onnxruntime-web`.
- **`dialect` does nothing yet.** It is accepted and recorded so that adding
  Old Babylonian versus Neo-Assyrian behaviour later is not a breaking change.
- **Prosody is reconstruction, not recording.** Stress comes from eBL's own
  Huehnergard implementation; everything else is a defensible default with a
  switch on it. This package should be described to users as reconstructed
  pronunciation, and the UI in §9 says so.

**What we would most value in return:** whether the pronunciations are actually
*right*. The emphatics, the vowel lengths and the stress can all be retuned in
minutes; judging them cannot.

---

## Project layout

| Path | What |
|---|---|
| `src/normalizer.ts` | eBL IPA → phoneme units for both engines. The one genuinely new piece of linguistic work. |
| `src/piper.ts` | Piper VITS inference via ONNX Runtime; voice resolution and the phoneme id encoding. |
| `src/espeak.ts` | espeak-ng WASM wrapper (reference engine). |
| `src/dsp.ts` | WAV I/O, silence trimming, WSOLA time-stretch, vowel-nucleus detection. No dependencies. |
| `src/synthesize.ts` | the public API and the engine-routing rules. |
| `src/fetch-voice.ts` | voice download with SHA-256 verification. |
| `src/cli.ts` | the `ebl-tts` command. |
| `scripts/gen-demo.mjs` | regenerates `demo/` **through the public API** and prints §8's measurements. |
| `scripts/ebl-to-piper.mjs` | dumps neural phoneme tokens as JSON, for auditing or external synthesis. |
| `test/basic.test.mjs` | 39 tests, covering the normalizer, both engines, engine routing, the DSP, and the CLI contract. Neural tests skip cleanly when the voice is absent. |
| `finetune/` | scaffolding for the Arabic fine-tune described in §13. Not shipped in the npm tarball. |

---

MIT © CloudRaider / Theosophia · built for the
[electronic Babylonian Library](https://www.ebl.lmu.de/) collaboration.
