// ECMA-418-2 (4th ed., 2025) clause 9.1: fluctuation strength of the Sottek Hearing Model
// (unit: vacil_HMS), implemented from the published standard text (Formulae 119–170).
//
// Per band and block (65536 samples, hop 16384) the Hilbert envelope (decimated to 1500 Hz, 2048
// samples) gets an envelope-dependent analysis window, a high-resolution spectral analysis (HSA:
// least-squares fit of a constant plus spectral line pairs to the first ≤ 49 DFT bins, with the
// window's own transform), peak picking, a fine-tuned maximum, harmonic analysis, and scaling with
// the HSA-based loudness. Results at the block rate are interpolated to 50 Hz and calibrated.
//
// Deviation from the literal text: Formula (159) multiplies by s̃b = 2048; here the length of the
// envelope analysis window (n2 − n1 + 1, typically 1920) is used, which is the factor that makes the
// HSA line power comparable to the windowed DFT power in the roughness formula (66). With the literal
// s̃b the calibration signal (1 kHz, 60 dB, m = 1, 4 Hz) reads 1.06 vacil, with the window length 1.004.
import { BAND_FC, DZ, FS, N_BANDS, basisLoudness, hearingModel } from './sottekHms';
import { resampleTo48k } from './loudnessTv';
import { pchip } from './roughnessEcma';

const SB = 65536, SH = 16384;
const NK = 2048; // s̃b
const RS = 1500; // decimated rate
const DF = RS / NK;
const EPS0 = 2.220446049250313e-16;
const C_F = 0.003840572;
const SKIP = 36; // l50 ≤ 35 discarded
const TAU = 0.75;
const K_MAX = 49;

const round8 = (v: number) => Math.round(v * 1e8) / 1e8;
const roundHalfUp = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Complex vectors over k = 0..K_MAX-1 of the window transform at normalised offset (formula 127). */
function windowTransform(f: number, n1: number, n2: number, re: Float64Array, im: Float64Array) {
  const Lw = n2 - n1 + 1;
  for (let k = 0; k < K_MAX; k++) {
    const nu = k / NK - f / RS;
    const s = Math.sin(Math.PI * nu);
    const mag = Math.abs(s) < 1e-12 ? Lw : Math.sin(Math.PI * nu * Lw) / s;
    const ph = -Math.PI * nu * (n1 + n2);
    re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph);
  }
}

interface Hsa { p0: number; a: number[]; b: number[]; E: number }

/**
 * HSA (formulae 121–142): fit a constant plus lines at `fc` to the DFT bins 0..K_L-1 of the windowed
 * envelope. P = spectrum (re, im) and sumPhi(K_L) come from the caller.
 */
