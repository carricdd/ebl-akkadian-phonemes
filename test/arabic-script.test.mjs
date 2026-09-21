// arabic-script + elevenlabs engine (fetch mocked) — 0.3.3
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, toArabicScript, synthesizeDetailed, encodeWav } from '../dist/index.js';

const ar = (ipa) => { const r = toArabicScript(normalize(ipa).units); return { ...r, text: r.text.normalize('NFC') }; };
const eq = (a, b) => assert.equal(a.normalize('NFC'), b.normalize('NFC'));

test('arabic-script: the reviewed emphatic pairs spell with native ص ط ق خ', () => {
  eq(ar('[ˈsaː.bu]').text, 'سَابُ');
  eq(ar('[ˈsˤaː.bu]').text, 'صَابُ');
  eq(ar('[ˈtˤaː.bu]').text, 'طَابُ');
  eq(ar('[ˈqaː.tu]').text, 'قَاتُ');
  eq(ar('[xar.ˈraː.nu]').text, 'خَرَّانُ'); // ḫ → خ, rr → shadda
  assert.equal(ar('[ˈṭuːp.pu]').representable, false); // transliteration ṭ accepted; p unspellable
});

test('arabic-script: length letters, shadda, hamza seats', () => {
  eq(ar('[ˈʃar.ru]').text, 'شَرُّ');
  eq(ar('[ʃar.ˈruː]').text, 'شَرُّو');
  const x = ar('[ʃar.ˈruːː]');
  assert.equal(x.text, 'شَرُّو'); // extra-long spelled long; stretch does the rest
  assert.deepEqual(x.ultralongVowelIndices, [1]);
  eq(ar('[ˈʔiː.lu]').text, 'إِيلُ');
  eq(ar('[a.ˈbaː.lu]').text, 'أَبَالُ');
  eq(ar('[ˈʔaː.lu]').text, 'آلُ');
});

test('arabic-script: e and o are reported, not faked', () => {
  const r = ar('[ˈbeː.lu]');
  assert.equal(r.representable, false);
  assert.match(r.notes.join(' '), /no Arabic vowel for \/e\//);
});

test('engine:elevenlabs sends Arabic script when spellable, IPA text otherwise, and applies the stretch', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body).text);
    // 0.5 s of a 200 Hz tone at 22.05 kHz as fake speech
    const n = 11025; const s = new Int16Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / 22050));
    return new Response(new Uint8Array(s.buffer), { status: 200, headers: { 'request-id': 'test' } });
  };
  try {
    const a = await synthesizeDetailed('[ˈsˤaː.bu]', { engine: 'elevenlabs', elevenlabs: { apiKey: 'x', voiceId: 'v' } });
    assert.equal(sent[0], 'صَابُ');
    assert.equal(a.engine, 'neural'); assert.equal(a.neuralEngine, 'elevenlabs'); assert.match(a.voice, /^elevenlabs:v$/);
    const b = await synthesizeDetailed('[ˈtˤup.pu]', { engine: 'elevenlabs', elevenlabs: { apiKey: 'x', voiceId: 'v' } });
    assert.equal(sent[1], '/ˈtˤup.pu/');
    assert.match(b.notes.join(' '), /sent as IPA text/);
    const c = await synthesizeDetailed('[ra.ˈbuːː]', { engine: 'elevenlabs', elevenlabs: { apiKey: 'x', voiceId: 'v' } });
    assert.equal(c.ultralong, 'nucleus-stretch');
    assert.ok(c.durationSeconds > a.durationSeconds, 'extra-long clip is longer than the plain one');
    await assert.rejects(synthesizeDetailed('[ˈbeː.lu]', { engine: 'elevenlabs', script: 'arabic', elevenlabs: { apiKey: 'x', voiceId: 'v' } }), /not spellable/);
  } finally { globalThis.fetch = realFetch; }
});

test('engine:elevenlabs refuses to run without a key or voice', async () => {
  const saved = [process.env.ELEVENLABS_API_KEY, process.env.EBL_ELEVENLABS_VOICE];
  delete process.env.ELEVENLABS_API_KEY; delete process.env.EBL_ELEVENLABS_VOICE;
  try { await assert.rejects(synthesizeDetailed('[ˈsaː.bu]', { engine: 'elevenlabs' }), /ELEVENLABS_API_KEY/); }
  finally { if (saved[0]) process.env.ELEVENLABS_API_KEY = saved[0]; if (saved[1]) process.env.EBL_ELEVENLABS_VOICE = saved[1]; }
});
