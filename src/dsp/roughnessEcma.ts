// ECMA-418-2 (4th ed., 2025) clause 7.1: roughness of the Sottek Hearing Model (unit: asper_HMS).
// Formula numbers refer to the standard. Structure and constants follow ecma418-torch
// (A. Grathwohl, MIT licence — see THIRD_PARTY_NOTICES.md). Mono input; the optional entropy
// weighting (7.1.6) is not implemented.
import { fft } from './fft';
import { BAND_FC, DZ, FS, N_BANDS, basisLoudness, hearingModel } from './sottekHms';
import { resampleTo48k } from './loudnessTv';

const SB = 16384, SH = 4096;
const NK = 512; // envelope block length after decimation to 1500 Hz
const DF = 1500 / NK; // (76)
const C_R = 0.0180685;
const SKIP = 16; // l50 ≤ 15 discarded, clauses 7.1.8 and 7.1.10
const EPS = 2.220446049250313e-16;

// Table 10, theta = 0..33.
const E_THETA = [
  0.0000, 0.0457, 0.0907, 0.1346, 0.1765, 0.2157, 0.2515, 0.2828, 0.3084, 0.3269, 0.3364, 0.3348,
  0.3188, 0.2844, 0.2259, 0.1351, 0.0000, -0.1351, -0.2259, -0.2844, -0.3188, -0.3348, -0.3364,
  -0.3269, -0.3084, -0.2828, -0.2515, -0.2157, -0.1765, -0.1346, -0.0907, -0.0457, 0.0000, 0.0000,
];

const lg = BAND_FC.map((f) => Math.log2(f / 1000));
const R_MAX = BAND_FC.map((f, z) => { // (84)
  const fk = f / 1000, low = fk < 1;
  return 1 / (1 + (low ? 0.3560 : 0.8024) * Math.abs(lg[z]) ** (low ? 0.8049 : 0.9333));
});
const F_MAX = BAND_FC.map((f) => 72.6937 * (1 - 1.1739 * Math.exp(-5.4583 * (f / 1000)))); // (86)
const Q2_HIGH = BAND_FC.map((f, z) => ((f / 1000) < 2 ** -3.4253 ? 0.2471 : 0.2471 + 0.0129 * (lg[z] + 3.4253) ** 2)); // (87)
const Q2_LOW = lg.map((l) => 1.0967 - 0.0640 * l); // (96)
const weight = (f: number, fmax: number, q1: number, q2: number) => 1 / (1 + ((f / fmax - fmax / f) * q1) ** 2) ** q2; // (85)

/** Round half to even (as numpy / torch). */
const roundEven = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** Indices (into x) of the `keep` most prominent strict local maxima, ascending. */
function prominentPeaks(x: Float64Array, keep: number): number[] {
  const n = x.length;
  const found: { i: number; prom: number }[] = [];
  for (let p = 1; p < n - 1; p++) {
    if (!(x[p] > x[p - 1] && x[p] > x[p + 1])) continue;
    const h = x[p];
    let lmin = h, rmin = h;
    for (let q = p - 1; q >= 0 && x[q] <= h; q--) if (x[q] < lmin) lmin = x[q];
    for (let q = p + 1; q < n && x[q] <= h; q++) if (x[q] < rmin) rmin = x[q];
    found.push({ i: p, prom: h - Math.max(lmin, rmin) });
  }
  found.sort((a, b) => b.prom - a.prom || a.i - b.i);
  return found.slice(0, keep).map((f) => f.i).sort((a, b) => a - b);
}

