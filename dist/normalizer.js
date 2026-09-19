/**
 * normalizer.ts
 * -------------
 * The one piece of genuinely new work in this package (revival doc §3.2 + §5.2):
 * map electronic Babylonian Library (eBL) IPA output -> the reference engine's
 * (espeak-ng) phoneme mnemonics, honoring eBL's `basic` / `affricative` /
 * `pharyngealized` variants.
 *
 * eBL emits IPA client-side from its `transcriptionToIpa.json` table. The exact
 * contract we consume (verbatim from that live file, revival doc §3.2):
 *
 *   basic:            y->j  '->ʔ  ʾ->ʔ  ḫ->x  h->x  š->ʃ  ṭ->ᵵ  ṣ->ᵴ
 *                     ā->aː ē->eː ī->iː ū->uː   â->aːː ê->eːː î->iːː û->uːː
 *   affricative:      s->t͡s  ṣ->t̴͡s̴  z->d͡z
 *   pharyngealized:   ṭ->tˤ  ṣ->sˤ
 *   pharyngealized-affricative: ṣ->t͡sˤ
 *
 * Two facts that drive the design:
 *  1. eBL's DEFAULT emphatics are the non-committal placeholders ᵵ (U+1D75) and
 *     ᵴ (U+1D74) — deliberately NOT choosing pharyngealized vs ejective. Only the
 *     `pharyngealized` switch makes eBL emit tˤ/sˤ. So we accept ALL forms of each
 *     emphatic and resolve them via the `emphatic` option.
 *  2. eBL writes the extra-long (circumflex â ê î û) vowels as a STACKED DOUBLE ː
 *     — two U+02D0. That is the literal token we must turn into a genuine third
 *     length (handled downstream by a duration stretch; here we only flag it).
 *
 * Output: an ordered list of PhonemeUnit — enough for the synthesizer to build an
 * espeak `[[...]]` string and to know which vowels are ultralong (so it can stretch
 * only those). Reimplemented from scratch (MIT); no GPL code copied.
 */
