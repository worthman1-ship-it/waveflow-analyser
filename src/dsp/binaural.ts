// Interaural analysis of a two-channel (head) recording: level difference and cross-correlation.
//   - ILD = Leq(left) - Leq(right).
//   - IACC = max over lags |tau| <= 1 ms of the normalised cross-correlation of the two channels,
//     ITD = the lag of that maximum (positive: the right channel lags the left). Broadband, over the
//     whole file and per 1 s frame (ISO 3382-1 IACC uses 80 ms of an impulse response in the 500 Hz
//     - 2 kHz octave bands; this is the running-signal analogue, unfiltered).
export interface InterauralResult {
  leqL: number; leqR: number; ild: number;
  iacc: number; itd: number;
  /** IACC per 1 s frame (dt = 1 s). */
  iaccT: Float32Array; dt: number;
}

function iaccOf(l: Float64Array, r: Float64Array, a: number, b: number, maxLag: number) {
  let el = 0, er = 0;
  for (let i = a; i < b; i++) { el += l[i] * l[i]; er += r[i] * r[i]; }
  const den = Math.sqrt(el * er);
  if (!(den > 0)) return { iacc: 0, lag: 0 };
  let best = -Infinity, bl = 0;
  for (let k = -maxLag; k <= maxLag; k++) {
    let s = 0;
    const i0 = Math.max(a, a - k), i1 = Math.min(b, b - k);
    for (let i = i0; i < i1; i++) s += l[i] * r[i + k];
    if (Math.abs(s) > best) { best = Math.abs(s); bl = k; }
  }
  return { iacc: best / den, lag: bl };
}

export function interaural(l: Float64Array, r: Float64Array, fs: number, ref: number): InterauralResult {
  const n = Math.min(l.length, r.length), maxLag = Math.round(0.001 * fs);
  const leq = (x: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += x[i] * x[i]; return 10 * Math.log10(Math.max(s / n, 1e-300) / (ref * ref)); };
  const whole = iaccOf(l, r, 0, n, maxLag);
  const fl = Math.round(fs), nF = Math.max(1, Math.floor(n / fl));
  const iaccT = new Float32Array(nF);
  for (let f = 0; f < nF; f++) iaccT[f] = iaccOf(l, r, f * fl, Math.min(n, (f + 1) * fl), maxLag).iacc;
  const L = leq(l), R = leq(r);
  return { leqL: L, leqR: R, ild: L - R, iacc: whole.iacc, itd: whole.lag / fs, iaccT, dt: 1 };
}