/** (73)–(81): quadratic-fit peak rate plus the Hann bias correction. */
function refinedRate(a: number, b: number, c: number, kp: number): number {
  const curv = 2 * b - a - c || 1;
  const ft = (kp + (c - a) / (2 * curv)) * DF; // (76)
  const fl = Math.floor(ft / DF);
  const beta = E_THETA.map((e, th) => (fl + th / 32) * DF - (ft + e)); // (79)
  let tmin = 0, best = Infinity;
  for (let i = 0; i < 33; i++) if (Math.abs(beta[i]) < best) { best = Math.abs(beta[i]); tmin = i; }
  const bMin = beta[tmin], bPrev = beta[Math.max(tmin - 1, 0)];
  const tcorr = tmin > 0 && bMin * bPrev < 0 ? tmin : tmin + 1; // (81)
  const b0 = beta[tcorr - 1], b1 = beta[tcorr], e0 = E_THETA[tcorr - 1], e1 = E_THETA[tcorr];
  return ft + e0 - ((e1 - e0) * b0) / (b1 - b0); // (77), (78)
}

/** Clause 7.1.5.3: fundamental modulation rate and its harmonic complex. Returns index of the fundamental and membership. */
function fundamental(fp: number[], at: number[], valid: boolean[]) {
  const p = fp.length;
  const r: number[][] = [], dev: number[][] = [];
  for (let i0 = 0; i0 < p; i0++) {
    r.push([]); dev.push([]);
    for (let i = 0; i < p; i++) {
      const ratio = fp[i] / fp[i0], rr = roundEven(ratio);
      r[i0].push(rr);
      dev[i0].push(valid[i0] && valid[i] && rr > 0 ? Math.abs(ratio / rr - 1) : Infinity); // (89), (90)
    }
  }
  const member: boolean[][] = [];
  const energy: number[] = [];
  for (let i0 = 0; i0 < p; i0++) {
    member.push([]);
    let e = 0;
    for (let i = 0; i < p; i++) {
      let beaten = false;
      for (let j = 0; j < p && !beaten; j++) {
        if (r[i0][j] === r[i0][i] && (dev[i0][j] < dev[i0][i] || (dev[i0][j] === dev[i0][i] && j < i))) beaten = true;
      }
      const m = dev[i0][i] < 0.04 && !beaten; // (90)
      member[i0].push(m);
      if (m) e += at[i]; // (91)
    }
    energy.push(valid[i0] ? e : -Infinity);
  }
  let iMax = 0;
  for (let i = 1; i < p; i++) if (energy[i] > energy[iMax]) iMax = i;
  return { iMax, inMax: member[iMax] };
}

const HANN = Float64Array.from({ length: NK }, (_, n) => (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / NK)) / Math.sqrt(0.375));

