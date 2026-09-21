/**
 * synthesize.ts — the public API (revival doc §5.1).
 *
 *   synthesize(ipa, opts?)       : Promise<Buffer>          // WAV bytes
 *   synthesizeDetailed(ipa, ...) : Promise<SynthesisResult> // WAV + what was done
 *
 * TWO ENGINES, one normalizer:
 *
 *   mode:'neural'    (DEFAULT) Piper VITS via onnxruntime-node, voice
 *                    en_US-kristin-medium. Human-sounding; this is the voice a
 *                    dictionary user should hear. Cannot do true emphatics or a
 *                    third vowel length by itself — see below.
 *
 *   mode:'reference' espeak-ng WASM. Robotic formant synthesis, but its phoneme
 *                    model has explicit pharyngealized/ejective/length features,
 *                    so it is the guaranteed-compliance floor and the only path
 *                    to genuine ejectives.
 *
 * How the two eBL phonetic criteria are met on the neural path:
 *
 *   EMPHATICS (ṭ/ṣ) — `ˤ` is a valid id in the voice's phoneme_id_map but was
 *   never in its English training data, so the neural render is perturbed, not
 *   genuinely pharyngealized (measured — README criterion 1). Default
 *   `emphatics:'auto'` therefore routes emphatic-bearing words to the reference
 *   engine so the contrast is real. `emphatics:'neural'` opts into one consistent
 *   voice at the cost of that guarantee.
 *
 *   EXTRA-LONG VOWELS (â/ê/î/û = aːː) — no stock neural voice stacks a second ː;
 *   measured here, `uːː` came out SHORTER than `uː` (~0.8×). So the word is
 *   rendered in ONE neural pass (preserving coarticulation), the flagged vowel's
 *   acoustic nucleus is located, and only that span is WSOLA time-stretched.
 */
import {
  normalize,
  normalizeForPiper,
  toEspeakString,
  toPiperPhonemes,
  type Emphatic,
  type Lengths,
  type PhonemeUnit,
} from './normalizer.js';
import { renderPhonemes } from './espeak.js';
import { renderPiperTokens, loadVoice, voiceProfile, emphaticVoicePath, DEFAULT_VOICE, EMPHATIC_VOICE } from './piper.js';
import type { VoiceProfile } from './piper.js';
import { renderOmniVoiceUnits, OMNIVOICE_REF_VOICE, type OmniVoiceOptions } from './omnivoice.js';
import { renderElevenLabsText, type ElevenLabsOptions } from './elevenlabs.js';
import { toArabicScript } from './arabic-script.js';
import {
  concatCrossfade,
  encodeWav,
  findVowelNuclei,
  stretchSpan,
  trimSilence,
  wsolaStretch,
  type Pcm,
} from './dsp.js';

export type Mode = 'reference' | 'neural';
/**
 * Which NEURAL voice model renders the neural stage. This selects ONLY the voice;
 * the hybrid around it (espeak emphatics + dsp vowel-length stretch) is identical
 * either way.
 *   'piper'     (DEFAULT) Piper VITS in-process via ONNX — deterministic, no
 *               external service. Consumes IPA directly, so its segmental mapping
 *               is the more faithful of the two.
 *   'omnivoice' OmniVoice (k2-fsa, Apache-2.0) via a local Python service — more
 *               natural/expressive, near-real-time, but consumes ARPABET, so it
 *               leans on the SAME espeak+dsp hybrid for emphatics and length.
 */
export type Engine = 'piper' | 'omnivoice' | 'elevenlabs';
export type Dialect = 'OB' | 'OA' | 'SB' | 'NA' | 'NB';
/** How emphatics (ṭ/ṣ) are rendered when mode is 'neural'. */
export type EmphaticPolicy = 'auto' | 'neural' | 'reference';