function hsa(
  Pre: Float64Array, Pim: Float64Array, phiCum: Float64Array, n1: number, n2: number, fc: number[],
): Hsa | null {
  const M = fc.length;
  const KL = Math.min(Math.max(17, roundHalfUp(Math.max(0, ...fc) / DF) + 8), K_MAX);
  const nb = 2 * M + 1;
  // basis vectors: B0 = W(0); per line B+ = W(f)+W(-f) and B- = j (W(f)-W(-f))
  const Br: Float64Array[] = [], Bi: Float64Array[] = [];
  const w0r = new Float64Array(K_MAX), w0i = new Float64Array(K_MAX);
  windowTransform(0, n1, n2, w0r, w0i);
  Br.push(w0r); Bi.push(w0i);
  const pr = new Float64Array(K_MAX), pi = new Float64Array(K_MAX), mr = new Float64Array(K_MAX), mi = new Float64Array(K_MAX);
  for (const f of fc) {
    windowTransform(f, n1, n2, pr, pi);
    windowTransform(-f, n1, n2, mr, mi);
    const sr = new Float64Array(K_MAX), si = new Float64Array(K_MAX), dr = new Float64Array(K_MAX), di = new Float64Array(K_MAX);
    for (let k = 0; k < K_MAX; k++) {
      sr[k] = pr[k] + mr[k]; si[k] = pi[k] + mi[k];
      const xr = pr[k] - mr[k], xi = pi[k] - mi[k];
      dr[k] = -xi; di[k] = xr; // j · (W+ − W−)
    }
    Br.push(sr, dr); Bi.push(si, di);
  }
  const A: number[][] = Array.from({ length: nb }, () => new Array(nb + 1).fill(0));
  for (let i = 0; i < nb; i++) {
    for (let j = i; j < nb; j++) {
      let s = 0;
      for (let k = 0; k < KL; k++) s += Br[i][k] * Br[j][k] + Bi[i][k] * Bi[j][k];
      A[i][j] = s; A[j][i] = s;
    }
    let s = 0;
    for (let k = 0; k < KL; k++) s += Br[i][k] * Pre[k] + Bi[i][k] * Pim[k];
    A[i][nb] = s;
  }
  const bvec = A.map((r) => r[nb]);
  let tr = 0;
  for (let i = 0; i < nb; i++) tr += A[i][i];
  for (let i = 0; i < nb; i++) A[i][i] += 1e-12 * tr;
  // Gauss elimination with partial pivoting
  for (let c = 0; c < nb; c++) {
    let p = c;
    for (let r = c + 1; r < nb; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-300) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < nb; r++) {
      const m = A[r][c] / A[c][c];
      for (let k = c; k <= nb; k++) A[r][k] -= m * A[c][k];
    }
  }
  const x = new Array(nb).fill(0);
  for (let r = nb - 1; r >= 0; r--) {
    let s = A[r][nb];
    for (let k = r + 1; k < nb; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  let xb = 0;
  for (let i = 0; i < nb; i++) xb += x[i] * bvec[i];
  const a: number[] = [], b: number[] = [];
  for (let m = 0; m < M; m++) { a.push(x[1 + 2 * m]); b.push(x[2 + 2 * m]); }
  return { p0: x[0], a, b, E: phiCum[KL] - xb }; // E = ΣΦ − xᵀb at the least-squares optimum
}

const lineAmp = (h: Hsa, m: number) => h.a[m] ** 2 + h.b[m] ** 2; // |p̂|², p̂ = a + jb: the envelope mean square is p0² + 2ΣA

/** (148) band-pass weighting of the modulation rate. */
function wlh(f: number, z: number): number {
  const FMAX = 4.8659;
  if (f === 0) return 0;
  const r = f / FMAX - FMAX / f;
  if (f <= FMAX) return 1 / (1 + (r * 0.33048) ** 2) ** 0.85902;
  return (1 + 0.092623 * Math.abs(Math.log2(BAND_FC[z] / 1000)) ** 1.24) ** -1 / (1 + (r * 0.21792) ** 2) ** 4.6728;
}

/** Moving median (length 33, truncated at the ends). */
function movingMedian33(x: Float64Array): Float64Array {
  const n = x.length, out = new Float64Array(n), win = new Float64Array(33);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 16), hi = Math.min(n - 1, i + 16), c = hi - lo + 1;
    for (let j = 0; j < c; j++) win[j] = x[lo + j];
    const s = win.subarray(0, c).sort();
    out[i] = c % 2 ? s[(c - 1) / 2] : 0.5 * (s[c / 2 - 1] + s[c / 2]);
  }
  return out;
}

/** 9.1.3: envelope analysis window [n1, n2], or null for a quiet / unusable block. */
function analysisWindow(e: Float64Array): { n1: number; n2: number } | null {
  const sm = movingMedian33(e).map(round8);
  let max = 0;
  for (let n = 0; n < NK; n++) {
    if (n < 64 || n > NK - 65) sm[n] = 0;
    if (sm[n] > max) max = sm[n];
  }
  if (max <= 5e-6) return null;
  const thr = round8(0.01 * max);
  let first = -1, last = -1;
  for (let n = 0; n < NK; n++) if (sm[n] >= thr) { if (first < 0) first = n; last = n; }
  let nzb = first, nze = NK - 1 - last;
  let bestB = -1, bestE = -1, bestLen = 0;
  for (let n = first; n <= last; ) {
    if (sm[n] < thr) {
      let m = n;
      while (m + 1 <= last && sm[m + 1] < thr) m++;
      if (m - n + 1 > bestLen) { bestLen = m - n + 1; bestB = n; bestE = m; }
      n = m + 1;
    } else n++;
  }
  if (bestLen > 320) {
    if (bestB - (nzb + 64) > NK - 1 - nze - 64 - bestE) nze = NK - 1 - bestB + 64;
    else nzb = bestE + 64;
  }
  const n1 = nzb, n2 = NK - 1 - nze;
  if (n2 - n1 + 1 < 320 || n2 < 511 || n1 >= n2) return null;
  // relative standard deviation of the least-squares line through e over n1+10 .. n2-10
  const a = n1 + 10, b = n2 - 10, c = b - a + 1;
  if (c < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let n = a; n <= b; n++) { sx += n; sy += e[n]; sxx += n * n; sxy += n * e[n]; }
  const den = c * sxx - sx * sx, slope = (c * sxy - sx * sy) / den, icpt = (sy - slope * sx) / c;
  let ss = 0;
  for (let n = a; n <= b; n++) ss += (e[n] - icpt - slope * n) ** 2;
  const mean = sy / c;
  if (!(Math.sqrt(ss / c) / (Math.abs(mean) + EPS0) >= 0.001)) return null;
  return { n1, n2 };
}

