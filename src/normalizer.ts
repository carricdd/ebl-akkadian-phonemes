/**
 * normalizer.ts
 * -------------
 * The one piece of genuinely new work in this package (revival doc §3.2 + §5.2):
 * map electronic Babylonian Library (eBL) IPA output -> the reference engine's
 * (espeak-ng) phoneme mnemonics, honoring eBL's `basic` / `affricative` /
 * `pharyngealized` variants.
 *
 * eBL emits IPA client-side from its `transcriptionToIpa.json` table. The exact
 * contract we consume (verbatim from that live file, revival doc §3.2):
 *
 *   basic:            y->j  '->ʔ  ʾ->ʔ  ḫ->x  h->x  š->ʃ  ṭ->ᵵ  ṣ->ᵴ
 *                     ā->aː ē->eː ī->iː ū->uː   â->aːː ê->eːː î->iːː û->uːː
 *   affricative:      s->t͡s  ṣ->t̴͡s̴  z->d͡z
 *   pharyngealized:   ṭ->tˤ  ṣ->sˤ
 *   pharyngealized-affricative: ṣ->t͡sˤ
 *
 * Two facts that drive the design:
 *  1. eBL's DEFAULT emphatics are the non-committal placeholders ᵵ (U+1D75) and
 *     ᵴ (U+1D74) — deliberately NOT choosing pharyngealized vs ejective. Only the
 *     `pharyngealized` switch makes eBL emit tˤ/sˤ. So we accept ALL forms of each
 *     emphatic and resolve them via the `emphatic` option.
 *  2. eBL writes the extra-long (circumflex â ê î û) vowels as a STACKED DOUBLE ː
 *     — two U+02D0. That is the literal token we must turn into a genuine third
 *     length (handled downstream by a duration stretch; here we only flag it).
 *
 * Output: an ordered list of PhonemeUnit — enough for the synthesizer to build an
 * espeak `[[...]]` string and to know which vowels are ultralong (so it can stretch
 * only those). Reimplemented from scratch (MIT); no GPL code copied.
 */

// ---- Unicode code points we care about (named for readability) --------------
const U = {
  STRESS_PRIMARY: 'ˈ', // ˈ
  STRESS_SECOND: 'ˌ', // ˌ
  LENGTH: 'ː', // ː
  PHARYNG: 'ˤ', // ˤ  (superscript reversed glottal stop = pharyngealization)
  TILDE_OVERLAY: '̴', // ̴  (eBL's "middle tilde" = emphatic marker on ᵵ/ᵴ decomposed / affricate)
  TIE: '͡', // ͡  (combining double inverted breve = affricate tie)
  EMPHATIC_T: 'ᵵ', // ᵵ  LATIN SMALL LETTER T WITH MIDDLE TILDE
  EMPHATIC_S: 'ᵴ', // ᵴ  LATIN SMALL LETTER S WITH MIDDLE TILDE
} as const;

export type Emphatic = 'pharyngealized' | 'ejective';
export type Lengths = '2tier' | '3tier';

export interface NormalizeOptions {
  /** Emphatic realization. Default 'pharyngealized' (Arabic-native). */
  emphatic?: Emphatic;
  /** '3tier' honors eBL's extra-long â/ê/î/û (aːː) as a distinct length. Default '3tier'. */
  lengths?: Lengths;
}

export type UnitKind = 'consonant' | 'vowel' | 'stress' | 'syllable' | 'space';

export interface PhonemeUnit {
  kind: UnitKind;
  /** original eBL-IPA slice this unit came from (for debugging / provenance) */
  ipa: string;
  /** espeak-ng phoneme mnemonic(s) for this unit (empty for stress/syllable/space markers) */
  espeak: string;
  /**
   * Piper (neural) target: the IPA token(s) to feed the neural voice's
   * `phoneme_id_map`. Empty array for syllable boundaries (dropped).
   */
  piper?: string[];
  /**
   * Set when the neural token is an APPROXIMATION of the true Akkadian phone
   * (English voice lacks it). Surfaced by explain() so a philologist can audit
   * every compromise rather than discover it by ear.
   */
  piperNote?: string;
  /** vowels only: 0 short, 1 long (ː), 2 ultralong (ːː) */
  length?: 0 | 1 | 2;
  /** vowels only: true when length === 2 (eBL circumflex â/ê/î/û) */
  ultralong?: boolean;
  /** consonants only: the resolved emphatic realization, if this is an emphatic */
  emphatic?: Emphatic | null;
}

