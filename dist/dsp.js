/**
 * dsp.ts — pure-JS audio helpers (no native deps).
 *
 * - parseWav / encodeWav : minimal RIFF/PCM16 read & write
 * - trimSilence          : strip leading/trailing near-silence
 * - wsolaStretch         : WSOLA time-stretch (pitch-preserving), used to turn a
 *                          long vowel into a genuine third ("extra-long") length
 *                          — the revival doc §5.3 "v1 duration post-processing".
 * - concatCrossfade      : equal-power crossfade concatenation of PCM segments
 *
 * All original (MIT). Operates on mono 16-bit PCM (what espeak-ng emits).
 */
/** Parse a canonical RIFF/WAVE PCM buffer (mono/stereo, 8/16-bit). Returns mono. */
export function parseWav(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
        throw new Error('not a WAV file');
    let off = 12;
    let sampleRate = 22050;
    let bits = 16;
    let channels = 1;
    let dataOff = -1;
    let dataLen = 0;
    while (off + 8 <= buf.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, true);
        const body = off + 8;
        if (id === 'fmt ') {
            channels = dv.getUint16(body + 2, true);
            sampleRate = dv.getUint32(body + 4, true);
            bits = dv.getUint16(body + 14, true);
        }
        else if (id === 'data') {
            dataOff = body;
            dataLen = size;
        }
        off = body + size + (size % 2); // chunks are word-aligned
    }
    if (dataOff < 0)
        throw new Error('WAV has no data chunk');
    const bytesPerSample = bits >> 3;
    const frames = Math.floor(dataLen / (bytesPerSample * channels));
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) {
            const p = dataOff + (i * channels + c) * bytesPerSample;
            let s;
            if (bits === 16)
                s = dv.getInt16(p, true);
            else
                s = (buf[p] - 128) << 8; // 8-bit unsigned -> signed 16
            acc += s;
        }
        out[i] = Math.max(-32768, Math.min(32767, Math.round(acc / channels)));
    }
    return { sampleRate, samples: out };
}
/** Encode mono PCM16 to a canonical 44-byte-header WAV buffer. */
export function encodeWav(pcm) {
    const { sampleRate, samples } = pcm;
    const dataLen = samples.length * 2;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataLen, 40);
    for (let i = 0; i < samples.length; i++)
        buf.writeInt16LE(samples[i], 44 + i * 2);
    return buf;
}
export function durationSeconds(pcm) {
    return pcm.samples.length / pcm.sampleRate;
}
/** Strip leading/trailing samples quieter than `thresh` (fraction of full-scale). */
export function trimSilence(pcm, thresh = 0.02, padMs = 5) {
    const s = pcm.samples;
    const t = thresh * 32768;
    let a = 0;
    let b = s.length - 1;
    while (a < s.length && Math.abs(s[a]) < t)
        a++;
    while (b > a && Math.abs(s[b]) < t)
        b--;
    if (a >= b)
        return pcm; // all silence — leave as-is
    const pad = Math.round((padMs / 1000) * pcm.sampleRate);
    a = Math.max(0, a - pad);
    b = Math.min(s.length - 1, b + pad);
    return { sampleRate: pcm.sampleRate, samples: s.slice(a, b + 1) };
}
function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++)
        w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
}
/**
 * WSOLA time-stretch. factor > 1 lengthens, < 1 shortens; pitch is preserved.
 * Robust for quasi-stationary signals (sustained vowels), which is exactly the
 * extra-long-vowel use case.
 */
