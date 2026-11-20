// Minimal RIFF/WAVE reader: PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE,
// and 4-bit IMA ADPCM (0x11) and Microsoft ADPCM (0x02), the usual "compressed" meter recordings.
// Samples are returned as Float64Array per channel, scaled so digital full scale = 1.0.

export interface WavData {
  fs: number;
  channels: Float64Array[];
  bitsPerSample: number;
  format: 'pcm' | 'float' | 'adpcm';
}

export function parseWav(buf: ArrayBuffer): WavData {
  const v = new DataView(buf);
  const tag = (o: number) =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  let off = 12;
  let fmtCode = 0, nCh = 0, fs = 0, bits = 0, blockAlign = 0;
  let dataOff = -1, dataLen = 0, fmtBody = 0, fmtSize = 0;
  while (off + 8 <= v.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmtBody = body; fmtSize = size;
      fmtCode = v.getUint16(body, true);
      nCh = v.getUint16(body + 2, true);
      fs = v.getUint32(body + 4, true);
      blockAlign = v.getUint16(body + 12, true);
      bits = v.getUint16(body + 14, true);
      if (fmtCode === 0xfffe && size >= 40) fmtCode = v.getUint16(body + 24, true); // SubFormat GUID
    } else if (id === 'data') {
      dataOff = body;
      // Streamed files sometimes leave the size as 0 or 0xFFFFFFFF; take the rest of the file.
      dataLen = size === 0 || size === 0xffffffff ? v.byteLength - body : Math.min(size, v.byteLength - body);
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fs) throw new Error('WAV has no fmt chunk');
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  if (fmtCode === 0x11 || fmtCode === 0x02) {
    const channels = fmtCode === 0x11
      ? decodeImaAdpcm(v, dataOff, dataLen, nCh, blockAlign)
      : decodeMsAdpcm(v, dataOff, dataLen, nCh, blockAlign, fmtBody, fmtSize);
    return { fs, channels, bitsPerSample: 4, format: 'adpcm' };
  }
  if (fmtCode !== 1 && fmtCode !== 3) throw new Error(`Unsupported WAV format code ${fmtCode}`);

  const bytes = bits / 8;
  const n = Math.floor(dataLen / blockAlign);
  const channels = Array.from({ length: nCh }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const frame = dataOff + i * blockAlign;
    for (let c = 0; c < nCh; c++) {
      const p = frame + c * bytes;
      let s: number;
      if (fmtCode === 3) {
        s = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true);
      } else if (bits === 16) {
        s = v.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
        if (x & 0x800000) x -= 0x1000000;
        s = x / 8388608;
      } else if (bits === 32) {
        s = v.getInt32(p, true) / 2147483648;
      } else if (bits === 8) {
        s = (v.getUint8(p) - 128) / 128;
      } else {
        throw new Error(`Unsupported PCM bit depth ${bits}`);
      }
      channels[c][i] = s;
    }
  }
  return { fs, channels, bitsPerSample: bits, format: fmtCode === 3 ? 'float' : 'pcm' };
}

const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp16 = (x: number) => (x < -32768 ? -32768 : x > 32767 ? 32767 : x);