// ---- Unicode code points we care about (named for readability) --------------
const U = {
    STRESS_PRIMARY: 'ˈ', // ˈ
    STRESS_SECOND: 'ˌ', // ˌ
    LENGTH: 'ː', // ː
    PHARYNG: 'ˤ', // ˤ  (superscript reversed glottal stop = pharyngealization)
    TILDE_OVERLAY: '̴', // ̴  (eBL's "middle tilde" = emphatic marker on ᵵ/ᵴ decomposed / affricate)
    TIE: '͡', // ͡  (combining double inverted breve = affricate tie)
    EMPHATIC_T: 'ᵵ', // ᵵ  LATIN SMALL LETTER T WITH MIDDLE TILDE
    EMPHATIC_S: 'ᵴ', // ᵴ  LATIN SMALL LETTER S WITH MIDDLE TILDE
    DOT_BELOW: '\u0323', // ̣  combining dot below (Assyriological ṭ/ṣ typed as t + U+0323)
    T_DOT: 'ṭ', // ṭ U+1E6D — the transliteration form; accepted as an emphatic input (0.3.2)
    S_DOT: 'ṣ', // ṣ U+1E63
};
// Plain (non-emphatic) consonant map: eBL-IPA symbol -> espeak mnemonic.
const CONSONANTS = {
    b: 'b',
    p: 'p',
    d: 'd',
    t: 't',
    g: 'g',
    k: 'k',
    q: 'q', // uvular (Akkadian q, if a caller passes it)
    m: 'm',
    n: 'n',
    l: 'l',
    r: 'r',
    w: 'w',
    j: 'j', // eBL y -> j (palatal glide)
    s: 's',
    z: 'z',
    'ʃ': 'S', // ʃ  (eBL š)
    'ʔ': '?', // ʔ  (eBL ʾ / ')
    x: 'x', // eBL ḫ / h
    h: 'x', // fallback: some eBL rows map h -> x
    'χ': 'X', // χ (if a caller passes it) -> espeak uvular X
};
const VOWELS = new Set(['a', 'e', 'i', 'u', 'o']);
// ---- Piper (neural) target inventory ----------------------------------------
// The shipped neural voice is `en_US-kristin-medium` (public-domain lineage —
// chosen for redistributability, see README §Licensing). Its phoneme_id_map is
// Piper's 157-symbol default IPA map, so every token below is a VALID id — but a
// valid id is not the same as a TRAINED one. An English voice has only ever heard
// espeak-`en-us` output, so tokens outside that inventory (χ, q, ʕ …) are
// out-of-distribution and render as noise-shaped guesses.
//
// The rule this table follows: stay IN-DISTRIBUTION on the neural path, and take
// the phonetic loss explicitly (each substitution carries a `note` that surfaces
// through explain()). Callers who need full phonetic fidelity use mode:'reference'
// (espeak-ng), which has real phoneme features for all of it. Every substitution
// here is documented in the README's "Neural substitution table".
const PHARYNG_MARK = 'ˤ'; // ˤ U+02E4 — in the id map; NOT trained on an English voice
const PIPER_CONSONANTS = {
    b: { tokens: ['b'] },
    p: { tokens: ['p'] },
    d: { tokens: ['d'] },
    t: { tokens: ['t'] },
    g: { tokens: ['ɡ'] },
    k: { tokens: ['k'] },
    // Akkadian q is uvular /q/ and contrasts with k. English has no uvular stop, so
    // the neural voice was never trained on `q`; it is folded to k here and the
    // k/q contrast is lost. mode:'reference' keeps it.
    q: { tokens: ['k'], note: 'uvular q → k (English voice has no uvular stop)' },
    m: { tokens: ['m'] },
    n: { tokens: ['n'] },
    l: { tokens: ['l'] },
    r: { tokens: ['r'] },
    w: { tokens: ['w'] },
    j: { tokens: ['j'] }, // eBL y
    s: { tokens: ['s'] },
    z: { tokens: ['z'] },
    'ʃ': { tokens: ['ʃ'] }, // eBL š — native English "sh"
    'ʔ': { tokens: ['ʔ'] }, // eBL ʾ / ' — English glottal stop, trained
    // eBL ḫ is a velar/uvular fricative [x]~[χ]. English has neither; both χ and x
    // are untrained tokens on this voice. /h/ is the nearest trained phone and is
    // non-contrastive in Akkadian (h merged into ḫ), so nothing distinctive is lost.
    x: { tokens: ['h'], note: 'ḫ [x] → h (English voice has no velar fricative)' },
    h: { tokens: ['h'] },
    'χ': { tokens: ['h'], note: 'χ → h (English voice has no uvular fricative)' },
};
const PIPER_VOWELS = {
    a: 'a',
    e: 'e',
    i: 'i',
    u: 'u',
    o: 'o',
};
/**
 * Emphatic → Piper tokens.
 *
 * MEASURED, and stated plainly: `ˤ` is a valid id in this voice's map but the
 * English training data never contained it, so the neural render is perturbed
 * rather than genuinely pharyngealized (a known-untrained control token produced
 * a comparable perturbation — see README §Acceptance criterion 1). Ejective is
 * not even representable: `ʼ` U+02BC is absent from Piper's id map entirely.
 * Phonetically-guaranteed emphatics come from mode:'reference'; synthesize()
 * routes to it automatically by default (see `emphatics` option).
 */
function emphaticPiper(base) {
    const stop = base === 't' ? 't' : 's';
    return {
        tokens: [stop, PHARYNG_MARK],
        note: 'emphatic ˤ is untrained on an English-lineage voice — see README criterion 1',
    };
}
/** Emphatic realization -> espeak mnemonic, keyed by the base sound. */
function emphaticEspeak(base, mode) {
    if (mode === 'ejective') {
        // Ethiosemitic-style ejectives on the Amharic (am) voice — the glottalic
        // reconstruction the card literally calls "glottalised", and the reading
        // Geers' Law supports (pron-akkadian-sumerian.md §1.2).
        if (base === 't')
            return 't`'; // ejective ṭ  (espeak am: t` -> tʼ)
        // No native ejective /sʼ/ in this espeak build; s? = alveolar sibilant + glottal
        // constriction is the closest audible glottalized sibilant. Documented approx.
        return 's?';
    }
    // pharyngealized (default) — espeak's own dental-emphatic mnemonics on the
    // Arabic (ar) voice: t[ -> t̪ , s[ -> s̪ . eBL's `pharyngealized` switch (tˤ/sˤ).
    if (base === 't')
        return 't[';
    if (base === 'affricate-s')
        return 'ts['; // ṣ affricate emphatic -> ts̪
    return 's['; // ṣ -> s̪
}
/**
 * Normalize an eBL-IPA string into ordered phoneme units for the reference engine.
 */
