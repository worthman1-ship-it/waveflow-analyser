// Fluctuation strength (slow loudness modulation, 0.5–20 Hz, unit: vacil).
//
// Simplified Fastl & Zwicker model, NOT a reference implementation:
//   F = K · Σ_bands ΔL_b · g(f_mod,b) · Δz_b,   g(f) = 1 / (f/4 + 4/f)
// where ΔL_b is the peak-to-peak level swing (dB) of the third-octave band envelope at its
// dominant modulation frequency, Δz_b the band's width in Bark, and K is set so that a 1 kHz,
// 60 dB tone with 100 % AM at 4 Hz gives exactly 1 vacil (the definition of the unit).
// The modulation spectrum is evaluated in 2 s windows (0.5 Hz resolution).
import { fft, hann, nextPow2 } from './fft';
import { THIRD_OCT_CENTRES, thirdOctaveLevels } from './loudness';

const ENV_DT = 0.01; // envelope sample interval, 100 Hz
const MOD_LO = 0.5, MOD_HI = 20;
const DL_MAX = 40; // masking limits the useful level swing
const WIN = 2; // seconds
const HOP = 0.25;
const g = (f: number) => 1 / (f / 4 + 4 / f);
const bark = (f: number) => 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) ** 2);

const bandEdges = (b: number) => {
  const fm = 1000 * 10 ** ((b - 16) / 10);
  return [fm * 10 ** -0.05, fm * 10 ** 0.05];
};
const dz = THIRD_OCT_CENTRES.map((_, b) => { const [lo, hi] = bandEdges(b); return bark(hi) - bark(lo); });
/** Bands below 100 Hz are too narrow for the 10 ms envelope; skip them. */
const FIRST_BAND = THIRD_OCT_CENTRES.indexOf(100);
/** K such that 1 kHz 100 % AM at 4 Hz (ΔL capped at DL_MAX) gives 1 vacil. */
const K = 1 / (DL_MAX * g(4) * dz[THIRD_OCT_CENTRES.indexOf(1000)]);

export interface FluctuationResult {
  F: Float32Array; dt: number; mean: number; max: number; fmod: number; windowSec: number;
}

/** Peak amplitude of the strongest modulation line in [0.5, 20] Hz relative to the envelope mean. */
function modulation(env: Float64Array, start: number, n: number, nfft: number, w: Float64Array, wss: number) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[start + i];
  mean /= n;
  if (mean <= 0) return { m: 0, f: 0 };
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = (env[start + i] - mean) * w[i];
  fft(re, im);
  const df = 1 / (ENV_DT * nfft);
  const kLo = Math.max(1, Math.ceil(MOD_LO / df)), kHi = Math.min(nfft / 2 - 1, Math.floor(MOD_HI / df));
  let kp = kLo, pk = -1;
  for (let k = kLo; k <= kHi; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    if (p > pk) { pk = p; kp = k; }
  }
  // Energy of the main lobe (Hann main lobe) → sinusoid amplitude, robust to zero-padding and scalloping.
  let e = 0;
  const half = Math.ceil((2 * nfft) / n); // Hann main lobe is ±2 bins of the unpadded FFT
  for (let k = Math.max(1, kp - half); k <= Math.min(nfft / 2 - 1, kp + half); k++) e += re[k] * re[k] + im[k] * im[k];
  const amp = Math.sqrt((4 * e) / (nfft * wss));
  return { m: amp / mean, f: kp * df };
}

export function fluctuationStrength(x: Float64Array, fs: number, onProgress?: (f: number) => void): FluctuationResult {
  const tl = thirdOctaveLevels(x, fs, ENV_DT);
  const nb = tl.blocks.length;
  const nWin = Math.round(WIN / ENV_DT);
  if (nb < nWin / 2) throw new Error('Fluctuation strength needs at least 1 s of signal');
  const n = Math.min(nWin, nb);
  const hop = Math.round(HOP / ENV_DT);
  const nfft = nextPow2(n) * 2;
  const w = hann(n);
  let wss = 0;
  for (let i = 0; i < n; i++) wss += w[i] * w[i];

  // Amplitude envelope per band (linear).
  const env: Float64Array[] = THIRD_OCT_CENTRES.map((_, b) => {
    const e = new Float64Array(nb);
    for (let k = 0; k < nb; k++) e[k] = Math.sqrt(10 ** (tl.blocks[k][b] / 10));
    return e;
  });

  const starts: number[] = [];
  for (let s = 0; s + n <= nb; s += hop) starts.push(s);
  const F = new Float32Array(starts.length);
  const fm = new Float64Array(starts.length);
  starts.forEach((s, wi) => {
    // Mean level per band over the window. Bands far below the loudest one are masked, and a band
    // much lower than a neighbour is just filter skirt of that neighbour (it would copy its modulation).
    const lv = new Float64Array(28).fill(-Infinity);
    for (let b = FIRST_BAND; b < 28; b++) {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += tl.blocks[s + i][b];
      lv[b] = mean / n;
    }
    const top = Math.max(...lv);
    let sum = 0, bestF = 0, bestC = 0;
    for (let b = FIRST_BAND; b < 28; b++) {
      if (lv[b] < top - 30 || lv[b] < 10) continue;
      if (lv[b] < Math.max(lv[b - 1] ?? -Infinity, lv[b + 1] ?? -Infinity) - 12) continue;
      const { m, f } = modulation(env[b], s, n, nfft, w, wss);
      const mc = Math.min(m, 0.999);
      const dL = Math.min(DL_MAX, 20 * Math.log10((1 + mc) / (1 - mc)));
      const c = dL * g(f) * dz[b];
      sum += c;
      if (c > bestC) { bestC = c; bestF = f; }
    }
    F[wi] = K * sum;
    fm[wi] = bestF;
    if (wi % 8 === 0) onProgress?.(wi / starts.length);
  });

  let mean = 0, max = 0, fmod = 0;
  for (let i = 0; i < F.length; i++) { mean += F[i]; if (F[i] > max) { max = F[i]; fmod = fm[i]; } }
  return { F, dt: HOP, mean: mean / F.length, max, fmod, windowSec: n * ENV_DT };
}