export interface SynthesizeOptions {
  /** 'neural' = Piper VITS (DEFAULT, human-sounding). 'reference' = espeak-ng. */
  mode?: Mode;
  /**
   * Which neural voice runs the neural stage. Default 'piper'. Only meaningful
   * when the render actually reaches the neural engine (mode:'neural' and the word
   * is not routed to espeak by the emphatics policy). Swaps the VOICE only — the
   * espeak emphatics route and the dsp vowel-length stretch are unchanged, so
   * 'omnivoice' output stays phonologically faithful, not raw OmniVoice.
   */
  engine?: Engine;
  /** OMNIVOICE only: overrides for the local Python service (python, refAudio, device …). */
  omnivoice?: OmniVoiceOptions;
  /**
   * Only meaningful when mode is 'neural'.
   *   'auto'      (default) render emphatic-bearing words on the REFERENCE engine,
   *               because an English-lineage neural voice cannot truly pharyngealize.
   *               Guarantees eBL acceptance criterion 1 at the cost of a voice switch.
   *   'neural'    keep one consistent voice; the emphatic is a perturbation, not a
   *               verified pharyngealized phone. Use when UX consistency matters more.
   *   'reference' always use espeak-ng for the whole word (same as mode:'reference').
   */
  emphatics?: EmphaticPolicy;
  /** Emphatic realization. Default 'pharyngealized'. 'ejective' forces the reference engine. */
  emphatic?: Emphatic;
  /** '3tier' honors eBL's extra-long â/ê/î/û as a distinct, longer vowel. Default '3tier'. */
  lengths?: Lengths;
  /** Not implemented. Supplying dialect throws; resolve source-specific IPA upstream. */
  dialect?: Dialect;
  /** Duration multiple applied to an extra-long vowel vs a long vowel. Default 1.8. */
  ultralongFactor?: number;
  /** REFERENCE engine only: speaking rate, words per minute. Default 150. */
  wpm?: number;
  /** NEURAL only: path to a Piper .onnx voice (its .onnx.json must sit beside it). */
  voicePath?: string;
  /**
   * 0.3.2: path to an ARABIC-trained Piper voice used for emphatic-bearing words
   * under emphatics:'auto' (and for any word when voicePath itself is Arabic-trained).
   * Default: `ar_JO-kareem-medium` if installed (`ebl-tts --fetch-voice arabic`).
   * Set to '' to disable and fall back to the espeak reference engine as in 0.3.1.
   */
  emphaticVoicePath?: string;
  /** engine:'elevenlabs' — API key / voice id / model / settings (see elevenlabs.ts). */
  elevenlabs?: ElevenLabsOptions;
  /**
   * engine:'elevenlabs' text form. 'auto' (default) = vowelled Arabic script when the word is
   * spellable (ṣ ṭ q ḫ ʾ native to the model — the form that passed eBL review 2026-09-21),
   * else the IPA text; 'arabic' forces Arabic (error if unspellable); 'ipa' forces IPA text.
   */
  script?: 'auto' | 'arabic' | 'ipa';
  /** NEURAL only: VITS length_scale, higher = slower. Default from the voice config. */
  lengthScale?: number;
  /** NEURAL only: VITS noise_scale. Default from the voice config. */
  noiseScale?: number;
  /** NEURAL only: VITS noise_w (duration-predictor noise). 0 makes duration deterministic. */
  noiseW?: number;
  /** NEURAL only: speaker id for multi-speaker voices. Default 0. */
  speakerId?: number;
}

/** What synthesizeDetailed() reports back, so nothing about the render is implicit. */
export interface SynthesisResult {
  /** WAV bytes (mono PCM16). */
  wav: Buffer;
  /** engine that actually rendered this word (may differ from the requested mode) */
  engine: Mode;
  /** why the engine differs from the request, if it does */
  engineReason?: string;
  sampleRate: number;
  durationSeconds: number;
  /** neural voice model used, when engine === 'neural' ('piper' | 'omnivoice') */
  neuralEngine?: Engine;
  /** neural voice used, when engine === 'neural' */
  voice?: string;
  /** how the extra-long vowel was realized */
  ultralong: 'none' | 'nucleus-stretch' | 'segment-stretch' | 'word-stretch' | 'disabled';
  /** measured stretch factor actually applied (1 = none) */
  ultralongFactor: number;
  /**
   * NEURAL only: duration, in seconds, of the audio span that was stretched —
   * i.e. the extra-long vowel as located in the render, BEFORE stretching. The
   * vowel's synthesized length is therefore this × ultralongFactor, and the word
   * grew by span × (ultralongFactor − 1). Reported so the length claim can be
   * checked against the file rather than taken on trust.
   */
  ultralongSpanSeconds?: number;
  /** neural phonetic approximations made for this word (empty = fully in-inventory) */
  notes: string[];
  /** tokens/phonemes handed to the engine, for auditing */
  phonemes: string;
}

// ---------------------------------------------------------------------------
// REFERENCE engine (espeak-ng)
// ---------------------------------------------------------------------------

interface Segment {
  phonemes: string; // espeak mnemonic string (inside of [[...]])
  stretch: number; // 1 = as-is; >1 = WSOLA lengthen
}