export function normalize(ipa, opts = {}) {
    const emphatic = opts.emphatic ?? 'pharyngealized';
    const lengths = opts.lengths ?? '3tier';
    const chars = Array.from(ipa); // iterate by code point
    const units = [];
    let i = 0;
    let hasUltralong = false;
    const isMark = (c) => c === U.LENGTH || c === U.PHARYNG || c === U.TILDE_OVERLAY;
    while (i < chars.length) {
        const c = chars[i];
        // --- stress + boundary markers (passthrough) ---
        if (c === U.STRESS_PRIMARY || c === U.STRESS_SECOND) {
            // Piper honors espeak's own stress marks ˈ (primary) / ˌ (secondary).
            units.push({ kind: 'stress', ipa: c, espeak: "'", piper: [c] });
            i++;
            continue;
        }
        if (c === '.') {
            // Syllable boundary: informational for espeak string; dropped for Piper
            // tokens (prosody comes from the stress mark).
            units.push({ kind: 'syllable', ipa: c, espeak: '', piper: [] });
            i++;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\n') {
            units.push({ kind: 'space', ipa: c, espeak: ' ', piper: [' '] });
            i++;
            continue;
        }
        // brackets eBL wraps whole words in ([a.ˈbaː.lu]) — ignore
        if (c === '[' || c === ']' || c === '/') {
            i++;
            continue;
        }
        // --- emphatic single-codepoint placeholders ᵵ / ᵴ ---
        const dotBelowNext = (c === 't' || c === 's') && chars[i + 1] === U.DOT_BELOW;
        if (c === U.EMPHATIC_T || c === U.EMPHATIC_S || c === U.T_DOT || c === U.S_DOT || dotBelowNext) {
            const start = i;
            i++;
            if (dotBelowNext)
                i++; // consume the combining dot
            // consume any trailing marks (e.g. a stray ˤ) so they don't leak
            while (i < chars.length && isMark(chars[i]))
                i++;
            const base = c === U.EMPHATIC_T || c === U.T_DOT || c === 't' ? 't' : 's';
            const pm = emphaticPiper(base);
            units.push({
                kind: 'consonant',
                ipa: chars.slice(start, i).join(''),
                espeak: emphaticEspeak(base, emphatic),
                piper: pm.tokens,
                piperNote: pm.note,
                emphatic,
            });
            continue;
        }
        // --- a base sound (consonant or vowel), possibly tied into an affricate,
        //     possibly followed by length / pharyngeal / tilde-overlay marks ---
        const start = i;
        let base = c;
        i++;
        // affricate: base + TIE + base2  (e.g. t͡s, d͡z, t̴͡s̴)
        let affricate = null;
        // a tilde-overlay may sit between the first base and the tie (t̴͡s̴)
        let sawTilde = false;
        while (i < chars.length && chars[i] === U.TILDE_OVERLAY) {
            sawTilde = true;
            i++;
        }
        if (i < chars.length && chars[i] === U.TIE) {
            i++; // consume tie
            if (i < chars.length) {
                affricate = chars[i];
                i++;
            }
        }
        // trailing modifier marks
        let lengthMarks = 0;
        let pharyng = false;
        while (i < chars.length && isMark(chars[i])) {
            if (chars[i] === U.LENGTH)
                lengthMarks++;
            else if (chars[i] === U.PHARYNG)
                pharyng = true;
            else if (chars[i] === U.TILDE_OVERLAY) {
                sawTilde = true;
            }
            i++;
        }
        const ipaSlice = chars.slice(start, i).join('');
        // ----- VOWEL -----
        if (VOWELS.has(base) && !affricate) {
            const len = Math.min(lengthMarks, 2);
            const ultralong = len === 2 && lengths === '3tier';
            if (ultralong)
                hasUltralong = true;
            // espeak gets at most a single ː (a second one saturates — see README);
            // the true third length is applied by the duration stretch downstream.
            const espeakVowel = base + (len >= 1 ? ':' : '');
            // Piper: base vowel + single ː for long/ultralong (espeak-ar has no ːː
            // token; ultralong is realized by the downstream duration stretch, or by
            // a ːː token if the fine-tune was trained with one).
            const pv = PIPER_VOWELS[base] ?? base;
            const piper = len >= 1 ? [pv, U.LENGTH] : [pv];
            units.push({
                kind: 'vowel',
                ipa: ipaSlice,
                espeak: espeakVowel,
                piper,
                length: len,
                ultralong,
            });
            continue;
        }
        // ----- AFFRICATE (t͡s, d͡z, t̴͡s̴, t͡sˤ) -----
        if (affricate) {
            const isEmphatic = pharyng || sawTilde;
            if (base === 't' && affricate === 's') {
                // s->t͡s  (plain affricate) OR ṣ->t̴͡s̴ / t͡sˤ (emphatic affricate)
                const pm = isEmphatic ? emphaticPiper('affricate-s') : { tokens: ['t', 's'] };
                units.push({
                    kind: 'consonant',
                    ipa: ipaSlice,
                    espeak: isEmphatic ? emphaticEspeak('affricate-s', emphatic) : 'ts',
                    // English voice has no /t͡s/ affricate token: rendered as t + s in sequence.
                    piper: pm.tokens,
                    piperNote: pm.note,
                    emphatic: isEmphatic ? emphatic : null,
                });
                continue;
            }
            if (base === 'd' && affricate === 'z') {
                units.push({
                    kind: 'consonant',
                    ipa: ipaSlice,
                    espeak: 'dz',
                    piper: ['d', 'z'],
                    emphatic: null,
                });
                continue;
            }
            // unknown affricate: emit the two bases back to back
            const a = CONSONANTS[base] ?? base;
            const b = CONSONANTS[affricate] ?? affricate;
            const pa = PIPER_CONSONANTS[base];
            const pb = PIPER_CONSONANTS[affricate];
            units.push({
                kind: 'consonant',
                ipa: ipaSlice,
                espeak: a + b,
                piper: [...(pa?.tokens ?? [base]), ...(pb?.tokens ?? [affricate])],
                piperNote: pa?.note ?? pb?.note,
                emphatic: null,
            });
            continue;
        }
        // ----- CONSONANT -----
        const isEmphatic = pharyng || sawTilde;
        if (isEmphatic && (base === 't' || base === 's')) {
            const pm = emphaticPiper(base);
            units.push({
                kind: 'consonant',
                ipa: ipaSlice,
                espeak: emphaticEspeak(base, emphatic),
                piper: pm.tokens,
                piperNote: pm.note,
                emphatic,
            });
            continue;
        }
        const mapped = CONSONANTS[base];
        const pmap = PIPER_CONSONANTS[base];
        if (mapped !== undefined) {
            units.push({
                kind: 'consonant',
                ipa: ipaSlice,
                espeak: mapped,
                piper: pmap?.tokens ?? [base],
                piperNote: pmap?.note,
                emphatic: null,
            });
            continue;
        }
        // Unknown symbol: pass it through verbatim so nothing is silently dropped.
        units.push({
            kind: 'consonant',
            ipa: ipaSlice,
            espeak: base,
            piper: pmap?.tokens ?? [base],
            piperNote: pmap?.note,
            emphatic: null,
        });
    }
    const voice = emphatic === 'ejective' ? 'am' : 'ar';
    return { units, voice, hasUltralong, emphatic, lengths };
}
/**
 * Build a flat espeak `[[...]]`-ready phoneme string from normalized units.
 * espeak wants the primary-stress mark `'` immediately before the stressed
 * syllable's onset, so we keep stress/syllable ordering as emitted by eBL.
 */