interface BandBlock { p0: number; sumA: number; ahat: number; lw: number }

/** 9.1.4–9.1.9 for one band and block. */
function bandBlock(e: Float64Array, z: number): BandBlock | null {
  const win = analysisWindow(e);
  if (!win) return null;
  const { n1, n2 } = win;
  const Pre = new Float64Array(K_MAX), Pim = new Float64Array(K_MAX), phi = new Float64Array(K_MAX);
  for (let k = 0; k < K_MAX; k++) {
    let sr = 0, si = 0;
    const w = (-2 * Math.PI * k) / NK;
    for (let n = n1; n <= n2; n++) { sr += e[n] * Math.cos(w * n); si += e[n] * Math.sin(w * n); }
    Pre[k] = sr; Pim[k] = si; phi[k] = sr * sr + si * si;
  }
  const cum = new Float64Array(K_MAX + 1);
  for (let k = 0; k < K_MAX; k++) cum[k + 1] = cum[k] + phi[k];
  const fit = (fc: number[]) => hsa(Pre, Pim, cum, n1, n2, fc);

  // 9.1.5 local maxima of the power spectrum, refined by their centroid (144)
  const fp: number[] = [];
  const lim = Math.max(0.001 * phi[0], 0.15);
  for (let k = 1; k < K_MAX - 1; k++) {
    if (phi[k] > phi[k - 1] && phi[k] >= phi[k + 1] && phi[k] >= lim) {
      let s = 0, sk = 0;
      for (let j = -1; j <= 1; j++) { s += phi[k + j]; sk += (k + j) * phi[k + j]; }
      fp.push((sk / s) * DF);
    }
  }
  if (!fp.length) return null;
  // error function at 16 rates, local minima
  const fs16 = Array.from({ length: 16 }, (_, i) => 0.25 * 2 ** ((i + 1 - 2) / 3));
  const E16 = fs16.map((f) => fit([f])?.E ?? Infinity);
  let fmin = -1, eBest = Infinity;
  for (let i = 1; i < 15; i++) if (E16[i] < E16[i - 1] && E16[i] < E16[i + 1] && E16[i] < eBest) { eBest = E16[i]; fmin = fs16[i]; }
  let cand: number[];
  let h: Hsa | null;
  if (fmin < 0) {
    cand = [...fp].sort((a, b) => a - b);
    h = fit(cand);
  } else {
    const keep = fp.filter((f) => Math.abs(fmin - f) >= 1.25 * DF);
    const c1 = [fmin, ...keep].sort((a, b) => a - b);
    if (keep.length === fp.length) { cand = c1; h = fit(c1); } else {
      const c2 = [...fp].sort((a, b) => a - b);
      const h1 = fit(c1), h2 = fit(c2);
      if (h1 && (!h2 || h1.E <= h2.E)) { cand = c1; h = h1; } else { cand = c2; h = h2; }
    }
  }
  if (!h) return null;
  let amax = 0;
  const amps = cand.map((_, m) => lineAmp(h!, m));
  for (const a of amps) amax = Math.max(amax, a);
  const lines: { f: number; A: number; At: number }[] = [];
  cand.forEach((f, m) => { if (amps[m] > 0.05 * amax && f > 0) lines.push({ f, A: amps[m], At: amps[m] * wlh(f, z) }); });
  if (!lines.length) return null;

  // 9.1.6–9.1.7 maximum of the weighted spectrum and Newton fine tuning
  let iMax = 0;
  lines.forEach((l, i) => { if (l.At > lines[iMax].At) iMax = i; });
  const eOf = (f: number) => fit([f])?.E ?? Infinity;
  const f0 = lines[iMax].f, dx = 1e-5;
  let x = f0;
  for (let k = 0; k < 40; k++) {
    const ep = eOf(x + dx), em = eOf(x - dx), e0 = eOf(x);
    const d1 = (ep - em) / (2 * dx), d2 = (ep - 2 * e0 + em) / (dx * dx);
    const step = 0.25 * Math.sign(d1) * Math.min(Math.abs(d1) / (Math.abs(d2) + EPS0), 2e-4);
    x -= step;
    if (!(Math.abs(step) > 1e-7)) break;
  }
  let fopt = f0;
  if (Math.abs(x - f0) <= 1.25 * DF) {
    fopt = x;
    const hh = fit([fopt]);
    if (hh) { lines[iMax].f = fopt; lines[iMax].A = lineAmp(hh, 0); lines[iMax].At = lines[iMax].A * wlh(fopt, z); }
  }
  if (fopt < 0.125) return null;

  // 9.1.8 harmonic analysis: the maximum is the fundamental, 2nd or 3rd order
  let bestE = -1, bestSet: { i: number; R: number }[] = [], bestF1 = fopt;
  for (let o = 1; o <= 3; o++) {
    const f1 = fopt / o;
    const set: { i: number; R: number }[] = [];
    let en = 0;
    lines.forEach((l, i) => {
      const R = roundHalfUp(l.f / f1);
      if (R < 1 || R > 5) return;
      if (Math.abs(l.f / (R * f1) - 1) < 0.04) { set.push({ i, R }); en += l.At; }
    });
    if (en > bestE) { bestE = en; bestSet = set; bestF1 = f1; }
  }
  // corrected rates: one constant + one line pair per component
  let p0s = 0, sumA = 0, sumAt = 0, cen = 0, cnt = 0;
  for (const { i, R } of bestSet) {
    const rate = i === iMax ? fopt : R * bestF1;
    const hh = fit([rate]);
    if (!hh) continue;
    const A = lineAmp(hh, 0), At = A * wlh(rate, z);
    p0s += hh.p0; cnt++; sumA += A; sumAt += At; cen += rate * At;
  }
  if (!cnt) return null;
  const wbw = 1 + 0.79577 * Math.abs(cen / (sumAt + EPS0) - fopt) ** 0.43461; // (158)
  return { p0: p0s / cnt, sumA, ahat: wbw * sumAt, lw: n2 - n1 + 1 };
}

