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
/**
 * Normalize an eBL-IPA string into ordered phoneme units for the reference engine.
 */
export declare function normalize(ipa: string, opts?: NormalizeOptions): NormalizeResult;
/**
 * Build a flat espeak `[[...]]`-ready phoneme string from normalized units.
 * espeak wants the primary-stress mark `'` immediately before the stressed
 * syllable's onset, so we keep stress/syllable ordering as emitted by eBL.
 */
export declare function toEspeakString(units: PhonemeUnit[]): string;
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
/**
 * Which phoneme inventory the loaded Piper voice was TRAINED on.
 *   'english' — en_US-kristin-medium (espeak `en-us`): no emphatics, no q, no χ.
 *   'arabic'  — ar_JO-kareem-medium (espeak `ar`): emphatics, q, χ, ʔ, ħ, ʕ and
 *               phonemic vowel length are all in-distribution.
 * 0.3.2 (Enrique Jiménez review, 2026-09-17: "the emphatics are not yet
 * distinguishable from non-emphatics"). Measured with Praat on ˈsaː.bu vs ˈsˤaː.bu:
 * espeak `s[` moves the following vowel's F2 by 1 Hz (1405→1404); the English voice
 * with ˤ moves it UP (1336→1588, wrong direction); the Arabic voice with the tokens
 * espeak-ar actually emits for ص (s + U+032A, then the backed vowel allophone
 * `a.`) moves it DOWN 177 Hz (1359→1182) and drops the sibilant centre of gravity.
 */
export type VoiceProfile = 'english' | 'arabic';
/** Piper token stream for a voice profile. 'english' keeps the 0.3.1 mapping. */
export declare function toPiperPhonemesFor(units: PhonemeUnit[], profile: VoiceProfile): string[];
export declare function toPiperPhonemes(units: PhonemeUnit[]): string[];
export interface PiperNormalizeResult {
    /** ordered phoneme tokens for piper's phonemes_to_ids() */
    tokens: string[];
    /** the espeak base the neural voice was trained on (`en` for en_US-kristin, `ar` for ar_JO-kareem) */
    espeakVoice: 'en' | 'ar';
    /** which inventory the tokens were derived for */
    profile: VoiceProfile;
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
export declare function normalizeForPiper(ipa: string, opts?: NormalizeOptions & {
    profile?: VoiceProfile;
}): PiperNormalizeResult;
//# sourceMappingURL=normalizer.d.ts.map