export interface NormalizeResult {
  units: PhonemeUnit[];
  /** the espeak base voice this phoneme stream must be synthesized with */
  voice: 'ar' | 'am';
  /** true if any vowel is ultralong AND lengths==='3tier' (synth must stretch) */
  hasUltralong: boolean;
  emphatic: Emphatic;
  lengths: Lengths;
}

// Plain (non-emphatic) consonant map: eBL-IPA symbol -> espeak mnemonic.
const CONSONANTS: Record<string, string> = {
  b: 'b',
  p: 'p',
  d: 'd',
  t: 't',
  g: 'g',
  k: 'k',
  q: 'q', // uvular (Akkadian q, if a caller passes it)
  m: 'm',
  n: 'n',
  l: 'l',
  r: 'r',
  w: 'w',
  j: 'j', // eBL y -> j (palatal glide)
  s: 's',
  z: 'z',
  'ʃ': 'S', // ʃ  (eBL š)
  'ʔ': '?', // ʔ  (eBL ʾ / ')
  x: 'x', // eBL ḫ / h
  h: 'x', // fallback: some eBL rows map h -> x
  'χ': 'X', // χ (if a caller passes it) -> espeak uvular X
};

const VOWELS = new Set(['a', 'e', 'i', 'u', 'o']);

// ---- Piper (neural) target inventory ----------------------------------------
// The shipped neural voice is `en_US-kristin-medium` (public-domain lineage —
// chosen for redistributability, see README §Licensing). Its phoneme_id_map is
// Piper's 157-symbol default IPA map, so every token below is a VALID id — but a
// valid id is not the same as a TRAINED one. An English voice has only ever heard
// espeak-`en-us` output, so tokens outside that inventory (χ, q, ʕ …) are
// out-of-distribution and render as noise-shaped guesses.
//
// The rule this table follows: stay IN-DISTRIBUTION on the neural path, and take
// the phonetic loss explicitly (each substitution carries a `note` that surfaces
// through explain()). Callers who need full phonetic fidelity use mode:'reference'
// (espeak-ng), which has real phoneme features for all of it. Every substitution
// here is documented in the README's "Neural substitution table".
const PHARYNG_MARK = 'ˤ'; // ˤ U+02E4 — in the id map; NOT trained on an English voice

interface PiperMapping {
  tokens: string[];
  /** set when the neural token is an approximation of the true Akkadian phone */
  note?: string;
}

const PIPER_CONSONANTS: Record<string, PiperMapping> = {
  b: { tokens: ['b'] },
  p: { tokens: ['p'] },
  d: { tokens: ['d'] },
  t: { tokens: ['t'] },
  g: { tokens: ['ɡ'] },
  k: { tokens: ['k'] },
  // Akkadian q is uvular /q/ and contrasts with k. English has no uvular stop, so
  // the neural voice was never trained on `q`; it is folded to k here and the
  // k/q contrast is lost. mode:'reference' keeps it.
  q: { tokens: ['k'], note: 'uvular q → k (English voice has no uvular stop)' },
  m: { tokens: ['m'] },
  n: { tokens: ['n'] },
  l: { tokens: ['l'] },
  r: { tokens: ['r'] },
  w: { tokens: ['w'] },
  j: { tokens: ['j'] }, // eBL y
  s: { tokens: ['s'] },
  z: { tokens: ['z'] },
  'ʃ': { tokens: ['ʃ'] }, // eBL š — native English "sh"
  'ʔ': { tokens: ['ʔ'] }, // eBL ʾ / ' — English glottal stop, trained
  // eBL ḫ is a velar/uvular fricative [x]~[χ]. English has neither; both χ and x
  // are untrained tokens on this voice. /h/ is the nearest trained phone and is
  // non-contrastive in Akkadian (h merged into ḫ), so nothing distinctive is lost.
  x: { tokens: ['h'], note: 'ḫ [x] → h (English voice has no velar fricative)' },
  h: { tokens: ['h'] },
  'χ': { tokens: ['h'], note: 'χ → h (English voice has no uvular fricative)' },
};

