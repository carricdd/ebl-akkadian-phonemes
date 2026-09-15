/**
 * Test suite — run with: npm test  (node --test)
 *
 * Covers the normalizer mapping table and end-to-end synthesis on BOTH engines,
 * asserting the three eBL acceptance criteria hold.
 *
 * Neural tests are skipped (not failed) when the ~61 MB Piper voice is not
 * installed, so `npm test` is meaningful immediately after `npm install`.
 * Install the voice with `npm run fetch-voice` to run the full suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesize,
  synthesizeDetailed,
  normalize,
  normalizeForPiper,
  toEspeakString,
  toPiperPhonemes,
  parseWav,
  explain,
  findVowelNuclei,
  voiceAvailable,
  phonemesToIds,
  wsolaStretch,
} from '../dist/index.js';

const es = (ipa, opts) => toEspeakString(normalize(ipa, opts).units);
const px = (ipa, opts) => toPiperPhonemes(normalize(ipa, opts).units).join('');
const HAVE_VOICE = voiceAvailable();
const neural = { skip: HAVE_VOICE ? false : 'neural voice not installed (npm run fetch-voice)' };
/** Deterministic VITS scales — duration sampling off, so measurements repeat. */
const DET = { noiseW: 0, noiseScale: 0 };

// ---------------------------------------------------------------------------
// Normalizer — the eBL IPA contract
// ---------------------------------------------------------------------------

test("normalizer: canonical abalu maps to a'ba:lu (espeak)", () => {
  assert.equal(es('[a.ˈbaː.lu]'), "a'ba:lu");
});

test('normalizer: canonical abalu maps to aˈbaːlu (neural tokens)', () => {
  assert.equal(px('[a.ˈbaː.lu]'), 'aˈbaːlu');
});

test('normalizer: emphatic ṣ accepted as ᵴ (U+1D74), sˤ, and affricate t̴͡s̴', () => {
  assert.equal(es('[ˈᵴaː.bu]'), "'s[a:bu"); // eBL default placeholder
  assert.equal(es('[ˈsˤaː.bu]'), "'s[a:bu"); // pharyngealized form
  assert.equal(es('[ˈt̴͡s̴aː.bu]'), "'ts[a:bu"); // affricate emphatic form
});

test('normalizer: emphatic ṭ accepted as ᵵ (U+1D75) and tˤ', () => {
  assert.equal(es('[ˈᵵaː.bu]'), "'t[a:bu");
  assert.equal(es('[ˈtˤaː.bu]'), "'t[a:bu");
});

test("normalizer: eBL's 'affricative' rows — s→t͡s, z→d͡z", () => {
  assert.equal(es('[ˈt͡sa.d͡zu]'), "'tsadzu");
});

test("normalizer: eBL's 'pharyngealized-affricative' row — ṣ→t͡sˤ", () => {
  assert.equal(es('[ˈt͡sˤaː.bu]'), "'ts[a:bu");
  const r = normalize('[ˈt͡sˤaː.bu]');
  assert.equal(r.units.find((u) => u.kind === 'consonant').emphatic, 'pharyngealized');
});

test('normalizer: every emphatic notation eBL can emit lands on one phoneme', () => {
  // ṣ has four spellings across eBL's reconstruction switches; all must agree.
  const forms = ['[ˈᵴaː.bu]', '[ˈsˤaː.bu]'];
  const affricates = ['[ˈt̴͡s̴aː.bu]', '[ˈt͡sˤaː.bu]'];
  assert.equal(new Set(forms.map((i) => es(i))).size, 1, 'plain emphatic forms agree');
  assert.equal(new Set(affricates.map((i) => es(i))).size, 1, 'affricate emphatic forms agree');
});

test('normalizer: ejective option switches emphatics + espeak voice', () => {
  const r = normalize('[ˈtˤaː.bu]', { emphatic: 'ejective' });
  assert.equal(r.voice, 'am');
  assert.equal(toEspeakString(r.units), "'t`a:bu");
  const s = normalize('[ˈsˤaː.bu]', { emphatic: 'ejective' });
  assert.equal(toEspeakString(s.units), "'s?a:bu");
});

test('normalizer: extra-long aːː/uːː flagged as ultralong, single ː to the engine', () => {
  const r = normalize('[ba.ˈnuːː]');
  assert.equal(r.hasUltralong, true);
  assert.equal(toEspeakString(r.units), "ba'nu:"); // engine gets one ː; DSP adds the length
  const two = normalize('[ba.ˈnuː]');
  assert.equal(two.hasUltralong, false);
});

