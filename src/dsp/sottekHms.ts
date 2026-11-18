// ECMA-418-2 (4th ed., 2025) clause 5: the Sottek Hearing Model front end.
// Outer/middle-ear filter (Table 1), 53-band auditory filter bank (Formulae 9–15, 5th-order
// gammatone-type band-pass), segmentation into 16384-sample blocks every 4096 samples,
// half-wave-rectified block RMS and Hilbert envelopes decimated by 32 (to 1500 Hz).
//
// Structure, constants and tables follow ecma418-torch (A. Grathwohl, MIT licence — see
// THIRD_PARTY_NOTICES.md). The band filters run in the time domain as an equivalent
// complex IIR (numerator Σ e_i d^i z^-i, five real poles at d, demodulated by the band centre).
import { fft } from './fft';
import { sosFilter, type Sos } from './biquad';

export const FS = 48000;
export const N_BANDS = 53;
export const DZ = 0.5;
const P0 = 2e-5;
const DF0 = 81.9289, C_BARK = 0.1618;
export const BAND_Z = Array.from({ length: N_BANDS }, (_, i) => (i + 1) * DZ);
export const BAND_FC = BAND_Z.map((z) => (DF0 / C_BARK) * Math.sinh(C_BARK * z)); // (9)
const BAND_BW = BAND_FC.map((f) => Math.sqrt(DF0 ** 2 + (C_BARK * f) ** 2)); // (10)
const EULER = [1, 11, 11, 1];

/** Table 1: (b0, b1, b2, a1, a2) per second-order section. */
export const EAR_SOS: Sos = ([
  [1.015896, -1.925299, 0.922118, -1.925299, 0.938014],
  [0.958943, -1.806088, 0.876439, -1.806088, 0.835382],
  [0.961372, -1.763632, 0.821788, -1.763632, 0.783160],
  [2.225804, -1.434650, -0.498204, -1.434650, 0.727599],
  [0.471735, -0.366092, 0.244145, -0.366092, -0.284120],
  [0.115267, 0.000000, -0.115267, -1.796003, 0.805838],
  [0.988029, -1.912434, 0.926132, -1.912434, 0.914161],
  [1.952238, 0.162320, -0.667994, 0.162320, 0.284244],
] as number[][]).map(([b0, b1, b2, a1, a2]) => ({ b0, b1, b2, a1, a2 }));

// Table 2, Formula (23).
const C_N = 0.0211964, ALPHA = 1.5;
const NU = [1.0, 0.6602, 0.0864, 0.6384, 0.0328, 0.4068, 0.2082, 0.3994, 0.6434];
const PT = [15, 25, 35, 45, 55, 65, 75, 85].map((db) => P0 * 10 ** (db / 20));
// Table 3.
const LTQ = [
  0.3310, 0.1625, 0.1051, 0.0757, 0.0576, 0.0453, 0.0365, 0.0298, 0.0247, 0.0207, 0.0176,
  0.0151, 0.0131, 0.0115, 0.0103, 0.0093, 0.0086, 0.0081, 0.0077, 0.0074, 0.0073, 0.0072,
  0.0071, 0.0072, 0.0073, 0.0074, 0.0076, 0.0079, 0.0082, 0.0086, 0.0092, 0.0100, 0.0109,
  0.0122, 0.0138, 0.0157, 0.0172, 0.0180, 0.0180, 0.0177, 0.0176, 0.0177, 0.0182, 0.0190,
  0.0202, 0.0217, 0.0237, 0.0263, 0.0296, 0.0339, 0.0398, 0.0485, 0.0622,
];

/** Formulae (24), (25): basis loudness from a block RMS pressure (Pa) in band z. */
export function basisLoudness(p: number, band: number): number {
  let out = (C_N * p) / P0;
  for (let i = 0; i < PT.length; i++) out *= (1 + (p / PT[i]) ** ALPHA) ** ((NU[i + 1] - NU[i]) / ALPHA);
  return Math.max(0, out - LTQ[band]);
}

