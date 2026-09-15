/**
 * espeak.ts — thin wrapper over the espeak-ng WASM CLI.
 *
 * The npm `espeak-ng` package is the maintained successor of the exact engine
 * (eSpeak) the original eBL "Phoneme Synthesis" prototype used — compiled to
 * WASM. It exposes espeak's command line: we invoke it once per render with
 * `-v <voice> -w out.wav [[<phonemes>]]`, then read the WAV back out of the
 * in-memory Emscripten filesystem.
 *
 * IMPORTANT invocation detail (discovered empirically, documented in the README):
 * espeak's `[[...]]` phoneme brackets take espeak/Kirshenbaum phoneme MNEMONICS,
 * NOT raw IPA. Feeding raw Unicode IPA silently drops diacritics (length, stress,
 * pharyngealization). The normalizer therefore maps eBL IPA -> espeak mnemonics.
 */
import ESpeakNG from 'espeak-ng';
import { parseWav, type Pcm } from './dsp.js';

export type Voice = 'ar' | 'am' | string;

export interface EspeakRenderOpts {
  /** espeak voice/language (e.g. 'ar' Arabic, 'am' Amharic). */
  voice?: Voice;
  /** words-per-minute (espeak -s). Lower = slower/clearer. Default 150. */
  wpm?: number;
  /** pass phonemes verbatim (already wrapped intent). We add the [[ ]] brackets. */
}

/**
 * Render an espeak phoneme-mnemonic string to PCM.
 * `phonemes` is the inside of the [[...]] brackets, e.g. "a'ba:lu".
 */
export async function renderPhonemes(
  phonemes: string,
  opts: EspeakRenderOpts = {},
): Promise<Pcm> {
  const voice = opts.voice ?? 'ar';
  const wpm = opts.wpm ?? 150;
  const bracketed = `[[${phonemes}]]`;
  let stderr = '';
  const mod = await ESpeakNG({
    arguments: ['-v', voice, '-s', String(wpm), '-w', 'out.wav', bracketed],
    print: () => {},
    printErr: (t) => {
      stderr += t + '\n';
    },
  });
  let raw: Uint8Array;
  try {
    const r = mod.FS.readFile('out.wav');
    raw = typeof r === 'string' ? new TextEncoder().encode(r) : r;
  } catch {
    throw new Error(
      `espeak-ng produced no audio for [[${phonemes}]] (voice=${voice}). ${stderr.trim()}`,
    );
  }
  return parseWav(raw);
}

/** Render plain orthographic/IPA-free text (used for quick sanity checks, not the API path). */
export async function renderText(text: string, opts: EspeakRenderOpts = {}): Promise<Pcm> {
  const voice = opts.voice ?? 'ar';
  const wpm = opts.wpm ?? 150;
  const mod = await ESpeakNG({
    arguments: ['-v', voice, '-s', String(wpm), '-w', 'out.wav', text],
    print: () => {},
    printErr: () => {},
  });
  const r = mod.FS.readFile('out.wav');
  const raw = typeof r === 'string' ? new TextEncoder().encode(r) : r;
  return parseWav(raw);
}

/** Debug helper: return espeak's phoneme mnemonics (-x) or IPA (--ipa) for text. */
export async function phonemize(
  text: string,
  mode: 'espeak' | 'ipa' = 'ipa',
  voice: Voice = 'ar',
): Promise<string> {
  let out = '';
  await ESpeakNG({
    arguments: ['-v', voice, '-q', mode === 'ipa' ? '--ipa' : '-x', text],
    print: (t) => {
      out += t + '\n';
    },
    printErr: () => {},
  });
  return out.trim();
}
