/**
 * SHA-256 of the upstream files, verified against huggingface.co on 2026-07-19.
 * A mismatch means the file changed upstream or the download was corrupted.
 */
export declare const VOICE_SHA256: Record<string, string>;
export declare function defaultVoiceDir(): string;
/** Download the default neural voice into `dir`. Returns the directory used. */
export declare function fetchVoice(dir?: string, log?: (s: string) => void): Promise<string>;
//# sourceMappingURL=fetch-voice.d.ts.map