const PIPER_VOWELS: Record<string, string> = {
  a: 'a',
  e: 'e',
  i: 'i',
  u: 'u',
  o: 'o',
};

/**
 * Emphatic → Piper tokens.
 *
 * MEASURED, and stated plainly: `ˤ` is a valid id in this voice's map but the
 * English training data never contained it, so the neural render is perturbed
 * rather than genuinely pharyngealized (a known-untrained control token produced
 * a comparable perturbation — see README §Acceptance criterion 1). Ejective is
 * not even representable: `ʼ` U+02BC is absent from Piper's id map entirely.
 * Phonetically-guaranteed emphatics come from mode:'reference'; synthesize()
 * routes to it automatically by default (see `emphatics` option).
 */
function emphaticPiper(base: 't' | 's' | 'affricate-s'): PiperMapping {
  const stop = base === 't' ? 't' : 's';
  return {
    tokens: [stop, PHARYNG_MARK],
    note: 'emphatic ˤ is untrained on an English-lineage voice — see README criterion 1',
  };
}

/** Emphatic realization -> espeak mnemonic, keyed by the base sound. */
function emphaticEspeak(base: 't' | 's' | 'affricate-s', mode: Emphatic): string {
  if (mode === 'ejective') {
    // Ethiosemitic-style ejectives on the Amharic (am) voice — the glottalic
    // reconstruction the card literally calls "glottalised", and the reading
    // Geers' Law supports (pron-akkadian-sumerian.md §1.2).
    if (base === 't') return 't`'; // ejective ṭ  (espeak am: t` -> tʼ)
    // No native ejective /sʼ/ in this espeak build; s? = alveolar sibilant + glottal
    // constriction is the closest audible glottalized sibilant. Documented approx.
    return 's?';
  }
  // pharyngealized (default) — espeak's own dental-emphatic mnemonics on the
  // Arabic (ar) voice: t[ -> t̪ , s[ -> s̪ . eBL's `pharyngealized` switch (tˤ/sˤ).
  if (base === 't') return 't[';
  if (base === 'affricate-s') return 'ts['; // ṣ affricate emphatic -> ts̪
  return 's['; // ṣ -> s̪
}

/**
 * Normalize an eBL-IPA string into ordered phoneme units for the reference engine.
 */