/** One band of the auditory filter bank applied to x (real in, real out). */
export function bandFilter(x: Float64Array, band: number): Float64Array {
  const order = 5;
  const tau = (70 / 512) / BAND_BW[band]; // C(2k-2, k-1) / 2^(2k-1) / BW
  const d = Math.exp(-1 / (FS * tau));
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += EULER[i] * d ** (i + 1);
  const c = (1 - d) ** order / norm;
  const k1 = c * EULER[0] * d, k2 = c * EULER[1] * d ** 2, k3 = c * EULER[2] * d ** 3, k4 = c * EULER[3] * d ** 4;
  const w0 = (2 * Math.PI * BAND_FC[band]) / FS;
  const rc = Math.cos(w0), rs = Math.sin(w0);
  const n = x.length, y = new Float64Array(n);
  let pr = 1, pi = 0; // e^{j w0 n}
  let u1r = 0, u1i = 0, u2r = 0, u2i = 0, u3r = 0, u3i = 0, u4r = 0, u4i = 0;
  let s1r = 0, s1i = 0, s2r = 0, s2i = 0, s3r = 0, s3i = 0, s4r = 0, s4i = 0, s5r = 0, s5i = 0;
  for (let i = 0; i < n; i++) {
    // u = x · e^{-j w0 n}
    const ur = x[i] * pr, ui = -x[i] * pi;
    const wr = k1 * u1r + k2 * u2r + k3 * u3r + k4 * u4r;
    const wi = k1 * u1i + k2 * u2i + k3 * u3i + k4 * u4i;
    u4r = u3r; u4i = u3i; u3r = u2r; u3i = u2i; u2r = u1r; u2i = u1i; u1r = ur; u1i = ui;
    s1r = wr + d * s1r; s1i = wi + d * s1i;
    s2r = s1r + d * s2r; s2i = s1i + d * s2i;
    s3r = s2r + d * s3r; s3i = s2i + d * s3i;
    s4r = s3r + d * s4r; s4i = s3i + d * s4i;
    s5r = s4r + d * s5r; s5i = s4i + d * s5i;
    y[i] = 2 * (s5r * pr - s5i * pi); // Re(e^{j w0 n} s5) · 2
    const nr = pr * rc - pi * rs, ni = pr * rs + pi * rc;
    pr = nr; pi = ni;
    if ((i & 1023) === 1023) { const m = Math.hypot(pr, pi); pr /= m; pi /= m; }
  }
  return y;
}

export interface HmsFeatures {
  /** Per band: decimated envelopes, block-major [block][nk]. */
  env: Float64Array[];
  /** Per band: half-wave-rectified block RMS (Pa) [block]. */
  rms: Float64Array[];
  nBlocks: number;
  /** Block end times on the unpadded axis, s. */
  t: Float64Array;
  /** Length of the (resampled) signal in samples. */
  n48: number;
}

/** Formula (1): 240-sample raised-cosine fade-in. */
function fadeIn(x: Float64Array): Float64Array {
  const y = Float64Array.from(x);
  for (let i = 0; i < Math.min(240, y.length); i++) y[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / 240);
  return y;
}

/**
 * Run the front end on a 48 kHz pressure signal. `sb`/`sh` = block / hop length; envelopes are
 * decimated by 32 to sb/32 samples per block.
 */