/** IMA ADPCM: per block and channel a 4-byte header (predictor, step index), then 4-byte groups of 8 nibbles per channel, interleaved. */
function decodeImaAdpcm(v: DataView, off: number, len: number, nCh: number, blockAlign: number): Float64Array[] {
  if (nCh < 1 || blockAlign < 4 * nCh) throw new Error('Invalid IMA ADPCM block size');
  const perBlock = 1 + ((blockAlign - 4 * nCh) * 2) / nCh;
  const nBlocks = Math.ceil(len / blockAlign), out = Array.from({ length: nCh }, () => new Float64Array(nBlocks * perBlock));
  let n = 0;
  for (let b = 0; b < nBlocks; b++) {
    const base = off + b * blockAlign, size = Math.min(blockAlign, off + len - base);
    if (size < 4 * nCh) break;
    const pred = new Int32Array(nCh), idx = new Int32Array(nCh);
    for (let c = 0; c < nCh; c++) {
      pred[c] = v.getInt16(base + 4 * c, true);
      idx[c] = Math.min(88, v.getUint8(base + 4 * c + 2));
      out[c][n] = pred[c] / 32768;
    }
    let k = 1;
    for (let g = 4 * nCh; g + 4 * nCh <= size; g += 4 * nCh) {
      for (let c = 0; c < nCh; c++) {
        for (let j = 0; j < 4; j++) {
          const byte = v.getUint8(base + g + 4 * c + j);
          for (let h = 0; h < 2; h++) {
            const nib = h === 0 ? byte & 15 : byte >> 4;
            const step = IMA_STEP[idx[c]];
            let d = step >> 3;
            if (nib & 1) d += step >> 2;
            if (nib & 2) d += step >> 1;
            if (nib & 4) d += step;
            pred[c] = clamp16(pred[c] + (nib & 8 ? -d : d));
            idx[c] = Math.max(0, Math.min(88, idx[c] + IMA_INDEX[nib & 7]));
            out[c][n + k + 2 * j + h] = pred[c] / 32768;
          }
        }
      }
      k += 8;
    }
    n += k;
  }
  return out.map((o) => o.slice(0, n));
}

const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_COEF_DEFAULT: [number, number][] = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];

/** Microsoft ADPCM: per block a header (predictor index, delta, two history samples per channel), then nibbles, high first, channels interleaved. */
function decodeMsAdpcm(v: DataView, off: number, len: number, nCh: number, blockAlign: number, fmtBody: number, fmtSize: number): Float64Array[] {
  if (nCh < 1 || nCh > 2 || blockAlign < 7 * nCh) throw new Error('Invalid MS ADPCM block size');
  let coef = MS_COEF_DEFAULT;
  if (fmtSize >= 32) { // cbSize, samplesPerBlock, numCoef, then coefficient pairs
    const nc = v.getUint16(fmtBody + 20, true);
    if (nc > 0 && fmtSize >= 22 + nc * 4) coef = Array.from({ length: nc }, (_, i) => [v.getInt16(fmtBody + 22 + i * 4, true), v.getInt16(fmtBody + 24 + i * 4, true)]);
  }
  const perBlock = 2 + ((blockAlign - 7 * nCh) * 2) / nCh;
  const nBlocks = Math.ceil(len / blockAlign), out = Array.from({ length: nCh }, () => new Float64Array(nBlocks * perBlock));
  let n = 0;
  for (let b = 0; b < nBlocks; b++) {
    const base = off + b * blockAlign, size = Math.min(blockAlign, off + len - base);
    if (size < 7 * nCh) break;
    let p = base;
    const ci = [], delta = new Int32Array(nCh), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh);
    for (let c = 0; c < nCh; c++) ci.push(Math.min(coef.length - 1, v.getUint8(p++)));
    for (let c = 0; c < nCh; c++) { delta[c] = v.getInt16(p, true); p += 2; }
    for (let c = 0; c < nCh; c++) { s1[c] = v.getInt16(p, true); p += 2; }
    for (let c = 0; c < nCh; c++) { s2[c] = v.getInt16(p, true); p += 2; }
    for (let c = 0; c < nCh; c++) { out[c][n] = s2[c] / 32768; out[c][n + 1] = s1[c] / 32768; }
    let k = 2, c = 0;
    for (; p < base + size; p++) {
      const byte = v.getUint8(p);
      for (let h = 0; h < 2; h++) {
        const u = h === 0 ? byte >> 4 : byte & 15, sn = u & 8 ? u - 16 : u;
        const [c1, c2] = coef[ci[c]];
        const x = clamp16(((s1[c] * c1 + s2[c] * c2) >> 8) + sn * delta[c]);
        delta[c] = Math.max(16, (MS_ADAPT[u] * delta[c]) >> 8);
        s2[c] = s1[c]; s1[c] = x;
        out[c][n + k] = x / 32768;
        if (++c === nCh) { c = 0; k++; }
      }
    }
    n += k;
  }
  return out.map((o) => o.slice(0, n));
}

/** Write a mono 32-bit float WAV (used by tests to round-trip the reader). */
export function encodeWavFloat32(x: ArrayLike<number>, fs: number): ArrayBuffer {
  const n = x.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) v.setFloat32(44 + i * 4, x[i], true);
  return buf;
}
