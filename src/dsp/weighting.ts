// Frequency weightings as digital SOS cascades.
//  - A, C: IEC 61672-1 analog pole/zero definition, bilinear with pre-warped poles,
//    normalised to 0 dB at 1 kHz.
//  - Vibration (Wb, Wc, Wd, Wk, Wm, Wh): ISO 8041 / ISO 2631-1 band-limiting × a-v transition
//    × upward step, parameters from ISO 8041-1 Table (Wb per BS 6841 / ISO 2631-4).
import { bilinear, prewarp, scaleSos, sosMagnitude, type Sos } from './biquad';

export type WeightingId = 'Z' | 'A' | 'C' | 'Wb' | 'Wc' | 'Wd' | 'Wk' | 'Wm' | 'Wh';

export const WEIGHTINGS: { id: WeightingId; label: string; group: string }[] = [
  { id: 'Z', label: 'Z (none)', group: 'General' },
  { id: 'A', label: 'A (IEC 61672)', group: 'Sound' },
  { id: 'C', label: 'C (IEC 61672)', group: 'Sound' },
  { id: 'Wb', label: 'Wb – vertical, buildings/rail (BS 6841, BS 6472)', group: 'Vibration' },
  { id: 'Wc', label: 'Wc – seat-back x (ISO 2631-1)', group: 'Vibration' },
  { id: 'Wd', label: 'Wd – horizontal x/y (ISO 2631-1)', group: 'Vibration' },
  { id: 'Wk', label: 'Wk – vertical z (ISO 2631-1)', group: 'Vibration' },
  { id: 'Wm', label: 'Wm – buildings, any axis (ISO 2631-2)', group: 'Vibration' },
  { id: 'Wh', label: 'Wh – hand-arm (ISO 5349-1)', group: 'Vibration' },
];

interface VibParams { f1: number; f2: number; f3?: number; f4?: number; Q4?: number; f5?: number; Q5?: number; f6?: number; Q6?: number; K: number }

const VIB: Record<string, VibParams> = {
  Wb: { f1: 0.4, f2: 100, f3: 16, f4: 16, Q4: 0.55, f5: 2.5, Q5: 0.9, f6: 4, Q6: 0.95, K: 1.024 },
  Wc: { f1: 0.4, f2: 100, f3: 8, f4: 8, Q4: 0.63, K: 1 },
  Wd: { f1: 0.4, f2: 100, f3: 2, f4: 2, Q4: 0.63, K: 1 },
  Wk: { f1: 0.4, f2: 100, f3: 12.5, f4: 12.5, Q4: 0.63, f5: 2.37, Q5: 0.91, f6: 3.35, Q6: 0.91, K: 1 },
  Wm: { f1: 0.7943, f2: 100, f3: 5.684, f4: 5.684, Q4: 0.5, K: 1 },
  Wh: { f1: 6.310, f2: 1258.9, f3: 15.915, f4: 15.915, Q4: 0.64, K: 1 },
};

const TWO_PI = 2 * Math.PI;
const Q1 = Math.SQRT1_2;

function vibrationSos(p: VibParams, fs: number): Sos {
  const w = (f: number) => prewarp(TWO_PI * f, fs);
  const sos: Sos = [];
  const w1 = w(p.f1);
  sos.push(bilinear([1, 0, 0], [1, w1 / Q1, w1 * w1], fs)); // high-pass
  if (p.f2 < 0.45 * fs) {
    const w2 = w(p.f2);
    sos.push(bilinear([0, 0, w2 * w2], [1, w2 / Q1, w2 * w2], fs)); // low-pass
  }
  if (p.f3 && p.f4 && p.Q4) {
    const w3 = w(p.f3), w4 = w(p.f4);
    // (1 + s/w3) / (1 + s/(Q4 w4) + s²/w4²)
    sos.push(bilinear([0, 1 / w3, 1], [1 / (w4 * w4), 1 / (p.Q4 * w4), 1], fs));
  }
  if (p.f5 && p.f6 && p.Q5 && p.Q6) {
    const w5 = w(p.f5), w6 = w(p.f6);
    // Upward step: unity at high frequency, (f5/f6)² at DC.
    sos.push(bilinear([1, w5 / p.Q5, w5 * w5], [1, w6 / p.Q6, w6 * w6], fs));
  }
  return scaleSos(sos, p.K);
}

// IEC 61672-1 pole frequencies
const F1 = 20.598997, F2 = 107.65265, F3 = 737.86223, F4 = 12194.217;

function acousticSos(id: 'A' | 'C', fs: number): Sos {
  const w = (f: number) => prewarp(TWO_PI * f, fs);
  const w1 = w(F1), w4 = w(F4);
  const sos: Sos = [bilinear([1, 0, 0], [1, 2 * w1, w1 * w1], fs)]; // s² / (s+w1)²
  if (id === 'A') {
    const w2 = w(F2), w3 = w(F3);
    sos.push(bilinear([1, 0, 0], [1, w2 + w3, w2 * w3], fs)); // s² / ((s+w2)(s+w3))
  }
  sos.push(bilinear([0, 0, w4 * w4], [1, 2 * w4, w4 * w4], fs)); // w4² / (s+w4)²
  return scaleSos(sos, 1 / sosMagnitude(sos, 1000, fs));
}

export function weightingSos(id: WeightingId, fs: number): Sos {
  if (id === 'Z') return [];
  if (id === 'A' || id === 'C') return acousticSos(id, fs);
  return vibrationSos(VIB[id], fs);
}

export function isVibrationWeighting(id: WeightingId): boolean {
  return id in VIB;
}
