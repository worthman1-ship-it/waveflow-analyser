// Tonality: tone-to-noise ratio (TNR) and prominence ratio (PR) after ECMA-74 Annex D /
// ISO 7779, plus an Aures-type tonality (unit: tu) from the same tone detection.
//
// Approximations to know about:
//  - Tones are found as local spectral maxima in a Hann-windowed power spectrum; the tone
//    occupies the peak bin ±2 bins. Noise is the critical-band power with all detected tones removed,
//    scaled to the full band.
//  - Aures: K = 1.09 · w_T^0.29 · w_Gr^0.79 with w_T = √Σ(w_i·w_f,i)², w_i = 1 − exp(−ΔL/15 dB),
//    w_f(f) = (1 + 0.2(f/700 + 700/f)²)^−½. The loudness ratio w_Gr = 1 − N_noise/N_total is
//    estimated from the power ratio with N ∝ P^0.23 instead of a full loudness calculation.
//    A single 1 kHz tone gives ≈ 1 tu, as in the definition of the unit.
import { fft, hann } from './fft';

export interface ToneInfo {
  f: number; levelDb: number; tnr: number; pr: number; prominent: boolean;
}

const cbw = (f: number) => 25 + 75 * (1 + 1.4 * (f / 1000) ** 2) ** 0.69; // critical bandwidth, Hz
/** ECMA-74 prominence thresholds (dB). */
const tnrLimit = (f: number) => (f >= 1000 ? 8 : 8 + 8.33 * Math.log10(1000 / f));
const prLimit = (f: number) => (f >= 1000 ? 9 : 9 + 10 * Math.log10(1000 / f));
const MIN_TNR = 6; // candidates below this are not reported as tones

/** One-sided power spectrum (mean square per bin) of a Hann-windowed frame. */
export function powerSpectrum(x: ArrayLike<number>, start: number, nfft: number, w: Float64Array, wss: number) {
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) re[i] = x[start + i] * w[i];
  fft(re, im);
  const p = new Float64Array(nfft / 2 + 1);
  // Normalised so that the sum over a tone's bins is its mean-square value.
  for (let k = 1; k < nfft / 2; k++) p[k] = (2 * (re[k] * re[k] + im[k] * im[k])) / (nfft * wss);
  return p;
}

export interface FrameTonality { tones: ToneInfo[]; aures: number; tnrMax: number; prMax: number; fTnr: number }