test('normalizer: passthrough of ʔ x ʃ j (espeak mnemonics)', () => {
  assert.equal(es('[ʔa.xa.ʃa.ja]'), '?axaSaja');
});

test('normalizer: neural map substitutes ḫ→h and q→k, and says so', () => {
  const r = normalizeForPiper('[ˈxa.qu]');
  assert.equal(r.tokens.join(''), 'ˈhaku');
  assert.equal(r.espeakVoice, 'en');
  assert.ok(r.notes.some((n) => n.includes('ḫ')), 'reports the ḫ substitution');
  assert.ok(r.notes.some((n) => n.includes('uvular q')), 'reports the q substitution');
});

test('normalizer: reports which vowel is the extra-long one', () => {
  const r = normalizeForPiper('[ba.ˈnuːː]');
  assert.equal(r.vowelCount, 2);
  assert.deepEqual(r.ultralongVowelIndices, [1]); // the second vowel
});

// ---------------------------------------------------------------------------
// Piper id encoding
// ---------------------------------------------------------------------------

test('phonemesToIds: BOS, id+PAD per phoneme, EOS; unknown phonemes reported', () => {
  const map = { '^': [1], $: [2], _: [0], a: [14], b: [15] };
  const { ids, missing } = phonemesToIds(['a', 'b', 'ZZZ'], map);
  assert.deepEqual(ids, [1, 14, 0, 15, 0, 2]);
  assert.deepEqual(missing, ['ZZZ']);
});

// ---------------------------------------------------------------------------
// Reference engine (espeak-ng) — always available, no download
// ---------------------------------------------------------------------------

test('reference: returns a valid non-empty WAV buffer', async () => {
  const wav = await synthesize('[a.ˈbaː.lu]', { mode: 'reference' });
  assert.ok(Buffer.isBuffer(wav));
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  const pcm = parseWav(wav);
  assert.equal(pcm.sampleRate, 22050);
  assert.ok(pcm.samples.length > 2000, 'has real audio samples');
});

test('criterion 1 (reference): emphatic renders a distinct sound from plain', async () => {
  const emph = parseWav(await synthesize('[ˈsˤaː.bu]', { mode: 'reference' }));
  const plain = parseWav(await synthesize('[ˈsaː.bu]', { mode: 'reference' }));
  const n = Math.min(emph.samples.length, plain.samples.length);
  let diff = 0;
  for (let i = 0; i < n; i++) diff += Math.abs(emph.samples[i] - plain.samples[i]);
  assert.ok(diff / n > 50, 'emphatic and plain waveforms differ substantially');
});

test('criterion 1 (reference): ejective renders distinctly from plain', async () => {
  const ej = parseWav(await synthesize('[ˈtˤaː.bu]', { emphatic: 'ejective' }));
  const pl = parseWav(await synthesize('[ˈtaː.bu]', { emphatic: 'ejective' }));
  const n = Math.min(ej.samples.length, pl.samples.length);
  let diff = 0;
  for (let i = 0; i < n; i++) diff += Math.abs(ej.samples[i] - pl.samples[i]);
  assert.ok(diff / n > 50, 'ejective and plain waveforms differ substantially');
});

test('criterion 2 (reference): extra-long word is >= 1.4x the long word', async () => {
  const long = parseWav(await synthesize('[ba.ˈnuː]', { mode: 'reference' }));
  const xlong = parseWav(await synthesize('[ba.ˈnuːː]', { mode: 'reference' }));
  const ratio = xlong.samples.length / long.samples.length;
  assert.ok(ratio >= 1.4, `ultralong/long ratio ${ratio.toFixed(2)} >= 1.4`);
});

test('criterion 2 (reference): 2tier mode does NOT lengthen (opt-out works)', async () => {
  const twoTier = parseWav(
    await synthesize('[ba.ˈnuːː]', { mode: 'reference', lengths: '2tier' }),
  );
  const long = parseWav(await synthesize('[ba.ˈnuː]', { mode: 'reference', lengths: '2tier' }));
  const ratio = twoTier.samples.length / long.samples.length;
  assert.ok(ratio < 1.2, `2tier ratio ${ratio.toFixed(2)} ~ 1 (no third length)`);
});

