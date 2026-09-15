#!/usr/bin/env node
/**
 * ebl-tts — command line for @ebl/akkadian-phonemes.
 *
 *   ebl-tts --fetch-voice                          # one-time: download the neural voice
 *   ebl-tts --ipa "[a.ˈbaː.lu]" -o abalu.wav       # neural (default)
 *   ebl-tts --ipa "[ˈsˤaː.bu]" --emphatic ejective -o sabu.wav
 *   ebl-tts --ipa "[ba.ˈnuːː]" --explain           # print the mapping, no audio
 */
import { writeFileSync } from 'node:fs';
import { synthesizeDetailed, explain } from './synthesize.js';
import { voiceAvailable, resolveVoicePath, DEFAULT_VOICE } from './piper.js';
import type { Emphatic, Lengths } from './normalizer.js';
import type { Mode, Engine, Dialect, EmphaticPolicy } from './synthesize.js';

interface Args {
  ipa?: string;
  out?: string;
  mode?: Mode;
  engine?: Engine;
  emphatic?: Emphatic;
  emphatics?: EmphaticPolicy;
  lengths?: Lengths;
  dialect?: Dialect;
  wpm?: number;
  lengthScale?: number;
  voicePath?: string;
  ultralongFactor?: number;
  explain?: boolean;
  detail?: boolean;
  fetchVoice?: boolean;
  checkVoice?: boolean;
  help?: boolean;
  version?: boolean;
}

const USAGE = `ebl-tts — synthesize Akkadian pronunciation from electronic Babylonian Library (eBL) IPA

USAGE
  ebl-tts --ipa "<eBL-IPA>" [-o out.wav] [options]
  ebl-tts --fetch-voice

SETUP (once)
  --fetch-voice          download the neural voice (${DEFAULT_VOICE}, ~61 MB)
                         into ~/.cache/ebl-akkadian-phonemes/voices/
  --check-voice          report whether a neural voice is installed, and where

OPTIONS
  --ipa, -i <str>        eBL IPA string, e.g. "[a.ˈbaː.lu]" (brackets optional)
  --out, -o <file>       output WAV path (default: out.wav)
  --mode <m>             neural | reference          (default: neural)
                           neural    = a neural voice (see --engine), human-sounding
                           reference = espeak-ng, robotic but phonetically exact
  --engine <e>           piper | omnivoice           (default: piper)
                           which NEURAL voice runs when mode is neural. Swaps the
                           voice ONLY — espeak still owns emphatics and dsp still
                           owns vowel length, so both stay phonetically faithful.
                           omnivoice needs the local Python service (see README).
  --emphatics <p>        auto | neural | reference   (default: auto)
                           how ṭ/ṣ are handled in neural mode; 'auto' renders
                           emphatic-bearing words on the reference engine
  --emphatic <e>         pharyngealized | ejective   (default: pharyngealized)
                           'ejective' always uses the reference engine
  --lengths <l>          2tier | 3tier               (default: 3tier)
                           3tier honors eBL's extra-long â/ê/î/û
  --ultralong-factor <n> extra-long vs long duration multiple (default: 1.8)
  --voice <file>         path to a Piper .onnx voice (overrides the default)
  --length-scale <n>     NEURAL speaking rate; higher = slower (default: 1.0)
  --wpm <n>              REFERENCE speaking rate, words/minute (default: 150)
  --dialect <d>          OB | OA | SB | NA | NB      (reserved)
  --explain              print the IPA→phoneme mapping as JSON and exit (no audio)
  --detail               also print how the render was made (engine, notes)
  --help, -h             show this help
  --version              print the package version

EXAMPLES
  ebl-tts --fetch-voice
  ebl-tts --ipa "[a.ˈbaː.lu]" -o abalu.wav
  ebl-tts --ipa "[a.ˈbaː.lu]" --engine omnivoice -o abalu-omni.wav
  ebl-tts --ipa "[ˈʃar.ru]" -o sharru.wav --detail
  ebl-tts --ipa "[ˈsˤaː.bu]" -o sabu.wav
  ebl-tts --ipa "[ˈsˤaː.bu]" --emphatics neural -o sabu-neural.wav
  ebl-tts --ipa "[ˈtˤaː.bu]" --emphatic ejective -o tabu-ejective.wav
  ebl-tts --ipa "[ba.ˈnuːː]" --ultralong-factor 2.0 -o banu.wav
  ebl-tts --ipa "[a.ˈbaː.lu]" --mode reference -o abalu-espeak.wav
  ebl-tts --ipa "[ba.ˈnuːː]" --explain
`;

