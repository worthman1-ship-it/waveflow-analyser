// Exponential time weighting (Fast τ = 0.125 s, Slow τ = 1 s), maxima, overall RMS and VDV.

export const TAU_FAST = 0.125;
export const TAU_SLOW = 1.0;

export interface TimeWeighted {
  /** Maximum running RMS (linear units of the signal). */
  max: number;
  /** Time of the maximum (s). */
  tMax: number;
  /** Running RMS history, decimated to `dt` spacing. */
  history: Float32Array;
  dt: number;
}

/**
 * Exponentially time-weighted running RMS: y' = (x² − y)/τ, discretised as
 * y[n] = y[n−1] + α (x[n]² − y[n−1]), α = 1 − exp(−1/(τ fs)).
 * The maximum is taken over every sample; the history is decimated for plotting.
 */
export function timeWeighted(x: Float64Array, fs: number, tau: number, maxPoints = 4000): TimeWeighted {
  const alpha = 1 - Math.exp(-1 / (tau * fs));
  const decim = Math.max(1, Math.ceil(x.length / maxPoints));
  const history = new Float32Array(Math.ceil(x.length / decim));
  let y = 0, max = 0, iMax = 0;
  for (let i = 0; i < x.length; i++) {
    y += alpha * (x[i] * x[i] - y);
    if (y > max) { max = y; iMax = i; }
    if (i % decim === decim - 1 || i === x.length - 1) history[Math.floor(i / decim)] = Math.sqrt(y);
  }
  return { max: Math.sqrt(max), tMax: iMax / fs, history, dt: decim / fs };
}

export function rms(x: Float64Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Vibration dose value (∫ a⁴ dt)^¼, m/s^1.75 when x is acceleration in m/s². */
export function vdv(x: Float64Array, fs: number): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) { const a2 = x[i] * x[i]; s += a2 * a2; }
  return Math.pow(s / fs, 0.25);
}

export function toDb(value: number, ref: number): number {
  return value > 0 ? 20 * Math.log10(value / ref) : -Infinity;
}