export function hearingModel(
  x48: Float64Array, field: 'free' | 'diffuse', sb: number, sh: number, onProgress?: (f: number) => void,
): HmsFeatures {
  const n48 = x48.length;
  const padded = new Float64Array(sb + n48);
  padded.set(fadeIn(x48), sb);
  const ear = sosFilter(field === 'diffuse' ? EAR_SOS.slice(2) : EAR_SOS, padded);
  const n = padded.length;
  const nReg = Math.floor((n - sb) / sh) + 1;
  const hasTail = (nReg - 1) * sh + sb < n;
  const nBlocks = nReg + (hasTail ? 1 : 0);
  const start = (l: number) => (l < nReg ? l * sh : n - sb);
  const t = Float64Array.from({ length: nBlocks }, (_, l) => (l < nReg ? (l * sh) / FS : (n - sb) / FS));
  const nk = sb / 32, half = sb / 2;

  const env = Array.from({ length: N_BANDS }, () => new Float64Array(nBlocks * nk));
  const rms = Array.from({ length: N_BANDS }, () => new Float64Array(nBlocks));

  const zr = new Float64Array(sb), zi = new Float64Array(sb);
  const fr = new Float64Array(nk), fi = new Float64Array(nk);
  const gr = new Float64Array(nk), gi = new Float64Array(nk);
  /** Envelope of the analytic signal (decimated by 32) from the spectra A, B of two blocks packed into one FFT. */
  const finishEnv = (
    out: Float64Array, off: number, accR: Float64Array, accI: Float64Array, dcR: number, dcI: number, nyR: number, nyI: number,
  ) => {
    // folded[0] = Σ 2X[k·nk] (k=0..15) − X[0] + X[half]  (bin 0 once, Nyquist once)
    accR[0] += -dcR + nyR; accI[0] += -dcI + nyI;
    fft(accR, accI, true);
    for (let i = 0; i < nk; i++) out[off + i] = Math.hypot(accR[i], accI[i]) / nk / 32; // ifft unscaled → /nk, then /32
  };

  for (let b0 = 0; b0 < N_BANDS; b0 += 2) {
    const bands = b0 + 1 < N_BANDS ? [b0, b0 + 1] : [b0];
    const ys = bands.map((b) => bandFilter(ear, b));
    for (let l = 0; l < nBlocks; l++) {
      const s = start(l);
      for (let j = 0; j < bands.length; j++) {
        let e = 0;
        for (let i = 0; i < sb; i++) { const v = ys[j][s + i]; if (v > 0) e += v * v; }
        rms[bands[j]][l] = Math.sqrt((2 / sb) * e);
      }
      for (let i = 0; i < sb; i++) { zr[i] = ys[0][s + i]; zi[i] = bands.length > 1 ? ys[1][s + i] : 0; }
      fft(zr, zi);
      // Split the packed transform: A[k] = (Z[k] + conj Z[N-k])/2, B[k] = (Z[k] - conj Z[N-k])/(2i).
      fr.fill(0); fi.fill(0); gr.fill(0); gi.fill(0);
      let dcAr = 0, dcAi = 0, dcBr = 0, dcBi = 0, nyAr = 0, nyAi = 0, nyBr = 0, nyBi = 0;
      for (let k = 0; k <= half; k++) {
        const m = (sb - k) % sb;
        const ar = (zr[k] + zr[m]) / 2, ai = (zi[k] - zi[m]) / 2;
        const br = (zi[k] + zi[m]) / 2, bi = -(zr[k] - zr[m]) / 2;
        if (k === 0) { dcAr = ar; dcAi = ai; dcBr = br; dcBi = bi; }
        if (k === half) { nyAr = ar; nyAi = ai; nyBr = br; nyBi = bi; }
        if (k < half) {
          const idx = k % nk;
          fr[idx] += 2 * ar; fi[idx] += 2 * ai;
          gr[idx] += 2 * br; gi[idx] += 2 * bi;
        }
      }
      finishEnv(env[bands[0]], l * nk, fr, fi, dcAr, dcAi, nyAr, nyAi);
      if (bands.length > 1) finishEnv(env[bands[1]], l * nk, gr, gi, dcBr, dcBi, nyBr, nyBi);
    }
    onProgress?.(Math.min(1, (b0 + 2) / N_BANDS));
  }
  return { env, rms, nBlocks, t, n48 };
}
