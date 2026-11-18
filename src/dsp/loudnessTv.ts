// Time-varying loudness after ISO 532-1:2017 (Zwicker method, section 6 / Annex A).
//
// Pipeline (all at the standard's 48 kHz): 28 one-third-octave filters with the Annex A
// coefficient tables → squaring and three first-order smoothers (τ = 2/(3 f), f ≤ 1 kHz,
// else 2/3 ms) → level per band at 2 kHz → core loudness → non-linear temporal decay →
// specific loudness and total loudness N(t) → temporal weighting (3.5 ms and 70 ms low-passes).
// Structure, constants and tables follow MoSQITo's implementation (Eomys, Apache-2.0,
// see THIRD_PARTY_NOTICES.md). Output N(t) is sampled every 2 ms.
// Signals at other sample rates are resampled to 48 kHz first (the standard requires 48 kHz).
import { sosFilter, type Sos } from './biquad';
import { calcSlopes, coreLoudness } from './loudness';
import { DIFF, GAIN } from './iso532Tables';

const FS = 48000;
const DEC = 24; // 48 kHz → 2 kHz internal rate (0.5 ms)
const NB = 28;
const REF_ROWS = [[1, 2, 1], [1, 0, -1], [1, -2, 1]];
const CENTRES = Array.from({ length: NB }, (_, i) => 1000 * 10 ** ((i - 16) / 10));

/** Windowed-sinc resampler to 48 kHz (Blackman window, 32-tap half width at the lower of the two Nyquists). */
export function resampleTo48k(x: Float64Array, fs: number): Float64Array {
  if (fs === FS) return x;
  const ratio = fs / FS; // input samples per output sample
  const nOut = Math.floor(x.length / ratio);
  const cut = Math.min(1, 1 / ratio); // cutoff relative to input Nyquist
  const half = 16 / cut;
  const out = new Float64Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const t = i * ratio;
    let acc = 0;
    for (let k = Math.ceil(t - half); k <= Math.floor(t + half); k++) {
      if (k < 0 || k >= x.length) continue;
      const d = k - t, u = d / half;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * cut * d) / (Math.PI * cut * d);
      const win = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      acc += x[k] * cut * sinc * win;
    }
    out[i] = acc;
  }
  return out;
}

function bandSos(b: number): Sos {
  return REF_ROWS.map((num, k) => ({
    b0: num[0] * (k === 0 ? GAIN[b] : 1), b1: num[1] * (k === 0 ? GAIN[b] : 1), b2: num[2] * (k === 0 ? GAIN[b] : 1),
    a1: -2 - DIFF[b][k][0], a2: 1 - DIFF[b][k][1],
  }));
}

/** Third-octave levels (dB re 20 µPa, intensity convention of the standard) at 2 kHz: [time][band]. */
export function thirdOctaveLevels2k(x48: Float64Array, onProgress?: (f: number) => void): Float64Array[] {
  const nT = Math.ceil(x48.length / DEC);
  const levels = Array.from({ length: nT }, () => new Float64Array(NB));
  for (let b = 0; b < NB; b++) {
    const y = sosFilter(bandSos(b), x48);
    const tau = CENTRES[b] <= 1000 ? 2 / (3 * CENTRES[b]) : 2 / 3000;
    const a1 = Math.exp(-1 / (FS * tau)), b0 = 1 - a1;
    for (let i = 0; i < y.length; i++) y[i] *= y[i];
    for (let pass = 0; pass < 3; pass++) {
      let s = 0;
      for (let i = 0; i < y.length; i++) { s = a1 * s + b0 * y[i]; y[i] = s; }
    }
    for (let t = 0; t < nT; t++) levels[t][b] = 10 * Math.log10((y[t * DEC] + 1e-12) / 4e-10);
    onProgress?.((b + 1) / NB * 0.5);
  }
  return levels;
}

