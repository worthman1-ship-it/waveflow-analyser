import { describe, expect, it } from 'vitest';
import { parseWav } from './wav';

// Test-side encoders (the app only decodes) built from the same published algorithms.
const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

function header(fmt: number, ch: number, fs: number, blockAlign: number, extra: number[], data: number[]): ArrayBuffer {
  const fmtLen = 16 + extra.length, n = data.length;
  const b = new Uint8Array(12 + 8 + fmtLen + 8 + n + (n & 1)), v = new DataView(b.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, b.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, fmtLen, true);
  v.setUint16(20, fmt, true); v.setUint16(22, ch, true); v.setUint32(24, fs, true); v.setUint32(28, fs, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, 4, true);
  extra.forEach((x, i) => { b[36 + i] = x; });
  const d = 36 + extra.length; str(d, 'data'); v.setUint32(d + 4, n, true); b.set(data, d + 8);
  return b.buffer;
}

function imaEncode(x: Int16Array, blockAlign: number) {
  const per = 1 + (blockAlign - 4) * 2, out: number[] = [];
  for (let s0 = 0; s0 + per <= x.length; s0 += per) {
    let pred = x[s0], idx = 0;
    out.push(pred & 255, (pred >> 8) & 255, idx, 0);
    const nibs: number[] = [];
    for (let i = 1; i < per; i++) {
      const step = STEP[idx];
      let diff = x[s0 + i] - pred, nib = 0;
      if (diff < 0) { nib = 8; diff = -diff; }
      let d = step >> 3;
      if (diff >= step) { nib |= 4; diff -= step; d += step; }
      if (diff >= step >> 1) { nib |= 2; diff -= step >> 1; d += step >> 1; }
      if (diff >= step >> 2) { nib |= 1; d += step >> 2; }
      pred = Math.max(-32768, Math.min(32767, pred + (nib & 8 ? -d : d)));
      idx = Math.max(0, Math.min(88, idx + IDX[nib & 7]));
      nibs.push(nib);
    }
    for (let i = 0; i < nibs.length; i += 2) out.push(nibs[i] | (nibs[i + 1] << 4));
  }
  return out;
}

const ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
function msEncode(x: Int16Array, blockAlign: number) {
  const per = 2 + (blockAlign - 7) * 2, out: number[] = [];
  const i16 = (n: number) => [n & 255, (n >> 8) & 255];
  for (let s0 = 0; s0 + per <= x.length; s0 += per) {
    let delta = 16, s1 = x[s0 + 1], s2 = x[s0];
    out.push(0, ...i16(delta), ...i16(s1), ...i16(s2)); // predictor 0: coefficients (256, 0)
    const nibs: number[] = [];
    for (let i = 2; i < per; i++) {
      const pred = (s1 * 256) >> 8;
      const q = Math.max(-8, Math.min(7, Math.round((x[s0 + i] - pred) / delta)));
      const val = Math.max(-32768, Math.min(32767, pred + q * delta));
      const u = q & 15;
      delta = Math.max(16, (ADAPT[u] * delta) >> 8);
      s2 = s1; s1 = val; nibs.push(u);
    }
    for (let i = 0; i < nibs.length; i += 2) out.push((nibs[i] << 4) | nibs[i + 1]);
  }
  return out;
}

const snr = (a: Float64Array, ref: Int16Array, skip = 0) => {
  let e = 0, s = 0;
  for (let i = skip; i < a.length; i++) { const r = ref[i] / 32768; e += (a[i] - r) ** 2; s += r * r; }
  return 10 * Math.log10(s / e);
};

describe('4-bit ADPCM WAV', () => {
  const fs = 24000, n = 24000;
  const x = Int16Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / fs) + 3000 * Math.sin((2 * Math.PI * 1700 * i) / fs)));
  it('IMA ADPCM (0x11) at 24 kHz decodes close to the source', () => {
    const blockAlign = 512, per = 1 + (blockAlign - 4) * 2;
    const w = parseWav(header(0x11, 1, fs, blockAlign, [2, 0, per & 255, per >> 8], imaEncode(x, blockAlign)));
    expect(w.fs).toBe(24000); expect(w.bitsPerSample).toBe(4); expect(w.format).toBe('adpcm');
    expect(w.channels[0].length).toBeGreaterThanOrEqual(n - per);
    expect(snr(w.channels[0], x)).toBeGreaterThan(25);
  });
  it('Microsoft ADPCM (0x02) decodes close to the source', () => {
    const blockAlign = 512, per = 2 + (blockAlign - 7) * 2;
    const coef = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];
    const extra = [32, 0, per & 255, per >> 8, 7, 0, ...coef.flatMap(([a, b]) => [a & 255, (a >> 8) & 255, b & 255, (b >> 8) & 255])];
    const w = parseWav(header(0x02, 1, fs, blockAlign, extra, msEncode(x, blockAlign)));
    expect(w.format).toBe('adpcm');
    expect(snr(w.channels[0], x, 200)).toBeGreaterThan(12); // first-order predictor in the test encoder: modest SNR
  });
});
