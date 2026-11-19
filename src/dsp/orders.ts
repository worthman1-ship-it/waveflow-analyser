// Order analysis against a control channel (engine / shaft speed).
//
// Speed comes from a tacho channel of the same WAV file (pulses per revolution, rising edges found
// with hysteresis and linear sub-sample interpolation) or from a linear RPM ramp. The shaft phase
// phi(t) in revolutions is interpolated with a monotone cubic (pchip).
//   - Order tracking: heterodyne at k * phi(t) with a Hann average over a frame, giving the RMS
//     amplitude of order k at the frame's mean speed.
//   - Level vs RPM: overall RMS per frame, averaged in RPM bins.
//   - Order spectrum: the signal is resampled to 64 samples per revolution (cubic interpolation) and
//     the Hann-windowed 16-revolution frames are averaged: amplitude vs order, resolution 1/16 order.
import { fft, hann } from './fft';
import { pchip } from './roughnessEcma';

export interface OrderParams {
  mode: 'tacho' | 'ramp';
  /** Tacho pulses per revolution. */
  ppr: number;
  rpm0: number; rpm1: number;
  orders: number[];
  frameSec: number;
}

export interface OrderResult {
  /** Speed vs time. */
  rpm: Float32Array; rpmDt: number; rpmMin: number; rpmMax: number;
  /** RPM bin grid for the "vs RPM" curves: bin i covers rpmLo + i * rpmStep. */
  rpmLo: number; rpmStep: number;
  /** Overall level per RPM bin (units of the signal, RMS; empty bins take the nearest filled one). */
  levelVsRpm: Float32Array;
  /** Tracked orders: RMS amplitude per RPM bin. */
  tracks: { order: number; amp: Float32Array }[];
  /** Order spectrum (RMS amplitude vs order) averaged over the file. */
  spectrum: Float32Array; orderStep: number;
  revolutions: number;
}

const SPR = 64, FRAME_REV = 16, NB = 40;

/** Rising-edge times (s) of a tacho channel. */
function tachoPulses(t: Float64Array, fs: number): Float64Array {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < t.length; i++) { lo = Math.min(lo, t[i]); hi = Math.max(hi, t[i]); }
  if (!(hi - lo > 1e-9)) throw new Error('Tacho channel is flat');
  const mid = (lo + hi) / 2, hy = 0.1 * (hi - lo);
  const times: number[] = [];
  let armed = t[0] < mid - hy;
  for (let i = 1; i < t.length; i++) {
    if (!armed) { if (t[i] < mid - hy) armed = true; continue; }
    if (t[i - 1] < mid && t[i] >= mid) {
      times.push((i - 1 + (mid - t[i - 1]) / (t[i] - t[i - 1])) / fs);
      armed = false;
    }
  }
  return Float64Array.from(times);
}

/** Shaft phase in revolutions at every sample, plus the speed at the sample rate of `x`. */
export function shaftPhase(n: number, fs: number, tacho: Float64Array | undefined, p: OrderParams): Float64Array {
  const ph = new Float64Array(n);
  const T = n / fs;
  if (p.mode === 'ramp') {
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      ph[i] = (p.rpm0 * t + ((p.rpm1 - p.rpm0) * t * t) / (2 * T)) / 60;
    }
    return ph;
  }
  if (!tacho) throw new Error('Select a tacho channel in the WAV source node, or use the RPM ramp');
  const pulses = tachoPulses(tacho, fs);
  if (pulses.length < 4) throw new Error(`Only ${pulses.length} tacho pulses found: check the channel and threshold`);
  const revs = Float64Array.from(pulses, (_, i) => i / p.ppr);
  const tq = Float64Array.from({ length: n }, (_, i) => i / fs);
  // inside the pulse range: pchip; outside: extend with the end speed
  const inside = pchip(pulses, revs, tq.map((t) => Math.min(Math.max(t, pulses[0]), pulses[pulses.length - 1])));
  const sA = 1 / (p.ppr * (pulses[1] - pulses[0])), sB = 1 / (p.ppr * (pulses[pulses.length - 1] - pulses[pulses.length - 2]));
  for (let i = 0; i < n; i++) {
    const t = tq[i];
    ph[i] = t < pulses[0] ? inside[i] - sA * (pulses[0] - t) : t > pulses[pulses.length - 1] ? inside[i] + sB * (t - pulses[pulses.length - 1]) : inside[i];
  }
  return ph;
}