/** Clauses 7.1.3–7.1.5 for one block: env[z] = NK envelope samples, nb[z] = basis loudness. Returns A(z). */
function blockRoughness(env: Float64Array[], nb: Float64Array): Float64Array {
  const re = new Float64Array(NK), im = new Float64Array(NK);
  const nmax = Math.max(...nb);
  // phi[z][k], k = 0..256 (66)
  const phi: Float64Array[] = [];
  for (let z = 0; z < N_BANDS; z++) {
    let phi0 = 0;
    for (let i = 0; i < NK; i++) { re[i] = env[z][i] * HANN[i]; im[i] = 0; phi0 += re[i] * re[i]; } // (67)
    fft(re, im);
    const sc = nmax * phi0 !== 0 ? (nb[z] * nb[z]) / (nmax * phi0) : 0;
    const row = new Float64Array(NK / 2 + 1);
    for (let k = 0; k <= NK / 2; k++) row[k] = sc * (re[k] * re[k] + im[k] * im[k]);
    phi.push(row);
  }
  // smoothing over neighbouring bands, then the sum over bands (68)
  const phib: Float64Array[] = phi.map((row, z) => {
    if (z === 0 || z === N_BANDS - 1) return row;
    return row.map((_, k) => (phi[z - 1][k] + row[k] + phi[z + 1][k]) / 3);
  });
  const s = new Float64Array(NK / 2 + 1);
  for (const row of phib) for (let k = 0; k < s.length; k++) s[k] += row[k];
  const mid = Float64Array.from(s.subarray(2, 256)).sort();
  const med = (mid[126] + mid[127]) / 2;
  const wt = s.map((v, k) => ((0.0856 * v) / (med + 1e-10)) * Math.min(1, Math.max(0, 0.1891 * Math.exp(0.0120 * k)))); // (71)
  let wmax = -Infinity;
  for (let k = 2; k < 256; k++) wmax = Math.max(wmax, wt[k]);
  const w = wt.map((v) => (v >= 0.05 * wmax ? Math.min(1, Math.max(0, v - 0.1407)) : 0)); // (70)

  const out = new Float64Array(N_BANDS);
  for (let z = 0; z < N_BANDS; z++) {
    const phih = phib[z].map((v, k) => v * w[k]); // (69)
    const idx = prominentPeaks(phih.subarray(2, 256), 10).map((i) => i + 2);
    if (!idx.length) continue;
    const bVals = idx.map((k) => phih[k]);
    const bmax = Math.max(...bVals);
    const fp: number[] = [], at: number[] = [], valid: boolean[] = [];
    idx.forEach((k, j) => {
      const ok = bVals[j] > 0.05 * bmax; // (72)
      valid.push(ok);
      if (!ok) { fp.push(1); at.push(0); return; }
      const a = phih[k - 1], b = phih[k], c = phih[k + 1];
      const f = refinedRate(a, b, c, k);
      fp.push(f);
      const amp = a + b + c; // (82)
      const t = amp * R_MAX[z] * (f > F_MAX[z] ? weight(f, F_MAX[z], 1.2822, Q2_HIGH[z]) : 1);
      at.push(f > DF ? t : 0); // (83)
    });
    if (!valid.some(Boolean)) continue;
    const { iMax, inMax } = fundamental(fp, at, valid);
    let iPeak = -1, sa = 0, cen = 0;
    for (let i = 0; i < fp.length; i++) {
      if (!inMax[i]) continue;
      if (iPeak < 0 || at[i] > at[iPeak]) iPeak = i; // (94)
      sa += at[i]; cen += fp[i] * at[i];
    }
    const centroid = cen / (sa + EPS);
    const wPeak = 1 + 0.1 * Math.abs(centroid - fp[iPeak]) ** 0.749; // (93)
    const total = wPeak * sa; // (92)
    const f0 = fp[iMax];
    const gLow = f0 <= F_MAX[z] ? weight(f0, F_MAX[z], 0.7066, Q2_LOW[z]) : 1;
    const v = f0 > DF ? gLow * total : 0; // (95)
    out[z] = v >= 0.074376 ? v : 0;
  }
  return out;
}

/** Piecewise cubic Hermite interpolation with SciPy's Fritsch–Carlson derivatives (clause 7.1.7). */
export function pchip(t: ArrayLike<number>, y: ArrayLike<number>, tq: ArrayLike<number>): Float64Array {
  const n = t.length;
  const h = new Float64Array(n - 1), delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) { h[i] = t[i + 1] - t[i]; delta[i] = (y[i + 1] - y[i]) / h[i]; }
  const d = new Float64Array(n);
  if (n === 2) { d[0] = d[1] = delta[0]; } else {
    for (let i = 1; i < n - 1; i++) {
      const d0 = delta[i - 1], d1 = delta[i];
      if (d0 * d1 > 0) {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        d[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
      }
    }
    const edge = (h0: number, h1: number, m0: number, m1: number) => {
      let e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
      if (Math.sign(e) !== Math.sign(m0)) e = 0;
      else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > 3 * Math.abs(m0)) e = 3 * m0;
      return e;
    };
    d[0] = edge(h[0], h[1], delta[0], delta[1]);
    d[n - 1] = edge(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);
  }
  const out = new Float64Array(tq.length);
  let k = 0;
  for (let j = 0; j < tq.length; j++) {
    while (k < n - 2 && tq[j] >= t[k + 1]) k++; // searchsorted(right) − 1, clamped
    const s = (tq[j] - t[k]) / h[k];
    out[j] = (1 + 2 * s) * (1 - s) ** 2 * y[k] + s * (1 - s) ** 2 * h[k] * d[k]
      + s * s * (3 - 2 * s) * y[k + 1] + s * s * (s - 1) * h[k] * d[k + 1];
  }
  return out;
}

