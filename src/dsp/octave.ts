// Octave and one-third-octave band levels (IEC 61260 base-10 centre frequencies), computed from
// Hann-windowed power spectra: the power in each band's exact edges is summed over frames.
// Gives the band Leq (energy average) and the maximum frame level per band.
import { fft, hann, nextPow2 } from './fft';

export interface OctaveResult {
  /** Band centre frequencies (Hz) and levels (dB re `ref`). */
  fc: number[]; leq: number[]; lmax: number[];
  /** Level summed over all reported bands (dB). */
  total: number; fraction: 1 | 3; frameSec: number;
}

export function octaveBands(x: Float64Array, fs: number, ref: number, fraction: 1 | 3, fLow = 20): OctaveResult {
  // Frame of >= 1 s so that the 20 Hz third-octave band (about 4.6 Hz wide) holds several bins.
  let nfft = nextPow2(Math.max(fs, 1024));
  while (nfft > x.length && nfft > 1024) nfft /= 2;
  if (x.length < nfft) throw new Error('Signal too short for band analysis');
  const df = fs / nfft, hop = nfft / 2, w = hann(nfft);
  let wss = 0;
  for (let i = 0; i < nfft; i++) wss += w[i] * w[i];
  const nFrames = 1 + Math.floor((x.length - nfft) / hop);

  const half = fraction === 3 ? 10 ** 0.05 : 10 ** 0.15;
  const fc: number[] = [], lo: number[] = [], hi: number[] = [];
  for (let k = -30; k <= 20; k++) {
    const f = 1000 * 10 ** ((fraction === 3 ? k : 3 * k) / 10);
    if (f < fLow * 0.99 || f * half > Math.min(fs / 2, 22000)) continue;
    if (f * half - f / half < 2 * df) continue; // fewer than 2 bins: not resolvable
    fc.push(f); lo.push(f / half); hi.push(f * half);
  }
  const nb = fc.length, sum = new Float64Array(nb), maxP = new Float64Array(nb);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let f = 0; f < nFrames; f++) {
    for (let i = 0; i < nfft; i++) { re[i] = x[f * hop + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < nb; b++) {
      let p = 0;
      const k0 = Math.ceil(lo[b] / df), k1 = Math.min(nfft / 2 - 1, Math.floor(hi[b] / df));
      for (let k = Math.max(1, k0); k <= k1; k++) p += (2 * (re[k] * re[k] + im[k] * im[k])) / (nfft * wss); // mean square of the bin
      sum[b] += p; if (p > maxP[b]) maxP[b] = p;
    }
  }
  const dB = (ms: number) => 10 * Math.log10(Math.max(ms, 1e-300) / (ref * ref));
  let tot = 0;
  for (let b = 0; b < nb; b++) tot += sum[b] / nFrames;
  return {
    fc, leq: Array.from(sum, (s) => dB(s / nFrames)), lmax: Array.from(maxP, dB), total: dB(tot), fraction, frameSec: nfft / fs,
  };
}