export function orderAnalysis(x: Float64Array, fs: number, tacho: Float64Array | undefined, p: OrderParams): OrderResult {
  const n = x.length;
  const phase = shaftPhase(n, fs, tacho, p);
  const revs = phase[n - 1] - phase[0];
  if (!(revs > FRAME_REV)) throw new Error(`Only ${revs.toFixed(1)} revolutions in the file (needs > ${FRAME_REV})`);

  // frames
  const fl = Math.max(16, Math.round(p.frameSec * fs)), hop = Math.floor(fl / 2), w = hann(fl);
  let ws = 0;
  for (let i = 0; i < fl; i++) ws += w[i];
  const nF = Math.max(1, 1 + Math.floor((n - fl) / hop));
  const frameRpm = new Float64Array(nF), frameLevel = new Float64Array(nF);
  const track = p.orders.map(() => new Float64Array(nF));
  for (let f = 0; f < nF; f++) {
    const s = f * hop, e = Math.min(n - 1, s + fl - 1);
    frameRpm[f] = (60 * (phase[e] - phase[s])) / ((e - s) / fs);
    let ms = 0;
    for (let i = 0; i < fl && s + i < n; i++) ms += w[i] * x[s + i] * x[s + i];
    frameLevel[f] = Math.sqrt(ms / ws);
    p.orders.forEach((k, j) => {
      let cr = 0, ci = 0;
      for (let i = 0; i < fl && s + i < n; i++) {
        const a = -2 * Math.PI * k * phase[s + i];
        cr += w[i] * x[s + i] * Math.cos(a); ci += w[i] * x[s + i] * Math.sin(a);
      }
      track[j][f] = (Math.SQRT2 * Math.hypot(cr, ci)) / ws; // RMS amplitude of a sinusoid of amplitude 2|mean|
    });
  }
  let rmin = Infinity, rmax = -Infinity;
  for (let f = 0; f < nF; f++) { rmin = Math.min(rmin, frameRpm[f]); rmax = Math.max(rmax, frameRpm[f]); }
  const step = Math.max((rmax - rmin) / NB, 1e-9);
  const bin = (r: number) => Math.min(NB - 1, Math.floor((r - rmin) / step));
  const avg = (v: Float64Array) => {
    const s = new Float64Array(NB), c = new Float64Array(NB);
    for (let f = 0; f < nF; f++) { const b = bin(frameRpm[f]); s[b] += v[f]; c[b]++; }
    const out = Float32Array.from(s, (v2, b) => (c[b] ? v2 / c[b] : NaN));
    let last = NaN;
    for (let b = 0; b < NB; b++) { if (isNaN(out[b])) out[b] = last; else last = out[b]; }
    for (let b = NB - 1; b >= 0; b--) { if (isNaN(out[b]) && b + 1 < NB) out[b] = out[b + 1]; }
    return out;
  };

  // speed vs time (every frame hop)
  const rpm = Float32Array.from(frameRpm);

  // order spectrum via angular resampling
  const total = Math.floor(revs * SPR);
  const u = new Float64Array(total);
  let j = 0;
  const p0 = phase[0];
  for (let i = 0; i < total; i++) {
    const target = p0 + i / SPR;
    while (j < n - 2 && phase[j + 1] < target) j++;
    const a = phase[j], b = phase[j + 1];
    const t = j + (b > a ? (target - a) / (b - a) : 0); // fractional sample index
    const k = Math.floor(t), fr = t - k;
    const g = (q: number) => x[Math.min(n - 1, Math.max(0, q))];
    const ym = g(k - 1), y0 = g(k), y1 = g(k + 1), y2 = g(k + 2);
    u[i] = y0 + 0.5 * fr * (y1 - ym + fr * (2 * ym - 5 * y0 + 4 * y1 - y2 + fr * (3 * (y0 - y1) + y2 - ym))); // Catmull-Rom
  }
  const nfft = FRAME_REV * SPR, ho = nfft / 2, wo = hann(nfft);
  let wsum = 0;
  for (let i = 0; i < nfft; i++) wsum += wo[i];
  const nSp = Math.max(1, 1 + Math.floor((total - nfft) / ho));
  const acc = new Float64Array(nfft / 2 + 1);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let f = 0; f < nSp; f++) {
    for (let i = 0; i < nfft; i++) { re[i] = u[f * ho + i] * wo[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= nfft / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  const spectrum = Float32Array.from(acc, (v, k) => {
    const a = (Math.sqrt(v / nSp) * 2) / wsum; // amplitude
    return (k === 0 ? a / 2 : a) / Math.SQRT2; // RMS
  });

  return {
    rpm, rpmDt: hop / fs, rpmMin: rmin, rpmMax: rmax, rpmLo: rmin, rpmStep: step,
    levelVsRpm: avg(frameLevel), tracks: p.orders.map((order, i) => ({ order, amp: avg(track[i]) })),
    spectrum, orderStep: 1 / FRAME_REV, revolutions: revs,
  };
}
