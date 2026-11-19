// Any time-varying metric (loudness, roughness, tonality, fluctuation) against shaft speed.
// The metric series v[k] is taken to belong to time k * dt; the speed at that time comes from the
// same tacho / ramp phase as the order analysis (averaged over max(dt, 0.1) s to steady it). Frames
// are grouped in 40 RPM bins; each bin gives the mean and the maximum of the metric.
import { shaftPhase, type OrderParams } from './orders';

export interface MetricRpmResult {
  rpmLo: number; rpmStep: number; rpmMin: number; rpmMax: number;
  mean: Float32Array; max: Float32Array;
  /** Frames used (after the start-up skip). */
  frames: number;
}

const NB = 40;

export function metricVsRpm(
  v: ArrayLike<number>, dt: number, n: number, fs: number, tacho: Float64Array | undefined, p: OrderParams, skipSec: number,
): MetricRpmResult {
  const phase = shaftPhase(n, fs, tacho, p);
  const T = (n - 1) / fs, h = Math.max(dt, 0.1) / 2;
  const at = (t: number) => { // phase at time t, linear between samples
    const q = Math.min(n - 1, Math.max(0, t * fs)), k = Math.min(n - 2, Math.floor(q));
    return phase[k] + (q - k) * (phase[k + 1] - phase[k]);
  };
  const rpmAt = (t: number) => {
    const a = Math.max(0, t - h), b = Math.min(T, t + h);
    return b > a ? (60 * (at(b) - at(a))) / (b - a) : NaN;
  };
  const k0 = Math.ceil(skipSec / dt);
  const r: number[] = [], m: number[] = [];
  for (let k = k0; k < v.length; k++) {
    const val = v[k], rpm = rpmAt(k * dt);
    if (k * dt > T || !isFinite(val) || !isFinite(rpm)) continue;
    r.push(rpm); m.push(val);
  }
  if (m.length < 10) throw new Error('Too few metric frames to plot against RPM (signal too short)');
  let rmin = Infinity, rmax = -Infinity;
  for (const x of r) { rmin = Math.min(rmin, x); rmax = Math.max(rmax, x); }
  const step = Math.max((rmax - rmin) / NB, 1e-9);
  const sum = new Float64Array(NB), cnt = new Float64Array(NB), mx = new Float64Array(NB).fill(-Infinity);
  for (let i = 0; i < m.length; i++) {
    const b = Math.min(NB - 1, Math.floor((r[i] - rmin) / step));
    sum[b] += m[i]; cnt[b]++; mx[b] = Math.max(mx[b], m[i]);
  }
  const fill = (a: Float32Array) => {
    let last = NaN;
    for (let b = 0; b < NB; b++) { if (isNaN(a[b])) a[b] = last; else last = a[b]; }
    for (let b = NB - 1; b >= 0; b--) if (isNaN(a[b]) && b + 1 < NB) a[b] = a[b + 1];
    return a;
  };
  return {
    rpmLo: rmin, rpmStep: step, rpmMin: rmin, rpmMax: rmax, frames: m.length,
    mean: fill(Float32Array.from(sum, (s, b) => (cnt[b] ? s / cnt[b] : NaN))),
    max: fill(Float32Array.from(mx, (x, b) => (cnt[b] ? x : NaN))),
  };
}
