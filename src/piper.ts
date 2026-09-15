/**
 * piper.ts — the NEURAL engine: Piper (VITS) inference in pure Node via ONNX Runtime.
 *
 * Piper is a VITS text-to-speech model exported to ONNX. Its graph takes phoneme
 * IDs — not text — which is exactly the interface eBL needs: we hand it the IPA
 * the dictionary already renders, mapped to the voice's phoneme inventory, and it
 * returns 22.05 kHz audio. No Python, no piper binary, no network at runtime.
 *
 * Graph contract (verified against en_US-kristin-medium, piper_version 1.0.0):
 *   inputs : input          int64   [1, T]   phoneme ids
 *            input_lengths  int64   [1]      T
 *            scales         float32 [3]      [noise_scale, length_scale, noise_w]
 *            sid            int64   [1]      speaker id (multi-speaker voices only)
 *   outputs: output         float32 [1, 1, N] audio in [-1, 1]
 *
 * ID encoding (Piper's own `phonemes_to_ids`, reimplemented here — MIT, no GPL
 * code copied): begin with BOS `^`, emit each phoneme's id followed by the PAD id
 * `_`, end with EOS `$`. Phonemes absent from the voice's `phoneme_id_map` are
 * skipped and reported, never silently mangled.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pcm } from './dsp.js';

/** The voice this package ships against. Public-domain lineage — see README §Licensing. */
export const DEFAULT_VOICE = 'en_US-kristin-medium';

const BOS = '^';
const EOS = '$';
const PAD = '_';

export interface PiperVoiceConfig {
  audio: { sample_rate: number; quality?: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers?: number;
  espeak?: { voice: string };
  dataset?: string;
}

export interface LoadedVoice {
  path: string;
  config: PiperVoiceConfig;
  session: any; // ort.InferenceSession (typed loosely so ORT stays a lazy import)
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

/** Candidate locations for the voice, in priority order. */
export function voiceSearchPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const paths: string[] = [];
  if (process.env.EBL_PIPER_VOICE) paths.push(process.env.EBL_PIPER_VOICE);
  if (process.env.EBL_VOICE_DIR)
    paths.push(join(process.env.EBL_VOICE_DIR, `${DEFAULT_VOICE}.onnx`));
  paths.push(join(homedir(), '.cache', 'ebl-akkadian-phonemes', 'voices', `${DEFAULT_VOICE}.onnx`));
  paths.push(join(here, '..', 'voices', `${DEFAULT_VOICE}.onnx`)); // package-local
  paths.push(join(process.cwd(), 'voices', `${DEFAULT_VOICE}.onnx`));
  return paths;
}

export class VoiceNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `Piper voice "${DEFAULT_VOICE}" not found. The neural engine needs a ~61 MB ONNX ` +
        `voice file, which is NOT bundled in the npm tarball.\n\n` +
        `Fix (one time):\n` +
        `  npx ebl-tts --fetch-voice\n` +
        `or download manually into ~/.cache/ebl-akkadian-phonemes/voices/ :\n` +
        `  ${DEFAULT_VOICE}.onnx and ${DEFAULT_VOICE}.onnx.json\n` +
        `  from https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/kristin/medium\n\n` +
        `Or point at an existing copy:  export EBL_PIPER_VOICE=/path/to/voice.onnx\n` +
        `Or use the no-download engine:  synthesize(ipa, { mode: 'reference' })\n\n` +
        `Searched:\n${searched.map((p) => '  ' + p).join('\n')}`,
    );
    this.name = 'VoiceNotFoundError';
  }
}

/** Resolve the voice file path, or throw a VoiceNotFoundError listing what was tried. */
export function resolveVoicePath(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new VoiceNotFoundError([explicit]);
    return explicit;
  }
  const candidates = voiceSearchPaths();
  for (const p of candidates) if (existsSync(p)) return p;
  throw new VoiceNotFoundError(candidates);
}

const cache = new Map<string, Promise<LoadedVoice>>();

/** Load (and memoize) a Piper voice. The ONNX session is reused across calls. */
export function loadVoice(explicitPath?: string): Promise<LoadedVoice> {
  const path = resolveVoicePath(explicitPath);
  const hit = cache.get(path);
  if (hit) return hit;
  const p = (async (): Promise<LoadedVoice> => {
    const cfgPath = `${path}.json`;
    if (!existsSync(cfgPath))
      throw new Error(
        `Piper voice config not found: ${cfgPath}\n` +
          `Every .onnx voice needs its .onnx.json beside it (it holds the phoneme_id_map).`,
      );
    const config = JSON.parse(readFileSync(cfgPath, 'utf8')) as PiperVoiceConfig;
    let ort: any;
    try {
      ort = (await import('onnxruntime-node')).default;
    } catch (err) {
      throw new Error(
        `Neural mode needs the optional peer 'onnxruntime-node', which failed to load: ` +
          `${(err as Error).message}\n` +
          `Install it (npm i onnxruntime-node) or use mode:'reference'.`,
      );
    }
    const session = await ort.InferenceSession.create(path);
    return { path, config, session };
  })();
  cache.set(path, p);
  return p;
}

export interface PhonemeIdResult {
  ids: number[];
  /** phonemes that are not in this voice's inventory (dropped, never guessed at) */
  missing: string[];
}

/** Piper's phoneme→id encoding: BOS, then each id followed by PAD, then EOS. */
export function phonemesToIds(
  phonemes: string[],
  map: Record<string, number[]>,
): PhonemeIdResult {
  const ids: number[] = [...(map[BOS] ?? [])];
  const missing: string[] = [];
  for (const p of phonemes) {
    const id = map[p];
    if (!id) {
      missing.push(p);
      continue;
    }
    ids.push(...id);
    ids.push(...(map[PAD] ?? []));
  }
  ids.push(...(map[EOS] ?? []));
  return { ids, missing };
}

/**
 * Render a phoneme-token stream on a Piper voice.
 * `tokens` are single IPA symbols as they appear in the voice's `phoneme_id_map`
 * (see normalizer.toPiperPhonemes).
 */
export async function renderPiperTokens(
  tokens: string[],
  opts: PiperRenderOptions = {},
): Promise<{ pcm: Pcm; missing: string[] }> {
  const voice = await loadVoice(opts.voicePath);
  const ort = (await import('onnxruntime-node')).default as any;
  const { config, session } = voice;
  const { ids, missing } = phonemesToIds(tokens, config.phoneme_id_map);
  if (ids.length === 0) throw new Error('no renderable phonemes after id mapping');

  const scales = Float32Array.from([
    opts.noiseScale ?? config.inference.noise_scale,
    opts.lengthScale ?? config.inference.length_scale,
    opts.noiseW ?? config.inference.noise_w,
  ]);
  const feeds: Record<string, unknown> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', scales, [3]),
  };
  if (session.inputNames.includes('sid'))
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(opts.speakerId ?? 0)]), [1]);

  const out = await session.run(feeds);
  const audio = out[session.outputNames[0]].data as Float32Array;
  const samples = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const v = Math.max(-1, Math.min(1, audio[i]));
    samples[i] = Math.round(v * 32767);
  }
  return { pcm: { sampleRate: config.audio.sample_rate, samples }, missing };
}

/** True when a usable voice file is present (used by tests/CLI to skip gracefully). */
export function voiceAvailable(explicitPath?: string): boolean {
  try {
    resolveVoicePath(explicitPath);
    return true;
  } catch {
    return false;
  }
}