export function toEspeakString(units) {
    let out = '';
    for (const u of units) {
        if (u.kind === 'syllable')
            continue; // boundary is informational only
        out += u.espeak;
    }
    return out.trim();
}
const DENTAL = '\u032a'; // ̪ combining bridge below — espeak-ar's emphatic mark, trained on kareem
/** Piper tokens for one unit on an Arabic-trained voice (espeak `ar` inventory). */
function arabicTokens(u, backNext) {
    if (u.kind === 'stress')
        return [u.ipa === U.STRESS_SECOND ? 'ˌ' : 'ˈ'];
    if (u.kind === 'space')
        return [' '];
    if (u.kind === 'syllable')
        return [];
    if (u.kind === 'vowel') {
        const base = u.ipa[0];
        const back = backNext.v && (base === 'a' || base === 'i'); // espeak-ar: s̪ˈa.ːb, s̪ˈi.ːb
        backNext.v = false;
        const out = [base === 'e' ? 'e' : base === 'o' ? 'o' : base];
        if (back)
            out.push('.');
        if ((u.length ?? 0) >= 1)
            out.push(U.LENGTH); // ːː is realized by the duration stretch
        return out;
    }
    // consonant
    const raw = u.ipa.normalize('NFD').replace(/[\u0323\u02e4\u0334]/g, '');
    const base = raw.replace(/[ᵵṭ]/g, 't').replace(/[ᵴṣ]/g, 's');
    if (u.emphatic) {
        // ṭ → t̪ˤ (t̪ is what espeak-ar emits for ط; ˤ is trained via ض dˤ and measured
        // to lower F2 a further ~90 Hz). ṣ → s̪ plus the backed vowel allophone next.
        if (base.startsWith('t') && !base.includes('s'))
            return ['t', DENTAL, 'ˤ'];
        backNext.v = true;
        if (base.includes('t'))
            return ['t', 's', DENTAL]; // affricate ṣ (t͡sˤ)
        return ['s', DENTAL];
    }
    const map = {
        q: ['q'], x: ['χ'], 'χ': ['χ'], h: ['h'], 'ʔ': ['ʔ'], 'ʃ': ['ʃ'], j: ['j'], g: ['ɡ'], 'ɡ': ['ɡ'],
        't͡s': ['t', 's'], 'd͡z': ['d', 'z'],
    };
    if (map[base])
        return map[base];
    return [...base].filter((ch) => ch !== U.TIE);
}
/** Piper token stream for a voice profile. 'english' keeps the 0.3.1 mapping. */
export function toPiperPhonemesFor(units, profile) {
    if (profile === 'english')
        return toPiperPhonemes(units);
    const out = [];
    const backNext = { v: false };
    for (const u of units)
        for (const t of arabicTokens(u, backNext))
            out.push(t);
    while (out.length && out[0] === ' ')
        out.shift();
    while (out.length && out[out.length - 1] === ' ')
        out.pop();
    return out;
}
export function toPiperPhonemes(units) {
    const out = [];
    for (const u of units) {
        for (const t of u.piper ?? [])
            out.push(t);
    }
    // trim leading/trailing spaces
    while (out.length && out[0] === ' ')
        out.shift();
    while (out.length && out[out.length - 1] === ' ')
        out.pop();
    return out;
}
/**
 * Convenience: eBL IPA string -> Piper phoneme tokens for the shipped neural
 * voice. This is the wiring point between eBL's IPA and the audio engine.
 */
export function normalizeForPiper(ipa, opts = {}) {
    const profile = opts.profile ?? 'english';
    const norm = normalize(ipa, opts);
    const ultralongVowelIndices = [];
    let vowelCount = 0;
    for (const u of norm.units) {
        if (u.kind !== 'vowel')
            continue;
        if (u.ultralong)
            ultralongVowelIndices.push(vowelCount);
        vowelCount++;
    }
    // English-voice approximation notes do not apply on an Arabic-trained voice: q, χ, ʔ
    // and the emphatics are all in-distribution there.
    const notes = profile === 'arabic' ? [] : [...new Set(norm.units.map((u) => u.piperNote).filter(Boolean))];
    return {
        tokens: toPiperPhonemesFor(norm.units, profile),
        espeakVoice: profile === 'arabic' ? 'ar' : 'en',
        profile,
        hasUltralong: norm.hasUltralong,
        ultralongVowelIndices,
        vowelCount,
        notes,
        units: norm.units,
    };
}
//# sourceMappingURL=normalizer.js.map