/** Non-linear temporal decay of the core loudness (one row = one critical-band slot), 2 kHz in / out. */
export function nonlinearDecay(core: Float64Array[]): Float64Array[] {
  const T = core.length, rows = core[0].length;
  const NL = 24, sr = 2000;
  const tShort = 0.005, tLong = 0.015, tVar = 0.075;
  const dt = 1 / (sr * NL);
  const P = (tVar + tLong) / (tVar * tShort), Q = 1 / (tShort * tVar);
  const l1 = -P / 2 + Math.sqrt((P * P) / 4 - Q), l2 = -P / 2 - Math.sqrt((P * P) / 4 - Q);
  const den = tVar * (l1 - l2);
  const e1 = Math.exp(l1 * dt), e2 = Math.exp(l2 * dt);
  const B0 = (e1 - e2) / den;
  const B1 = ((tVar * l2 + 1) * e1 - (tVar * l1 + 1) * e2) / den;
  const B2 = ((tVar * l1 + 1) * e1 - (tVar * l2 + 1) * e2) / den;
  const B3 = ((tVar * l1 + 1) * (tVar * l2 + 1) * (e1 - e2)) / den;
  const B4 = Math.exp(-dt / tLong);
  const B5 = Math.exp(-dt / tVar);

  const out = Array.from({ length: T }, () => new Float64Array(rows));
  for (let r = 0; r < rows; r++) {
    let uoP = 0, u2P = 0;
    for (let t = 0; t < T; t++) {
      const c0 = core[t][r], c1 = t + 1 < T ? core[t + 1][r] : 0;
      const delta = (c1 - c0) / NL;
      for (let i = 0; i < NL; i++) {
        const ui = c0 + i * delta; // linear interpolation between samples
        let uo = ui;
        let uo2 = uoP * B2 - u2P * B3;
        if (uoP > u2P && uo2 >= ui) uo = uo2;
        uo2 = uoP * B4;
        if (uoP <= u2P && uo2 >= ui) uo = uo2;
        let u2 = uo;
        const u22 = uoP * B0 - u2P * B1;
        if (ui < uoP && uoP > u2P && u22 <= uo) u2 = u22;
        if (ui >= uoP && !(Math.abs(ui - uoP) < 1e-5 && uo <= u2P)) u2 = (u2P - ui) * B5 + ui;
        if (i === 0) out[t][r] = uo;
        uoP = uo; u2P = u2;
      }
    }
  }
  return out;
}

/** First-order low-pass with linear interpolation (24 inner steps) at 2 kHz. */
function lowpassIntp(x: Float64Array, tau: number): Float64Array {
  const NL = 24, sr = 2000;
  const a1 = Math.exp(-1 / (sr * NL * tau)), b0 = 1 - a1;
  const out = new Float64Array(x.length);
  let y = 0;
  for (let t = 0; t < x.length; t++) {
    const c1 = t + 1 < x.length ? x[t + 1] : 0;
    const delta = (c1 - x[t]) / NL;
    for (let i = 0; i < NL; i++) {
      y = a1 * y + b0 * (x[t] + i * delta);
      if (i === 0) out[t] = y;
    }
  }
  return out;
}

export interface LoudnessTvResult {
  /** Loudness vs time, sone, every 2 ms. */
  N: Float32Array; dt: number;
  Nmax: number; tNmax: number; Nmean: number;
  /** Loudness exceeded in x % of the time. */
  N5: number; N10: number; N50: number; N95: number;
  /** Loudness level at Nmax, phon. */
  LNmax: number;
}

export function loudnessTimeVarying(
  x: Float64Array, fs: number, field: 'free' | 'diffuse', onProgress?: (f: number) => void,
): LoudnessTvResult {
  const x48 = resampleTo48k(x, fs);
  if (x48.length < FS * 0.1) throw new Error('Signal too short for time-varying loudness (needs ≥ 0.1 s)');
  const lev = thirdOctaveLevels2k(x48, onProgress);
  const core = lev.map((l) => {
    const c = Float64Array.from(l);
    for (let i = 0; i < 11; i++) c[i] = Math.min(c[i], 120); // the method is not defined above 120 dB; clip
    return Float64Array.from(coreLoudness(c, field));
  });
  onProgress?.(0.6);
  const nl = nonlinearDecay(core);
  onProgress?.(0.8);
  const raw = new Float64Array(nl.length);
  for (let t = 0; t < nl.length; t++) raw[t] = calcSlopes(Array.from(nl[t])).N;
  const f1 = lowpassIntp(raw, 3.5e-3), f2 = lowpassIntp(raw, 70e-3);
  const n = Math.ceil(raw.length / 4);
  const N = new Float32Array(n);
  for (let k = 0; k < n; k++) N[k] = 0.47 * f1[k * 4] + 0.53 * f2[k * 4];

  const sorted = Float32Array.from(N).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; // p = fraction below
  let max = 0, kMax = 0, sum = 0;
  for (let k = 0; k < n; k++) { sum += N[k]; if (N[k] > max) { max = N[k]; kMax = k; } }
  const phon = (v: number) => (v >= 1 ? 40 + 10 * Math.log2(v) : 40 * (v + 0.0005) ** 0.35);
  return {
    N, dt: 0.002, Nmax: max, tNmax: kMax * 0.002, Nmean: sum / n,
    N5: at(0.95), N10: at(0.9), N50: at(0.5), N95: at(0.05), LNmax: phon(max),
  };
}
