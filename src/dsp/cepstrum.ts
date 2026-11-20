// Real cepstrum: inverse FFT of the log magnitude spectrum, c(q) = IFFT(ln|X(f)|), with the log
// spectrum averaged over Hann-windowed frames first (so noise settles and periodic structure remains).
// A family of equally spaced spectral lines (harmonics, sidebands) appears as a peak at quefrency
// q = 1 / spacing, plus rahmonics at multiples of q.
import { fft, hann, nextPow2 } from './fft';

export interface CepstrumPeak { q: number; freq: number; amp: number }
export interface CepstrumResult {
  /** Quefrency step (s) and cepstrum values from q = 0 up to `maxQ`. */
  dq: number; c: Float32Array; maxQ: number; frameSec: number; frames: number;
  /** Strongest local maxima above `minQ`, largest first (freq = 1/q is the line spacing in Hz). */
  peaks: CepstrumPeak[];
  /** Shortest-quefrency peak that is at least half the strongest: the line spacing, since rahmonics (multiples of q) can be taller. */
  fundamental: CepstrumPeak | null;
}

export function cepstrum(x: Float64Array, fs: number, frameSec: number, maxQ: number, minQ: number, nPeaks = 8): CepstrumResult {
  let nfft = nextPow2(Math.round(frameSec * fs));
  while (nfft > x.length && nfft > 256) nfft /= 2;
  if (x.length < nfft) throw new Error('Signal too short for cepstrum analysis');
  const hop = nfft / 2, w = hann(nfft), nFrames = 1 + Math.floor((x.length - nfft) / hop);
  const re = new Float64Array(nfft), im = new Float64Array(nfft), avg = new Float64Array(nfft);
  for (let f = 0; f < nFrames; f++) {
    for (let i = 0; i < nfft; i++) { re[i] = x[f * hop + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= nfft / 2; k++) avg[k] += 0.5 * Math.log(re[k] * re[k] + im[k] * im[k] + 1e-300);
  }
  // symmetric real log spectrum -> real cepstrum
  for (let k = 0; k <= nfft / 2; k++) { re[k] = avg[k] / nFrames; im[k] = 0; }
  for (let k = nfft / 2 + 1; k < nfft; k++) { re[k] = re[nfft - k]; im[k] = 0; }
  fft(re, im, true);
  const n = Math.min(nfft / 2, Math.floor(maxQ * fs)), c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = re[i] / nfft;
  const i0 = Math.max(2, Math.ceil(minQ * fs)), peaks: CepstrumPeak[] = [];
  for (let i = i0; i < n - 1; i++) {
    if (c[i] > c[i - 1] && c[i] >= c[i + 1] && c[i] > 0) peaks.push({ q: i / fs, freq: fs / i, amp: c[i] });
  }
  const top = peaks.reduce((m, p) => Math.max(m, p.amp), 0);
  const fundamental = peaks.find((p) => p.amp >= 0.5 * top) ?? null; // peaks are in quefrency order here
  peaks.sort((a, b) => b.amp - a.amp);
  return { dq: 1 / fs, c, maxQ: n / fs, frameSec: nfft / fs, frames: nFrames, peaks: peaks.slice(0, nPeaks), fundamental };
}