export function normalize(ipa: string, opts: NormalizeOptions = {}): NormalizeResult {
  const emphatic: Emphatic = opts.emphatic ?? 'pharyngealized';
  const lengths: Lengths = opts.lengths ?? '3tier';
  const chars = Array.from(ipa); // iterate by code point
  const units: PhonemeUnit[] = [];
  let i = 0;
  let hasUltralong = false;

  const isMark = (c: string) =>
    c === U.LENGTH || c === U.PHARYNG || c === U.TILDE_OVERLAY;

  while (i < chars.length) {
    const c = chars[i];

    // --- stress + boundary markers (passthrough) ---
    if (c === U.STRESS_PRIMARY || c === U.STRESS_SECOND) {
      // Piper honors espeak's own stress marks ˈ (primary) / ˌ (secondary).
      units.push({ kind: 'stress', ipa: c, espeak: "'", piper: [c] });
      i++;
      continue;
    }
    if (c === '.') {
      // Syllable boundary: informational for espeak string; dropped for Piper
      // tokens (prosody comes from the stress mark).
      units.push({ kind: 'syllable', ipa: c, espeak: '', piper: [] });
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      units.push({ kind: 'space', ipa: c, espeak: ' ', piper: [' '] });
      i++;
      continue;
    }
    // brackets eBL wraps whole words in ([a.ˈbaː.lu]) — ignore
    if (c === '[' || c === ']' || c === '/') {
      i++;
      continue;
    }

    // --- emphatic single-codepoint placeholders ᵵ / ᵴ ---
    if (c === U.EMPHATIC_T || c === U.EMPHATIC_S) {
      const start = i;
      i++;
      // consume any trailing marks (e.g. a stray ˤ) so they don't leak
      while (i < chars.length && isMark(chars[i])) i++;
      const base = c === U.EMPHATIC_T ? 't' : 's';
      const pm = emphaticPiper(base);
      units.push({
        kind: 'consonant',
        ipa: chars.slice(start, i).join(''),
        espeak: emphaticEspeak(base, emphatic),
        piper: pm.tokens,
        piperNote: pm.note,
        emphatic,
      });
      continue;
    }

    // --- a base sound (consonant or vowel), possibly tied into an affricate,
    //     possibly followed by length / pharyngeal / tilde-overlay marks ---
    const start = i;
    let base = c;
    i++;

    // affricate: base + TIE + base2  (e.g. t͡s, d͡z, t̴͡s̴)
    let affricate: string | null = null;
    // a tilde-overlay may sit between the first base and the tie (t̴͡s̴)
    let sawTilde = false;
    while (i < chars.length && chars[i] === U.TILDE_OVERLAY) {
      sawTilde = true;
      i++;
    }
    if (i < chars.length && chars[i] === U.TIE) {
      i++; // consume tie
      if (i < chars.length) {
        affricate = chars[i];
        i++;
      }
    }

    // trailing modifier marks
    let lengthMarks = 0;
    let pharyng = false;
    while (i < chars.length && isMark(chars[i])) {
      if (chars[i] === U.LENGTH) lengthMarks++;
      else if (chars[i] === U.PHARYNG) pharyng = true;
      else if (chars[i] === U.TILDE_OVERLAY) {
        sawTilde = true;
      }
      i++;
    }

    const ipaSlice = chars.slice(start, i).join('');

    // ----- VOWEL -----
    if (VOWELS.has(base) && !affricate) {
      const len = Math.min(lengthMarks, 2) as 0 | 1 | 2;
      const ultralong = len === 2 && lengths === '3tier';
      if (ultralong) hasUltralong = true;
      // espeak gets at most a single ː (a second one saturates — see README);
      // the true third length is applied by the duration stretch downstream.
      const espeakVowel = base + (len >= 1 ? ':' : '');
      // Piper: base vowel + single ː for long/ultralong (espeak-ar has no ːː
      // token; ultralong is realized by the downstream duration stretch, or by
      // a ːː token if the fine-tune was trained with one).
      const pv = PIPER_VOWELS[base] ?? base;
      const piper = len >= 1 ? [pv, U.LENGTH] : [pv];
      units.push({
        kind: 'vowel',
        ipa: ipaSlice,
        espeak: espeakVowel,
        piper,
        length: len,
        ultralong,
      });
      continue;
    }

    // ----- AFFRICATE (t͡s, d͡z, t̴͡s̴, t͡sˤ) -----
    if (affricate) {
      const isEmphatic = pharyng || sawTilde;
      if (base === 't' && affricate === 's') {
        // s->t͡s  (plain affricate) OR ṣ->t̴͡s̴ / t͡sˤ (emphatic affricate)
        const pm = isEmphatic ? emphaticPiper('affricate-s') : { tokens: ['t', 's'] as string[] };
        units.push({
          kind: 'consonant',
          ipa: ipaSlice,
          espeak: isEmphatic ? emphaticEspeak('affricate-s', emphatic) : 'ts',
          // English voice has no /t͡s/ affricate token: rendered as t + s in sequence.
          piper: pm.tokens,
          piperNote: (pm as { note?: string }).note,
          emphatic: isEmphatic ? emphatic : null,
        });
        continue;
      }
      if (base === 'd' && affricate === 'z') {
        units.push({
          kind: 'consonant',
          ipa: ipaSlice,
          espeak: 'dz',
          piper: ['d', 'z'],
          emphatic: null,
        });
        continue;
      }
      // unknown affricate: emit the two bases back to back
      const a = CONSONANTS[base] ?? base;
      const b = CONSONANTS[affricate] ?? affricate;
      const pa = PIPER_CONSONANTS[base];
      const pb = PIPER_CONSONANTS[affricate];
      units.push({
        kind: 'consonant',
        ipa: ipaSlice,
        espeak: a + b,
        piper: [...(pa?.tokens ?? [base]), ...(pb?.tokens ?? [affricate])],
        piperNote: pa?.note ?? pb?.note,
        emphatic: null,
      });
      continue;
    }

    // ----- CONSONANT -----
    const isEmphatic = pharyng || sawTilde;
    if (isEmphatic && (base === 't' || base === 's')) {
      const pm = emphaticPiper(base as 't' | 's');
      units.push({
        kind: 'consonant',
        ipa: ipaSlice,
        espeak: emphaticEspeak(base as 't' | 's', emphatic),
        piper: pm.tokens,
        piperNote: pm.note,
        emphatic,
      });
      continue;
    }
    const mapped = CONSONANTS[base];
    const pmap = PIPER_CONSONANTS[base];
    if (mapped !== undefined) {
      units.push({
        kind: 'consonant',
        ipa: ipaSlice,
        espeak: mapped,
        piper: pmap?.tokens ?? [base],
        piperNote: pmap?.note,
        emphatic: null,
      });
      continue;
    }
    // Unknown symbol: pass it through verbatim so nothing is silently dropped.
    units.push({
      kind: 'consonant',
      ipa: ipaSlice,
      espeak: base,
      piper: pmap?.tokens ?? [base],
      piperNote: pmap?.note,
      emphatic: null,
    });
  }

  const voice: 'ar' | 'am' = emphatic === 'ejective' ? 'am' : 'ar';
  return { units, voice, hasUltralong, emphatic, lengths };
}