export function wsolaStretch(pcm, factor) {
    if (Math.abs(factor - 1) < 1e-3 || pcm.samples.length < 2048)
        return pcm;
    const sr = pcm.sampleRate;
    const x = Float32Array.from(pcm.samples, (v) => v / 32768);
    const N = Math.max(256, Math.round(0.03 * sr) | 1); // ~30 ms frame (odd)
    const Hs = N >> 1; // synthesis hop (50% overlap)
    const Ha = Math.max(1, Math.round(Hs / factor)); // analysis hop
    const tol = Math.round(0.005 * sr); // ±5 ms similarity search
    const win = hann(N);
    const overlap = N - Hs;
    // The output is built to EXACTLY round(inLen * factor). Without this the
    // analysis loop stops one frame early and silently under-delivers the stretch
    // (measured: a requested 1.80× came out 1.70×), which would make every duration
    // figure this package reports optimistic by ~5%.
    const targetLen = Math.max(1, Math.round(x.length * factor));
    const outLen = targetLen + N;
    const y = new Float32Array(outLen);
    const norm = new Float32Array(outLen);
    let yPos = 0;
    let aIdx = 0;
    let prevTail = null;
    const addFrame = (start) => {
        for (let k = 0; k < N; k++) {
            const yi = yPos + k;
            if (yi >= outLen)
                break;
            y[yi] += x[start + k] * win[k];
            norm[yi] += win[k];
        }
    };
    const maxStart = Math.max(0, x.length - N);
    while (yPos < targetLen) {
        // Clamp to the last full frame so the loop can keep synthesizing to the
        // target length; on a sustained vowel the clamped frames simply hold the
        // steady state, which is exactly what lengthening a vowel should do.
        let start = Math.min(aIdx, maxStart);
        if (prevTail) {
            // search ±tol for the position whose head best matches prevTail (max x-corr)
            let best = -Infinity;
            let bestDelta = 0;
            const searchFrom = Math.min(aIdx, maxStart);
            for (let delta = -tol; delta <= tol; delta++) {
                const s0 = searchFrom + delta;
                if (s0 < 0 || s0 + overlap >= x.length)
                    continue;
                let dot = 0;
                for (let k = 0; k < overlap; k++)
                    dot += x[s0 + k] * prevTail[k];
                if (dot > best) {
                    best = dot;
                    bestDelta = delta;
                }
            }
            start = Math.min(aIdx, maxStart) + bestDelta;
        }
        start = Math.max(0, Math.min(start, maxStart));
        addFrame(start);
        // the natural continuation region for the next frame's similarity target
        prevTail = x.slice(start + Hs, start + Hs + overlap);
        yPos += Hs;
        aIdx += Ha;
    }
    // Exactly the requested length — the overlap-add tail beyond targetLen is
    // discarded so the delivered factor equals the requested one.
    const out = new Int16Array(targetLen);
    for (let i = 0; i < out.length; i++) {
        const v = norm[i] > 1e-6 ? y[i] / norm[i] : 0;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
    }
    return { sampleRate: sr, samples: out };
}
/**
 * Locate vowel nuclei (syllable peaks) in an isolated word.
 *
 * Used by the NEURAL path: a Piper/VITS voice renders a whole word in one
 * inference (that single pass is what makes it sound human), so to lengthen just
 * ONE vowel we have to find that vowel in the rendered audio afterwards rather
 * than splicing separate renders together.
 *
 * Method (classic, no deps): frame-wise RMS + zero-crossing rate. A vowel is
 * loud and low-ZCR; fricatives/stops are quiet or high-ZCR. Frames passing both
 * gates are grouped into runs, short runs are dropped, and each surviving run is
 * returned as a [start, end) sample span in left-to-right order.
 *
 * Returns [] when nothing convincing is found — callers must handle that.
 */
export function findVowelNuclei(pcm, opts = {}) {
    const frameMs = opts.frameMs ?? 5;
    const minMs = opts.minMs ?? 25;
    const energyRatio = opts.energyRatio ?? 0.25; // fraction of peak frame RMS
    const maxZcr = opts.maxZcr ?? 0.22; // crossings per sample; voiced speech is low
    const dipDb = opts.dipDb ?? 2.5; // valley depth that separates two nuclei
    // Optional: shrink each nucleus to the frames within this fraction of its own
    // peak. OFF by default — measured on Akkadian test words it narrows the span
    // enough that the stretch adds noticeably less duration than the valley-to-
    // valley span does. Available for callers who want the vowel core only.
    const core = opts.core ?? 0;
    const s = pcm.samples;
    const hop = Math.max(1, Math.round((frameMs / 1000) * pcm.sampleRate));
    const nFrames = Math.floor(s.length / hop);
    if (nFrames < 5)
        return [];
    const rms = new Float64Array(nFrames);
    const zcr = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
        const a = f * hop;
        const b = Math.min(s.length, a + hop);
        let acc = 0;
        let cross = 0;
        for (let i = a; i < b; i++) {
            const v = s[i] / 32768;
            acc += v * v;
            if (i > a && s[i] < 0 !== s[i - 1] < 0)
                cross++;
        }
        rms[f] = Math.sqrt(acc / Math.max(1, b - a));
        zcr[f] = cross / Math.max(1, b - a);
    }
    // 3-frame moving average so a single glottal period does not read as a valley
    const sm = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
        const a = Math.max(0, f - 1);
        const b = Math.min(nFrames - 1, f + 1);
        let acc = 0;
        for (let k = a; k <= b; k++)
            acc += rms[k];
        sm[f] = acc / (b - a + 1);
    }
    let peak = 0;
    for (let f = 0; f < nFrames; f++)
        if (sm[f] > peak)
            peak = sm[f];
    if (peak <= 0)
        return [];
    const gate = peak * energyRatio;
    // Pass 1: contiguous voiced+loud runs. Sonorants (l, r, m, n) are voiced and
    // low-ZCR too, so a run may span several syllables — split them in pass 2.
    const runs = [];
    let f = 0;
    while (f < nFrames) {
        if (sm[f] >= gate && zcr[f] <= maxZcr) {
            const a = f;
            while (f < nFrames && sm[f] >= gate && zcr[f] <= maxZcr)
                f++;
            runs.push({ a, b: f });
        }
        else
            f++;
    }
    // Pass 2: inside each run, split at energy valleys deep enough to be a
    // consonant between two vowels (peak-picking with a dip-depth criterion —
    // the standard syllable-nucleus heuristic).
    const dipRatio = Math.pow(10, -dipDb / 20);
    const out = [];
    const minFrames = Math.max(1, Math.round(minMs / frameMs));
    for (const { a, b } of runs) {
        if (b - a < minFrames)
            continue;
        // local maxima inside the run
        const peaks = [];
        for (let f2 = a + 1; f2 < b - 1; f2++)
            if (sm[f2] >= sm[f2 - 1] && sm[f2] > sm[f2 + 1])
                peaks.push(f2);
        if (peaks.length === 0) {
            out.push({ start: a * hop, end: Math.min(s.length, b * hop) });
            continue;
        }
        // keep only peaks separated from the previous kept peak by a real valley
        const kept = [peaks[0]];
        const valleys = [];
        for (let k = 1; k < peaks.length; k++) {
            const prev = kept[kept.length - 1];
            let vmin = Infinity;
            let vIdx = prev;
            for (let f2 = prev; f2 <= peaks[k]; f2++)
                if (sm[f2] < vmin) {
                    vmin = sm[f2];
                    vIdx = f2;
                }
            const lower = Math.min(sm[prev], sm[peaks[k]]);
            if (vmin <= lower * dipRatio) {
                kept.push(peaks[k]);
                valleys.push(vIdx);
            }
            else if (sm[peaks[k]] > sm[prev]) {
                kept[kept.length - 1] = peaks[k]; // same nucleus, taller peak
            }
        }
        // nucleus spans: bounded by the run edges and the valleys between kept peaks
        const bounds = [a, ...valleys, b];
        for (let k = 0; k < kept.length; k++) {
            let st = bounds[k];
            let en = bounds[k + 1];
            if (en - st < minFrames)
                continue;
            if (core > 0) {
                // Shrink to the vowel's high-energy core. Adjacent sonorants (n, l, m, r)
                // are voiced and only moderately quieter than the vowel, so a valley split
                // can leave a shoulder of nasal/lateral inside the span. Keeping only the
                // frames within `core` of the local peak makes the span mean the same
                // thing every time — which matters because the same detector both TARGETS
                // the stretch and MEASURES the result.
                let localPeak = 0;
                for (let f2 = st; f2 < en; f2++)
                    if (sm[f2] > localPeak)
                        localPeak = sm[f2];
                const floor = localPeak * core;
                let cs = kept[k];
                let ce = kept[k];
                while (cs > st && sm[cs - 1] >= floor)
                    cs--;
                while (ce < en - 1 && sm[ce + 1] >= floor)
                    ce++;
                if (ce + 1 - cs >= minFrames) {
                    st = cs;
                    en = ce + 1;
                }
            }
            out.push({ start: st * hop, end: Math.min(s.length, en * hop) });
        }
    }
    return out;
}
/**
 * Time-stretch ONE span of a signal by `factor`, leaving the rest untouched, and
 * splice it back with short equal-power crossfades so the joins are inaudible.
 * This is how the neural path realizes eBL's extra-long vowel: the surrounding
 * consonants keep their natural neural duration; only the flagged vowel grows.
 */
