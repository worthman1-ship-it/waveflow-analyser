import { describe, expect, it } from 'vitest';
import { GraphRunner } from './run';
import type { EdgeSpec, NodeResult, NodeSpec, WorkerOut } from './types';

/** 16-bit PCM WAV, `ch` channels, from per-channel float arrays in [-1, 1]. */
function wav(fs: number, chans: Float64Array[]): ArrayBuffer {
  const n = chans[0].length, ch = chans.length;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, fs, true);
  v.setUint32(28, fs * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) v.setInt16(44 + (i * ch + c) * 2, Math.round(chans[c][i] * 32767), true);
  return buf;
}

function runGraph(fs: number, chans: Float64Array[], wavParams: Record<string, unknown>, nodeType: NodeSpec['type'], params: Record<string, unknown>) {
  const r = new GraphRunner();
  r.addFile('f1', wav(fs, chans));
  const nodes: NodeSpec[] = [
    { id: 'w', type: 'wavSource', params: { fileId: 'f1', fileName: 'x.wav', channel: 0, fullScale: 1, quantity: 'pressure', ref: 2e-5, ...wavParams } },
    { id: 'n', type: nodeType, params },
  ];
  const edges: EdgeSpec[] = [{ source: 'w', target: 'n' }];
  const out: Record<string, NodeResult> = {}, errors: Record<string, string> = {};
  r.run(nodes, edges, (m: WorkerOut) => {
    if (m.type === 'result') out[m.nodeId] = m.result;
    if (m.type === 'error') errors[m.nodeId] = m.message;
  });
  return { result: out.n, error: errors.n };
}

const tone = (f: number, amp: number, fs: number, sec: number) => Float64Array.from({ length: fs * sec }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / fs));

