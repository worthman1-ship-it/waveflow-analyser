// Roughness after Daniel & Weber (1997), ported from MoSQITo's roughness_dw (Eomys, Apache-2.0;
// see THIRD_PARTY_NOTICES.md). Deviations from MoSQITo:
//  - Frame length is the power of two nearest 0.2 s (radix-2 FFT), not exactly 0.2 s.
//  - Bin k is taken at k·fs/n (MoSQITo labels it (k+1)·fs/n); DC is excluded.
import { fft } from './fft';

const interp = (x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number => {
  if (x <= xp[0]) return fp[0];
  const n = xp.length;
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] > x) hi = m; else lo = m; }
  return fp[lo] + ((fp[hi] - fp[lo]) * (x - xp[lo])) / (xp[hi] - xp[lo]);
};

const BARK_F = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 510, 570, 630, 700, 770, 840, 920, 1000, 1080, 1170,
  1270, 1370, 1480, 1600, 1720, 1850, 2000, 2150, 2320, 2500, 2700, 2900, 3150, 3400, 3700, 4000, 4400, 4800, 5300,
  5800, 6400, 7000, 7700, 8500, 9500, 10500, 12000, 13500, 15500, 20000];
const BARK_Z = BARK_F.map((_, i) => i * 0.5);
const freq2bark = (f: number) => interp(f, BARK_F, BARK_Z);
const bark2freq = (z: number) => interp(z, BARK_Z, BARK_F);

const EAR_X = [0, 10, 12, 13, 14, 15, 16, 16.5, 17, 18, 18.5, 19, 20, 21, 21.5, 22, 22.5, 23, 23.5, 24, 25, 26];
const EAR_Y = [0, 0, 1.15, 2.31, 3.85, 5.62, 6.92, 7.38, 6.92, 4.23, 2.31, 0, -1.43, -2.59, -3.57, -5.19, -7.41, -11.3, -20, -40, -130, -999];
const LTQ_X = [0, 0.01, 0.17, 0.8, 1, 1.5, 2, 3.3, 4, 5, 6, 8, 10, 12, 13.3, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 24.5, 25];
const LTQ_Y = [130, 70, 60, 30, 25, 20, 15, 10, 8.1, 6.3, 5, 3.5, 2.5, 1.7, 0, -2.5, -4, -3.7, -1.5, 1.4, 3.8, 5, 7.5, 15, 48, 60, 130];
const GR_Y = [0.15, 0.26, 0.38, 0.47, 0.54, 0.65, 0.76, 0.83, 0.9, 0.98, 0.98, 0.9, 0.8, 0.7, 0.62, 0.54, 0.49, 0.43, 0.39, 0.35, 0.3, 0.3, 0.3, 0.3, 0.3];
const GR_X = GR_Y.map((_, i) => i);

const H_TABLES: { x: number[]; y: number[]; lastHz: number }[] = [
  { x: [0, 17, 23, 25, 32, 37, 48, 67, 90, 114, 171, 206, 247, 294, 358], y: [0, 0.8, 0.95, 0.975, 1, 0.975, 0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0], lastHz: 358 },
  { x: [0, 32, 43, 56, 69, 92, 120, 142, 165, 231, 277, 331, 397, 502], y: [0, 0.8, 0.95, 1, 0.975, 0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0], lastHz: 502 },
  { x: [0, 23.5, 34, 47, 56, 63, 79, 100, 115, 135, 159, 172, 194, 215, 244, 290, 348, 415, 500, 645], y: [0, 0.4, 0.6, 0.8, 0.9, 0.95, 1, 0.975, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0], lastHz: 502 },
  { x: [0, 19, 44, 52.5, 58, 75, 101.5, 114.5, 132.5, 143.5, 165.5, 197.5, 241, 290, 348, 415, 500, 645], y: [0, 0.4, 0.8, 0.9, 0.95, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0], lastHz: 502 },
  { x: [0, 15, 41, 49, 53, 64, 71, 88, 94, 106, 115, 137, 180, 238, 290, 348, 415, 500, 645], y: [0, 0.4, 0.8, 0.9, 0.965, 0.99, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0], lastHz: 502 },
];
// Channel (0-based) → H table index, as in MoSQITo: 0–3 → H2, 4–14 → H5, 15–19 → H16, 20–40 → H21, 41–46 → H42
const H_FOR_CHANNEL = (i: number) => (i <= 3 ? 0 : i <= 14 ? 1 : i <= 19 ? 2 : i <= 40 ? 3 : 4);

function hWeights(n: number, fs: number): Float64Array[] {
  const cut = 2;
  const tabs = H_TABLES.map(({ x, y, lastHz }) => {
    const h = new Float64Array(n);
    const last = Math.floor((lastHz / fs) * n);
    for (let j = cut; j < last; j++) h[j] = interp(((j - cut) * fs) / n, x, y);
    return h;
  });
  return Array.from({ length: 47 }, (_, i) => tabs[H_FOR_CHANNEL(i)]);
}

