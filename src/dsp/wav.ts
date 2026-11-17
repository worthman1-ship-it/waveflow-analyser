// Minimal RIFF/WAVE reader: PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE.
// Samples are returned as Float64Array per channel, scaled so digital full scale = 1.0.

export interface WavData {
  fs: number;
  channels: Float64Array[];
  bitsPerSample: number;
  format: 'pcm' | 'float';
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
  let dataOff = -1, dataLen = 0;
  while (off + 8 <= v.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
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
