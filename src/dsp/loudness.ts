// Zwicker loudness (ISO 532-1:2017 method for stationary sounds / DIN 45631) and
// DIN 45692 sharpness.
//
// Data tables and the algorithm structure follow the BASIC program of Zwicker & Fastl (1991)
// as reproduced in MoSQITo (Eomys, Apache-2.0) — see THIRD_PARTY_NOTICES.md.
// Third-octave levels come from our own 6th-order Butterworth filter bank (IEC 61260 style),
// not the ISO 532-1 reference filter coefficients, so results can differ slightly from
// the standard's reference implementation.
import { butterBandpass, sosFilter } from './biquad';

export const THIRD_OCT_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500,
];

/** Third-octave band levels (dB re 20 µPa) per block of `blockSec`; plus whole-signal levels. */
export function thirdOctaveLevels(x: Float64Array, fs: number, blockSec: number) {
  if (fs < 32000) throw new Error(`Loudness needs fs ≥ 32 kHz (12.5 kHz band); file is ${fs} Hz`);
  const blockN = Math.max(1, Math.round(blockSec * fs));
  const nBlocks = Math.max(1, Math.floor(x.length / blockN));
  const blocks: Float64Array[] = Array.from({ length: nBlocks }, () => new Float64Array(28));
  const overall = new Float64Array(28);
  const ref2 = 2e-5 * 2e-5;
  THIRD_OCT_CENTRES.forEach((_, b) => {
    const fm = 1000 * 10 ** ((b - 16) / 10); // exact base-10 midband
    const y = sosFilter(butterBandpass(3, fm * 10 ** -0.05, fm * 10 ** 0.05, fs), x);
    let total = 0;
    for (let k = 0; k < nBlocks; k++) {
      let s = 0;
      const end = Math.min(x.length, (k + 1) * blockN);
      for (let i = k * blockN; i < end; i++) s += y[i] * y[i];
      total += s;
      blocks[k][b] = 10 * Math.log10(Math.max(s / (end - k * blockN), 1e-30) / ref2);
    }
    overall[b] = 10 * Math.log10(Math.max(total / Math.min(x.length, nBlocks * blockN), 1e-30) / ref2);
  });
  return { blocks, overall, blockDt: blockN / fs };
}

const RAP = [45, 55, 65, 71, 80, 90, 100, 120];
const DLL = [
  [-32, -24, -16, -10, -5, 0, -7, -3, 0, -2, 0],
  [-29, -22, -15, -10, -4, 0, -7, -2, 0, -2, 0],
  [-27, -19, -14, -9, -4, 0, -6, -2, 0, -2, 0],
  [-25, -17, -12, -9, -3, 0, -5, -2, 0, -2, 0],
  [-23, -16, -11, -7, -3, 0, -4, -1, 0, -1, 0],
  [-20, -14, -10, -6, -3, 0, -4, -1, 0, -1, 0],
  [-18, -12, -9, -6, -2, 0, -3, -1, 0, -1, 0],
  [-15, -10, -8, -4, -2, 0, -3, -1, 0, -1, 0],
];
const LTQ = [30, 18, 12, 8, 7, 6, 5, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
const A0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.5, -1.6, -3.2, -5.4, -5.6, -4, -1.5, 2, 5, 12];
const DDF = [0, 0, 0.5, 0.9, 1.2, 1.6, 2.3, 2.8, 3, 2, 0, -1.4, -2, -1.9, -1, 0.5, 3, 4, 4.3, 4];
const DCB = [-0.25, -0.6, -0.8, -0.8, -0.5, 0, 0.5, 1.1, 1.5, 1.7, 1.8, 1.8, 1.7, 1.6, 1.4, 1.2, 0.8, 0.5, 0, -0.5];
const ZUP = [0.9, 1.8, 2.8, 3.5, 4.4, 5.4, 6.6, 7.9, 9.2, 10.6, 12.3, 13.8, 15.2, 16.7, 18.1, 19.3, 20.6, 21.8, 22.7, 23.6, 24];
const RNS = [21.5, 18, 15.1, 11.5, 9, 6.1, 4.4, 3.1, 2.13, 1.36, 0.82, 0.42, 0.3, 0.22, 0.15, 0.1, 0.035, 0];
const USL = [
  [13, 8.2, 6.3, 5.5, 5.5, 5.5, 5.5, 5.5],
  [9, 7.5, 6, 5.1, 4.5, 4.5, 4.5, 4.5],
  [7.8, 6.7, 5.6, 4.9, 4.4, 3.9, 3.9, 3.9],
  [6.2, 5.4, 4.6, 4.0, 3.5, 3.2, 3.2, 3.2],
  [4.5, 3.8, 3.6, 3.2, 2.9, 2.7, 2.7, 2.7],
  [3.7, 3.0, 2.8, 2.35, 2.2, 2.2, 2.2, 2.2],
  [2.9, 2.3, 2.1, 1.9, 1.8, 1.7, 1.7, 1.7],
  [2.4, 1.7, 1.5, 1.35, 1.3, 1.3, 1.3, 1.3],
  [1.95, 1.45, 1.3, 1.15, 1.1, 1.1, 1.1, 1.1],
  [1.5, 1.2, 0.94, 0.86, 0.82, 0.82, 0.82, 0.82],
  [0.72, 0.67, 0.64, 0.63, 0.62, 0.62, 0.62, 0.62],
  [0.59, 0.53, 0.51, 0.5, 0.42, 0.42, 0.42, 0.42],
  [0.4, 0.33, 0.26, 0.24, 0.24, 0.22, 0.22, 0.22],
  [0.27, 0.21, 0.2, 0.18, 0.17, 0.17, 0.17, 0.17],
  [0.16, 0.15, 0.14, 0.12, 0.11, 0.11, 0.11, 0.11],
  [0.12, 0.11, 0.1, 0.08, 0.08, 0.08, 0.08, 0.08],
  [0.09, 0.08, 0.07, 0.06, 0.06, 0.06, 0.06, 0.05],
  [0.06, 0.05, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02],
];

