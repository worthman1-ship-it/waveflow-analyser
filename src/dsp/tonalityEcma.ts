// ECMA-418-2 (4th ed., 2025) clause 6.2: psychoacoustic tonality of the Sottek Hearing Model,
// implemented from the published standard text (Formulae 27–64, Tables 4–9).
//
// Per critical band the half-wave-rectified band signal is segmented with a band-dependent block
// size (Table 4), its normalised autocorrelation (ACF) is computed by FFT, scaled with the basis
// loudness, averaged over neighbouring bands and blocks, and windowed in lag. The spectrum of the
// windowed ACF gives the tonal loudness; sigmoid noise reduction and an overall loudness SNR give
// the specific tonality T'(l,z) in tu_HMS at 187.5 Hz. Single value T = mean of T(l) = max_z T'(l,z)
// over frames 57.. where T(l) > 0.02.
import { fft } from './fft';
import { sosFilter } from './biquad';
import { resampleTo48k } from './loudnessTv';
import { BAND_FC, EAR_SOS, FS, N_BANDS, basisLoudness, bandFilter } from './sottekHms';

const EPS = 1e-12;
const SB_MAX = 8192, SH_MAX = 2048, SH_MIN = 256;
const RSD = FS / SH_MIN; // 187.5 Hz
const DFT_N = 16384;
const C_T = 2.8758615;
const FIRST_FRAME = 57;
const BAND_DF = BAND_FC.map((f) => Math.sqrt(81.9289 ** 2 + (0.1618 * f) ** 2)); // (10)

/** Table 4: block size per band index (z = 0.5..1.5, 2..8, 8.5..12.5, ≥13). */
const sbOf = (i: number) => (i < 3 ? 8192 : i < 16 ? 4096 : i < 25 ? 2048 : 1024);
/** Table 5. */
const NB_AVG: Record<number, number> = { 8192: 2, 4096: 2, 2048: 1, 1024: 0 };
/** Table 8: c and d per block size; Table 7, 9. */
const G_PAR: Record<number, [number, number]> = { 8192: [18.21, 0.36], 4096: [12.14, 0.36], 2048: [417.54, 0.71], 1024: [962.68, 0.69] };
const NR_ALPHA = 20, NR_BETA = 0.07, Q_A = 35, Q_B = 0.003;

/** Bands averaged into band j's ACF (clause 6.2.3). */
function neighbours(j: number): number[] {
  if (j === 0) return [0, 1];
  const nb = Math.min(NB_AVG[sbOf(j)], j, N_BANDS - 1 - j);
  return Array.from({ length: 2 * nb + 1 }, (_, k) => j - nb + k);
}

/** Lag window (31)–(35) as sample indices. */
function lagWindow(j: number) {
  const tauStart = Math.max(0.5 / BAND_DF[j], 0.002);
  const tauEnd = Math.max(4 / BAND_DF[j], tauStart + 0.001);
  return { mStart: Math.ceil(tauStart * FS) - 1, mEnd: Math.floor(tauEnd * FS) - 1 };
}

/** Max |DFT_16384| over the M-sample sequence v (zero padded) and its index; coarse FFT then refinement. */
function peakSpectrum(v: Float64Array, M: number): { mag: number; k: number } {
  let nc = 256;
  while (nc < 4 * M && nc < DFT_N) nc *= 2;
  const re = new Float64Array(nc), im = new Float64Array(nc);
  re.set(v.subarray(0, M));
  fft(re, im);
  let kc = 0, best = -1;
  for (let k = 0; k <= nc / 2; k++) { const m = re[k] * re[k] + im[k] * im[k]; if (m > best) { best = m; kc = k; } }
  const r = DFT_N / nc;
  if (r === 1) return { mag: Math.sqrt(best), k: kc };
  let mag = -1, kb = 0;
  const lo = Math.max(0, (kc - 1) * r), hi = Math.min(DFT_N / 2, (kc + 1) * r);
  for (let k = lo; k <= hi; k++) {
    const w = (2 * Math.PI * k) / DFT_N;
    let sr = 0, si = 0;
    for (let m = 0; m < M; m++) { sr += v[m] * Math.cos(w * m); si -= v[m] * Math.sin(w * m); }
    const a = sr * sr + si * si;
    if (a > mag) { mag = a; kb = k; }
  }
  return { mag: Math.sqrt(mag), k: kb };
}

