#!/usr/bin/env node
/**
 * ebl-to-piper.mjs — dump the neural phoneme-token stream for one or more eBL-IPA
 * words, as JSON.
 *
 * Useful for (a) auditing what the normalizer hands the neural voice, and (b)
 * driving a Python/GPU synthesizer that calls piper's own `phonemes_to_ids()`
 * — e.g. the fine-tuning path in finetune/. There is ONE normalizer, so these
 * tokens are exactly what `synthesize(ipa)` uses internally; nothing is
 * re-implemented here.
 *
 * Usage:
 *   node scripts/ebl-to-piper.mjs                       # the 4 demo words
 *   node scripts/ebl-to-piper.mjs "[a.ˈbaː.lu]" "[ˈʃar.ru]"
 */
import { normalizeForPiper } from '../dist/index.js';

// The 4 fast-proof words, as eBL renders them (natural words, NOT hyphenated
// syllable-by-syllable). IPA per the eBL transcriptionToIpa contract.
const DEMO = [
  { word: 'abālu', ipa: '[a.ˈbaː.lu]' },
  { word: 'šarru', ipa: '[ˈʃar.ru]' },
  { word: 'bītu', ipa: '[ˈbiː.tu]' },
  { word: 'ilu', ipa: '[ˈi.lu]' },
];

const args = process.argv.slice(2).filter((a) => a !== '--demo');
const items = args.length ? args.map((ipa) => ({ word: ipa, ipa })) : DEMO;

const out = items.map(({ word, ipa }) => {
  const r = normalizeForPiper(ipa);
  return {
    word,
    ipa,
    espeak_voice: r.espeakVoice, // 'en' — the base the shipped voice was trained on
    tokens: r.tokens, // feed to piper phonemes_to_ids()
    hasUltralong: r.hasUltralong,
    ultralongVowelIndices: r.ultralongVowelIndices,
    vowelCount: r.vowelCount,
    approximations: r.notes,
  };
});

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