export interface FluctuationEcmaResult {
  /** Single value F (90th percentile of F(t), l50 ≥ 36), vacil_HMS. */
  F: number;
  /** F(t) every 20 ms. */
  Ft: Float32Array; dt: number;
  /** Time-averaged specific fluctuation strength per band (vacil/Bark) and band centre frequencies. */
  specific: Float32Array; bandFreq: Float32Array;
  max: number;
}

export function fluctuationEcma(
  x: Float64Array, fs: number, field: 'free' | 'diffuse' = 'free', onProgress?: (f: number) => void,
): FluctuationEcmaResult {
  const r = fluctuationFromSpecific(specificFluctuationEcma(x, fs, field, onProgress));
  onProgress?.(1);
  return r;
}

/** Time-dependent specific fluctuation strength F'(l50, z) of one channel, spec[z][i] at 50 Hz. */
export function specificFluctuationEcma(
  x: Float64Array, fs: number, field: 'free' | 'diffuse' = 'free', onProgress?: (f: number) => void,
): Float64Array[] {
  const x48 = resampleTo48k(x, fs);
  if (x48.length < FS * 2) throw new Error('ECMA-418-2 fluctuation strength needs at least 2 s of signal');
  const hm = hearingModel(x48, field, SB, SH, (f) => onProgress?.(f * 0.6));
  const L = hm.nBlocks;
  const Ab = Array.from({ length: N_BANDS }, () => new Float64Array(L));
  for (let l = 0; l < L; l++) {
    const res: (BandBlock | null)[] = [];
    const nh = new Float64Array(N_BANDS);
    for (let z = 0; z < N_BANDS; z++) {
      const r = bandBlock(hm.env[z].subarray(l * NK, (l + 1) * NK), z);
      res.push(r);
      if (r) nh[z] = basisLoudness(Math.sqrt(0.5 * (r.p0 ** 2 + 2 * r.sumA)), z); // (160), (161)
    }
    const nmax = Math.max(...nh);
    for (let z = 0; z < N_BANDS; z++) {
      const r = res[z];
      if (!r) continue;
      const a = (1 / (r.p0 ** 2 + 2 * r.sumA + EPS0)) * ((nh[z] * nh[z]) / (nmax + EPS0)) * r.lw * r.ahat; // (159), with the analysis-window length in place of s̃b (see header)
      Ab[z][l] = a < 5.2519 ? 0 : a;
    }
    onProgress?.(0.6 + 0.35 * ((l + 1) / L));
  }
  // 9.1.11 interpolation to 50 Hz, nonlinearity and calibration, 0.75 s smoothing
  const T = Math.floor((hm.n48 * 50) / FS) + 1;
  const t50 = Float64Array.from({ length: T }, (_, i) => i / 50);
  const est = Ab.map((a) => pchip(hm.t, a, t50).map((v) => Math.max(0, v)));
  const spec = Array.from({ length: N_BANDS }, () => new Float64Array(T));
  const Bhat = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    let sq = 0, sum = 0;
    for (let z = 0; z < N_BANDS; z++) { sq += est[z][i] ** 2; sum += est[z][i]; }
    Bhat[i] = Math.sqrt(sq / N_BANDS) / (sum / N_BANDS + 1e-12); // (165)–(167)
  }
  const B = new Float64Array(T);
  for (let i = 0; i < T; i++) { // moving median, length 71
    const lo = Math.max(0, i - 35), hi = Math.min(T - 1, i + 35);
    const s = Bhat.slice(lo, hi + 1).sort(), c = s.length;
    B[i] = c % 2 ? s[(c - 1) / 2] : 0.5 * (s[c / 2 - 1] + s[c / 2]);
  }
  for (let i = 0; i < T; i++) {
    const e = 0.37106 * (Math.tanh(1.6407 * (B[i] - 2.5804)) + 1) * 0.5 + 0.58449; // (164)
    for (let z = 0; z < N_BANDS; z++) spec[z][i] = est[z][i] > 0 ? C_F * est[z][i] ** e : 0; // (163)
  }
  const a = Math.exp(-1 / (50 * TAU));
  for (let z = 0; z < N_BANDS; z++) for (let i = 1; i < T; i++) spec[z][i] = spec[z][i] * (1 - a) + spec[z][i - 1] * a; // (168)
  return spec;
}

/** Fluctuation strength quantities (Formula 169 and the 90th percentile) from specific values spec[z][i]. */
export function fluctuationFromSpecific(spec: Float64Array[]): FluctuationEcmaResult {
  const T = spec[0].length;
  const Ft = new Float32Array(T);
  for (let i = 0; i < T; i++) { let s = 0; for (let z = 0; z < N_BANDS; z++) s += spec[z][i]; Ft[i] = DZ * s; } // (169)
  const tail = Float64Array.from(Ft.subarray(SKIP)).sort();
  const pos = 0.9 * (tail.length - 1), lo = Math.floor(pos);
  const F = tail[lo] + (tail[Math.min(lo + 1, tail.length - 1)] - tail[lo]) * (pos - lo);
  const specific = new Float32Array(N_BANDS);
  for (let z = 0; z < N_BANDS; z++) {
    let s = 0;
    for (let i = SKIP; i < T; i++) s += spec[z][i];
    specific[z] = s / (T - SKIP);
  }
  return { F, Ft, dt: 0.02, specific, bandFreq: Float32Array.from(BAND_FC), max: tail[tail.length - 1] };
}
