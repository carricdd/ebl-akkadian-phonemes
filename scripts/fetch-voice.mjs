#!/usr/bin/env node
/**
 * fetch-voice.mjs — repo-local wrapper around the package's own voice fetcher.
 * The real implementation lives in src/fetch-voice.ts so that it ships inside
 * dist/ and `ebl-tts --fetch-voice` works from a published install too.
 *
 *   npm run fetch-voice
 *   node scripts/fetch-voice.mjs --dir ./voices
 */
import { fetchVoice, defaultVoiceDir } from '../dist/fetch-voice.js';

const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : defaultVoiceDir();
fetchVoice(dir).catch((e) => {
  process.stderr.write(`fetch-voice: ${e.message}\n`);
  process.exit(1);
});
