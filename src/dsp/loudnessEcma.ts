// ECMA-418-2 (4th ed., 2025) clause 8.1: loudness of the Sottek Hearing Model (unit: sone_HMS),
// from the tonal and noise specific loudness of clause 6 (Formulae 113–117). Mono input.
import { N_BANDS, DZ, BAND_FC } from './sottekHms';
import { tonalityCore } from './tonalityEcma';

const WN = 0.5331, EA = 0.2918, EB = 0.5459, EPS = 1e-12;
const FIRST = 57;
const E_POW = 1 / Math.log10(2);

export interface LoudnessEcmaResult {
  /** N(t) every 1/187.5 s, sone_HMS. */
  Nt: Float32Array; dt: number;
  /** Single value N (power average, Formula 117) and maximum. */
  N: number; Nmax: number;
  /** Average specific loudness per band (Formula 115), sone_HMS/Bark. */
  specific: Float32Array; bandFreq: Float32Array;
}

export function loudnessEcma(
  x: Float64Array, fs: number, field: 'free' | 'diffuse' = 'free', onProgress?: (f: number) => void,
): LoudnessEcmaResult {
  const { nL, nTonal, nSigLp } = tonalityCore(x, fs, field, onProgress);
  const spec = Array.from({ length: N_BANDS }, () => new Float64Array(nL));
  const Nt = new Float32Array(nL);
  for (let l = 0; l < nL; l++) {
    let mx = 0;
    const nn = new Float64Array(N_BANDS);
    for (let z = 0; z < N_BANDS; z++) {
      nn[z] = Math.max(0, nSigLp[z][l] - nTonal[z][l]); // (48)
      mx = Math.max(mx, nTonal[z][l] + nn[z]);
    }
    const e = EA / (mx + EPS) + EB; // (114)
    let sum = 0;
    for (let z = 0; z < N_BANDS; z++) {
      const v = (nTonal[z][l] ** e + (WN * nn[z]) ** e) ** (1 / e); // (113)
      spec[z][l] = v; sum += v;
    }
    Nt[l] = DZ * sum; // (116)
  }
  const pavg = (get: (l: number) => number) => {
    let s = 0;
    for (let l = FIRST; l < nL; l++) s += get(l) ** E_POW;
    return (s / (nL - FIRST)) ** (1 / E_POW);
  };
  const specific = new Float32Array(N_BANDS);
  for (let z = 0; z < N_BANDS; z++) specific[z] = pavg((l) => spec[z][l]);
  let Nmax = 0;
  for (let l = 0; l < nL; l++) Nmax = Math.max(Nmax, Nt[l]);
  return { Nt, dt: 1 / 187.5, N: pavg((l) => Nt[l]), Nmax, specific, bandFreq: Float32Array.from(BAND_FC) };
}
