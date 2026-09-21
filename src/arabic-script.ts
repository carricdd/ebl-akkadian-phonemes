/**
 * arabic-script.ts — eBL IPA → vowelled Arabic script, for multilingual neural voices.
 *
 * WHY (2026-09-21): the only renders that passed philological review (Enrique Jiménez, eBL:
 * "it sounds correct to me. I would go with the Arabic-style pharyngealized") were made by
 * giving a multilingual voice (ElevenLabs v3) an ARABIC-SCRIPT spelling of the Akkadian word.
 * Arabic is the conservative Semitic sibling: ص ط ق خ ء are native, so ṣ ṭ q ḫ ʾ come out as
 * real pharyngealized / uvular / glottal consonants instead of the s t k h an English-lineage
 * voice substitutes, and the shadda gives a genuine geminate. Vowel length (ā ī ū) is spelled
 * with the long-vowel letters; the extra-long tier (â) is NOT spellable and is realized
 * downstream by the WSOLA stretch, exactly as on every other engine.
 *
 * What Arabic cannot spell, reported in `notes` and reflected in `representable`:
 *   p  (no /p/; the caller falls back to IPA text for the word — do not write ب for p),
 *   e / ē / ê (no /e/ phoneme; likewise fall back),
 *   o / ō      (same),
 *   g  (ج is [dʒ] in MSA; گ U+06AF is used, which multilingual models read as [g] — approximation),
 *   affricate ṣ (t͡sˤ) → ص plus a note.
 * Word-final SHORT vowels are written as a bare vowel mark (ḥaraka). Arabic pausal pronunciation
 * may drop them; the reviewed set was rendered exactly this way and passed, so it stays.
 *
 * Reimplemented from scratch (MIT). Input = the PhonemeUnit list from normalize(), so every
 * emphatic notation eBL emits (ᵵ ᵴ tˤ sˤ, and transliteration ṭ ṣ) reaches here already resolved.
 */
import type { PhonemeUnit } from './normalizer.js';

const FATHA = 'َ', KASRA = 'ِ', DAMMA = 'ُ', SHADDA = 'ّ';
const ALIF = 'ا', ALIF_MADDA = 'آ', YA = 'ي', WAW = 'و';
const HAMZA_ALIF = 'أ', HAMZA_ALIF_BELOW = 'إ', HAMZA = 'ء';

/** consonant base (after emphatic resolution) → Arabic letter, or null when unrepresentable */
const CONSONANTS: Record<string, string | null> = {
  b: 'ب', p: null, d: 'د', t: 'ت', g: 'گ', k: 'ك', q: 'ق',
  m: 'م', n: 'ن', l: 'ل', r: 'ر', w: WAW, j: YA, s: 'س', z: 'ز',
  'ʃ': 'ش', 'ʔ': HAMZA, x: 'خ', 'χ': 'خ', h: 'ه',
};
const EMPHATIC: Record<string, string> = { t: 'ط', s: 'ص' }; // ṭ → ط, ṣ → ص

export interface ArabicScriptResult {
  /** the vowelled Arabic string, or '' when not representable */
  text: string;
  /** false when any segment could not be spelled (p, e, o, …); caller should fall back */
  representable: boolean;
  notes: string[];
  /** 0-based indices (among vowels) of extra-long vowels; the stretch stage lengthens these */
  ultralongVowelIndices: number[];
  vowelCount: number;
}

function consonantBase(u: PhonemeUnit): string {
  const raw = u.ipa.normalize('NFD').replace(/[̣ˤ̴͡]/g, '');
  return raw.replace(/[ᵵṭ]/g, 't').replace(/[ᵴṣ]/g, 's');
}

/** Spell one word's units. Space units split words; the caller joins with spaces. */
export function toArabicScript(units: PhonemeUnit[]): ArabicScriptResult {
  const notes: string[] = [];
  const ultralongVowelIndices: number[] = [];
  let vowelCount = 0;
  let representable = true;
  const words: string[] = [];
  let cur = ''; // current word
  let prevCons: string | null = null; // last consonant letter written (for shadda)
  let atWordStart = true;

  const flushWord = () => { if (cur) words.push(cur); cur = ''; prevCons = null; atWordStart = true; };

  for (const u of units) {
    if (u.kind === 'space') { flushWord(); continue; }
    if (u.kind === 'stress' || u.kind === 'syllable') continue;
    if (u.kind === 'consonant') {
      const base = consonantBase(u);
      let letter: string | null | undefined;
      if (u.emphatic) {
        if (base.includes('t') && base.includes('s')) { letter = EMPHATIC.s; notes.push('affricate ṣ (t͡sˤ) written as ص'); }
        else letter = EMPHATIC[base.startsWith('t') ? 't' : 's'];
      } else if (base.length > 1 && !CONSONANTS[base]) {
        // affricate t͡s / d͡z etc.: spell as the sequence
        letter = [...base].map((c) => CONSONANTS[c] ?? null).every(Boolean)
          ? [...base].map((c) => CONSONANTS[c] as string).join('')
          : null;
      } else letter = CONSONANTS[base];
      if (letter === null || letter === undefined) {
        representable = false;
        notes.push(`no Arabic letter for /${base}/`);
        letter = '';
      }
      if (base === 'g') notes.push('g written with گ (U+06AF); MSA ج would be [dʒ]');
      // gemination: same consonant twice in a row → one letter + shadda
      if (letter && prevCons === letter && cur.endsWith(letter)) {
        cur += SHADDA;
      } else {
        cur += letter;
      }
      prevCons = letter || null;
      atWordStart = false;
      continue;
    }
    // vowel
    const base = u.ipa[0];
    const len = u.length ?? 0;
    if (u.ultralong) ultralongVowelIndices.push(vowelCount);
    vowelCount++;
    if (base === 'e' || base === 'o') {
      representable = false;
      notes.push(`no Arabic vowel for /${base}/`);
      continue;
    }
    const haraka = base === 'a' ? FATHA : base === 'i' ? KASRA : DAMMA;
    const longLetter = base === 'a' ? ALIF : base === 'i' ? YA : WAW;
    if (atWordStart) {
      // word-initial vowel needs a hamza seat (Akkadian words written with an initial vowel
      // begin with a glottal onset in every reading convention)
      if (len >= 1 && base === 'a') cur += ALIF_MADDA;
      else cur += (base === 'i' ? HAMZA_ALIF_BELOW : HAMZA_ALIF) + haraka + (len >= 1 ? longLetter : '');
      atWordStart = false;
      prevCons = null;
      continue;
    }
    // a word-initial ʾ (glottal stop) takes its conventional seat: أَ إِ أُ, آ for ʾā
    if (cur === HAMZA) {
      cur = len >= 1 && base === 'a' ? ALIF_MADDA : (base === 'i' ? HAMZA_ALIF_BELOW : HAMZA_ALIF) + haraka + (len >= 1 ? longLetter : '');
      prevCons = null;
      continue;
    }
    cur += haraka + (len >= 1 ? longLetter : '');
    prevCons = null;
  }
  flushWord();
  if (ultralongVowelIndices.length) notes.push('extra-long vowel(s) spelled long; the third tier is applied by the duration stretch');
  // NFC puts the ḥaraka before the shadda (canonical combining order), so output is byte-stable
  return { text: representable ? words.join(' ').normalize('NFC') : '', representable, notes: [...new Set(notes)], ultralongVowelIndices, vowelCount };
}
