/**
 * omnivoice.ts — an ALTERNATE neural voice stage, parallel to piper.ts.
 *
 * Piper (piper.ts) renders IPA phoneme-ids in-process via ONNX. OmniVoice
 * (k2-fsa/OmniVoice, Apache-2.0) is a PyTorch/MPS voice-cloning model with no
 * Node binding and a *different* input contract: it takes CMU/ARPABET phonemes in
 * square brackets, not IPA. So this adapter (a) maps the same normalized eBL units
 * down to ARPABET, and (b) shells out to scripts/omnivoice_render.py, which loads
 * the model, generates, extracts the first clean burst, and writes a WAV we read
 * back as Pcm.
 *
 * IT ONLY SWAPS THE NEURAL VOICE. The hybrid around it is unchanged:
 *   * emphatics (ṭ/ṣ) never reach OmniVoice — synthesize.ts routes emphatic-bearing
 *     words to the espeak REFERENCE engine first (emphatics:'auto'), exactly as it
 *     does for the Piper path. ARPABET cannot spell a pharyngealized consonant, so
 *     this is what keeps the OmniVoice output phonologically honest.
 *   * vowel length (ā/â) is applied AFTER this returns, by the WSOLA stretch in
 *     dsp.ts (synthesize.renderNeural), identically to the Piper path.
 *
 * Where ARPABET is genuinely lossier than Piper's IPA, the loss is returned as a
 * `note` (uvular q → k, ḫ → h, glottal stop dropped) and surfaced through
 * synthesizeDetailed(), never hidden.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav } from './dsp.js';
/**
 * The voice-clone reference this engine ships against, and its provenance.
 * The timbre is cloned from en_US-kristin-medium (Piper) OUTPUT — public-domain
 * LibriVox lineage, the same redistributable voice the Piper path uses. No paid
 * TTS (ElevenLabs etc.) audio is used as a clone reference, so nothing here is
 * encumbered by a "do not clone our output" clause. See README §Licensing.
 */
export const OMNIVOICE_REF_VOICE = 'en_US-kristin-medium (Piper, public-domain lineage)';
/**
 * Default reference clip + its transcript. The clip is included in the npm
 * archive, so a clean install never inherits a path from the build machine.
 */
const DEFAULT_REF_AUDIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'kristin-reference.wav');
const DEFAULT_REF_TEXT = 'abalu sharru bitu ilu';
/**
 * Environment overrides (an install on another host sets these):
 *   EBL_OMNIVOICE_PYTHON   python interpreter that has `omnivoice` importable
 *                          (e.g. .../omnivoice/.venv/bin/python)
 *   EBL_OMNIVOICE_HELPER   path to omnivoice_render.py (default: package-local)
 *   EBL_OMNIVOICE_REF_AUDIO  voice-clone reference WAV
 *   EBL_OMNIVOICE_REF_TEXT   transcript of that reference
 *   EBL_OMNIVOICE_DEVICE     mps | cpu | cuda   (default mps)
 */
function defaultPython() {
    if (process.env.EBL_OMNIVOICE_PYTHON)
        return process.env.EBL_OMNIVOICE_PYTHON;
    // Common local layout: a sibling omnivoice/.venv next to this project.
    const guesses = [
        join(homedir(), 'Projects', 'Theosophia', 'omnivoice', '.venv', 'bin', 'python'),
    ];
    for (const g of guesses)
        if (existsSync(g))
            return g;
    return 'python3';
}
function defaultHelper() {
    if (process.env.EBL_OMNIVOICE_HELPER)
        return process.env.EBL_OMNIVOICE_HELPER;
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', 'scripts', 'omnivoice_render.py'), // package-local (dist/../scripts)
        join(here, '..', '..', 'scripts', 'omnivoice_render.py'),
    ];
    for (const c of candidates)
        if (existsSync(c))
            return c;
    return candidates[0];
}
const ARPA_VOWEL = {
    a: { short: 'AH', long: 'AA' },
    e: { short: 'EH', long: 'EY' },
    i: { short: 'IH', long: 'IY' },
    u: { short: 'UH', long: 'UW' },
    o: { short: 'OW', long: 'OW' },
};
// Keyed by the espeak mnemonic the normalizer already resolved each unit to, so we
// reuse its decisions rather than re-parsing IPA.
const ARPA_CONS = {
    b: { arpa: ['B'] },
    p: { arpa: ['P'] },
    d: { arpa: ['D'] },
    t: { arpa: ['T'] },
    g: { arpa: ['G'] },
    k: { arpa: ['K'] },
    q: { arpa: ['K'], note: 'uvular q → k (ARPABET has no uvular stop)' },
    m: { arpa: ['M'] },
    n: { arpa: ['N'] },
    l: { arpa: ['L'] },
    r: { arpa: ['R'] },
    w: { arpa: ['W'] },
    j: { arpa: ['Y'] }, // eBL y
    s: { arpa: ['S'] },
    z: { arpa: ['Z'] },
    S: { arpa: ['SH'] }, // espeak 'S' == ʃ == eBL š
    x: { arpa: ['HH'], note: 'ḫ [x] → h (ARPABET has no velar fricative)' },
    X: { arpa: ['HH'], note: 'χ → h (ARPABET has no uvular fricative)' },
    '?': { arpa: [], note: 'glottal stop ʔ dropped (no ARPABET symbol)' },
    ts: { arpa: ['T', 'S'], note: 'affricate t͡s → T S (no ARPABET affricate)' },
    dz: { arpa: ['D', 'Z'], note: 'affricate d͡z → D Z (no ARPABET affricate)' },
};
/**
 * Build an ARPABET string from the normalizer's units. Stress (a preceding
 * `stress` unit) is attached as the digit on the next vowel; every other vowel
 * gets `0`. Emphatic units (which normally never arrive here, because
 * emphatics:'auto' routes them to espeak) degrade to their plain stop plus a note,
 * so `emphatics:'neural'` still produces sound rather than throwing.
 */
