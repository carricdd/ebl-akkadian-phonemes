/**
 * @ebl/akkadian-phonemes — turn electronic Babylonian Library (eBL) IPA into
 * synthesized Akkadian pronunciation.
 *
 * Public entry point. See README for the acceptance criteria this satisfies.
 */
export { synthesize, synthesizeDetailed, explain } from './synthesize.js';
export type { SynthesizeOptions, SynthesisResult, Mode, Engine, Dialect, EmphaticPolicy, } from './synthesize.js';
export { toArpabet, renderOmniVoiceUnits, omnivoiceAvailable, OmniVoiceError, OMNIVOICE_REF_VOICE, } from './omnivoice.js';
export type { OmniVoiceOptions, ArpabetResult } from './omnivoice.js';
export { DEFAULT_VOICE, EMPHATIC_VOICE, KNOWN_VOICES, voiceProfile, emphaticVoicePath, loadVoice, resolveVoicePath, voiceAvailable, voiceSearchPaths, phonemesToIds, renderPiperTokens, VoiceNotFoundError, } from './piper.js';
export type { PiperVoiceConfig, PiperRenderOptions, LoadedVoice, KnownVoice, VoiceProfile } from './piper.js';
export { normalize, toEspeakString, toPiperPhonemes, toPiperPhonemesFor, normalizeForPiper, } from './normalizer.js';
export type { Emphatic, Lengths, PhonemeUnit, NormalizeResult, NormalizeOptions, PiperNormalizeResult, } from './normalizer.js';
export { parseWav, encodeWav, durationSeconds, wsolaStretch, trimSilence, concatCrossfade, findVowelNuclei, stretchSpan, } from './dsp.js';
export type { Pcm } from './dsp.js';
//# sourceMappingURL=index.d.ts.map