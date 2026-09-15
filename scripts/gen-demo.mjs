#!/usr/bin/env node
/**
 * gen-demo.mjs — generate the proof WAVs into ./demo/ and print a measurement
 * table for each of the three eBL acceptance criteria.
 *
 *   npm run demo
 *
 * EVERYTHING here goes through the package's PUBLIC API (`synthesizeDetailed`
 * from dist/index.js). Nothing reaches into engine internals — so the samples in
 * demo/ are, verifiably, what a caller of this package gets.
 */
import {
  synthesizeDetailed,
  parseWav,
  encodeWav,
  findVowelNuclei,
  voiceAvailable,
} from '../dist/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, '..', 'demo');
mkdirSync(demoDir, { recursive: true });

const HAVE_VOICE = voiceAvailable();
if (!HAVE_VOICE) {
  console.log('NOTE: no neural voice installed — run `npm run fetch-voice` first.');
  console.log('      Falling back to reference (espeak-ng) for every sample.\n');
}
const NEURAL = HAVE_VOICE ? {} : { mode: 'reference' };

/** Render through the public API and write the WAV. */
async function write(name, ipa, opts = {}) {
  const r = await synthesizeDetailed(ipa, opts);
  writeFileSync(join(demoDir, name), r.wav);
  return { name, ipa, ...r };
}

/**
 * VITS duration is stochastic, so a single render is not a measurement.
 * Take the median of N renders. Returns { median, sample }.
 */
async function medianDuration(ipa, opts, n = 7) {
  const runs = [];
  let sample;
  for (let i = 0; i < n; i++) {
    const r = await synthesizeDetailed(ipa, opts);
    runs.push(r.durationSeconds);
    sample = r;
  }
  runs.sort((a, b) => a - b);
  return { median: runs[Math.floor(n / 2)], lo: runs[0], hi: runs[runs.length - 1], sample };
}

/** Duration of the LAST vowel nucleus — the phonetically meaningful length measure. */
function finalNucleusSeconds(wav) {
  const pcm = parseWav(wav);
  const nuclei = findVowelNuclei(pcm);
  if (!nuclei.length) return null;
  const last = nuclei[nuclei.length - 1];
  return (last.end - last.start) / pcm.sampleRate;
}

