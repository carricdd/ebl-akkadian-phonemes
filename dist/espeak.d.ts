import { type Pcm } from './dsp.js';
export type Voice = 'ar' | 'am' | string;
export interface EspeakRenderOpts {
    /** espeak voice/language (e.g. 'ar' Arabic, 'am' Amharic). */
    voice?: Voice;
    /** words-per-minute (espeak -s). Lower = slower/clearer. Default 150. */
    wpm?: number;
}
/**
 * Render an espeak phoneme-mnemonic string to PCM.
 * `phonemes` is the inside of the [[...]] brackets, e.g. "a'ba:lu".
 */
export declare function renderPhonemes(phonemes: string, opts?: EspeakRenderOpts): Promise<Pcm>;
/** Render plain orthographic/IPA-free text (used for quick sanity checks, not the API path). */
export declare function renderText(text: string, opts?: EspeakRenderOpts): Promise<Pcm>;
/** Debug helper: return espeak's phoneme mnemonics (-x) or IPA (--ipa) for text. */
export declare function phonemize(text: string, mode?: 'espeak' | 'ipa', voice?: Voice): Promise<string>;
//# sourceMappingURL=espeak.d.ts.map