/** Detect tones in a power spectrum and evaluate TNR, PR and Aures tonality. */
export function analyseSpectrum(p: Float64Array, fs: number, nfft: number, ref: number): FrameTonality {
  const df = fs / nfft, nb = p.length;
  const kOf = (f: number) => Math.round(f / df);
  // Candidate tones: local maxima (±3 bins) well above their surroundings (±10 bins).
  const cand: number[] = [];
  for (let k = kOf(50); k < Math.min(nb - 11, kOf(Math.min(fs / 2 - 100, 12000))); k++) {
    if (p[k] <= 0) continue;
    let isMax = true;
    for (let j = -3; j <= 3 && isMax; j++) if (j && p[k + j] >= p[k]) isMax = false;
    if (!isMax) continue;
    let s = 0, c = 0;
    for (let j = 4; j <= 10; j++) { s += p[k - j] + p[k + j]; c += 2; }
    if (p[k] > 4 * (s / c)) cand.push(k); // ≥ 6 dB
  }
  const isTone = new Uint8Array(nb);
  for (const k of cand) for (let j = -2; j <= 2; j++) isTone[k + j] = 1;

  const bandPower = (f1: number, f2: number, skipTones: boolean) => {
    let s = 0, c = 0, all = 0;
    for (let k = Math.max(1, Math.ceil(f1 / df)); k <= Math.min(nb - 2, Math.floor(f2 / df)); k++) {
      all++;
      if (skipTones && isTone[k]) continue;
      s += p[k]; c++;
    }
    return { s, c, all };
  };

  const tones: ToneInfo[] = [];
  let wt2 = 0, tonalPower = 0;
  for (const k of cand) {
    const f = k * df, bw = cbw(f);
    let pt = 0;
    for (let j = -2; j <= 2; j++) pt += p[k + j];
    const band = bandPower(f - bw / 2, f + bw / 2, true);
    if (band.c < 4) continue;
    const pn = Math.max((band.s / band.c) * band.all, 1e-300); // noise scaled to the full critical band
    const tnr = 10 * Math.log10(pt / pn);
    if (tnr < MIN_TNR) continue;
    const centre = bandPower(f - bw / 2, f + bw / 2, false).s;
    const lo = bandPower(f - 1.5 * bw, f - bw / 2, false).s, hi = bandPower(f + bw / 2, f + 1.5 * bw, false).s;
    const adj = (lo > 0 && hi > 0 ? (lo + hi) / 2 : Math.max(lo, hi)) || 1e-300;
    const pr = 10 * Math.log10(centre / adj);
    tones.push({
      f, levelDb: 10 * Math.log10(pt / (ref * ref)), tnr, pr,
      prominent: tnr >= tnrLimit(f) && pr >= prLimit(f),
    });
    const wi = 1 - Math.exp(-Math.min(tnr, 50) / 15);
    const wf = (1 + 0.2 * (f / 700 + 700 / f) ** 2) ** -0.5;
    wt2 += (wi * wf) ** 2;
    tonalPower += pt;
  }
  let total = 0;
  for (let k = 1; k < nb - 1; k++) total += p[k];
  const wGr = total > 0 ? 1 - (Math.max(total - tonalPower, 0) / total) ** 0.23 : 0;
  const aures = tones.length ? 1.09 * Math.sqrt(wt2) ** 0.29 * Math.max(wGr, 0) ** 0.79 : 0;
  tones.sort((a, b) => b.tnr - a.tnr);
  return {
    tones, aures,
    tnrMax: tones[0]?.tnr ?? -Infinity, fTnr: tones[0]?.f ?? 0,
    prMax: tones.length ? Math.max(...tones.map((t) => t.pr)) : -Infinity,
  };
}

export interface TonalityResult {
  /** Aures tonality per frame (tu) and max TNR per frame (dB). */
  K: Float32Array; tnr: Float32Array; dt: number;
  Kmean: number; Kmax: number; tnrMax: number; fTnr: number; prMax: number;
  /** TNR/PR figures and tones are from the whole-file average spectrum; K and the plot are per frame.
   *  Tones found in the average spectrum, strongest first (up to 8). */
  tones: ToneInfo[]; aures: number; nfft: number; frameSec: number;
}

export function tonality(x: Float64Array, fs: number, ref: number, nfft = 16384): TonalityResult {
  while (nfft > x.length && nfft > 1024) nfft /= 2;
  if (x.length < nfft) throw new Error('Signal too short for tonality analysis');
  const hop = nfft / 2, w = hann(nfft);
  let wss = 0;
  for (let i = 0; i < nfft; i++) wss += w[i] * w[i];
  const nFrames = 1 + Math.floor((x.length - nfft) / hop);
  const K = new Float32Array(nFrames), tnr = new Float32Array(nFrames);
  const avg = new Float64Array(nfft / 2 + 1);
  let kMax = 0, kSum = 0;
  for (let f = 0; f < nFrames; f++) {
    const p = powerSpectrum(x, f * hop, nfft, w, wss);
    for (let k = 0; k < p.length; k++) avg[k] += p[k];
    const r = analyseSpectrum(p, fs, nfft, ref);
    K[f] = r.aures; tnr[f] = isFinite(r.tnrMax) ? r.tnrMax : 0;
    kSum += r.aures; kMax = Math.max(kMax, r.aures);
  }
  for (let k = 0; k < avg.length; k++) avg[k] /= nFrames;
  const a = analyseSpectrum(avg, fs, nfft, ref);
  return {
    K, tnr, dt: hop / fs, Kmean: kSum / nFrames, Kmax: kMax, tnrMax: a.tnrMax, fTnr: a.fTnr, prMax: a.prMax,
    tones: a.tones.slice(0, 8), aures: a.aures, nfft, frameSec: nfft / fs,
  };
}
