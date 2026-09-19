/**
 * SHA-256 of the upstream files, verified against huggingface.co on 2026-07-19.
 * A mismatch means the file changed upstream or the download was corrupted.
 */
export declare const VOICE_SHA256: Record<string, string>;
export declare function defaultVoiceDir(): string;
/**
 * Download a neural voice into `dir`. Returns the directory used.
 * `name` defaults to the shipped English voice; pass EMPHATIC_VOICE
 * (`ar_JO-kareem-medium`) for the Arabic-trained voice that renders ṭ/ṣ/q.
 */
export declare function fetchVoice(dir?: string, log?: (s: string) => void, name?: string): Promise<string>;
//# sourceMappingURL=fetch-voice.d.ts.map