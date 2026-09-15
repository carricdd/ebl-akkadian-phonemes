/**
 * synthesize.ts — the public API (revival doc §5.1).
 *
 *   synthesize(ipa, opts?)       : Promise<Buffer>          // WAV bytes
 *   synthesizeDetailed(ipa, ...) : Promise<SynthesisResult> // WAV + what was done
 *
 * TWO ENGINES, one normalizer:
 *
 *   mode:'neural'    (DEFAULT) Piper VITS via onnxruntime-node, voice
 *                    en_US-kristin-medium. Human-sounding; this is the voice a
 *                    dictionary user should hear. Cannot do true emphatics or a
 *                    third vowel length by itself — see below.
 *
 *   mode:'reference' espeak-ng WASM. Robotic formant synthesis, but its phoneme
 *                    model has explicit pharyngealized/ejective/length features,
 *                    so it is the guaranteed-compliance floor and the only path
 *                    to genuine ejectives.
 *
 * How the two eBL phonetic criteria are met on the neural path:
 *
 *   EMPHATICS (ṭ/ṣ) — `ˤ` is a valid id in the voice's phoneme_id_map but was
 *   never in its English training data, so the neural render is perturbed, not
 *   genuinely pharyngealized (measured — README criterion 1). Default
 *   `emphatics:'auto'` therefore routes emphatic-bearing words to the reference
 *   engine so the contrast is real. `emphatics:'neural'` opts into one consistent
 *   voice at the cost of that guarantee.
 *
 *   EXTRA-LONG VOWELS (â/ê/î/û = aːː) — no stock neural voice stacks a second ː;
 *   measured here, `uːː` came out SHORTER than `uː` (~0.8×). So the word is
 *   rendered in ONE neural pass (preserving coarticulation), the flagged vowel's
 *   acoustic nucleus is located, and only that span is WSOLA time-stretched.
 */
import { normalize, normalizeForPiper, toEspeakString, toPiperPhonemes, } from './normalizer.js';
import { renderPhonemes } from './espeak.js';
import { renderPiperTokens, DEFAULT_VOICE } from './piper.js';
import { renderOmniVoiceUnits, OMNIVOICE_REF_VOICE } from './omnivoice.js';
import { concatCrossfade, encodeWav, findVowelNuclei, stretchSpan, trimSilence, wsolaStretch, } from './dsp.js';
/**
 * Split normalized units into espeak render segments, isolating each extra-long
 * vowel so ONLY that vowel gets the duration stretch. The stressed-syllable mark
 * is re-attached to the isolated vowel (eBL emits stress before the syllable
 * onset; when we peel the vowel off we carry its stress with it).
 */