function corrcoef(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const N_CH = 47;

/** Roughness (asper) of one frame of sound pressure (Pa); frame length must be a power of two. */
export function roughnessFrame(frame: Float64Array, fs: number, H: Float64Array[]): number {
  const n = frame.length, half = n / 2;
  // Blackman window normalised by its sum, ×1.42 (as MoSQITo comp_spectrum)
  const re = new Float64Array(n), im = new Float64Array(n);
  let wsum = 0;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    wsum += w[i];
  }
  for (let i = 0; i < n; i++) re[i] = (frame[i] * w[i]) / wsum;
  fft(re, im);

  const specRe = new Float64Array(half), specIm = new Float64Array(half);
  const module = new Float64Array(half), specDb = new Float64Array(half);
  const bark = new Float64Array(half), thr = new Float64Array(half);
  const audible: number[] = [];
  for (let k = 0; k < half; k++) {
    const f = (k * fs) / n;
    bark[k] = freq2bark(f);
    const a0 = 10 ** (interp(bark[k], EAR_X, EAR_Y) / 20);
    specRe[k] = re[k] * 1.42 * a0;
    specIm[k] = im[k] * 1.42 * a0;
    module[k] = Math.hypot(specRe[k], specIm[k]);
    specDb[k] = 20 * Math.log10(Math.max(module[k], 2e-12) / 2e-5);
    thr[k] = interp(bark[k], LTQ_X, LTQ_Y);
    if (k > 0 && specDb[k] > thr[k]) audible.push(k);
  }

  const binAxis = Float64Array.from({ length: half }, (_, k) => k);
  const minExcitDb = Array.from({ length: N_CH }, (_, j) => interp((bark2freq((j + 1) / 2) * n) / fs, binAxis, thr));

  const s1 = -27;
  const nA = audible.length;
  const chLow = new Int32Array(nA), chHigh = new Int32Array(nA);
  const slopes = audible.map(() => new Float64Array(N_CH));
  audible.forEach((k, a) => {
    const b = bark[k], lev = specDb[k];
    const f = (k * fs) / n;
    const s2 = Math.min(-24 - 230 / f + 0.2 * lev, 0);
    chLow[a] = Math.floor(2 * b) - 1;
    chHigh[a] = Math.ceil(2 * b) - 1;
    for (let j = 0; j <= chLow[a] && j < N_CH; j++) {
      const sl = s1 * (b - (j + 1) * 0.5) + lev;
      if (sl > minExcitDb[j]) slopes[a][j] = 2e-5 * 10 ** (sl / 20);
    }
    for (let j = Math.max(0, chHigh[a]); j < N_CH; j++) {
      const sl = s2 * ((j + 1) * 0.5 - b) + lev;
      if (sl > minExcitDb[j]) slopes[a][j] = 2e-5 * 10 ** (sl / 20);
    }
  });

  const hBP: Float64Array[] = [];
  const modDepth = new Float64Array(N_CH);
  const er = new Float64Array(n), ei = new Float64Array(n);
  for (let i = 0; i < N_CH; i++) {
    er.fill(0); ei.fill(0);
    for (let a = 0; a < nA; a++) {
      const k = audible[a];
      let ampl: number;
      if (chLow[a] === i || chHigh[a] === i) ampl = 1;
      else if (chHigh[a] > i) ampl = i + 1 < N_CH ? slopes[a][i + 1] / module[k] : 0;
      else ampl = i - 1 >= 0 ? slopes[a][i - 1] / module[k] : 0;
      er[k] = ampl * specRe[k];
      ei[k] = ampl * specIm[k];
    }
    fft(er, ei, true); // unscaled inverse = n·ifft
    let h0 = 0;
    for (let t = 0; t < n; t++) { er[t] = Math.abs(er[t]); h0 += er[t]; }
    h0 /= n;
    for (let t = 0; t < n; t++) { er[t] -= h0; ei[t] = 0; }
    fft(er, ei);
    const Hi = H[i];
    for (let t = 0; t < n; t++) { er[t] *= Hi[t]; ei[t] *= Hi[t]; }
    fft(er, ei, true);
    const bp = new Float64Array(n);
    let ss = 0;
    for (let t = 0; t < n; t++) { bp[t] = (2 * er[t]) / n; ss += bp[t] * bp[t]; }
    hBP.push(bp);
    const hrms = Math.sqrt(ss / n);
    modDepth[i] = h0 > 0 ? Math.min(1, hrms / h0) : 0;
  }

  const ki = new Float64Array(N_CH);
  for (let i = 0; i < 45; i++) ki[i] = corrcoef(hBP[i], hBP[i + 2]);
  const gzi = (i: number) => interp((i + 1) / 2, GR_X, GR_Y);
  let R = 0;
  R += gzi(0) * (modDepth[0] * ki[0]) ** 2;
  R += gzi(1) * (modDepth[1] * ki[1]) ** 2;
  for (let i = 2; i < 45; i++) R += gzi(i) * (modDepth[i] * ki[i] * ki[i - 2]) ** 2;
  R += gzi(45) * (modDepth[45] * ki[43]) ** 2;
  R += gzi(46) * (modDepth[46] * ki[44]) ** 2;
  return 0.25 * R;
}

export interface RoughnessResult { R: Float32Array; dt: number; frameSec: number; mean: number; max: number }

export function roughness(x: Float64Array, fs: number, overlap: number, onProgress?: (f: number) => void): RoughnessResult {
  const n = 2 ** Math.round(Math.log2(0.2 * fs));
  const hop = Math.max(1, Math.round(n * (1 - overlap)));
  const nFrames = x.length >= n ? 1 + Math.floor((x.length - n) / hop) : 0;
  if (!nFrames) throw new Error(`Signal shorter than one roughness frame (${(n / fs).toFixed(3)} s)`);
  const H = hWeights(n, fs);
  const R = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    R[f] = roughnessFrame(x.subarray(f * hop, f * hop + n), fs, H);
    onProgress?.((f + 1) / nFrames);
  }
  let sum = 0, max = 0;
  for (const r of R) { sum += r; if (r > max) max = r; }
  return { R, dt: hop / fs, frameSec: n / fs, mean: sum / nFrames, max };
}
