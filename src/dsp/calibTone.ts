// Calibrator tone finder: locates the dominant spectral line of a recording of an acoustic or vibration
// calibrator and returns its RMS, so the physical value of digital full scale can be set from the known level.
import { fft, hann, nextPow2 } from './fft';

export interface CalibToneResult {
  freq: number; toneRms: number; totalRms: number;
  /** Fraction of the total mean square that sits in the tone (1 = clean calibrator signal). */
  toneShare: number;
}

export function findCalibTone(x: Float64Array, fs: number): CalibToneResult {
  const nfft = Math.min(nextPow2(fs * 2), 2 ** Math.floor(Math.log2(x.length)));
  if (nfft < 1024) throw new Error('Signal too short for tone detection');
  const w = hann(nfft), hop = nfft / 2, nFrames = 1 + Math.floor((x.length - nfft) / hop);
  let wss = 0;
  for (let i = 0; i < nfft; i++) wss += w[i] * w[i];
  const re = new Float64Array(nfft), im = new Float64Array(nfft), p = new Float64Array(nfft / 2 + 1);
  for (let f = 0; f < nFrames; f++) {
    for (let i = 0; i < nfft; i++) { re[i] = x[f * hop + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < nfft / 2; k++) p[k] += (2 * (re[k] * re[k] + im[k] * im[k])) / (nfft * wss * nFrames); // mean square per bin
  }
  let kp = 1;
  for (let k = 2; k < nfft / 2; k++) if (p[k] > p[kp]) kp = k;
  // Hann main lobe is +-2 bins; add +-3 to collect the whole line
  let tone = 0, total = 0;
  for (let k = Math.max(1, kp - 3); k <= Math.min(nfft / 2 - 1, kp + 3); k++) tone += p[k];
  for (let k = 1; k < nfft / 2; k++) total += p[k];
  // parabolic interpolation of the log peak for the frequency
  const a = Math.log(p[kp - 1] + 1e-300), b = Math.log(p[kp] + 1e-300), c = Math.log(p[kp + 1] + 1e-300);
  const d = (a - 2 * b + c) === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
  return { freq: (kp + d) * (fs / nfft), toneRms: Math.sqrt(tone), totalRms: Math.sqrt(total), toneShare: tone / total };
}