function parse(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case '--ipa':
      case '-i':
        a.ipa = next();
        break;
      case '--out':
      case '-o':
        a.out = next();
        break;
      case '--mode':
        a.mode = next() as Mode;
        break;
      case '--engine':
        a.engine = next() as Engine;
        break;
      case '--emphatic':
        a.emphatic = next() as Emphatic;
        break;
      case '--emphatics':
        a.emphatics = next() as EmphaticPolicy;
        break;
      case '--lengths':
        a.lengths = next() as Lengths;
        break;
      case '--dialect':
        a.dialect = next() as Dialect;
        break;
      case '--wpm':
        a.wpm = Number(next());
        break;
      case '--length-scale':
        a.lengthScale = Number(next());
        break;
      case '--voice':
        a.voicePath = next();
        break;
      case '--ultralong-factor':
        a.ultralongFactor = Number(next());
        break;
      case '--explain':
        a.explain = true;
        break;
      case '--detail':
        a.detail = true;
        break;
      case '--fetch-voice':
        a.fetchVoice = true;
        break;
      case '--check-voice':
        a.checkVoice = true;
        break;
      case '--version':
        a.version = true;
        break;
      case '--help':
      case '-h':
        a.help = true;
        break;
      default:
        if (!a.ipa && !t.startsWith('-')) a.ipa = t; // allow bare positional IPA
        else throw new Error(`unknown argument: ${t}`);
    }
  }
  return a;
}

async function main() {
  const args = parse(process.argv.slice(2));

  if (args.version) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    );
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    return;
  }

  if (args.fetchVoice) {
    const { fetchVoice } = await import('./fetch-voice.js');
    await fetchVoice();
    return;
  }

  if (args.checkVoice) {
    if (voiceAvailable(args.voicePath)) {
      process.stdout.write(`neural voice OK: ${resolveVoicePath(args.voicePath)}\n`);
    } else {
      process.stdout.write(
        `neural voice NOT installed. Run:  ebl-tts --fetch-voice\n` +
          `(mode:'reference' works without it.)\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (args.help) {
    // An explicit --help is a successful request for help, not an error.
    process.stdout.write(USAGE);
    return;
  }
  if (!args.ipa) {
    // No input: usage goes to stderr and the exit code is non-zero, so a script
    // that forgot --ipa fails loudly instead of writing an empty file.
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const opts = {
    mode: args.mode,
    engine: args.engine,
    emphatic: args.emphatic,
    emphatics: args.emphatics,
    lengths: args.lengths,
    dialect: args.dialect,
    wpm: args.wpm,
    lengthScale: args.lengthScale,
    voicePath: args.voicePath,
    ultralongFactor: args.ultralongFactor,
  };

  if (args.explain) {
    process.stdout.write(JSON.stringify(explain(args.ipa!, opts), null, 2) + '\n');
    return;
  }

  const r = await synthesizeDetailed(args.ipa!, opts);
  const out = args.out ?? 'out.wav';
  writeFileSync(out, r.wav);
  process.stdout.write(
    `wrote ${out} (${r.wav.length} bytes, ${r.durationSeconds.toFixed(3)}s, ` +
      `${r.sampleRate} Hz, engine=${r.engine}` +
      `${r.neuralEngine ? `/${r.neuralEngine}` : ''}${r.voice ? ` voice=${r.voice}` : ''})\n`,
  );
  if (args.detail) {
    if (r.engineReason) process.stdout.write(`  engine reason: ${r.engineReason}\n`);
    process.stdout.write(`  phonemes: ${r.phonemes}\n`);
    process.stdout.write(
      `  extra-long: ${r.ultralong}${r.ultralongFactor !== 1 ? ` (${r.ultralongFactor}×)` : ''}\n`,
    );
    for (const n of r.notes) process.stdout.write(`  note: ${n}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`ebl-tts: ${err.message}\n`);
  process.exit(1);
});
