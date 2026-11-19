// Speech Transmission Index from a room impulse response (IEC 60268-16, indirect method):
// the modulation transfer function m(F) = |int h^2(t) e^(-j 2 pi F t) dt| / int h^2(t) dt in the seven
// octave bands 125 Hz - 8 kHz at 14 modulation frequencies 0.63 - 12.5 Hz, converted to transmission
// indices and weighted with the male-speech weights. Background noise and auditory masking are not
// applied (the noise-free STI). Octave filtering is zero-phase in the frequency domain.
import { fft, nextPow2 } from './fft';

const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
const MOD = [0.63, 0.8, 1, 1.25, 1.6, 2, 2.5, 3.15, 4, 5, 6.3, 8, 10, 12.5];
const ALPHA = [0.085, 0.127, 0.23, 0.233, 0.309, 0.224, 0.173];
const BETA = [0.085, 0.078, 0.065, 0.011, 0.047, 0.095];

export interface StiResult {
  sti: number; rating: string;
  /** Modulation transfer index per octave band. */
  mti: number[]; bands: number[];
  /** m(F) for each band: [band][mod]. */
  mtf: number[][]; modFreq: number[];
}

const rating = (s: number) => (s < 0.3 ? 'bad' : s < 0.45 ? 'poor' : s < 0.6 ? 'fair' : s < 0.75 ? 'good' : 'excellent');

export function stiFromImpulseResponse(h: Float64Array, fs: number): StiResult {
  const bands = BANDS.filter((f) => f * Math.SQRT2 <= fs / 2);
  if (bands.length < 7) throw new Error(`STI needs fs >= ${Math.ceil(2 * 8000 * Math.SQRT2)} Hz (8 kHz octave band); file is ${fs} Hz`);
  if (h.length < fs * 0.1) throw new Error('Impulse response too short (needs >= 0.1 s)');
  const n = nextPow2(h.length * 2);
  const re0 = new Float64Array(n), im0 = new Float64Array(n);
  re0.set(h);
  fft(re0, im0);
  const mtf: number[][] = [], mti: number[] = [];
  for (const fo of bands) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 0; k <= n / 2; k++) {
      const f = (k * fs) / n;
      // 3rd-order band-pass magnitude, octave bandwidth
      const m = f > 0 ? 1 / Math.sqrt(1 + ((f / fo - fo / f) / 0.707) ** 6) : 0;
      re[k] = re0[k] * m; im[k] = im0[k] * m;
      if (k > 0 && k < n / 2) { re[n - k] = re0[n - k] * m; im[n - k] = im0[n - k] * m; }
    }
    fft(re, im, true);
    let e = 0;
    const g = new Float64Array(h.length);
    for (let i = 0; i < h.length; i++) { const v = re[i] / n; g[i] = v * v; e += g[i]; }
    const row = MOD.map((F) => {
      let cr = 0, ci = 0;
      const w = (2 * Math.PI * F) / fs;
      for (let i = 0; i < h.length; i++) { cr += g[i] * Math.cos(w * i); ci += g[i] * Math.sin(w * i); }
      return Math.min(0.99999, Math.hypot(cr, ci) / Math.max(e, 1e-300));
    });
    mtf.push(row);
    const ti = row.map((m) => (Math.min(15, Math.max(-15, 10 * Math.log10(m / (1 - m)))) + 15) / 30);
    mti.push(ti.reduce((a, b) => a + b, 0) / ti.length);
  }
  let sti = 0;
  for (let k = 0; k < 7; k++) sti += ALPHA[k] * mti[k];
  for (let k = 0; k < 6; k++) sti -= BETA[k] * Math.sqrt(mti[k] * mti[k + 1]);
  sti = Math.min(1, Math.max(0, sti));
  return { sti, rating: rating(sti), mti, bands, mtf, modFreq: MOD };
}
