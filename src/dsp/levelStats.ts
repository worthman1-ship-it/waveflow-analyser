// Overall level statistics: Leq, peak, Fast-weighted maximum/minimum and the percentile levels
// L_x exceeded for x % of the time (125 ms Fast detector, 100 Hz sampling).
import { timeWeighted, TAU_FAST } from './levels';

export interface LevelStatsResult {
  leq: number; lpeak: number; lfMax: number; lfMin: number;
  /** x -> L_x (dB), x in {1, 5, 10, 50, 90, 95, 99}. */
  percentiles: { x: number; level: number }[];
  duration: number;
}

export function levelStatistics(x: Float64Array, fs: number, ref: number): LevelStatsResult {
  const dur = x.length / fs;
  const f = timeWeighted(x, fs, TAU_FAST, Math.max(10, Math.floor(dur * 100)));
  const skip = dur > 3 ? Math.ceil(0.5 / f.dt) : 0; // detector start-up
  const lv = Float64Array.from(f.history.subarray(skip), (v) => 20 * Math.log10(Math.max(v, 1e-300) / ref)).sort();
  const at = (xPct: number) => lv[Math.min(lv.length - 1, Math.max(0, Math.floor((1 - xPct / 100) * lv.length)))];
  let ms = 0, pk = 0;
  for (let i = 0; i < x.length; i++) { ms += x[i] * x[i]; pk = Math.max(pk, Math.abs(x[i])); }
  return {
    leq: 10 * Math.log10(Math.max(ms / x.length, 1e-300) / (ref * ref)),
    lpeak: 20 * Math.log10(Math.max(pk, 1e-300) / ref),
    lfMax: lv[lv.length - 1], lfMin: lv[0],
    percentiles: [1, 5, 10, 50, 90, 95, 99].map((p) => ({ x: p, level: at(p) })),
    duration: dur,
  };
}

/**
 * Psychoacoustic annoyance after Zwicker and Fastl (Psychoacoustics, 3rd ed.):
 * PA = N5 (1 + sqrt(wS^2 + wFR^2)), wS = (S/acum - 1.75) * 0.25 * lg(N5/sone + 10) for S > 1.75 (else 0),
 * wFR = 2.18 / (N5/sone)^0.4 * (0.4 F/vacil + 0.6 R/asper).
 */
export function psychoacousticAnnoyance(n5: number, s: number, f: number, r: number) {
  const wS = s > 1.75 ? (s - 1.75) * 0.25 * Math.log10(n5 + 10) : 0;
  const wFR = n5 > 0 ? (2.18 / n5 ** 0.4) * (0.4 * f + 0.6 * r) : 0;
  return { PA: n5 * (1 + Math.sqrt(wS * wS + wFR * wFR)), wS, wFR };
}