/** Real IIR of order 3 at 187.5 Hz, cutoff per footnote 20: τ = 6/(32·7) s, e = [0,1,1]. */
function lowpass3(x: Float64Array): Float64Array {
  const tau = 6 / (32 * 7);
  const d = Math.exp(-1 / (RSD * tau));
  const g = (1 - d) ** 3 / (d + d * d);
  const b1 = g * d, b2 = g * d * d;
  const a1 = -3 * d, a2 = 3 * d * d, a3 = -(d ** 3);
  const y = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) {
    y[n] = b1 * (n >= 1 ? x[n - 1] : 0) + b2 * (n >= 2 ? x[n - 2] : 0)
      - a1 * (n >= 1 ? y[n - 1] : 0) - a2 * (n >= 2 ? y[n - 2] : 0) - a3 * (n >= 3 ? y[n - 3] : 0);
  }
  return y;
}

export interface TonalityEcmaResult {
  /** Time-dependent tonality T(l), tu_HMS, every 1/187.5 s. */
  Tl: Float32Array; dt: number;
  /** Single value (Formula 63) and maximum of T(l). */
  T: number; Tmax: number;
  /** Average specific tonality (Formula 53) and its frequency (55) per band. */
  specific: Float32Array; fTon: Float32Array; bandFreq: number[];
  /** Prominent tonal components (6.3): critical-band index, frequency and specific tonality. */
  prominent: { band: number; f: number; T: number }[];
}

