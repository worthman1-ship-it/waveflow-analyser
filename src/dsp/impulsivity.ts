// Impulsiveness indicators from the A-weighted sound level with Fast and Impulse time weightings
// (IEC 61672-1: Fast τ = 125 ms; Impulse: rise 35 ms, decay 1.5 s).
// The difference L_AI,max − L_AF,max grows with the impulsiveness of the sound.
export interface ImpulsivityResult {
  lafMax: number; laiMax: number; diff: number; laeq: number; peak: number; crest: number;
  tLaf: number; tLai: number; laf: Float32Array; lai: Float32Array; dt: number;
}

/**
 * Exponential mean-square detector. Stage 1 is a symmetric average with `tauRise`; if `tauDecay`
 * is longer, stage 2 holds the stage-1 output and lets it decay with `tauDecay` (so a steady sound
 * reads the same as with the symmetric detector, but an impulse is held). Returns history and max.
 */
function detector(x: Float64Array, fs: number, tauRise: number, tauDecay: number, maxPoints: number) {
  const ar = Math.exp(-1 / (fs * tauRise)), ad = Math.exp(-1 / (fs * tauDecay));
  const step = Math.max(1, Math.ceil(x.length / maxPoints));
  const hist = new Float32Array(Math.ceil(x.length / step));
  let y1 = 0, y = 0, max = 0, tMax = 0;
  for (let i = 0; i < x.length; i++) {
    y1 = ar * y1 + (1 - ar) * x[i] * x[i];
    y = tauDecay > tauRise ? Math.max(y1, y * ad) : y1;
    if (y > max) { max = y; tMax = i / fs; }
    if (i % step === 0) hist[i / step] = y;
  }
  return { max, tMax, hist };
}

const db = (ms: number, ref: number) => 10 * Math.log10(Math.max(ms, 1e-300) / (ref * ref));

/** `x` must already be A-weighted pressure; `rawPeak` is the peak |p| of the unweighted signal. */
export function impulsivity(x: Float64Array, fs: number, ref: number, rawPeak: number, maxPoints = 2000): ImpulsivityResult {
  const f = detector(x, fs, 0.125, 0.125, maxPoints);
  const i = detector(x, fs, 0.035, 1.5, maxPoints);
  let ms = 0;
  for (let k = 0; k < x.length; k++) ms += x[k] * x[k];
  ms /= x.length;
  const lafMax = db(f.max, ref), laiMax = db(i.max, ref);
  const toDb = (h: Float32Array) => Float32Array.from(h, (v) => db(v, ref));
  const peak = Math.max(rawPeak, 1e-300);
  return {
    lafMax, laiMax, diff: laiMax - lafMax, laeq: db(ms, ref),
    peak: 20 * Math.log10(peak / ref), crest: 20 * Math.log10(peak / Math.sqrt(Math.max(ms, 1e-300))),
    tLaf: f.tMax, tLai: i.tMax, laf: toDb(f.hist), lai: toDb(i.hist), dt: x.length / fs / f.hist.length,
  };
}
