import { type Pcm } from './dsp.js';
import type { PhonemeUnit } from './normalizer.js';
/**
 * The voice-clone reference this engine ships against, and its provenance.
 * The timbre is cloned from en_US-kristin-medium (Piper) OUTPUT — public-domain
 * LibriVox lineage, the same redistributable voice the Piper path uses. No paid
 * TTS (ElevenLabs etc.) audio is used as a clone reference, so nothing here is
 * encumbered by a "do not clone our output" clause. See README §Licensing.
 */
export declare const OMNIVOICE_REF_VOICE = "en_US-kristin-medium (Piper, public-domain lineage)";
export interface OmniVoiceOptions {
    /** python interpreter with `omnivoice` importable */
    python?: string;
    /** path to omnivoice_render.py */
    helper?: string;
    /** voice-clone reference WAV (clean provenance) */
    refAudio?: string;
    /** transcript of the reference audio */
    refText?: string;
    /** mps | cpu | cuda */
    device?: string;
    /** flow-matching steps (default 32) */
    numStep?: number;
    /** classifier-free guidance (default 2.0) */
    guidanceScale?: number;
    /** lower = more stable isolated words; 1.0 stops self-repetition (default 1.0) */
    positionTemperature?: number;
    /** generation attempts; best clean burst wins (default 3) */
    attempts?: number;
}
export interface ArpabetResult {
    /** space-separated ARPABET phones with stress digits on vowels */
    text: string;
    /** ARPABET tokens */
    tokens: string[];
    /** lossy-mapping notes, deduped */
    notes: string[];
}
/**
 * Build an ARPABET string from the normalizer's units. Stress (a preceding
 * `stress` unit) is attached as the digit on the next vowel; every other vowel
 * gets `0`. Emphatic units (which normally never arrive here, because
 * emphatics:'auto' routes them to espeak) degrade to their plain stop plus a note,
 * so `emphatics:'neural'` still produces sound rather than throwing.
 */
export declare function toArpabet(units: PhonemeUnit[]): ArpabetResult;
export declare class OmniVoiceError extends Error {
    constructor(message: string);
}
/** True when the local OmniVoice python + helper + reference clip are present. */
export declare function omnivoiceAvailable(opts?: OmniVoiceOptions): boolean;
/**
 * Render one word's normalized units on OmniVoice, returning raw neural PCM (the
 * caller applies trim + WSOLA length exactly as for Piper).
 */
export declare function renderOmniVoiceUnits(units: PhonemeUnit[], opts?: OmniVoiceOptions): Promise<{
    pcm: Pcm;
    arpabet: string;
    notes: string[];
}>;
//# sourceMappingURL=omnivoice.d.ts.map