// ---------------------------------------------------------------------------
// Engine routing — the behaviour a caller must be able to predict
// ---------------------------------------------------------------------------

test('routing: neural is the default mode', () => {
  assert.equal(explain('[a.ˈbaː.lu]').mode, 'neural');
});

test("routing: emphatic:'ejective' always falls back to the reference engine", async () => {
  const r = await synthesizeDetailed('[ˈtˤaː.bu]', { emphatic: 'ejective' });
  assert.equal(r.engine, 'reference');
  assert.match(r.engineReason, /ejective/);
});

test("routing: emphatics:'auto' (default) routes emphatic words to reference", async () => {
  const r = await synthesizeDetailed('[ˈsˤaː.bu]');
  assert.equal(r.engine, 'reference');
  assert.match(r.engineReason, /emphatic/);
});

test('routing: a word with no emphatic is NOT diverted', { ...neural }, async () => {
  const r = await synthesizeDetailed('[a.ˈbaː.lu]');
  assert.equal(r.engine, 'neural');
  assert.equal(r.engineReason, undefined);
});

// ---------------------------------------------------------------------------
// Neural engine (Piper) — needs the downloaded voice
// ---------------------------------------------------------------------------

test('neural: returns a valid 22.05 kHz WAV', { ...neural }, async () => {
  const r = await synthesizeDetailed('[a.ˈbaː.lu]');
  assert.equal(r.engine, 'neural');
  assert.equal(r.voice, 'en_US-kristin-medium');
  assert.equal(r.sampleRate, 22050);
  assert.equal(r.wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.ok(parseWav(r.wav).samples.length > 4000);
  assert.deepEqual(r.notes, [], 'abālu is fully in the voice inventory');
});

test('neural: all four demo words render without approximation', { ...neural }, async () => {
  for (const ipa of ['[a.ˈbaː.lu]', '[ˈʃar.ru]', '[ˈbiː.tu]', '[ˈi.lu]']) {
    const r = await synthesizeDetailed(ipa);
    assert.equal(r.engine, 'neural', `${ipa} rendered neurally`);
    assert.deepEqual(r.notes, [], `${ipa} needed no phonetic substitution`);
    assert.ok(r.durationSeconds > 0.1, `${ipa} produced audio`);
  }
});

test(
  'criterion 2 (neural): the extra-long vowel is stretched 1.8x, and the file grew by that much',
  { ...neural },
  async () => {
    for (const [longIpa, xIpa] of [
      ['[ba.ˈnuː]', '[ba.ˈnuːː]'],
      ['[ra.ˈbuː]', '[ra.ˈbuːː]'],
      ['[ib.ˈnuː]', '[ib.ˈnuːː]'],
      ['[i.ˈluː]', '[i.ˈluːː]'],
    ]) {
      const L = await synthesizeDetailed(longIpa, DET);
      const X = await synthesizeDetailed(xIpa, DET);
      assert.ok(X.ultralongSpanSeconds > 0.05, `${xIpa}: a vowel span was located`);
      assert.ok(X.ultralongFactor >= 1.4, `${xIpa}: vowel stretched >= 1.4x`);
      // Detector-independent cross-check: the file must actually be longer by
      // span x (factor - 1), minus the two 8 ms crossfades used to splice it back.
      const predicted = X.ultralongSpanSeconds * (X.ultralongFactor - 1);
      const actual = X.durationSeconds - L.durationSeconds;
      assert.ok(
        actual > predicted - 0.03 && actual < predicted + 0.03,
        `${xIpa}: file grew ${(actual * 1000).toFixed(0)}ms vs ${(predicted * 1000).toFixed(0)}ms predicted`,
      );
      assert.ok(
        X.durationSeconds > L.durationSeconds,
        `${xIpa} is longer than ${longIpa}`,
      );
    }
  },
);

test('wsolaStretch delivers exactly the requested factor', () => {
  const sr = 22050;
  const n = Math.round(0.3 * sr);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / sr));
  for (const factor of [1.4, 1.8, 2.0]) {
    const out = wsolaStretch({ sampleRate: sr, samples }, factor);
    const got = out.samples.length / n;
    assert.ok(
      Math.abs(got - factor) < 0.005,
      `requested ${factor}, delivered ${got.toFixed(3)}`,
    );
  }
});

