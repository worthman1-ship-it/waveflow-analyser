// Event detection and rule-based source identification for long-term noise surveys.
//
// 1. A-weighted Leq per 0.25 s block.
// 2. Background = L90 of those blocks in a sliding window (default 5 min), evaluated every 10 s and interpolated.
// 3. Event = blocks more than `threshold` dB above the background for at least `minDur`; gaps under 2 s are bridged.
// 4. Per event: LAeq, LAmax, SEL, duration, rise/fall, steadiness, impulse (10 ms level over LAeq), and from an
//    averaged spectrum of the raw signal: peak frequency, centroid, low/high-frequency share, strongest-line prominence.
// 5. A transparent rule set (no training data) turns those features into a source label. The thresholds are generic
//    rules of thumb, not calibrated on any site: read the features and check the labels against listening or logs.
import { fft, hann, nextPow2 } from './fft';

export interface EventParams { threshold: number; minDur: number; windowSec: number }
export interface SurveyEvent {
  t0: number; dur: number; laeq: number; lamax: number; sel: number;
  tMax: number; rise: number; fall: number; steadiness: number; impulse: number;
  fPeak: number; centroid: number; lfShare: number; hfShare: number; tonalProm: number;
  source: string;
}
export interface EventsResult {
  dt: number; level: Float32Array; background: Float32Array; duration: number; laeq: number;
  events: SurveyEvent[];
  /** Per source: count and the equivalent level it contributes over the whole recording (from the summed SEL). */
  classes: { source: string; count: number; contribution: number }[];
  threshold: number;
}

const BLOCK = 0.25;

export function classify(e: Omit<SurveyEvent, 'source'>): string {
  const smooth = e.rise >= 6 && e.fall >= 6 && e.tMax > 0.2 && e.tMax < 0.8;
  if (e.dur < 3 && e.impulse >= 10) return 'Impulsive (bang, door, hammer)';
  if (e.tonalProm >= 15 && e.steadiness <= 3 && e.dur >= 5) return 'Tonal plant / machinery';
  if (e.dur >= 12 && smooth && e.centroid < 1500) return 'Aircraft / long pass-by';
  if (e.dur >= 2 && e.dur < 12 && smooth) return 'Road vehicle pass-by';
  if (e.centroid >= 3000 && e.lfShare < 0.2) return 'High-frequency (birds, squeal, hiss)';
  if (e.steadiness <= 3 && e.dur >= 10) return 'Steady noise (plant, ventilation, rain)';
  return 'Unclassified';
}