/**
 * Split normalized units into espeak render segments, isolating each extra-long
 * vowel so ONLY that vowel gets the duration stretch. The stressed-syllable mark
 * is re-attached to the isolated vowel (eBL emits stress before the syllable
 * onset; when we peel the vowel off we carry its stress with it).
 */
function segmentForStretch(units: PhonemeUnit[], factor: number): Segment[] {
  const segs: Segment[] = [];
  let buf = '';
  let pendingStress = false;

  const flush = () => {
    if (buf.length) segs.push({ phonemes: buf, stretch: 1 });
    buf = '';
  };

  for (const u of units) {
    switch (u.kind) {
      case 'stress':
        pendingStress = true; // defer; attach to the syllable's vowel
        break;
      case 'syllable':
        break; // boundary is informational
      case 'space':
        buf += ' ';
        break;
      case 'consonant':
        buf += u.espeak;
        break;
      case 'vowel':
        if (u.ultralong) {
          flush(); // close the prefix (onset consonants stay here, unstressed)
          segs.push({
            phonemes: (pendingStress ? "'" : '') + u.espeak,
            stretch: factor,
          });
          pendingStress = false;
        } else {
          buf += (pendingStress ? "'" : '') + u.espeak;
          pendingStress = false;
        }
        break;
    }
  }
  flush();
  return segs;
}

async function renderReference(
  ipa: string,
  opts: SynthesizeOptions,
  factor: number,
): Promise<{ pcm: Pcm; ultralong: SynthesisResult['ultralong']; phonemes: string }> {
  const wpm = opts.wpm ?? 150;
  const norm = normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
  const voice = norm.voice;
  const phonemes = toEspeakString(norm.units);

  if (!norm.hasUltralong) {
    // Fast path: one espeak render for the whole word (best coarticulation).
    // Trim espeak's leading/trailing silence padding so durations are honest
    // and consistent with the extra-long path.
    const pcm = trimSilence(await renderPhonemes(phonemes, { voice, wpm }));
    return { pcm, ultralong: opts.lengths === '2tier' ? 'disabled' : 'none', phonemes };
  }
  // Extra-long path: isolate each ultralong vowel and WSOLA-stretch just it,
  // then crossfade the segments back together (revival doc §5.3, v1).
  const segs = segmentForStretch(norm.units, factor);
  const parts: Pcm[] = [];
  for (const s of segs) {
    let seg = await renderPhonemes(s.phonemes, { voice, wpm });
    seg = trimSilence(seg);
    if (s.stretch !== 1) seg = wsolaStretch(seg, s.stretch);
    parts.push(seg);
  }
  return { pcm: concatCrossfade(parts), ultralong: 'segment-stretch', phonemes };
}

// ---------------------------------------------------------------------------
// NEURAL engine (Piper VITS)
// ---------------------------------------------------------------------------