/**
 * Build a flat espeak `[[...]]`-ready phoneme string from normalized units.
 * espeak wants the primary-stress mark `'` immediately before the stressed
 * syllable's onset, so we keep stress/syllable ordering as emitted by eBL.
 */
export function toEspeakString(units: PhonemeUnit[]): string {
  let out = '';
  for (const u of units) {
    if (u.kind === 'syllable') continue; // boundary is informational only
    out += u.espeak;
  }
  return out.trim();
}

/**
 * Flatten normalized units into the ordered Piper (neural) phoneme-token list.
 * Each token is one entry to feed piper's `phonemes_to_ids()` for the fine-tuned
 * Arabic voice. Leading/trailing spaces are trimmed. Syllable boundaries are
 * dropped (their `piper` is []).
 *
 * NOTE: these tokens target espeak-`ar` output (t̪/s̪, χ, aː …). Before shipping,
 * validate every token is a key in the trained voice's `phoneme_id_map`; any
 * OOV token (e.g. e/o/ɡ if the Arabic voice lacks them) should be remapped to
 * the nearest in-inventory phone at synth time. See scripts/ebl-to-piper.mjs.
 */
export function toPiperPhonemes(units: PhonemeUnit[]): string[] {
  const out: string[] = [];
  for (const u of units) {
    for (const t of u.piper ?? []) out.push(t);
  }
  // trim leading/trailing spaces
  while (out.length && out[0] === ' ') out.shift();
  while (out.length && out[out.length - 1] === ' ') out.pop();
  return out;
}

export interface PiperNormalizeResult {
  /** ordered phoneme tokens for piper's phonemes_to_ids() */
  tokens: string[];
  /** the espeak base the shipped neural voice was trained on (`en` for en_US-kristin) */
  espeakVoice: 'en';
  /** true if any vowel is ultralong (synth must stretch — no stock voice has a ːː) */
  hasUltralong: boolean;
  /**
   * 0-based indices, among the word's VOWELS in order, of the ultralong ones.
   * The synthesizer uses these to pick which acoustic vowel nucleus to lengthen.
   */
  ultralongVowelIndices: number[];
  /** total vowel count, so the caller can sanity-check nucleus detection */
  vowelCount: number;
  /** every neural approximation made for this word (empty = fully in-inventory) */
  notes: string[];
  /** the full normalized unit list, for the duration stretch and for auditing */
  units: PhonemeUnit[];
}

/**
 * Convenience: eBL IPA string -> Piper phoneme tokens for the shipped neural
 * voice. This is the wiring point between eBL's IPA and the audio engine.
 */
export function normalizeForPiper(
  ipa: string,
  opts: NormalizeOptions = {},
): PiperNormalizeResult {
  const norm = normalize(ipa, opts);
  const ultralongVowelIndices: number[] = [];
  let vowelCount = 0;
  for (const u of norm.units) {
    if (u.kind !== 'vowel') continue;
    if (u.ultralong) ultralongVowelIndices.push(vowelCount);
    vowelCount++;
  }
  const notes = [...new Set(norm.units.map((u) => u.piperNote).filter(Boolean) as string[])];
  return {
    tokens: toPiperPhonemes(norm.units),
    espeakVoice: 'en',
    hasUltralong: norm.hasUltralong,
    ultralongVowelIndices,
    vowelCount,
    notes,
    units: norm.units,
  };
}
