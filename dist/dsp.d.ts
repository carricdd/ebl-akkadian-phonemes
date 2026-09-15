/**
 * dsp.ts — pure-JS audio helpers (no native deps).
 *
 * - parseWav / encodeWav : minimal RIFF/PCM16 read & write
 * - trimSilence          : strip leading/trailing near-silence
 * - wsolaStretch         : WSOLA time-stretch (pitch-preserving), used to turn a
 *                          long vowel into a genuine third ("extra-long") length
 *                          — the revival doc §5.3 "v1 duration post-processing".
 * - concatCrossfade      : equal-power crossfade concatenation of PCM segments
 *
 * All original (MIT). Operates on mono 16-bit PCM (what espeak-ng emits).
 */
export interface Pcm {
    sampleRate: number;
    samples: Int16Array;
}
/** Parse a canonical RIFF/WAVE PCM buffer (mono/stereo, 8/16-bit). Returns mono. */
export declare function parseWav(buf: Uint8Array): Pcm;
/** Encode mono PCM16 to a canonical 44-byte-header WAV buffer. */
export declare function encodeWav(pcm: Pcm): Buffer;
export declare function durationSeconds(pcm: Pcm): number;
/** Strip leading/trailing samples quieter than `thresh` (fraction of full-scale). */
export declare function trimSilence(pcm: Pcm, thresh?: number, padMs?: number): Pcm;
/**
 * WSOLA time-stretch. factor > 1 lengthens, < 1 shortens; pitch is preserved.
 * Robust for quasi-stationary signals (sustained vowels), which is exactly the
 * extra-long-vowel use case.
 */
export declare function wsolaStretch(pcm: Pcm, factor: number): Pcm;
/**
 * Locate vowel nuclei (syllable peaks) in an isolated word.
 *
 * Used by the NEURAL path: a Piper/VITS voice renders a whole word in one
 * inference (that single pass is what makes it sound human), so to lengthen just
 * ONE vowel we have to find that vowel in the rendered audio afterwards rather
 * than splicing separate renders together.
 *
 * Method (classic, no deps): frame-wise RMS + zero-crossing rate. A vowel is
 * loud and low-ZCR; fricatives/stops are quiet or high-ZCR. Frames passing both
 * gates are grouped into runs, short runs are dropped, and each surviving run is
 * returned as a [start, end) sample span in left-to-right order.
 *
 * Returns [] when nothing convincing is found — callers must handle that.
 */
export declare function findVowelNuclei(pcm: Pcm, opts?: {
    frameMs?: number;
    minMs?: number;
    energyRatio?: number;
    maxZcr?: number;
    dipDb?: number;
    core?: number;
}): Array<{
    start: number;
    end: number;
}>;
/**
 * Time-stretch ONE span of a signal by `factor`, leaving the rest untouched, and
 * splice it back with short equal-power crossfades so the joins are inaudible.
 * This is how the neural path realizes eBL's extra-long vowel: the surrounding
 * consonants keep their natural neural duration; only the flagged vowel grows.
 */
export declare function stretchSpan(pcm: Pcm, start: number, end: number, factor: number, fadeMs?: number): Pcm;
/** Equal-power crossfade concatenation of PCM segments (all same sample rate). */
export declare function concatCrossfade(parts: Pcm[], fadeMs?: number): Pcm;
//# sourceMappingURL=dsp.d.ts.map