async function renderNeural(
  ipa: string,
  opts: SynthesizeOptions,
  factor: number,
): Promise<{
  pcm: Pcm;
  ultralong: SynthesisResult['ultralong'];
  phonemes: string;
  notes: string[];
  /** duration of the span that was stretched, before stretching */
  spanSeconds?: number;
}> {
  const engine: Engine = opts.engine ?? 'piper';
  let profile: VoiceProfile = 'english';
  if (engine === 'piper') {
    try {
      profile = voiceProfile((await loadVoice(opts.voicePath)).config);
    } catch {
      profile = 'english'; // voice missing: renderPiperTokens below raises the real error
    }
  }
  const n = normalizeForPiper(ipa, { emphatic: opts.emphatic, lengths: opts.lengths, profile });
  // notes describe THIS engine's approximations, so scope them per branch: the
  // Piper IPA-mapping notes (n.notes) are meaningless on the OmniVoice ARPABET path.
  const notes: string[] = [];

  // ---- NEURAL VOICE STAGE (the only part that swaps between engines) ----
  // Both branches return raw neural PCM; everything below (trim + WSOLA length)
  // is engine-agnostic and applies identically.
  let pcm: Pcm;
  // What the neural voice actually consumed, for --detail (IPA for Piper, ARPABET
  // for OmniVoice — reporting Piper's IPA on the OmniVoice path would be a lie).
  let phonemesReported = n.tokens.join(' ');
  if (engine === 'elevenlabs') {
    // The reviewed route: Arabic-script spelling to a multilingual voice (arabic-script.ts),
    // IPA text for words Arabic cannot spell. Length tier applied below like every engine.
    const ar = toArabicScript(n.units);
    const want = opts.script ?? 'auto';
    let text: string;
    if (want === 'arabic' && !ar.representable) throw new Error(`script:'arabic' but word is not spellable in Arabic: ${ar.notes.join('; ')}`);
    if (want === 'ipa' || (want === 'auto' && !ar.representable)) {
      text = '/' + ipa.replace(/^\[|\]$/g, '') + '/';
      if (want === 'auto') notes.push(`sent as IPA text (Arabic script not representable: ${ar.notes.join('; ')})`);
    } else {
      text = ar.text;
      for (const note of ar.notes) notes.push(note);
    }
    const r = await renderElevenLabsText(text, opts.elevenlabs);
    pcm = r.pcm;
    phonemesReported = text;
  } else if (engine === 'omnivoice') {
    // OmniVoice consumes ARPABET (built from the same normalized units) and runs
    // in a local Python service. It already first-burst-trims and peak-normalizes.
    const r = await renderOmniVoiceUnits(n.units, opts.omnivoice);
    pcm = r.pcm;
    phonemesReported = r.arpabet;
    for (const note of r.notes) notes.push(note);
  } else {
    for (const note of n.notes) notes.push(note);
    // A trailing period gives VITS a sentence terminator; without one the duration
    // predictor drifts and trailing artefacts creep in on isolated words.
    const tokens = [...n.tokens, '.'];
    const piper = await renderPiperTokens(tokens, {
      voicePath: opts.voicePath,
      lengthScale: opts.lengthScale,
      noiseScale: opts.noiseScale,
      noiseW: opts.noiseW,
      speakerId: opts.speakerId,
    });
    pcm = piper.pcm;
    if (piper.missing.length)
      notes.push(`dropped tokens not in this voice's inventory: ${piper.missing.join(' ')}`);
  }

  // Gentle trim: the model pads isolated words with ~0.2 s of true silence
  // (measured RMS 0.0002), but low-level speech — a fricative onset, a final
  // release — can sit under 1% of full scale. Trim at 0.4% with 15 ms of padding
  // so dead air goes and audible detail stays.
  // ElevenLabs pads ~1.7 s of room tone at about -40 dBFS after the word; trim that at -34 dBFS so the
  // extra-long stretch lands on the vowel, not the tail (measured 2026-09-19: 4.05 s clip for a 0.7 s word).
  const trimmed = engine === 'elevenlabs' ? trimSilence(pcm, 0.02, 60) : trimSilence(pcm, 0.004, 15);
  if (!n.hasUltralong)
    return {
      pcm: trimmed,
      ultralong: opts.lengths === '2tier' ? 'disabled' : 'none',
      phonemes: phonemesReported,
      notes,
    };

  // Extra-long vowel: the word was rendered in ONE neural pass, so find the
  // flagged vowel acoustically and stretch only that span.
  const nuclei = findVowelNuclei(trimmed);
  const target = n.ultralongVowelIndices[0];
  let span: { start: number; end: number } | null = null;
  let how: SynthesisResult['ultralong'] = 'nucleus-stretch';

  if (nuclei.length === n.vowelCount && target < nuclei.length) {
    span = nuclei[target]; // clean 1:1 match between written and detected vowels
  } else if (nuclei.length > 0 && target === n.vowelCount - 1) {
    span = nuclei[nuclei.length - 1]; // word-final ultralong (the common Akkadian case)
  } else if (nuclei.length > target) {
    span = nuclei[target]; // best effort, ordinal match
  }

  // 0.3.2 (Enrique Jiménez, 2026-09-17: "the extra-long vowels are not yet represented").
  // Measured cause: the nucleus detector often returned a 30-70 ms sliver for a
  // word-final û/ê, so the 1.8× stretch added ~40 ms and was inaudible. A word-final
  // ultralong vowel is followed by nothing, so its true span runs from the nucleus
  // onset to the end of the word: extend it there, and never stretch a span
  // shorter than 120 ms (a real long vowel on this voice is 150-260 ms).
  if (span && target === n.vowelCount - 1) {
    const end = trimmed.samples.length;
    const minSpan = Math.round(0.12 * trimmed.sampleRate);
    span = { start: Math.min(span.start, end - minSpan), end };
    if (span.start < 0) span.start = 0;
    how = 'nucleus-stretch';
  } else if (span && span.end - span.start < Math.round(0.12 * trimmed.sampleRate)) {
    const minSpan = Math.round(0.12 * trimmed.sampleRate);
    const mid = Math.round((span.start + span.end) / 2);
    span = { start: Math.max(0, mid - minSpan / 2), end: Math.min(trimmed.samples.length, mid + minSpan / 2) };
    notes.push('extra-long vowel nucleus detected shorter than 120 ms; widened to 120 ms before stretching');
  }

  if (!span) {
    // Detector found nothing usable: stretch the whole word by the equivalent
    // amount of ADDED time rather than silently ignoring the length contrast.
    how = 'word-stretch';
    const wordFactor = 1 + (factor - 1) / Math.max(1, n.vowelCount * 2);
    notes.push(
      `vowel-nucleus detection failed (${nuclei.length} nuclei for ${n.vowelCount} vowels); ` +
        `applied a whole-word ${wordFactor.toFixed(2)}× stretch instead`,
    );
    return {
      pcm: wsolaStretch(trimmed, wordFactor),
      ultralong: how,
      phonemes: phonemesReported,
      notes,
    };
  }
  return {
    pcm: stretchSpan(trimmed, span.start, span.end, factor),
    ultralong: how,
    phonemes: phonemesReported,
    notes,
    spanSeconds: (span.end - span.start) / trimmed.sampleRate,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Does this word contain an emphatic (ṭ/ṣ in any of eBL's notations)? */
function hasEmphatic(ipa: string, opts: SynthesizeOptions): boolean {
  return normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths }).units.some(
    (u) => u.emphatic != null,
  );
}

/**
 * Consonants the English voice cannot say and the Arabic-trained voice can:
 * emphatics ṭ/ṣ, uvular q (folded to k on the English voice) and ḫ [x]~[χ]
 * (folded to h). 0.3.2: these words go to the Arabic voice under emphatics:'auto'.
 */
function needsArabicInventory(ipa: string, opts: SynthesizeOptions): { yes: boolean; why: string } {
  const units = normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths }).units;
  const found = new Set<string>();
  for (const u of units) {
    if (u.kind !== 'consonant') continue;
    if (u.emphatic != null) found.add(u.ipa);
    else if (u.ipa === 'q') found.add('q');
    else if (u.ipa === 'x' || u.ipa === 'χ') found.add('ḫ');
  }
  return { yes: found.size > 0, why: [...found].join(' ') };
}

