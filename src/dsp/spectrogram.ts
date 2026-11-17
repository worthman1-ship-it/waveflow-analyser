// Moving (short-time) FFT. Each bin is scaled to the RMS value of a sinusoid at that bin
// (Hann window, coherent-gain corrected), then expressed in dB re `ref`.
import { fft, hann } from './fft';

export interface Spectrogram {
  /** dB values, row-major [frame][bin] after reduction for display. */
  db: Float32Array;
  frames: number;
  bins: number;
  /** Seconds per displayed frame and Hz per displayed bin. */
  dt: number;
  df: number;
  /** Power-averaged spectrum over the whole file (dB, full resolution). */
  avgDb: Float32Array;
  avgDf: number;
  maxDb: number;
}

export function spectrogram(
  x: Float64Array, fs: number, nfft: number, overlap: number, ref: number,
  fMax = 0, maxFrames = 1200, maxBins = 512,
): Spectrogram {
  const hop = Math.max(1, Math.round(nfft * (1 - overlap)));
  const nFrames = x.length >= nfft ? 1 + Math.floor((x.length - nfft) / hop) : 0;
  if (nFrames === 0) throw new Error(`Signal shorter than FFT size (${nfft} samples)`);
  const nBins = nfft / 2 + 1;
  // Bins kept for the display matrix (fMax = 0 → up to Nyquist).
  const nShow = fMax > 0 ? Math.min(nBins, Math.ceil(fMax / (fs / nfft)) + 1) : nBins;
  const w = hann(nfft);
  let wsum = 0;
  for (let i = 0; i < nfft; i++) wsum += w[i];
  // |X|·2/Σw gives peak amplitude; /√2 gives RMS.
  const scale = 2 / wsum / Math.SQRT2;

  const fStep = Math.ceil(nFrames / maxFrames), bStep = Math.ceil(nShow / maxBins);
  const outF = Math.ceil(nFrames / fStep), outB = Math.ceil(nShow / bStep);
  const pow = new Float32Array(outF * outB); // max-pooled mean-square
  const avg = new Float64Array(nBins);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);

  for (let f = 0; f < nFrames; f++) {
    const o = f * hop;
    for (let i = 0; i < nfft; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const row = Math.floor(f / fStep) * outB;
    for (let k = 0; k < nBins; k++) {
      let p = (re[k] * re[k] + im[k] * im[k]) * scale * scale;
      if (k === 0 || k === nfft / 2) p /= 2; // DC/Nyquist have no mirror image
      avg[k] += p;
      if (k >= nShow) continue;
      const cell = row + Math.floor(k / bStep);
      if (p > pow[cell]) pow[cell] = p;
    }
  }

  const ref2 = ref * ref;
  const db = new Float32Array(pow.length);
  let maxDb = -Infinity;
  for (let i = 0; i < pow.length; i++) {
    db[i] = pow[i] > 0 ? 10 * Math.log10(pow[i] / ref2) : -300;
    if (db[i] > maxDb) maxDb = db[i];
  }
  const avgDb = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) avgDb[k] = avg[k] > 0 ? 10 * Math.log10(avg[k] / nFrames / ref2) : -300;

  return { db, frames: outF, bins: outB, dt: (hop * fStep) / fs, df: (fs / nfft) * bStep, avgDb, avgDf: fs / nfft, maxDb };
}