/** Clauses 6.2.2–6.2.7: tonal specific loudness and filtered signal loudness per band at 187.5 Hz (also the basis of ECMA-418-2 loudness). */
export function tonalityCore(
  x: Float64Array, fs: number, field: 'free' | 'diffuse', onProgress?: (f: number) => void,
): { nL: number; nTonal: Float64Array[]; nSigLp: Float64Array[]; fTon: Float64Array[]; n48: number } {
  const x48 = resampleTo48k(x, fs);
  const n = x48.length;
  if (n < FS * 0.5) throw new Error('Signal too short for ECMA-418-2 tonality (needs ≥ 0.5 s)');
  // 5.1.2 pre-processing: fade-in, zero padding (start s_b,max, end to n_new), ear filter.
  const nNew = SH_MAX * (Math.ceil((n + SH_MAX + SB_MAX) / SH_MAX) - 1);
  const padded = new Float64Array(SB_MAX + nNew);
  padded.set(x48, SB_MAX);
  for (let i = 0; i < Math.min(240, n); i++) padded[SB_MAX + i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / 240);
  const ear = sosFilter(field === 'diffuse' ? EAR_SOS.slice(2) : EAR_SOS, padded);

  // Which (band, block size) ACFs are needed (target band j averages its neighbours at block size S_j).
  const needs = Array.from({ length: N_BANDS }, () => new Set<number>());
  const lagMax: Record<number, number> = {};
  for (let j = 0; j < N_BANDS; j++) {
    const S = sbOf(j);
    lagMax[S] = Math.max(lagMax[S] ?? 0, lagWindow(j).mEnd);
    for (const b of neighbours(j)) needs[b].add(S);
  }
  const nBlocks = (S: number) => nNew / (S / 4) + 1;

  // Scaled ACF (30), lags 0..lagMax[S] per block: acf[S][band] = Float64Array(blocks × (lagMax+1)).
  const acf: Record<number, (Float64Array | undefined)[]> = {};
  for (const S of [8192, 4096, 2048, 1024]) acf[S] = new Array(N_BANDS);
  for (let i = 0; i < N_BANDS; i++) {
    const y = bandFilter(ear, i);
    for (const S of needs[i]) {
      const sh = S / 4, nb = nBlocks(S), L = lagMax[S] + 1, i0 = SB_MAX - S;
      const out = new Float64Array(nb * L);
      const re = new Float64Array(2 * S), im = new Float64Array(2 * S), cum = new Float64Array(S + 1);
      for (let l = 0; l < nb; l++) {
        const s = l * sh + i0;
        let e = 0;
        for (let k = 0; k < S; k++) {
          const v = y[s + k] > 0 ? y[s + k] : 0;
          re[k] = v; e += v * v; cum[k + 1] = e;
        }
        re.fill(0, S); im.fill(0);
        const Nb = basisLoudness(Math.sqrt((2 / S) * e), i);
        if (Nb === 0) continue; // scaled ACF is zero
        fft(re, im);
        for (let k = 0; k < 2 * S; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
        fft(re, im, true);
        for (let m = 0; m < L; m++) {
          const den = Math.sqrt(cum[S - m] * (e - cum[m])) + EPS; // Σ_{0}^{S-m-1} r² · Σ_{m}^{S-1} r²
          out[l * L + m] = (Nb * re[m]) / (2 * S) / den;
        }
      }
      acf[S][i] = out;
    }
    onProgress?.(((i + 1) / N_BANDS) * 0.8);
  }

  // Per target band: average, window, tonal loudness; then resample to 187.5 Hz.
  const lEnd = Math.ceil((n / FS) * RSD);
  const nL = lEnd + 1;
  const nTonalHat: Float64Array[] = [], nSignal: Float64Array[] = [], fTon: Float64Array[] = [];
  for (let j = 0; j < N_BANDS; j++) {
    const S = sbOf(j), nb = nBlocks(S), L = lagMax[S] + 1, { mStart, mEnd } = lagWindow(j);
    const M = mEnd - mStart + 1, nbrs = neighbours(j);
    // band average (only lag 0 and window lags needed)
    const A = new Float64Array(nb * (M + 1));
    for (let l = 0; l < nb; l++) {
      for (const b of nbrs) {
        const src = acf[S][b]!;
        A[l * (M + 1)] += src[l * L] / nbrs.length;
        for (let m = 0; m < M; m++) A[l * (M + 1) + 1 + m] += src[l * L + mStart + m] / nbrs.length;
      }
    }
    let Af = A;
    if (S >= 4096) { // average with preceding and following block, except first and last
      Af = A.slice();
      for (let l = 1; l < nb - 1; l++) for (let k = 0; k <= M; k++) Af[l * (M + 1) + k] = (A[(l - 1) * (M + 1) + k] + A[l * (M + 1) + k] + A[(l + 1) * (M + 1) + k]) / 3;
    }
    const nt = new Float64Array(nb), ns = new Float64Array(nb), ft = new Float64Array(nb);
    const v = new Float64Array(M);
    for (let l = 0; l < nb; l++) {
      const o = l * (M + 1), phi0 = Af[o];
      let mean = 0;
      for (let m = 0; m < M; m++) mean += Af[o + 1 + m];
      mean /= M;
      for (let m = 0; m < M; m++) v[m] = Af[o + 1 + m] - mean;
      const pk = peakSpectrum(v, M);
      const est = (2 * pk.mag) / (M / 2);
      nt[l] = est <= phi0 ? est : phi0; // (37)
      ns[l] = phi0;
      ft[l] = (pk.k * FS) / DFT_N;
    }
    // linear interpolation to the common time basis (Table 6), up to l_end
    const ip = S / 1024;
    const up = (a: Float64Array) => {
      const r = new Float64Array(nL);
      for (let t = 0; t < nL; t++) {
        const p = t / ip, i0 = Math.min(Math.floor(p), nb - 1), i1 = Math.min(i0 + 1, nb - 1), fr = p - i0;
        r[t] = a[i0] * (1 - fr) + a[i1] * fr;
      }
      return r;
    };
    nTonalHat.push(up(nt)); nSignal.push(up(ns)); fTon.push(up(ft));
    onProgress?.(0.8 + ((j + 1) / N_BANDS) * 0.15);
  }

  // 6.2.7 noise reduction, 6.2.8 specific tonality.
  const nTonal: Float64Array[] = [], nSigLp: Float64Array[] = [];
  for (let j = 0; j < N_BANDS; j++) {
    const snr = new Float64Array(nL);
    for (let l = 0; l < nL; l++) snr[l] = nTonalHat[j][l] / (nSignal[j][l] - nTonalHat[j][l] + EPS); // (42)
    const nTil = lowpass3(nTonalHat[j]), snrTil = lowpass3(snr);
    const [c, d] = G_PAR[sbOf(j)];
    const g = c / BAND_FC[j] ** d; // (46)
    const nt = new Float64Array(nL);
    for (let l = 0; l < nL; l++) {
      const ex = Math.exp(-NR_ALPHA * (snrTil[l] / g - NR_BETA));
      nt[l] = (ex < 1 ? 1 - ex : 0) * nTil[l]; // (45), (47)
    }
    nTonal.push(nt); nSigLp.push(lowpass3(nSignal[j]));
  }
  return { nL, nTonal, nSigLp, fTon, n48: n };
}

export function tonalityEcma(
  x: Float64Array, fs: number, field: 'free' | 'diffuse', onProgress?: (f: number) => void,
): TonalityEcmaResult {
  const { nL, nTonal, nSigLp, fTon } = tonalityCore(x, fs, field, onProgress);
  const specT = Array.from({ length: N_BANDS }, () => new Float64Array(nL));
  const Tl = new Float32Array(nL);
  for (let l = 0; l < nL; l++) {
    let noise = 0, maxTon = 0;
    for (let j = 0; j < N_BANDS; j++) { noise += nSigLp[j][l] - nTonal[j][l]; if (nTonal[j][l] > maxTon) maxTon = nTonal[j][l]; } // (48)
    const snr = maxTon / (EPS + noise); // (49)
    const ex = Math.exp(-Q_A * (snr - Q_B));
    const q = ex < 1 ? 1 - ex : 0; // (50)
    let tmax = 0;
    for (let j = 0; j < N_BANDS; j++) { specT[j][l] = C_T * q * nTonal[j][l]; if (specT[j][l] > tmax) tmax = specT[j][l]; } // (51)
    Tl[l] = tmax;
  }

  // 6.2.9–6.2.11 averages over frames ≥ 57 where the value exceeds 0.02 tu.
  const specific = new Float32Array(N_BANDS), fBand = new Float32Array(N_BANDS);
  for (let j = 0; j < N_BANDS; j++) {
    let s = 0, f = 0, c = 0;
    for (let l = FIRST_FRAME; l < nL; l++) if (specT[j][l] > 0.02) { s += specT[j][l]; f += fTon[j][l]; c++; }
    specific[j] = s / (c + EPS); fBand[j] = f / (c + EPS);
  }
  let s = 0, c = 0, Tmax = 0;
  for (let l = 0; l < nL; l++) Tmax = Math.max(Tmax, Tl[l]);
  for (let l = FIRST_FRAME; l < nL; l++) if (Tl[l] > 0.02) { s += Tl[l]; c++; }
  const prominent: TonalityEcmaResult['prominent'] = [];
  for (let j = 0; j < N_BANDS; j++) {
    if (specific[j] <= 0.4) continue;
    if (j > 0 && specific[j - 1] > specific[j]) continue;
    if (j < N_BANDS - 1 && specific[j + 1] > specific[j]) continue;
    const lo = BAND_FC[Math.max(0, j - 2)], hi = BAND_FC[Math.min(N_BANDS - 1, j + 2)];
    if (fBand[j] < lo || fBand[j] > hi) continue;
    prominent.push({ band: j, f: fBand[j], T: specific[j] });
  }
  prominent.sort((a, b) => b.T - a.T);
  onProgress?.(1);
  return { Tl, dt: 1 / RSD, T: s / (c + EPS), Tmax, specific, fTon: fBand, bandFreq: BAND_FC, prominent };
}