/**
 * Synthesize eBL IPA to WAV bytes.
 *
 * @param ipa e.g. "[a.ˈbaː.lu]" (brackets optional), the exact string eBL's
 *            dictionary already renders next to each word.
 */
export async function synthesize(
  ipa: string,
  opts: SynthesizeOptions = {},
): Promise<Buffer> {
  return (await synthesizeDetailed(ipa, opts)).wav;
}

/**
 * Same as synthesize(), but returns the audio together with an account of how it
 * was produced: which engine ran, why, how the extra-long vowel was realized, and
 * every phonetic approximation made. Use this when you need to show your work.
 */
export async function synthesizeDetailed(
  ipa: string,
  opts: SynthesizeOptions = {},
): Promise<SynthesisResult> {
  if (opts.dialect !== undefined) {
    throw new Error('Dialect conversion is not implemented. Resolve source-specific IPA through the culture/period profile before synthesis; do not silently assume a dialect was applied.');
  }
  const requested: Mode = opts.mode ?? 'neural';
  const factor = opts.ultralongFactor ?? 1.8;
  const policy: EmphaticPolicy = opts.emphatics ?? 'auto';

  let engine: Mode = requested;
  let engineReason: string | undefined;

  if (requested === 'neural') {
    if (opts.emphatic === 'ejective') {
      // `ʼ` U+02BC is absent from Piper's phoneme id map entirely — ejectives are
      // structurally impossible on any stock Piper voice.
      engine = 'reference';
      engineReason =
        "emphatic:'ejective' is not representable on a Piper voice (no ʼ in the phoneme id map); rendered on the reference engine";
    } else if (policy === 'reference') {
      engine = 'reference';
      engineReason = "emphatics:'reference' requested";
    } else if (policy === 'auto' && needsArabicInventory(ipa, opts).yes) {
      const why = needsArabicInventory(ipa, opts).why;
      const ar = opts.emphaticVoicePath === undefined ? emphaticVoicePath() : opts.emphaticVoicePath || null;
      const explicitIsArabic = opts.voicePath ? voiceProfile((await loadVoice(opts.voicePath)).config) === 'arabic' : false;
      if (explicitIsArabic) {
        // caller already chose an Arabic-trained voice: the emphatics are in-distribution there
      } else if ((opts.engine ?? 'piper') === 'elevenlabs') {
        // Arabic-script spelling gives the multilingual voice native ṣ ṭ q ḫ: no diversion needed.
      } else if (ar && (opts.engine ?? 'piper') === 'piper') {
        opts = { ...opts, voicePath: ar };
        engineReason =
          `word contains ${why} and emphatics:'auto' is set; rendered on the Arabic-trained neural voice ${EMPHATIC_VOICE}, where s̪ t̪ q χ are trained tokens (measured: following-vowel F2 lowered ~150 Hz for s̪/t̪). Pass emphatics:'neural' to keep the default voice, or emphaticVoicePath:'' for the espeak reference engine.`;
      } else if (hasEmphatic(ipa, opts)) {
        engine = 'reference';
        engineReason =
          "word contains an emphatic (ṭ/ṣ) and emphatics:'auto' is set; no Arabic-trained voice is installed (ebl-tts --fetch-voice arabic), so it is rendered on the reference engine. Pass emphatics:'neural' to keep one voice.";
      }
    }
  }

  if (engine === 'reference') {
    const r = await renderReference(ipa, opts, factor);
    return {
      wav: encodeWav(r.pcm),
      engine,
      engineReason,
      sampleRate: r.pcm.sampleRate,
      durationSeconds: r.pcm.samples.length / r.pcm.sampleRate,
      ultralong: r.ultralong,
      ultralongFactor: r.ultralong === 'segment-stretch' ? factor : 1,
      notes: [],
      phonemes: r.phonemes,
    };
  }

  const neuralEngine: Engine = opts.engine ?? 'piper';
  const r = await renderNeural(ipa, opts, factor);
  return {
    wav: encodeWav(r.pcm),
    engine,
    engineReason,
    sampleRate: r.pcm.sampleRate,
    durationSeconds: r.pcm.samples.length / r.pcm.sampleRate,
    neuralEngine,
    voice:
      neuralEngine === 'omnivoice'
        ? OMNIVOICE_REF_VOICE
        : neuralEngine === 'elevenlabs'
          ? `elevenlabs:${opts.elevenlabs?.voiceId ?? process.env.EBL_ELEVENLABS_VOICE ?? '?'}`
          : opts.voicePath ?? DEFAULT_VOICE,
    ultralong: r.ultralong,
    ultralongFactor: r.ultralong === 'none' || r.ultralong === 'disabled' ? 1 : factor,
    ultralongSpanSeconds: r.spanSeconds,
    notes: r.notes,
    phonemes: r.phonemes,
  };
}

