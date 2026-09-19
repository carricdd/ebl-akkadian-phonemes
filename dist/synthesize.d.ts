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
import { type Emphatic, type Lengths } from './normalizer.js';
import { type OmniVoiceOptions } from './omnivoice.js';
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
export type Engine = 'piper' | 'omnivoice';
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
/**
 * Synthesize eBL IPA to WAV bytes.
 *
 * @param ipa e.g. "[a.ˈbaː.lu]" (brackets optional), the exact string eBL's
 *            dictionary already renders next to each word.
 */
export declare function synthesize(ipa: string, opts?: SynthesizeOptions): Promise<Buffer>;
/**
 * Same as synthesize(), but returns the audio together with an account of how it
 * was produced: which engine ran, why, how the extra-long vowel was realized, and
 * every phonetic approximation made. Use this when you need to show your work.
 */
export declare function synthesizeDetailed(ipa: string, opts?: SynthesizeOptions): Promise<SynthesisResult>;
/**
 * Debug: return the normalized phoneme streams and metadata for an IPA input
 * without synthesizing audio. Shows BOTH engines' targets plus every neural
 * approximation, so a philologist can audit exactly how each symbol was
 * interpreted rather than trusting a black box.
 */
export declare function explain(ipa: string, opts?: SynthesizeOptions): {
    ipa: string;
    mode: Mode;
    voice: "ar" | "am";
    emphatic: Emphatic;
    lengths: Lengths;
    hasUltralong: boolean;
    espeak: string;
    neural: {
        voice: string;
        tokens: string[];
        ultralongVowelIndices: number[];
        vowelCount: number;
        approximations: string[];
        /** 0.3.2: the token stream an Arabic-trained voice (ar_JO-kareem-medium) receives */
        arabicTokens: string[];
        emphaticVoiceInstalled: string | null;
    };
    units: {
        note?: string | undefined;
        ipa: string;
        espeak: string;
        neural: string[] | undefined;
        kind: import("./normalizer.js").UnitKind;
    }[];
};
//# sourceMappingURL=synthesize.d.ts.map