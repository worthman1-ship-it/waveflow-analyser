import { describe, expect, it } from 'vitest';
import { encodeWavFloat32, parseWav } from './wav';
import { butterBandpass, sosFilter, sosMagnitude } from './biquad';
import { weightingSos } from './weighting';
import { rms, timeWeighted, toDb, vdv } from './levels';
import { spectrogram } from './spectrogram';
import { loudnessFromLevels, thirdOctaveLevels } from './loudness';
import { roughness } from './roughness';
import { fluctuationStrength } from './fluctuation';
import { tonality } from './tonality';
import { loudnessTimeVarying, resampleTo48k } from './loudnessTv';
import { impulsivity } from './impulsivity';

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

// Deterministic pseudo-random noise (rms 1).
const noise = (n: number, seed = 1) => {
  let a = seed;
  return Float64Array.from({ length: n }, () => {
    let s = 0;
    for (let k = 0; k < 12; k++) { a = (a * 1664525 + 1013904223) >>> 0; s += a / 4294967296; }
    return s - 6;
  });
};
const REF = 2e-5;
const pa = (db: number) => REF * 10 ** (db / 20) * Math.SQRT2; // sine amplitude for a given SPL

describe('fluctuation strength', () => {
  const am = (fm: number, depth = 1) => {
    const c = sine(1000, pa(60), 48000, 6);
    return c.map((v, i) => v * (1 + depth * Math.sin((2 * Math.PI * fm * i) / 48000)));
  };
  it('1 kHz 60 dB 100 % AM at 4 Hz is ~1 vacil', () => {
    const r = fluctuationStrength(am(4), 48000);
    expect(r.mean).toBeGreaterThan(0.8);
    expect(r.mean).toBeLessThan(1.2);
    expect(r.fmod).toBeCloseTo(4, 0);
  });
  it('is low for an unmodulated tone and for 1 Hz modulation, and falls with depth', () => {
    expect(fluctuationStrength(sine(1000, pa(60), 48000, 6), 48000).mean).toBeLessThan(0.1);
    expect(fluctuationStrength(am(1), 48000).mean).toBeLessThan(0.6);
    expect(fluctuationStrength(am(4, 0.3), 48000).mean).toBeLessThan(fluctuationStrength(am(4), 48000).mean);
  });
});

describe('tonality', () => {
  it('a 1 kHz tone in weak noise is ~1 tu with large TNR', () => {
    const x = sine(1000, pa(60), 48000, 3);
    const n = noise(x.length);
    for (let i = 0; i < x.length; i++) x[i] += n[i] * REF * 10 ** (20 / 20) * 0.1; // ~ 6 dB SPL broadband
    const r = tonality(x, 48000, REF);
    expect(r.Kmean).toBeGreaterThan(0.8);
    expect(r.Kmean).toBeLessThan(1.15);
    expect(r.tnrMax).toBeGreaterThan(30);
    expect(r.fTnr).toBeCloseTo(1000, -1);
    expect(r.tones[0].prominent).toBe(true);
    expect(r.kt).toBe(6); // ΔLta ≫ 10 dB → maximum Nordic adjustment
  });
  it('white noise is not tonal', () => {
    const x = noise(48000 * 3).map((v) => v * 0.02);
    const r = tonality(x, 48000, REF);
    expect(r.Kmean).toBeLessThan(0.1);
    expect(r.tones.filter((t) => t.prominent).length).toBe(0);
    expect(r.kt).toBe(0);
  });
});

describe('impulsivity', () => {
  it('steady noise has a small LAI−LAF, clicks a large one', () => {
    const steady = sine(1000, 0.1, 48000, 4);
    const a = impulsivity(steady, 48000, REF, 0.5);
    expect(Math.abs(a.diff)).toBeLessThan(1);
    const clicks = new Float64Array(48000 * 4);
    for (let k = 0; k < 4; k++) for (let i = 0; i < 48; i++) clicks[(k * 48000) + 12000 + i] = Math.sin((2 * Math.PI * 1000 * i) / 48000) * 5;
    const b = impulsivity(clicks, 48000, REF, 5);
    expect(b.diff).toBeGreaterThan(4.5); // short burst: ≈ 10·log(125 ms / 35 ms) = 5.5 dB
  });
});

describe('time-varying loudness (ISO 532-1)', () => {
  it('stationary 1 kHz: 40 dB → 1 sone, 60 dB → ~4 sone', () => {
    const a = loudnessTimeVarying(sine(1000, pa(40), 48000, 2), 48000, 'free');
    expect(a.N[Math.floor(a.N.length * 0.9)]).toBeGreaterThan(0.95);
    expect(a.N[Math.floor(a.N.length * 0.9)]).toBeLessThan(1.05);
    const b = loudnessTimeVarying(sine(1000, pa(60), 48000, 2), 48000, 'free');
    const v = b.N[Math.floor(b.N.length * 0.9)];
    expect(v).toBeGreaterThan(3.8);
    expect(v).toBeLessThan(4.4);
  });
  it('a 100 ms burst is quieter than the same tone sustained, and loudness decays after it', () => {
    const fs = 48000, x = sine(1000, pa(60), fs, 1.5);
    for (let i = Math.round(0.6 * fs); i < x.length; i++) x[i] = 0;
    for (let i = 0; i < Math.round(0.5 * fs); i++) x[i] = 0;
    const r = loudnessTimeVarying(x, fs, 'free');
    const sustained = loudnessTimeVarying(sine(1000, pa(60), fs, 1.5), fs, 'free');
    expect(r.Nmax).toBeLessThan(sustained.Nmax);
    expect(r.Nmax).toBeGreaterThan(1.5);
    expect(r.N[Math.round(1.4 / 0.002)]).toBeLessThan(0.05 * r.Nmax);
  });
  it('resampling keeps a tone intact', () => {
    const y = resampleTo48k(sine(1000, 1, 44100, 0.2), 44100);
    expect(y.length).toBe(9600);
    const z = y.subarray(2000, 7000);
    expect(Math.max(...z)).toBeGreaterThan(0.98);
    expect(Math.max(...z)).toBeLessThan(1.02);
  });
});
