/**
 * elevenlabs.ts — the PAID, human-quality voice stage (ElevenLabs v3 over HTTPS).
 *
 * This is the route that passed philological review on 2026-09-21 (Enrique Jiménez, eBL):
 * the word is spelled in vowelled Arabic script (arabic-script.ts) so ṣ ṭ q ḫ ʾ are native to
 * the multilingual model, then the extra-long tier is applied by the same WSOLA stretch every
 * engine uses. Words Arabic cannot spell (p, e, o) are sent as the IPA text instead.
 *
 * Contract:
 *   ELEVENLABS_API_KEY   required (never bundled; never logged)
 *   EBL_ELEVENLABS_VOICE voice id (the reviewed clips used the eBL/gesztu Akkadian voice; there is
 *                        no default because a voice is a licensing and provenance decision)
 *   EBL_ELEVENLABS_MODEL default eleven_v3
 * Output is requested as pcm_22050 (raw signed 16-bit mono) so no decoder is needed.
 *
 * Licensing: ElevenLabs output may be played in an application but its terms forbid
 * redistributing it as a dataset; keep generated audio out of public corpora and repos.
 */
import type { Pcm } from './dsp.js';

export interface ElevenLabsOptions {
  voiceId?: string;
  modelId?: string;
  /** ElevenLabs voice_settings; the reviewed clips used stability 0.5, similarity 0.85, style 0, speed 0.9 */
  voiceSettings?: Record<string, number | boolean>;
  apiKey?: string;
  /** override the endpoint (tests) */
  baseUrl?: string;
}

export const ELEVENLABS_REVIEWED_SETTINGS = { stability: 0.5, similarity_boost: 0.85, style: 0, speed: 0.9, use_speaker_boost: true };

export function elevenlabsAvailable(opts: ElevenLabsOptions = {}): boolean {
  return Boolean((opts.apiKey ?? process.env.ELEVENLABS_API_KEY) && (opts.voiceId ?? process.env.EBL_ELEVENLABS_VOICE));
}

/** Render `text` (Arabic script or IPA) to 22.05 kHz PCM through the ElevenLabs API. */
export async function renderElevenLabsText(text: string, opts: ElevenLabsOptions = {}): Promise<{ pcm: Pcm; requestId: string | null; model: string; voiceId: string }> {
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  const voiceId = opts.voiceId ?? process.env.EBL_ELEVENLABS_VOICE;
  const modelId = opts.modelId ?? process.env.EBL_ELEVENLABS_MODEL ?? 'eleven_v3';
  if (!apiKey) throw new Error('engine:elevenlabs needs ELEVENLABS_API_KEY (source ~/.zsh_env)');
  if (!voiceId) throw new Error('engine:elevenlabs needs EBL_ELEVENLABS_VOICE (a voice id you are licensed to use)');
  const base = opts.baseUrl ?? 'https://api.elevenlabs.io';
  const res = await fetch(`${base}/v1/text-to-speech/${voiceId}?output_format=pcm_22050`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: opts.voiceSettings ?? ELEVENLABS_REVIEWED_SETTINGS }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  return { pcm: { sampleRate: 22050, samples: new Int16Array(samples) }, requestId: res.headers.get('request-id'), model: modelId, voiceId };
}