export interface RoughnessEcmaResult {
  /** Single value R (90th percentile of R(t), l50 ≥ 16), asper_HMS. */
  R: number;
  /** R(t) every 20 ms. */
  Rt: Float32Array; dt: number;
  /** Time-averaged specific roughness per band (asper/Bark) and band centre frequencies. */
  specific: Float32Array; bandFreq: Float32Array;
  max: number;
}

export function roughnessEcma(
  x: Float64Array, fs: number, field: 'free' | 'diffuse' = 'free', onProgress?: (f: number) => void,
): RoughnessEcmaResult {
  const x48 = resampleTo48k(x, fs);
  if (x48.length < FS) throw new Error('ECMA-418-2 roughness needs at least 1 s of signal');
  const hm = hearingModel(x48, field, SB, SH, (f) => onProgress?.(f * 0.9));
  const L = hm.nBlocks;
  // A(l, z)
  const A = Array.from({ length: N_BANDS }, () => new Float64Array(L));
  for (let l = 0; l < L; l++) {
    const envs = hm.env.map((e) => e.subarray(l * NK, (l + 1) * NK));
    const nb = Float64Array.from({ length: N_BANDS }, (_, z) => basisLoudness(hm.rms[z][l], z));
    const a = blockRoughness(envs, nb);
    for (let z = 0; z < N_BANDS; z++) A[z][l] = a[z];
    if (l % 8 === 0) onProgress?.(0.9 + 0.1 * (l / L));
  }
  // Interpolate to 50 Hz (7.1.7)
  const T = Math.floor((hm.n48 * 50) / FS) + 1;
  const t50 = Float64Array.from({ length: T }, (_, i) => i / 50);
  const est = Array.from({ length: N_BANDS }, (_, z) => pchip(hm.t, A[z], t50).map((v) => Math.max(0, v)));
  // Band-distribution exponent and calibration (104)–(108), then temporal smoothing (109), (110)
  const spec = Array.from({ length: N_BANDS }, () => new Float64Array(T));
  for (let i = 0; i < T; i++) {
    let sq = 0, sum = 0;
    for (let z = 0; z < N_BANDS; z++) { sq += est[z][i] ** 2; sum += est[z][i]; }
    const rmsV = Math.sqrt(sq / N_BANDS), mean = sum / N_BANDS;
    const bb = mean > 0 ? rmsV / mean : 0; // (106)
    const e = 0.37106 * (Math.tanh(1.6407 * (bb - 2.5804)) + 1) * 0.5 + 0.58449;
    for (let z = 0; z < N_BANDS; z++) spec[z][i] = est[z][i] > 0 ? C_R * est[z][i] ** e : 0;
  }
  const aR = Math.exp(-1 / (50 * 0.0625)), aF = Math.exp(-1 / (50 * 0.5));
  for (let z = 0; z < N_BANDS; z++) {
    for (let i = 1; i < T; i++) {
      const a = spec[z][i] >= spec[z][i - 1] ? aR : aF;
      spec[z][i] = spec[z][i] * (1 - a) + spec[z][i - 1] * a;
    }
  }
  const Rt = new Float32Array(T);
  for (let i = 0; i < T; i++) { let s = 0; for (let z = 0; z < N_BANDS; z++) s += spec[z][i]; Rt[i] = DZ * s; } // (111)
  const tail = Float64Array.from(Rt.subarray(SKIP)).sort();
  const pos = 0.9 * (tail.length - 1), lo = Math.floor(pos);
  const R = tail[lo] + (tail[Math.min(lo + 1, tail.length - 1)] - tail[lo]) * (pos - lo);
  const specific = new Float32Array(N_BANDS);
  for (let z = 0; z < N_BANDS; z++) {
    let s = 0;
    for (let i = SKIP; i < T; i++) s += spec[z][i];
    specific[z] = s / (T - SKIP);
  }
  return { R, Rt, dt: 0.02, specific, bandFreq: Float32Array.from(BAND_FC), max: tail[tail.length - 1] };
}
