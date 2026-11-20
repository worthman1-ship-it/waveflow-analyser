// ISO 532-1 conformance check against the standard's own test signals (Annex B). Opt-in: the signals
// and reference tables are not part of this repository. Set ISO532_DIR to a folder holding
//   ref_tv.json  (time-varying references: per signal Nmax, N5, N(t) and its 5 % / 10 % tolerance bands),
//   ref_st.json  (stationary specific-loudness references for signals 1-5),
//   b4/, b5/, st/ (the .wav test signals; full scale 1.0 = 2*sqrt(2) Pa).
// Run:  ISO532_DIR=<folder> npx vitest run src/dsp/iso532.compliance.test.ts --disableConsoleIntercept
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWav } from './wav';
import { loudnessTimeVarying } from './loudnessTv';
import { loudnessFromLevels, thirdOctaveLevels } from './loudness';

const dir = process.env.ISO532_DIR;
const CAL = 2 * Math.SQRT2;

function load(path: string) {
  const b = readFileSync(path);
  const w = parseWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return { fs: w.fs, x: Float64Array.from(w.channels[0], (v) => v * CAL) };
}
const find = (d: string, n: number) => join(dir!, d, readdirSync(join(dir!, d)).find((f) => f.startsWith(`Test signal ${n} `) && f.endsWith('.wav'))!);

describe.skipIf(!dir || !existsSync(join(dir ?? '', 'ref_tv.json')))('ISO 532-1 Annex B', () => {
  it('time-varying loudness (B.4, B.5)', { timeout: 600000 }, () => {
    const ref = JSON.parse(readFileSync(join(dir!, 'ref_tv.json'), 'utf8'));
    const rows: string[] = [];
    let worst = 0, minIn5 = 1;
    for (const n of Object.keys(ref).map(Number)) {
      const r = ref[n];
      const { fs, x } = load(find(n < 14 ? 'b4' : 'b5', n));
      const res = loudnessTimeVarying(x, fs, r.field);
      let in5 = 0, in10 = 0, dev = 0;
      for (let i = 0; i < r.t.length; i++) {
        const v = res.N[Math.min(res.N.length - 1, Math.round(r.t[i] / res.dt))];
        if (v >= r.lo5[i] - 1e-9 && v <= r.hi5[i] + 1e-9) in5++;
        if (v >= r.lo10[i] - 1e-9 && v <= r.hi10[i] + 1e-9) in10++;
        if (r.N[i] > 0.5) dev = Math.max(dev, Math.abs(v / r.N[i] - 1));
      }
      // The reference N5 values follow per-signal conventions (which silent stretch is left out, interpolated
      // percentile), so N5 is not compared here: N(t) and Nmax carry the conformance.
      const dMax = (res.Nmax / r.nmax - 1) * 100, tot = r.t.length;
      worst = Math.max(worst, Math.abs(dMax));
      minIn5 = Math.min(minIn5, in5 / tot);
      rows.push(`signal ${n}: Nmax ${res.Nmax.toFixed(3)} vs ${r.nmax.toFixed(3)} (${dMax.toFixed(2)} %), N(t) in 5 % band ${(100 * in5 / tot).toFixed(1)} %, in 10 % band ${(100 * in10 / tot).toFixed(1)} %, max deviation ${(100 * dev).toFixed(2)} % (N > 0.5 sone)`);
    }
    console.log(rows.join('\n'));
    expect(worst).toBeLessThan(0.5);
    expect(minIn5).toBe(1);
  });

  it('stationary loudness (B.2, B.3)', { timeout: 120000 }, () => {
    const ref = JSON.parse(readFileSync(join(dir!, 'ref_st.json'), 'utf8'));
    const rows: string[] = [];
    // signal 1: third-octave levels from the annex; 2-5 from the wav files
    const lv1 = [-60, -60, 78, 79, 89, 72, 80, 89, 75, 87, 85, 79, 86, 80, 71, 70, 72, 71, 72, 74, 69, 65, 67, 77, 68, 58, 45, 30];
    for (const n of [1, 2, 3, 4, 5]) {
      let lt: ArrayLike<number> = lv1;
      if (n > 1) { const { fs, x } = load(find('st', n)); lt = thirdOctaveLevels(x, fs, 1).overall; }
      const r = loudnessFromLevels(lt, 'free');
      const refN = ref[n].reduce((s: number, v: number) => s + v, 0) * 0.1; // 0.1 Bark rectangle sum
      let maxDiff = 0;
      for (let i = 0; i < 240; i++) maxDiff = Math.max(maxDiff, Math.abs(r.ns[i] - ref[n][i]));
      rows.push(`signal ${n}: N ${r.N.toFixed(3)} vs ${refN.toFixed(3)} (${((r.N / refN - 1) * 100).toFixed(1)} %), max |N' diff| ${maxDiff.toFixed(3)} sone/Bark`);
      expect(Math.abs(r.N / refN - 1)).toBeLessThan(0.05);
    }
    console.log(rows.join('\n'));
  });
});
