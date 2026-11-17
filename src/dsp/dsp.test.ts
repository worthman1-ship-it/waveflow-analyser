import { describe, expect, it } from 'vitest';
import { encodeWavFloat32, parseWav } from './wav';
import { butterBandpass, sosFilter, sosMagnitude } from './biquad';
import { weightingSos } from './weighting';
import { rms, timeWeighted, toDb, vdv } from './levels';
import { spectrogram } from './spectrogram';
import { loudnessFromLevels, thirdOctaveLevels } from './loudness';
import { roughness } from './roughness';

const sine = (f: number, amp: number, fs: number, sec: number) =>
  Float64Array.from({ length: Math.round(fs * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / fs));
const magDb = (id: Parameters<typeof weightingSos>[0], f: number, fs = 48000) =>
  20 * Math.log10(sosMagnitude(weightingSos(id, fs), f, fs));

describe('wav', () => {
  it('round-trips float32', () => {
    const x = sine(100, 0.5, 8000, 0.1);
    const w = parseWav(encodeWavFloat32(x, 8000));
    expect(w.fs).toBe(8000);
    expect(w.channels[0][20]).toBeCloseTo(x[20], 6);
  });
});

describe('weightings', () => {
  it('A-weighting matches IEC 61672 table', () => {
    expect(magDb('A', 1000)).toBeCloseTo(0, 2);
    expect(Math.abs(magDb('A', 100) + 19.1)).toBeLessThan(0.1);
    expect(Math.abs(magDb('A', 31.623) + 39.4)).toBeLessThan(0.1);
    // bilinear warping near the 12.2 kHz poles: +0.3 dB at 4 kHz, +0.7 dB at 8 kHz (inside Class 1 tolerance)
    expect(Math.abs(magDb('A', 4000) - 0.96)).toBeLessThan(0.4);
  });
  it('C-weighting matches IEC 61672 table', () => {
    expect(Math.abs(magDb('C', 31.623) + 3.0)).toBeLessThan(0.1);
    expect(magDb('C', 100)).toBeCloseTo(-0.3, 1);
  });
  it('vibration weightings have expected gains (ISO 2631 tables)', () => {
    const fs = 1024;
    expect(magDb('Wd', 1, fs)).toBeCloseTo(20 * Math.log10(1.011), 0);
    expect(magDb('Wk', 8, fs)).toBeCloseTo(20 * Math.log10(1.036), 0);
    expect(magDb('Wm', 1, fs)).toBeCloseTo(20 * Math.log10(0.833), 0);
    expect(magDb('Wk', 1, fs)).toBeCloseTo(20 * Math.log10(0.482), 0);
    expect(magDb('Wb', 8, fs)).toBeCloseTo(0, 0);
  });
});

describe('Fast / Slow', () => {
  it('steady sine: max Fast and Slow → rms', () => {
    const fs = 4096, x = sine(31.5, 1, fs, 10);
    const f = timeWeighted(x, fs, 0.125), s = timeWeighted(x, fs, 1);
    expect(f.max).toBeGreaterThan(0.70);
    expect(f.max).toBeLessThan(0.74);
    expect(s.max).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rms(x)).toBeCloseTo(Math.SQRT1_2, 4);
  });
  it('1 s tone burst: Slow max ≈ 1 − e^-1 of the energy', () => {
    const fs = 4096, x = new Float64Array(fs * 4);
    x.set(sine(100, 1, fs, 1), fs);
    const s = timeWeighted(x, fs, 1);
    expect(toDb(s.max, Math.SQRT1_2)).toBeCloseTo(10 * Math.log10(1 - Math.exp(-1)), 1); // −2.0 dB
  });
  it('VDV of a 1 m/s² peak sine for 1 s', () => {
    const fs = 4096;
    expect(vdv(sine(8, 1, fs, 1), fs)).toBeCloseTo(Math.pow(3 / 8, 0.25), 3);
  });
});

describe('moving FFT', () => {
  it('bin value is the sine rms', () => {
    const fs = 8192, nfft = 1024, f0 = 1024; // exactly on bin 128
    const sp = spectrogram(sine(f0, 1, fs, 1), fs, nfft, 0.5, 1, 0, 1e9, 1e9);
    expect(sp.avgDb[128]).toBeCloseTo(20 * Math.log10(Math.SQRT1_2), 1);
  });
});

describe('third-octave bank', () => {
  it('1 kHz tone lands in the 1 kHz band at full level', () => {
    const fs = 48000, sec = 1, amp = 2e-5 * 10 ** (60 / 20) * Math.SQRT2;
    const t = thirdOctaveLevels(sine(1000, amp, fs, sec), fs, sec);
    expect(t.overall[16]).toBeCloseTo(60, 0);
    // two bands away a 6th-order Butterworth gives ≈37 dB rejection
    expect(t.overall[14]).toBeLessThan(25);
  });
  it('Butterworth band-pass is -3 dB at the edges', () => {
    const fs = 48000, sos = butterBandpass(3, 891, 1122, fs);
    expect(20 * Math.log10(sosMagnitude(sos, 891, fs))).toBeCloseTo(-3, 1);
    expect(20 * Math.log10(sosMagnitude(sos, 1122, fs))).toBeCloseTo(-3, 1);
    expect(sosFilter(sos, new Float64Array(10)).length).toBe(10);
  });
});

describe('Zwicker loudness', () => {
  // Tones go through the third-octave bank: leakage into neighbouring bands is part of the method.
  const tone = (L: number) => {
    const fs = 48000, amp = 2e-5 * 10 ** (L / 20) * Math.SQRT2;
    return loudnessFromLevels(thirdOctaveLevels(sine(1000, amp, fs, 1), fs, 1).overall, 'free');
  };
  it('1 kHz tone at 40 dB = 1 sone', () => {
    expect(tone(40).N).toBeCloseTo(1.0, 1);
  });
  it('1 kHz tone at 60 dB ≈ 4 sone (loudness doubles per 10 phon)', () => {
    const { N } = tone(60);
    expect(N).toBeGreaterThan(3.7);
    expect(N).toBeLessThan(4.4);
  });
  it('1 kHz tone at 60 dB has sharpness ≈ 1 acum (DIN 45692 reference point)', () => {
    const { S } = tone(60);
    expect(S).toBeGreaterThan(0.9);
    expect(S).toBeLessThan(1.15);
  });
});

describe('roughness', () => {
  it('1 kHz, 60 dB, 100 % AM at 70 Hz ≈ 1 asper', () => {
    const fs = 48000, n = fs;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      x[i] = (1 + Math.cos(2 * Math.PI * 70 * t)) * Math.sin(2 * Math.PI * 1000 * t);
    }
    const scale = (2e-5 * 10 ** (60 / 20)) / rms(x);
    for (let i = 0; i < n; i++) x[i] *= scale;
    const r = roughness(x, fs, 0.5);
    expect(r.mean).toBeGreaterThan(0.8);
    expect(r.mean).toBeLessThan(1.2);
  });
});
