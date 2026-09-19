import type { Pcm } from './dsp.js';
/** The voice this package ships against. Public-domain lineage — see README §Licensing. */
export declare const DEFAULT_VOICE = "en_US-kristin-medium";
/**
 * The Arabic-trained voice used for emphatic-bearing words (0.3.2). Trained on
 * espeak-ng `ar` output, so s̪ t̪ q χ ʔ ħ ʕ and phonemic ː are in-distribution.
 * Same rhasspy/piper-voices lineage and license terms as the default voice.
 */
export declare const EMPHATIC_VOICE = "ar_JO-kareem-medium";
export type VoiceProfile = 'english' | 'arabic';
export interface KnownVoice {
    name: string;
    /** path under https://huggingface.co/rhasspy/piper-voices/resolve/main/ */
    hfDir: string;
    profile: VoiceProfile;
    sha256: {
        onnx: string;
        json: string;
    };
}
/** Voices this package knows how to fetch and verify. */
export declare const KNOWN_VOICES: Record<string, KnownVoice>;
/** Profile of a loaded voice, from the espeak base it was trained on. */
export declare function voiceProfile(config: PiperVoiceConfig): VoiceProfile;
export interface PiperVoiceConfig {
    audio: {
        sample_rate: number;
        quality?: string;
    };
    inference: {
        noise_scale: number;
        length_scale: number;
        noise_w: number;
    };
    phoneme_id_map: Record<string, number[]>;
    num_speakers?: number;
    espeak?: {
        voice: string;
    };
    dataset?: string;
}
export interface LoadedVoice {
    path: string;
    config: PiperVoiceConfig;
    session: any;
}
export interface PiperRenderOptions {
    /** Absolute path to a Piper `.onnx` voice (its `.onnx.json` must sit beside it). */
    voicePath?: string;
    /** VITS length_scale — higher is slower. Default from the voice config (1.0). */
    lengthScale?: number;
    /** VITS noise_scale. Default from the voice config (0.667). */
    noiseScale?: number;
    /** VITS noise_w (duration-predictor noise). Default from the voice config (0.8). */
    noiseW?: number;
    /** Multi-speaker voices only. Default 0. */
    speakerId?: number;
}
/** Candidate locations for a voice (default: the shipped English voice), in priority order. */
export declare function voiceSearchPaths(name?: string): string[];
/** Path of the Arabic emphatic voice if it is installed, else null (no throw). */
export declare function emphaticVoicePath(): string | null;
export declare class VoiceNotFoundError extends Error {
    constructor(searched: string[]);
}
/** Resolve the voice file path, or throw a VoiceNotFoundError listing what was tried. */
export declare function resolveVoicePath(explicit?: string): string;
/** Load (and memoize) a Piper voice. The ONNX session is reused across calls. */
export declare function loadVoice(explicitPath?: string): Promise<LoadedVoice>;
export interface PhonemeIdResult {
    ids: number[];
    /** phonemes that are not in this voice's inventory (dropped, never guessed at) */
    missing: string[];
}
/** Piper's phoneme→id encoding: BOS, then each id followed by PAD, then EOS. */
export declare function phonemesToIds(phonemes: string[], map: Record<string, number[]>): PhonemeIdResult;
/**
 * Render a phoneme-token stream on a Piper voice.
 * `tokens` are single IPA symbols as they appear in the voice's `phoneme_id_map`
 * (see normalizer.toPiperPhonemes).
 */
export declare function renderPiperTokens(tokens: string[], opts?: PiperRenderOptions): Promise<{
    pcm: Pcm;
    missing: string[];
}>;
/** True when a usable voice file is present (used by tests/CLI to skip gracefully). */
export declare function voiceAvailable(explicitPath?: string): boolean;
//# sourceMappingURL=piper.d.ts.map