function segmentForStretch(units, factor) {
    const segs = [];
    let buf = '';
    let pendingStress = false;
    const flush = () => {
        if (buf.length)
            segs.push({ phonemes: buf, stretch: 1 });
        buf = '';
    };
    for (const u of units) {
        switch (u.kind) {
            case 'stress':
                pendingStress = true; // defer; attach to the syllable's vowel
                break;
            case 'syllable':
                break; // boundary is informational
            case 'space':
                buf += ' ';
                break;
            case 'consonant':
                buf += u.espeak;
                break;
            case 'vowel':
                if (u.ultralong) {
                    flush(); // close the prefix (onset consonants stay here, unstressed)
                    segs.push({
                        phonemes: (pendingStress ? "'" : '') + u.espeak,
                        stretch: factor,
                    });
                    pendingStress = false;
                }
                else {
                    buf += (pendingStress ? "'" : '') + u.espeak;
                    pendingStress = false;
                }
                break;
        }
    }
    flush();
    return segs;
}
async function renderReference(ipa, opts, factor) {
    const wpm = opts.wpm ?? 150;
    const norm = normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
    const voice = norm.voice;
    const phonemes = toEspeakString(norm.units);
    if (!norm.hasUltralong) {
        // Fast path: one espeak render for the whole word (best coarticulation).
        // Trim espeak's leading/trailing silence padding so durations are honest
        // and consistent with the extra-long path.
        const pcm = trimSilence(await renderPhonemes(phonemes, { voice, wpm }));
        return { pcm, ultralong: opts.lengths === '2tier' ? 'disabled' : 'none', phonemes };
    }
    // Extra-long path: isolate each ultralong vowel and WSOLA-stretch just it,
    // then crossfade the segments back together (revival doc §5.3, v1).
    const segs = segmentForStretch(norm.units, factor);
    const parts = [];
    for (const s of segs) {
        let seg = await renderPhonemes(s.phonemes, { voice, wpm });
        seg = trimSilence(seg);
        if (s.stretch !== 1)
            seg = wsolaStretch(seg, s.stretch);
        parts.push(seg);
    }
    return { pcm: concatCrossfade(parts), ultralong: 'segment-stretch', phonemes };
}
// ---------------------------------------------------------------------------
// NEURAL engine (Piper VITS)
// ---------------------------------------------------------------------------
async function renderNeural(ipa, opts, factor) {
    const n = normalizeForPiper(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
    const engine = opts.engine ?? 'piper';
    // notes describe THIS engine's approximations, so scope them per branch: the
    // Piper IPA-mapping notes (n.notes) are meaningless on the OmniVoice ARPABET path.
    const notes = [];
    // ---- NEURAL VOICE STAGE (the only part that swaps between engines) ----
    // Both branches return raw neural PCM; everything below (trim + WSOLA length)
    // is engine-agnostic and applies identically.
    let pcm;
    // What the neural voice actually consumed, for --detail (IPA for Piper, ARPABET
    // for OmniVoice — reporting Piper's IPA on the OmniVoice path would be a lie).
    let phonemesReported = n.tokens.join(' ');
    if (engine === 'omnivoice') {
        // OmniVoice consumes ARPABET (built from the same normalized units) and runs
        // in a local Python service. It already first-burst-trims and peak-normalizes.
        const r = await renderOmniVoiceUnits(n.units, opts.omnivoice);
        pcm = r.pcm;
        phonemesReported = r.arpabet;
        for (const note of r.notes)
            notes.push(note);
    }
    else {
        for (const note of n.notes)
            notes.push(note);
        // A trailing period gives VITS a sentence terminator; without one the duration
        // predictor drifts and trailing artefacts creep in on isolated words.
        const tokens = [...n.tokens, '.'];
        const piper = await renderPiperTokens(tokens, {
            voicePath: opts.voicePath,
            lengthScale: opts.lengthScale,
            noiseScale: opts.noiseScale,
            noiseW: opts.noiseW,
            speakerId: opts.speakerId,
        });
        pcm = piper.pcm;
        if (piper.missing.length)
            notes.push(`dropped tokens not in this voice's inventory: ${piper.missing.join(' ')}`);
    }
    // Gentle trim: the model pads isolated words with ~0.2 s of true silence
    // (measured RMS 0.0002), but low-level speech — a fricative onset, a final
    // release — can sit under 1% of full scale. Trim at 0.4% with 15 ms of padding
    // so dead air goes and audible detail stays.
    const trimmed = trimSilence(pcm, 0.004, 15);
    if (!n.hasUltralong)
        return {
            pcm: trimmed,
            ultralong: opts.lengths === '2tier' ? 'disabled' : 'none',
            phonemes: phonemesReported,
            notes,
        };
    // Extra-long vowel: the word was rendered in ONE neural pass, so find the
    // flagged vowel acoustically and stretch only that span.
    const nuclei = findVowelNuclei(trimmed);
    const target = n.ultralongVowelIndices[0];
    let span = null;
    let how = 'nucleus-stretch';
    if (nuclei.length === n.vowelCount && target < nuclei.length) {
        span = nuclei[target]; // clean 1:1 match between written and detected vowels
    }
    else if (nuclei.length > 0 && target === n.vowelCount - 1) {
        span = nuclei[nuclei.length - 1]; // word-final ultralong (the common Akkadian case)
    }
    else if (nuclei.length > target) {
        span = nuclei[target]; // best effort, ordinal match
    }
    if (!span) {
        // Detector found nothing usable: stretch the whole word by the equivalent
        // amount of ADDED time rather than silently ignoring the length contrast.
        how = 'word-stretch';
        const wordFactor = 1 + (factor - 1) / Math.max(1, n.vowelCount * 2);
        notes.push(`vowel-nucleus detection failed (${nuclei.length} nuclei for ${n.vowelCount} vowels); ` +
            `applied a whole-word ${wordFactor.toFixed(2)}× stretch instead`);
        return {
            pcm: wsolaStretch(trimmed, wordFactor),
            ultralong: how,
            phonemes: phonemesReported,
            notes,
        };
    }
    return {
        pcm: stretchSpan(trimmed, span.start, span.end, factor),
        ultralong: how,
        phonemes: phonemesReported,
        notes,
        spanSeconds: (span.end - span.start) / trimmed.sampleRate,
    };
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Does this word contain an emphatic (ṭ/ṣ in any of eBL's notations)? */
function hasEmphatic(ipa, opts) {
    return normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths }).units.some((u) => u.emphatic != null);
}
/**
 * Synthesize eBL IPA to WAV bytes.
 *
 * @param ipa e.g. "[a.ˈbaː.lu]" (brackets optional), the exact string eBL's
 *            dictionary already renders next to each word.
 */
export async function synthesize(ipa, opts = {}) {
    return (await synthesizeDetailed(ipa, opts)).wav;
}
/**
 * Same as synthesize(), but returns the audio together with an account of how it
 * was produced: which engine ran, why, how the extra-long vowel was realized, and
 * every phonetic approximation made. Use this when you need to show your work.
 */
export async function synthesizeDetailed(ipa, opts = {}) {
    if (opts.dialect !== undefined) {
        throw new Error('Dialect conversion is not implemented. Resolve source-specific IPA through the culture/period profile before synthesis; do not silently assume a dialect was applied.');
    }
    const requested = opts.mode ?? 'neural';
    const factor = opts.ultralongFactor ?? 1.8;
    const policy = opts.emphatics ?? 'auto';
    let engine = requested;
    let engineReason;
    if (requested === 'neural') {
        if (opts.emphatic === 'ejective') {
            // `ʼ` U+02BC is absent from Piper's phoneme id map entirely — ejectives are
            // structurally impossible on any stock Piper voice.
            engine = 'reference';
            engineReason =
                "emphatic:'ejective' is not representable on a Piper voice (no ʼ in the phoneme id map); rendered on the reference engine";
        }
        else if (policy === 'reference') {
            engine = 'reference';
            engineReason = "emphatics:'reference' requested";
        }
        else if (policy === 'auto' && hasEmphatic(ipa, opts)) {
            engine = 'reference';
            engineReason =
                "word contains an emphatic (ṭ/ṣ) and emphatics:'auto' is set; rendered on the reference engine so the pharyngealized contrast is genuine. Pass emphatics:'neural' to keep one voice.";
        }
    }
    if (engine === 'reference') {
        const r = await renderReference(ipa, opts, factor);
        return {
            wav: encodeWav(r.pcm),
            engine,
            engineReason,
            sampleRate: r.pcm.sampleRate,
            durationSeconds: r.pcm.samples.length / r.pcm.sampleRate,
            ultralong: r.ultralong,
            ultralongFactor: r.ultralong === 'segment-stretch' ? factor : 1,
            notes: [],
            phonemes: r.phonemes,
        };
    }
    const neuralEngine = opts.engine ?? 'piper';
    const r = await renderNeural(ipa, opts, factor);
    return {
        wav: encodeWav(r.pcm),
        engine,
        engineReason,
        sampleRate: r.pcm.sampleRate,
        durationSeconds: r.pcm.samples.length / r.pcm.sampleRate,
        neuralEngine,
        voice: neuralEngine === 'omnivoice'
            ? OMNIVOICE_REF_VOICE
            : opts.voicePath ?? DEFAULT_VOICE,
        ultralong: r.ultralong,
        ultralongFactor: r.ultralong === 'none' || r.ultralong === 'disabled' ? 1 : factor,
        ultralongSpanSeconds: r.spanSeconds,
        notes: r.notes,
        phonemes: r.phonemes,
    };
}
/**
 * Debug: return the normalized phoneme streams and metadata for an IPA input
 * without synthesizing audio. Shows BOTH engines' targets plus every neural
 * approximation, so a philologist can audit exactly how each symbol was
 * interpreted rather than trusting a black box.
 */
export function explain(ipa, opts = {}) {
    if (opts.dialect !== undefined) {
        throw new Error('Dialect conversion is not implemented. Supply resolved IPA without a dialect option.');
    }
    const norm = normalize(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
    const piper = normalizeForPiper(ipa, { emphatic: opts.emphatic, lengths: opts.lengths });
    return {
        ipa,
        mode: opts.mode ?? 'neural',
        voice: norm.voice, // espeak voice for the reference engine
        emphatic: norm.emphatic,
        lengths: norm.lengths,
        hasUltralong: norm.hasUltralong,
        espeak: toEspeakString(norm.units),
        neural: {
            voice: opts.voicePath ?? DEFAULT_VOICE,
            tokens: toPiperPhonemes(norm.units),
            ultralongVowelIndices: piper.ultralongVowelIndices,
            vowelCount: piper.vowelCount,
            approximations: piper.notes,
        },
        units: norm.units.map((u) => ({
            ipa: u.ipa,
            espeak: u.espeak,
            neural: u.piper,
            kind: u.kind,
            ...(u.piperNote ? { note: u.piperNote } : {}),
        })),
    };
}
//# sourceMappingURL=synthesize.js.map