export function stretchSpan(pcm, start, end, factor, fadeMs = 8) {
    const s = pcm.samples;
    const a = Math.max(0, Math.min(start, s.length));
    const b = Math.max(a, Math.min(end, s.length));
    if (b - a < 512 || Math.abs(factor - 1) < 1e-3)
        return pcm;
    const head = { sampleRate: pcm.sampleRate, samples: s.slice(0, a) };
    const mid = { sampleRate: pcm.sampleRate, samples: s.slice(a, b) };
    const tail = { sampleRate: pcm.sampleRate, samples: s.slice(b) };
    const stretched = wsolaStretch(mid, factor);
    const parts = [head, stretched, tail].filter((p) => p.samples.length > 0);
    return concatCrossfade(parts, fadeMs);
}
/** Equal-power crossfade concatenation of PCM segments (all same sample rate). */
export function concatCrossfade(parts, fadeMs = 12) {
    const clean = parts.filter((p) => p.samples.length > 0);
    if (clean.length === 0)
        return { sampleRate: 22050, samples: new Int16Array(0) };
    if (clean.length === 1)
        return clean[0];
    const sr = clean[0].sampleRate;
    const fade = Math.round((fadeMs / 1000) * sr);
    let acc = Float32Array.from(clean[0].samples, (v) => v / 32768);
    for (let idx = 1; idx < clean.length; idx++) {
        const next = Float32Array.from(clean[idx].samples, (v) => v / 32768);
        const f = Math.min(fade, acc.length, next.length);
        const merged = new Float32Array(acc.length + next.length - f);
        merged.set(acc.subarray(0, acc.length - f), 0);
        for (let k = 0; k < f; k++) {
            const t = (k + 1) / (f + 1);
            const g1 = Math.cos((Math.PI / 2) * t); // equal-power out
            const g2 = Math.sin((Math.PI / 2) * t); // equal-power in
            merged[acc.length - f + k] = acc[acc.length - f + k] * g1 + next[k] * g2;
        }
        merged.set(next.subarray(f), acc.length);
        acc = merged;
    }
    const out = new Int16Array(acc.length);
    for (let i = 0; i < acc.length; i++)
        out[i] = Math.max(-32768, Math.min(32767, Math.round(acc[i] * 32768)));
    return { sampleRate: sr, samples: out };
}
//# sourceMappingURL=dsp.js.map