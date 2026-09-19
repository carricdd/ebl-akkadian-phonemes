#!/usr/bin/env node
/**
 * gen-review-samples.mjs — the 0.3.2 philological review set (Enrique Jiménez,
 * 2026-09-17: "the emphatics are not yet distinguishable from non-emphatics, and
 * the extra-long vowels are not yet represented").
 *
 *   node scripts/gen-review-samples.mjs            # writes demo/review-0.3.2/*.wav + index.json
 *
 * Every clip goes through the public API (synthesizeDetailed), deterministic
 * (noiseW 0 = deterministic durations; noiseScale left at the voice default) so the duration table is a measurement, not a draw.
 * Minimal pairs, three renderings each where it matters:
 *   arabic    = ar_JO-kareem-medium (0.3.2 default for ṭ ṣ q ḫ words under emphatics:'auto')
 *   english   = en_US-kristin-medium (0.3.1 default voice)
 *   reference = espeak-ng (0.3.1's "genuine emphatic" path)
 */
import { synthesizeDetailed, emphaticVoicePath, voiceAvailable } from '../dist/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'demo', 'review-0.3.2');
mkdirSync(out, { recursive: true });

const AR = emphaticVoicePath();
if (!AR) { console.error('Arabic voice not installed: ebl-tts --fetch-voice arabic'); process.exit(1); }
if (!voiceAvailable()) { console.error('English voice not installed: ebl-tts --fetch-voice'); process.exit(1); }

// [file stem, gloss, eBL IPA]
const PAIRS = {
  'emphatic-s': [
    ['sabu', 'sābu (plain s)', '[ˈsaː.bu]'],
    ['ssabu', 'ṣābu "troops" (emphatic ṣ)', '[ˈsˤaː.bu]'],
  ],
  'emphatic-t': [
    ['tabu', 'tābu (plain t)', '[ˈtaː.bu]'],
    ['ttabu', 'ṭābu "good" (emphatic ṭ)', '[ˈtˤaː.bu]'],
    ['tuppu', 'tuppu (plain t)', '[ˈtup.pu]'],
    ['ttuppu', 'ṭuppu "tablet" (emphatic ṭ)', '[ˈtˤup.pu]'],
  ],
  'uvular-q': [
    ['katu', 'kātu (plain k)', '[ˈkaː.tu]'],
    ['qatu', 'qātu "hand" (uvular q)', '[ˈqaː.tu]'],
  ],
  'velar-h': [
    ['harranu', 'ḫarrānu "road" (ḫ)', '[xar.ˈraː.nu]'],
  ],
  'length-u': [
    ['sharru', 'šarru "king" (short u)', '[ˈʃar.ru]'],
    ['sharruu', 'šarrū "kings" (long ū)', '[ʃar.ˈruː]'],
    ['sharruuu', 'šarrû (extra-long û)', '[ʃar.ˈruːː]'],
  ],
  'length-rabu': [
    ['rabuu', 'rabū (long ū)', '[ra.ˈbuː]'],
    ['rabuuu', 'rabû "great" (extra-long û)', '[ra.ˈbuːː]'],
  ],
  'length-e': [
    ['shamee', 'šamē (long ē)', '[ʃa.ˈmeː]'],
    ['shameee', 'šamê "heaven" (extra-long ê)', '[ʃa.ˈmeːː]'],
  ],
  'length-a': [
    ['bana', 'bana (short a)', '[ˈba.na]'],
    ['banaa', 'banā (long ā)', '[ba.ˈnaː]'],
    ['banaaa', 'banâ (extra-long â)', '[ba.ˈnaːː]'],
  ],
};

const RENDERS = {
  arabic: { voicePath: AR, noiseW: 0 },   // voice-default noiseScale (0.667): noiseScale 0 flattens articulation and halves the emphatic F2 shift
  english: { emphatics: 'neural', noiseW: 0 },
  reference: { mode: 'reference' },
};

const index = [];
for (const [group, items] of Object.entries(PAIRS)) {
  for (const [stem, gloss, ipa] of items) {
    for (const [render, opts] of Object.entries(RENDERS)) {
      const r = await synthesizeDetailed(ipa, opts);
      const file = `${group}__${stem}__${render}.wav`;
      writeFileSync(join(out, file), r.wav);
      index.push({
        group, stem, gloss, ipa, render, file,
        engine: r.engine, voice: r.voice ?? 'espeak-ng',
        durationSeconds: +r.durationSeconds.toFixed(3),
        ultralong: r.ultralong, ultralongSpanMs: r.ultralongSpanSeconds ? Math.round(r.ultralongSpanSeconds * 1000) : null,
        phonemes: r.phonemes, notes: r.notes,
      });
      console.log(`${file.padEnd(44)} ${r.durationSeconds.toFixed(3)}s  ${r.phonemes}`);
    }
  }
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\n${index.length} clips -> ${out}`);