/** Core loudness NM (21 values, last = 0) from 28 third-octave levels. */
export function coreLoudness(lt: ArrayLike<number>, field: 'free' | 'diffuse'): number[] {
  for (let i = 0; i < 11; i++) {
    if (lt[i] > 120) throw new Error('A third-octave band below 300 Hz exceeds 120 dB; Zwicker method not valid');
  }
  const ti = new Array<number>(11);
  for (let i = 0; i < 11; i++) {
    let j = 0;
    while (j < 7 && lt[i] > RAP[j] - DLL[j][i]) j++;
    ti[i] = 10 ** ((lt[i] + DLL[j][i]) / 10);
  }
  const gi = [ti.slice(0, 6), ti.slice(6, 9), ti.slice(9, 11)].map((a) => a.reduce((s, v) => s + v, 0));
  const lcb = gi.map((g) => (g > 0 ? 10 * Math.log10(g) : 0));

  const nm = new Array<number>(21).fill(0);
  for (let i = 0; i < 20; i++) {
    let le = i < 3 ? lcb[i] : lt[i + 8];
    le -= A0[i];
    if (field === 'diffuse') le += DDF[i];
    if (le > LTQ[i]) {
      le -= DCB[i];
      const mp1 = 0.0635 * 10 ** (0.025 * LTQ[i]);
      const mp2 = (1 - 0.25 + 0.25 * 10 ** ((le - LTQ[i]) / 10)) ** 0.25 - 1;
      nm[i] = Math.max(0, mp1 * mp2);
    }
  }
  const korry = 0.4 + 0.32 * nm[0] ** 0.2;
  if (korry <= 1) nm[0] *= korry;
  return nm;
}

/** Total loudness N (sone) and specific loudness N'(z) on 0.1-Bark steps (240 values). */
export function calcSlopes(nm: number[]): { N: number; ns: Float64Array } {
  const ns = new Float64Array(240);
  let N = 0, z1 = 0, n1 = 0, iz = 0, j = 0;
  let z = 0.1;
  for (let i = 0; i < 21; i++) {
    const zup = ZUP[i] + 0.0001;
    const ig = Math.max(0, Math.min(7, i - 1));
    do {
      let n2: number, z2: number;
      if (n1 > nm[i]) {
        // Falling slope
        n2 = Math.max(RNS[j], nm[i]);
        const usl = USL[j][ig];
        let dz = (n1 - n2) / usl;
        z2 = z1 + dz;
        if (z2 > zup) { z2 = zup; dz = z2 - z1; n2 = n1 - dz * usl; }
        N += (dz * (n1 + n2)) / 2;
        while (z < z2 && iz < 240) { ns[iz] = n1 - (z - z1) * usl; iz++; z = (iz + 1) * 0.1; }
      } else {
        // Flat (or rising step) to the band edge
        if (n1 < nm[i]) { j = 0; while (j < 17 && RNS[j] > nm[i]) j++; }
        z2 = zup; n2 = nm[i];
        N += n2 * (z2 - z1);
        while (z < z2 && iz < 240) { ns[iz] = n2; iz++; z = (iz + 1) * 0.1; }
      }
      while (j < 17 && n2 <= RNS[j]) j++;
      z1 = z2; n1 = n2;
    } while (z1 < zup);
  }
  N = Math.max(0, N);
  N = N <= 16 ? Math.floor(N * 1000 + 0.5) / 1000 : Math.floor(N * 100 + 0.5) / 100;
  return { N, ns };
}

/** DIN 45692 sharpness (acum) from specific loudness on the 0.1-Bark grid. */
export function sharpnessDin(N: number, ns: Float64Array): number {
  if (N < 0.1) return 0;
  let s = 0;
  for (let k = 0; k < ns.length; k++) {
    const z = (k + 1) * 0.1;
    const g = z > 15.8 ? 0.15 * Math.exp(0.42 * (z - 15.8)) + 0.85 : 1;
    s += ns[k] * g * z * 0.1;
  }
  return (0.11 * s) / N;
}

export function loudnessFromLevels(lt: ArrayLike<number>, field: 'free' | 'diffuse') {
  const { N, ns } = calcSlopes(coreLoudness(lt, field));
  return { N, ns, S: sharpnessDin(N, ns) };
}