function percentile(a: Float32Array, lo: number, hi: number, p: number): number {
  const s = Array.from(a.subarray(lo, hi)).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Features of one event from the raw (unweighted) signal, the A-weighted signal and the A-weighted block levels. */
function describe(raw: Float64Array, fs: number, aw: Float64Array, level: Float32Array, b0: number, b1: number, ref: number): Omit<SurveyEvent, 'source'> {
  const n = b1 - b0, dur = n * BLOCK;
  let lmax = -Infinity, imax = b0, sum = 0;
  for (let b = b0; b < b1; b++) { sum += 10 ** (level[b] / 10); if (level[b] > lmax) { lmax = level[b]; imax = b; } }
  const laeq = 10 * Math.log10(sum / n);
  const edge = Math.max(1, Math.min(4, Math.floor(n / 4)));
  const mean = (lo: number, hi: number) => { let s = 0; for (let b = lo; b < hi; b++) s += level[b]; return s / (hi - lo); };
  const rise = lmax - mean(b0, b0 + edge), fall = lmax - mean(b1 - edge, b1);
  let m = 0, v = 0;
  for (let b = b0; b < b1; b++) m += level[b] / n;
  for (let b = b0; b < b1; b++) v += (level[b] - m) ** 2 / n;
  // impulse: loudest 10 ms of the A-weighted signal over the event LAeq
  const blk = Math.max(1, Math.round(0.01 * fs)), s0 = Math.round(b0 * BLOCK * fs), s1 = Math.min(aw.length, Math.round(b1 * BLOCK * fs));
  let p10 = 0;
  for (let i = s0; i + blk <= s1; i += blk) { let q = 0; for (let j = 0; j < blk; j++) q += aw[i + j] ** 2; p10 = Math.max(p10, q / blk); }
  const impulse = 10 * Math.log10(Math.max(p10, 1e-300) / (ref * ref)) - laeq;
  // averaged spectrum: up to 8 s around the maximum
  const nfft = nextPow2(Math.round(0.1 * fs)), w = hann(nfft), half = Math.round(4 * fs);
  const c = Math.round((imax + 0.5) * BLOCK * fs), a = Math.max(s0, c - half), z = Math.min(s1, c + half);
  const re = new Float64Array(nfft), im = new Float64Array(nfft), P = new Float64Array(nfft / 2 + 1);
  let frames = 0;
  for (let st = a; st + nfft <= z; st += nfft / 2) {
    for (let i = 0; i < nfft; i++) { re[i] = raw[st + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < nfft / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const df = fs / nfft, k0 = Math.max(1, Math.ceil(20 / df));
  let tot = 0, cen = 0, lf = 0, hf = 0, kp = k0;
  for (let k = k0; k < nfft / 2; k++) {
    tot += P[k]; cen += P[k] * k * df;
    if (k * df < 250) lf += P[k];
    if (k * df > 2000) hf += P[k];
    if (P[k] > P[kp]) kp = k;
  }
  // prominence of the strongest line over the mean power of the bins 4-20 either side
  let nb = 0, nbSum = 0;
  for (let d = 4; d <= 20; d++) for (const k of [kp - d, kp + d]) if (k >= 1 && k < nfft / 2) { nbSum += P[k]; nb++; }
  const lineP = P[Math.max(0, kp - 1)] + P[kp] + P[kp + 1], bgP = (nbSum / Math.max(1, nb)) * 3;
  return {
    t0: b0 * BLOCK, dur, laeq, lamax: lmax, sel: laeq + 10 * Math.log10(dur), tMax: (imax - b0 + 0.5) / n,
    rise, fall, steadiness: Math.sqrt(v), impulse, fPeak: kp * df,
    centroid: frames && tot > 0 ? cen / tot : 0, lfShare: tot > 0 ? lf / tot : 0, hfShare: tot > 0 ? hf / tot : 0,
    tonalProm: frames && bgP > 0 ? 10 * Math.log10(lineP / bgP) : 0,
  };
}

export function detectEvents(raw: Float64Array, aw: Float64Array, fs: number, ref: number, p: EventParams): EventsResult {
  const bs = Math.round(BLOCK * fs), nb = Math.floor(aw.length / bs);
  if (nb < 40) throw new Error('Recording too short for event detection (needs at least 10 s)');
  const level = new Float32Array(nb);
  let totalMs = 0;
  for (let b = 0; b < nb; b++) {
    let q = 0;
    for (let i = b * bs; i < (b + 1) * bs; i++) q += aw[i] * aw[i];
    q /= bs; totalMs += q;
    level[b] = 10 * Math.log10(Math.max(q, 1e-300) / (ref * ref));
  }
  // background: L90 in a window ending at each 10 s knot (centred where possible), linearly interpolated
  const win = Math.min(nb, Math.max(40, Math.round(p.windowSec / BLOCK))), stepB = Math.round(10 / BLOCK), knots: number[] = [], kv: number[] = [];
  for (let c = 0; c < nb + stepB; c += stepB) {
    const cc = Math.min(c, nb - 1), lo = Math.max(0, Math.min(nb - win, cc - Math.floor(win / 2)));
    knots.push(cc); kv.push(percentile(level, lo, lo + win, 0.1));
    if (cc === nb - 1) break;
  }
  const background = new Float32Array(nb);
  for (let k = 0, b = 0; b < nb; b++) {
    while (k < knots.length - 2 && knots[k + 1] < b) k++;
    const k1 = Math.min(k + 1, knots.length - 1);
    const f = knots[k1] === knots[k] ? 0 : (b - knots[k]) / (knots[k1] - knots[k]);
    background[b] = kv[k] + (kv[k1] - kv[k]) * Math.max(0, Math.min(1, f));
  }
  // threshold crossings; bridge gaps under 2 s; keep events of at least minDur
  const on = Array.from(level, (l, b) => l > background[b] + p.threshold);
  const gap = Math.round(2 / BLOCK), spans: [number, number][] = [];
  for (let b = 0; b < nb; b++) {
    if (!on[b]) continue;
    let e = b;
    for (;;) {
      let nx = -1;
      for (let g = 1; g <= gap + 1 && e + g < nb; g++) if (on[e + g]) { nx = e + g; break; }
      if (nx < 0) break;
      e = nx;
    }
    spans.push([b, e + 1]); b = e;
  }
  const events = spans
    .map(([a, z]) => describe(raw, fs, aw, level, a, z, ref))
    .filter((f) => f.dur >= p.minDur || f.impulse >= 10) // short bangs are kept whatever the minimum duration
    .map((f) => ({ ...f, source: classify(f) }));
  const dur = nb * BLOCK, byClass = new Map<string, { n: number; e: number }>();
  for (const e of events) { const c = byClass.get(e.source) ?? { n: 0, e: 0 }; c.n++; c.e += 10 ** (e.sel / 10); byClass.set(e.source, c); }
  const classes = [...byClass].map(([source, c]) => ({ source, count: c.n, contribution: 10 * Math.log10(c.e / dur) })).sort((a, b) => b.contribution - a.contribution);
  return { dt: BLOCK, level, background, duration: dur, laeq: 10 * Math.log10(totalMs / nb / (ref * ref)), events, classes, threshold: p.threshold };
}