/**
 * Debug: return the normalized phoneme streams and metadata for an IPA input
 * without synthesizing audio. Shows BOTH engines' targets plus every neural
 * approximation, so a philologist can audit exactly how each symbol was
 * interpreted rather than trusting a black box.
 */
export function explain(ipa: string, opts: SynthesizeOptions = {}) {
  if (opts.dialect !== undefined) {
    throw new Error('Dialect conversion is not implemented. Supply resolved IPA without a dialect option.');
  }
  const norm = normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
  const piper = normalizeForPiper(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
  const arabic = normalizeForPiper(ipa, { emphatic: opts.emphatic, lengths: opts.lengths, profile: 'arabic' });
  return {
    ipa,
    mode: opts.mode ?? 'neural',
    voice: norm.voice, // espeak voice for the reference engine
    emphatic: norm.emphatic,
    lengths: norm.lengths,
    hasUltralong: norm.hasUltralong,
    espeak: toEspeakString(norm.units),
    neural: {
      voice: opts.voicePath ?? DEFAULT_VOICE,
      tokens: toPiperPhonemes(norm.units),
      ultralongVowelIndices: piper.ultralongVowelIndices,
      vowelCount: piper.vowelCount,
      approximations: piper.notes,
      /** 0.3.2: the token stream an Arabic-trained voice (ar_JO-kareem-medium) receives */
      arabicTokens: arabic.tokens,
      arabicScript: toArabicScript(norm.units),
      emphaticVoiceInstalled: emphaticVoicePath(),
    },
    units: norm.units.map((u) => ({
      ipa: u.ipa,
      espeak: u.espeak,
      neural: u.piper,
      kind: u.kind,
      ...(u.piperNote ? { note: u.piperNote } : {}),
    })),
  };
}