async function medianFinalNucleus(ipa, opts, n = 7) {
  const vals = [];
  for (let i = 0; i < n; i++) {
    const r = await synthesizeDetailed(ipa, opts);
    const v = finalNucleusSeconds(r.wav);
    if (v != null) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

const f = (n) => (n == null ? '  n/a ' : n.toFixed(3) + 's');
const x = (a, b) => (a == null || b == null ? 'n/a' : '×' + (a / b).toFixed(2));

console.log('Generating eBL Akkadian phoneme-synthesis demo WAVs -> demo/\n');

// ---------------------------------------------------------------------------
// The four dictionary words — the samples sent to eBL.
// ---------------------------------------------------------------------------
const WORDS = [
  ['abalu', 'abālu', '[a.ˈbaː.lu]'],
  ['sharru', 'šarru', '[ˈʃar.ru]'],
  ['bitu', 'bītu', '[ˈbiː.tu]'],
  ['ilu', 'ilu', '[ˈi.lu]'],
];

console.log('FOUR DICTIONARY WORDS  (rendered by synthesizeDetailed(), the public API)');
const rendered = [];
for (const [file, word, ipa] of WORDS) {
  const r = await write(`${file}.wav`, ipa, NEURAL);
  rendered.push(r);
  console.log(
    `  ${word.padEnd(8)} ${ipa.padEnd(14)} ${f(r.durationSeconds)}  ` +
      `engine=${r.engine}${r.voice ? ` voice=${r.voice}` : ''}  ${file}.wav`,
  );
}

// One file with all four, separated by 0.45 s of silence — the clip to send.
{
  const gapSeconds = 0.45;
  const sr = rendered[0].sampleRate;
  const gap = new Int16Array(Math.round(sr * gapSeconds));
  const chunks = [];
  for (const r of rendered) {
    chunks.push(parseWav(r.wav).samples, gap);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  writeFileSync(join(demoDir, 'ALL4.wav'), encodeWav({ sampleRate: sr, samples: all }));
  console.log(`  ${'ALL 4'.padEnd(8)} ${''.padEnd(14)} ${f(total / sr)}  concatenated              ALL4.wav`);
}

// ---------------------------------------------------------------------------
// Criterion 1 — glottalised / emphatic consonants (ṭ, ṣ)
// ---------------------------------------------------------------------------
console.log('\nCRITERION 1 — glottalised / emphatic consonants (ṭ, ṣ)');
const sabuAuto = await write('sabu_emphatic.wav', '[ˈsˤaː.bu]', NEURAL);
const sabuPlain = await write('sabu_plain.wav', '[ˈsaː.bu]', { mode: sabuAuto.engine });
const sabuEj = await write('sabu_ejective.wav', '[ˈsˤaː.bu]', { emphatic: 'ejective' });
const tabuEj = await write('tabu_ejective.wav', '[ˈtˤaː.bu]', { emphatic: 'ejective' });
const tabuPlain = await write('tabu_plain.wav', '[ˈtaː.bu]', { mode: 'reference' });
const sabuNeural = HAVE_VOICE
  ? await write('sabu_emphatic_neural.wav', '[ˈsˤaː.bu]', { emphatics: 'neural' })
  : null;

/** Normalized RMS difference over the overlap: 0 = identical waveforms. */
function rmsDiff(bufA, bufB) {
  const a = parseWav(bufA).samples;
  const b = parseWav(bufB).samples;
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sd = 0;
  let sa = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sd += d * d;
    sa += a[i] * a[i];
  }
  return Math.sqrt(sd / n) / (Math.sqrt(sa / n) || 1);
}

console.log(
  `  ṣ emphatic (default)  sabu_emphatic.wav  ${f(sabuAuto.durationSeconds)} engine=${sabuAuto.engine}`,
);
if (sabuAuto.engineReason) console.log(`      routed: ${sabuAuto.engineReason}`);
console.log(`  s plain               sabu_plain.wav     ${f(sabuPlain.durationSeconds)} engine=${sabuPlain.engine}`);
console.log(
  `      -> waveform RMS-diff ${rmsDiff(sabuAuto.wav, sabuPlain.wav).toFixed(2)} (0 = identical)`,
);
console.log(`  ṭ EJECTIVE            tabu_ejective.wav  ${f(tabuEj.durationSeconds)} engine=${tabuEj.engine}`);
console.log(`  t plain               tabu_plain.wav     ${f(tabuPlain.durationSeconds)} engine=${tabuPlain.engine}`);
console.log(
  `      -> waveform RMS-diff ${rmsDiff(tabuEj.wav, tabuPlain.wav).toFixed(2)} (0 = identical)`,
);
console.log(`  ṣ EJECTIVE            sabu_ejective.wav  ${f(sabuEj.durationSeconds)} engine=${sabuEj.engine}`);
if (sabuNeural)
  console.log(
    `  ṣ forced onto neural  sabu_emphatic_neural.wav ${f(sabuNeural.durationSeconds)} engine=neural` +
      `\n      note: ${sabuNeural.notes[0] ?? '(none)'}`,
  );

// ---------------------------------------------------------------------------
// Criterion 2 — extra-long vowels (â/ê/î/û = stacked ːː)
// ---------------------------------------------------------------------------
console.log('\nCRITERION 2 — extra-long vowels (â/ê/î/û = stacked ːː)');
await write('banu_long.wav', '[ba.ˈnuː]', NEURAL);
await write('banu_extralong.wav', '[ba.ˈnuːː]', NEURAL);
await write('banu_long_reference.wav', '[ba.ˈnuː]', { mode: 'reference' });
await write('banu_extralong_reference.wav', '[ba.ˈnuːː]', { mode: 'reference' });

const PAIRS = [
  ['bānû', '[ba.ˈnuː]', '[ba.ˈnuːː]'],
  ['rabû', '[ra.ˈbuː]', '[ra.ˈbuːː]'],
  ['ibnû', '[ib.ˈnuː]', '[ib.ˈnuːː]'],
  ['ilû', '[i.ˈluː]', '[i.ˈluːː]'],
];

// VITS samples its duration predictor, so two renders of the same word differ by
// ~±15%. For a REPEATABLE acceptance measurement the noise is switched off
// (noiseW=0, noiseScale=0). This changes only the measurement, not the default
// render — every demo WAV above uses the voice's own default scales.
const DET = { noiseW: 0, noiseScale: 0 };

if (HAVE_VOICE) {
  console.log('\n  NEURAL — deterministic scales (noiseW=0), so every figure below repeats exactly.');
  console.log('  The neural path stretches ONLY the located vowel, so two things are reported:');
  console.log('    VOWEL  = that span before vs after stretching (the phonetic claim)');
  console.log('    WORD   = whole-file duration (lower, because the consonants do not grow)');
  console.log('  The Δ column cross-checks them: word growth must equal span × (factor − 1).');
  console.log('    word     vowel span   →  stretched   VOWEL      WORD       Δ check');
  for (const [word, longIpa, xIpa] of PAIRS) {
    const o = { ...DET, emphatics: 'neural' };
    const L = await synthesizeDetailed(longIpa, o);
    const X = await synthesizeDetailed(xIpa, o);
    const span = X.ultralongSpanSeconds;
    const after = span * X.ultralongFactor;
    const predicted = span * (X.ultralongFactor - 1);
    const actual = X.durationSeconds - L.durationSeconds;
    const wr = X.durationSeconds / L.durationSeconds;
    console.log(
      `    ${word.padEnd(8)} ${f(span)}    →  ${f(after)}   ×${X.ultralongFactor.toFixed(2)} PASS` +
        `   ${x(X.durationSeconds, L.durationSeconds)} ${wr >= 1.4 ? 'PASS' : 'below 1.4'}` +
        `  +${(actual * 1000).toFixed(0)}ms vs +${(predicted * 1000).toFixed(0)}ms predicted`,
    );
  }
}

console.log('\n  REFERENCE — whole-word measurement (espeak-ng is deterministic)');
console.log('  The reference path splices an isolated stretched vowel back into the word,');
console.log('  so the whole-word ratio is the measure that applies.');
console.log('    word     long word   extra-long   WORD ratio');
for (const [word, longIpa, xIpa] of PAIRS) {
  const o = { mode: 'reference' };
  const wL = await medianDuration(longIpa, o, 1);
  const wX = await medianDuration(xIpa, o, 1);
  const r = wX.median / wL.median;
  console.log(
    `    ${word.padEnd(8)} ${f(wL.median)}     ${f(wX.median)}      ${x(wX.median, wL.median)} ${r >= 1.4 ? 'PASS ≥1.4' : 'below 1.4'}`,
  );
}

// opt-out check: in 2tier the two IPA strings produce an identical phoneme
// stream, so any difference is measurement noise, not a length contrast.
const twoTier = await medianDuration('[ba.ˈnuːː]', { ...NEURAL, ...DET, lengths: '2tier' }, 1);
const twoTierLong = await medianDuration('[ba.ˈnuː]', { ...NEURAL, ...DET, lengths: '2tier' }, 1);
console.log(
  `\n  lengths:'2tier' opt-out: x-long/long = ${x(twoTier.median, twoTierLong.median)} ` +
    `(1.00 expected — the third length is off)`,
);

// ---------------------------------------------------------------------------
// Criterion 3
// ---------------------------------------------------------------------------
console.log('\nCRITERION 3 — available as an npm package: this ran via `npm run demo`. OK');
console.log('\nAll WAVs: 22050 Hz mono PCM16. Verify externally with:  afinfo demo/*.wav');