describe('GraphRunner: new analysis nodes', () => {
  const fs = 48000, a60 = 2e-5 * 10 ** 3 * Math.SQRT2; // 60 dB SPL sine amplitude (Pa); full scale = 1 Pa
  const x = tone(1000, a60, fs, 3);
  it('level statistics, octave bands and ECMA loudness run through the worker path', { timeout: 120000 }, () => {
    const ls = runGraph(fs, [x], {}, 'levelStats', {});
    expect(ls.error).toBeUndefined();
    expect(ls.result.kind === 'levelStats' && Math.abs(ls.result.leq - 60) < 0.3).toBe(true);
    const oc = runGraph(fs, [x], {}, 'octave', { fraction: 3 });
    expect(oc.result.kind === 'octave' && Math.abs(oc.result.total - 60) < 0.5).toBe(true);
    const le = runGraph(fs, [x], {}, 'loudnessEcma', { field: 'free' });
    expect(le.error).toBeUndefined();
    expect(le.result.kind === 'loudnessEcma' && le.result.N > 1).toBe(true);
  });
  it('orders: RPM ramp, and tacho channel selected in the WAV source', () => {
    const f = 8000, n = f * 10;
    const phase = (t: number) => (1200 * t + (1800 * t * t) / 20) / 60;
    const sig = Float64Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 2 * phase(i / f)));
    const tach = Float64Array.from({ length: n }, (_, i) => (phase(i / f) % 1 < 0.1 ? 0.8 : 0));
    const ramp = runGraph(f, [sig], { quantity: 'acceleration', ref: 1e-6 }, 'orders', { mode: 'ramp', rpm0: 1200, rpm1: 3000, orders: '2,3', frameSec: 0.25 });
    expect(ramp.error).toBeUndefined();
    const tc = runGraph(f, [sig, tach], { quantity: 'acceleration', ref: 1e-6, tachoChannel: 1 }, 'orders', { mode: 'tacho', ppr: 1, orders: '2', frameSec: 0.25 });
    expect(tc.error).toBeUndefined();
    if (tc.result.kind !== 'orders') throw new Error('wrong result');
    const a = tc.result.tracks[0].amp;
    expect(a[Math.floor(a.length / 2)]).toBeGreaterThan(0.33); // 0.5 / sqrt(2) = 0.354
    const noTacho = runGraph(f, [sig, tach], { quantity: 'acceleration', ref: 1e-6 }, 'orders', { mode: 'tacho', ppr: 1, orders: '2' });
    expect(noTacho.error).toMatch(/tacho/i);
  });
  it('metric vs RPM: loudness rises with a level that follows the speed ramp', { timeout: 120000 }, () => {
    const f = 48000, sec = 6, n = f * sec;
    // 1 kHz tone whose amplitude grows linearly with time (a run-up), speed 1000 -> 3000 rpm
    const sig = Float64Array.from({ length: n }, (_, i) => (0.02 + 0.3 * (i / n)) * Math.sin((2 * Math.PI * 1000 * i) / f));
    const r = runGraph(f, [sig], {}, 'metricRpm', { metric: 'loudnessTv', field: 'free', mode: 'ramp', rpm0: 1000, rpm1: 3000 });
    expect(r.error).toBeUndefined();
    if (r.result.kind !== 'metricRpm') throw new Error('wrong result');
    const m = r.result.mean;
    expect(m[m.length - 1]).toBeGreaterThan(2 * m[0]);
    expect(r.result.rpmMin).toBeGreaterThan(1150); // after the 0.5 s skip
    expect(r.result.rpmMax).toBeLessThan(3001);
  });
  it('binaural: level difference, IACC, ITD and binaural loudness', { timeout: 120000 }, () => {
    const f = 48000, n = f * 3, d = 24; // right ear: -6 dB and 0.5 ms later
    const noise = new Float64Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; noise[i] = 0.2 * (s / 0x7fffffff - 0.5) * 2; }
    const left = noise, right = Float64Array.from(noise, (_, i) => 0.5 * (noise[i - d] ?? 0));
    const r = runGraph(f, [left, right], { rightChannel: 1 }, 'binaural', { field: 'free' });
    expect(r.error).toBeUndefined();
    if (r.result.kind !== 'binaural') throw new Error('wrong result');
    expect(r.result.ild).toBeCloseTo(6.02, 1);
    expect(r.result.iacc).toBeGreaterThan(0.99);
    expect(r.result.itd * 1000).toBeCloseTo(0.5, 1);
    expect(r.result.vB!).toBeLessThan(r.result.vL);
    expect(r.result.vB!).toBeGreaterThan(r.result.vR);
    // other metrics: binaural value lies between the ears (quadratic mean of specific values)
    const am = (f: number, a: number) => Float64Array.from({ length: 48000 * 3 }, (_, i) => a * (1 + 0.9 * Math.sin(2 * Math.PI * 70 * i / 48000)) * Math.sin(2 * Math.PI * 1000 * i / 48000) * (f / f));
    const rg = runGraph(48000, [am(1, 0.2), am(1, 0.05)], { rightChannel: 1 }, 'binaural', { metric: 'roughness', field: 'free' });
    expect(rg.error).toBeUndefined();
    if (rg.result.kind !== 'binaural') throw new Error('wrong result');
    expect(rg.result.vB!).toBeLessThan(rg.result.vL);
    expect(rg.result.vB!).toBeGreaterThan(rg.result.vR);
    const to = runGraph(48000, [am(1, 0.2), am(1, 0.05)], { rightChannel: 1 }, 'binaural', { metric: 'tonality', field: 'free' });
    expect(to.result.kind === 'binaural' && to.result.vB === null && to.result.vL > 0).toBe(true);
    expect(runGraph(f, [left, right], {}, 'binaural', {}).error).toMatch(/right/i);
  });
  it('cepstrum: harmonic series at 100 Hz peaks at 10 ms', () => {
    const f = 16000, n = f * 4;
    let s = 7;
    const sig = Float64Array.from({ length: n }, (_, i) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      let v = 0.05 * (s / 0x7fffffff - 0.5);
      for (let h = 1; h <= 30; h++) v += 0.1 * Math.sin((2 * Math.PI * 100 * h * i) / f);
      return v;
    });
    const r = runGraph(f, [sig], {}, 'cepstrum', { frameSec: 1, maxMs: 50, minMs: 2 });
    expect(r.error).toBeUndefined();
    if (r.result.kind !== 'cepstrum') throw new Error('wrong result');
    expect(r.result.fundamental!.q * 1000).toBeCloseTo(10, 0);
    expect(r.result.fundamental!.freq).toBeCloseTo(100, -1);
  });
  it('annoyance needs Pa', { timeout: 200000 }, () => {
    const bad = runGraph(fs, [x], { quantity: 'acceleration', ref: 1e-6 }, 'annoyance', {});
    expect(bad.error).toMatch(/pressure/i);
    const pa = runGraph(fs, [x], {}, 'annoyance', {});
    expect(pa.error).toBeUndefined();
    expect(pa.result.kind === 'annoyance' && pa.result.PA > 0).toBe(true);
  });
});
