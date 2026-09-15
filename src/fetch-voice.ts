/**
 * fetch-voice.ts — download the neural voice once, into the user cache.
 *
 * The ONNX voice is ~61 MB, so it is deliberately NOT bundled in the npm tarball
 * and NOT committed to git. This module fetches it from the canonical
 * rhasspy/piper-voices repository on Hugging Face (no account, no API key, no
 * cost) and verifies the SHA-256, so a truncated or substituted download cannot
 * pass silently into audio you intend to redistribute.
 */
import { createWriteStream, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_VOICE } from './piper.js';

const BASE =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kristin/medium';

/**
 * SHA-256 of the upstream files, verified against huggingface.co on 2026-07-19.
 * A mismatch means the file changed upstream or the download was corrupted.
 */
export const VOICE_SHA256: Record<string, string> = {
  [`${DEFAULT_VOICE}.onnx`]:
    '5849957f929cbf720c258f8458692d6103fff2f0e3d3b19c8259474bb06a18d4',
  [`${DEFAULT_VOICE}.onnx.json`]:
    '5681426d4aead22195de70531eeeeddb46493cfaffc5764b2ea3db73428b651c',
};

export function defaultVoiceDir(): string {
  return join(homedir(), '.cache', 'ebl-akkadian-phonemes', 'voices');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(
  name: string,
  dir: string,
  log: (s: string) => void,
): Promise<string> {
  const dest = join(dir, name);
  if (existsSync(dest) && statSync(dest).size > 0) {
    if (VOICE_SHA256[name] && sha256(dest) === VOICE_SHA256[name]) {
      log(`  already present and verified: ${dest}\n`);
      return dest;
    }
    log(`  present but hash does not match — re-downloading ${name}\n`);
  }
  const url = `${BASE}/${name}`;
  log(`  downloading ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  if (!res.body) throw new Error(`empty response body for ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  log(`  wrote ${dest} (${statSync(dest).size} bytes)\n`);
  const expected = VOICE_SHA256[name];
  if (expected) {
    const got = sha256(dest);
    if (got !== expected)
      throw new Error(
        `sha256 mismatch for ${name}\n  expected ${expected}\n  got      ${got}\n` +
          `The upstream file changed or the download was corrupted. Delete ${dest} and retry.`,
      );
    log(`  sha256 OK\n`);
  }
  return dest;
}

/** Download the default neural voice into `dir`. Returns the directory used. */
export async function fetchVoice(
  dir: string = defaultVoiceDir(),
  log: (s: string) => void = (s) => process.stdout.write(s),
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  log(`Fetching Piper voice "${DEFAULT_VOICE}" into ${dir}\n`);
  await download(`${DEFAULT_VOICE}.onnx.json`, dir, log);
  await download(`${DEFAULT_VOICE}.onnx`, dir, log);
  log(
    `\nDone. Neural mode is now available.\n` +
      `Verify with:  ebl-tts --ipa "[a.ˈbaː.lu]" -o abalu.wav\n`,
  );
  return dir;
}