export function toArpabet(units) {
    const tokens = [];
    const notes = [];
    let pendingStress = false;
    for (const u of units) {
        switch (u.kind) {
            case 'stress':
                pendingStress = true;
                break;
            case 'syllable':
                break;
            case 'space':
                // OmniVoice is driven one word at a time; a space is a soft boundary.
                pendingStress = false;
                break;
            case 'vowel': {
                const base = u.ipa.replace(/[ːˈˌ\.\[\]]/g, '')[0] ?? 'a';
                const map = ARPA_VOWEL[base] ?? ARPA_VOWEL.a;
                const long = (u.length ?? 0) >= 1;
                const stress = pendingStress ? '1' : '0';
                tokens.push((long ? map.long : map.short) + stress);
                pendingStress = false;
                break;
            }
            case 'consonant': {
                if (u.emphatic) {
                    // Only reachable with emphatics:'neural'. ARPABET can't pharyngealize.
                    const stop = u.espeak.startsWith('t') || u.espeak.includes('t') ? 'T' : 'S';
                    tokens.push(stop);
                    notes.push('emphatic ṭ/ṣ flattened to plain in ARPABET (use emphatics:auto for a genuine one via espeak)');
                    break;
                }
                const m = ARPA_CONS[u.espeak];
                if (m) {
                    tokens.push(...m.arpa);
                    if (m.note)
                        notes.push(m.note);
                }
                else {
                    // Unknown mnemonic: uppercase best-effort so nothing is dropped silently.
                    tokens.push(u.espeak.toUpperCase());
                    notes.push(`no ARPABET mapping for "${u.espeak}"; passed through as-is`);
                }
                break;
            }
        }
    }
    return { text: tokens.join(' '), tokens, notes: [...new Set(notes)] };
}
export class OmniVoiceError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OmniVoiceError';
    }
}
/** True when the local OmniVoice python + helper + reference clip are present. */
export function omnivoiceAvailable(opts = {}) {
    const python = opts.python ?? defaultPython();
    const helper = opts.helper ?? defaultHelper();
    const ref = opts.refAudio ?? process.env.EBL_OMNIVOICE_REF_AUDIO ?? DEFAULT_REF_AUDIO;
    // python may be a bare command on PATH, so only hard-check helper + ref here.
    return existsSync(helper) && existsSync(ref) && (python === 'python3' || existsSync(python));
}
/**
 * Render one word's normalized units on OmniVoice, returning raw neural PCM (the
 * caller applies trim + WSOLA length exactly as for Piper).
 */
export async function renderOmniVoiceUnits(units, opts = {}) {
    const python = opts.python ?? defaultPython();
    const helper = opts.helper ?? defaultHelper();
    const refAudio = opts.refAudio ?? process.env.EBL_OMNIVOICE_REF_AUDIO ?? DEFAULT_REF_AUDIO;
    const refText = opts.refText ?? process.env.EBL_OMNIVOICE_REF_TEXT ?? DEFAULT_REF_TEXT;
    const device = opts.device ?? process.env.EBL_OMNIVOICE_DEVICE ?? 'mps';
    if (!existsSync(helper))
        throw new OmniVoiceError(`OmniVoice helper not found: ${helper}\n` +
            `Set EBL_OMNIVOICE_HELPER to the path of scripts/omnivoice_render.py.`);
    if (!existsSync(refAudio))
        throw new OmniVoiceError(`OmniVoice reference audio not found: ${refAudio}\n` +
            `Set EBL_OMNIVOICE_REF_AUDIO to a clean-provenance reference WAV ` +
            `(the package targets ${OMNIVOICE_REF_VOICE}).`);
    const arpa = toArpabet(units);
    if (arpa.tokens.length === 0)
        throw new OmniVoiceError('no ARPABET phones after mapping (empty input?)');
    const dir = mkdtempSync(join(tmpdir(), 'ebl-omnivoice-'));
    const out = join(dir, 'seg.wav');
    try {
        const argv = [
            helper,
            '--arpabet', arpa.text,
            '--ref-audio', refAudio,
            '--ref-text', refText,
            '--output', out,
            '--device', device,
            '--num-step', String(opts.numStep ?? 32),
            '--guidance-scale', String(opts.guidanceScale ?? 2.0),
            '--position-temperature', String(opts.positionTemperature ?? 1.0),
            '--attempts', String(opts.attempts ?? 3),
        ];
        const res = spawnSync(python, argv, {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' },
        });
        if (res.error)
            throw new OmniVoiceError(`failed to launch OmniVoice python (${python}): ${res.error.message}\n` +
                `Set EBL_OMNIVOICE_PYTHON to an interpreter that can 'import omnivoice'.`);
        if (res.status !== 0)
            throw new OmniVoiceError(`omnivoice_render.py exited ${res.status}.\n${(res.stderr || '').trim()}`);
        if (!existsSync(out))
            throw new OmniVoiceError(`omnivoice_render.py wrote no file.\n${(res.stderr || '').trim()}`);
        const pcm = parseWav(readFileSync(out));
        return { pcm, arpabet: arpa.text, notes: arpa.notes };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=omnivoice.js.map