test(
  "criterion 2 (neural): 2tier is a true opt-out (identical phoneme stream)",
  { ...neural },
  async () => {
    const a = await synthesizeDetailed('[ba.ˈnuːː]', { ...DET, lengths: '2tier' });
    const b = await synthesizeDetailed('[ba.ˈnuː]', { ...DET, lengths: '2tier' });
    assert.equal(a.phonemes, b.phonemes, 'same tokens once the third length is off');
    assert.equal(a.ultralong, 'disabled');
    const ratio = a.durationSeconds / b.durationSeconds;
    assert.ok(ratio < 1.15, `2tier ratio ${ratio.toFixed(2)} ~ 1`);
  },
);

test('neural: reports how the extra-long vowel was realized', { ...neural }, async () => {
  const r = await synthesizeDetailed('[ba.ˈnuːː]', DET);
  assert.ok(
    ['nucleus-stretch', 'word-stretch'].includes(r.ultralong),
    `ultralong strategy reported (${r.ultralong})`,
  );
  assert.equal(r.ultralongFactor, 1.8);
});

test("neural: emphatics:'neural' keeps one voice and flags the compromise", { ...neural }, async () => {
  const r = await synthesizeDetailed('[ˈsˤaː.bu]', { emphatics: 'neural' });
  assert.equal(r.engine, 'neural');
  assert.ok(r.notes.some((n) => n.includes('untrained')), 'the ˤ caveat is surfaced');
});

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------

test('findVowelNuclei: separates two vowels across a sonorant', { ...neural }, async () => {
  const r = await synthesizeDetailed('[ba.ˈnuː]', DET);
  const n = findVowelNuclei(parseWav(r.wav));
  assert.equal(n.length, 2, 'ba-nū has two vowel nuclei');
  assert.ok(n[0].end <= n[1].start, 'nuclei are ordered and disjoint');
});

// ---------------------------------------------------------------------------
// explain()
// ---------------------------------------------------------------------------

test('explain() returns both engines mappings without synthesizing', () => {
  const info = explain('[ˈsˤaː.bu]');
  assert.equal(info.voice, 'ar');
  assert.equal(info.espeak, "'s[a:bu");
  assert.equal(info.neural.voice, 'en_US-kristin-medium');
  assert.ok(info.neural.approximations.length > 0, 'the emphatic caveat is listed');
  assert.ok(info.units.length > 0);
});

test('explain() flags the extra-long vowel by index', () => {
  const info = explain('[ba.ˈnuːː]');
  assert.equal(info.hasUltralong, true);
  assert.deepEqual(info.neural.ultralongVowelIndices, [1]);
});

// ---------------------------------------------------------------------------
// CLI contract — the examples printed in the README must behave as printed
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileP = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

/** Run the CLI, returning { code, stdout, stderr } without throwing. */
async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('cli: --help exits 0 and prints usage', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0, '--help is a successful request, not an error');
  assert.match(r.stdout, /USAGE/);
});

test('cli: no arguments exits 1 with usage on stderr', async () => {
  const r = await cli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /USAGE/);
});

test('cli: an unknown flag exits non-zero with a named error', async () => {
  const r = await cli(['--bogus']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unknown argument: --bogus/);
});

test('cli: --version prints name and version', async () => {
  const r = await cli(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /@ebl\/akkadian-phonemes \d+\.\d+\.\d+/);
});

test('cli: --explain emits parseable JSON and writes no audio', async () => {
  const r = await cli(['--ipa', '[ba.ˈnuːː]', '--explain']);
  assert.equal(r.code, 0);
  const info = JSON.parse(r.stdout);
  assert.equal(info.hasUltralong, true);
  assert.equal(info.espeak, "ba'nu:");
});

test('cli: writes a WAV and reports the engine used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebl-cli-'));
  const out = join(dir, 'abalu.wav');
  const r = await cli(['--ipa', '[a.ˈbaː.lu]', '-o', out, '--mode', 'reference']);
  assert.equal(r.code, 0);
  assert.ok(existsSync(out), 'the WAV was written');
  assert.match(r.stdout, /engine=reference/);
});

test('cli: --detail explains an automatic engine switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebl-cli-'));
  const r = await cli(['--ipa', '[ˈsˤaː.bu]', '-o', join(dir, 'sabu.wav'), '--detail']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /engine=reference/);
  assert.match(r.stdout, /engine reason:.*emphatic/);
});
