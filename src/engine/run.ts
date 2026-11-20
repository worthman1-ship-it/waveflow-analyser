// Graph evaluation: sources → processors → analysis sinks. Pure (no DOM), runs in the worker.
// Results and intermediate signals are cached by a signature of the upstream chain,
// so re-running only recomputes nodes whose inputs or parameters changed.
import { parseWav, type WavData } from '../dsp/wav';
import { sosFilter } from '../dsp/biquad';
import { weightingSos, type WeightingId } from '../dsp/weighting';
import { rms, timeWeighted, vdv, TAU_FAST, TAU_SLOW } from '../dsp/levels';
import { spectrogram } from '../dsp/spectrogram';
import { loudnessFromLevels, thirdOctaveLevels } from '../dsp/loudness';
import { roughness } from '../dsp/roughness';
import { fluctuationStrength } from '../dsp/fluctuation';
import { tonality } from '../dsp/tonality';
import { impulsivity } from '../dsp/impulsivity';
import { loudnessTimeVarying } from '../dsp/loudnessTv';
import { roughnessEcma, specificRoughnessEcma, roughnessFromSpecific } from '../dsp/roughnessEcma';
import { tonalityEcma } from '../dsp/tonalityEcma';
import { fluctuationEcma, specificFluctuationEcma, fluctuationFromSpecific } from '../dsp/fluctuationEcma';
import { loudnessEcma, specificLoudnessEcma, binauralSpecific, loudnessFromSpecific } from '../dsp/loudnessEcma';
import { interaural } from '../dsp/binaural';
import { octaveBands } from '../dsp/octave';
import { cepstrum } from '../dsp/cepstrum';
import { findCalibTone } from '../dsp/calibTone';
import { levelStatistics, psychoacousticAnnoyance } from '../dsp/levelStats';
import { orderAnalysis } from '../dsp/orders';
import { metricVsRpm } from '../dsp/metricRpm';
import type { EdgeSpec, NodeResult, NodeSpec, Signal, WavParams, WorkerOut } from './types';

export class GraphRunner {
  private files = new Map<string, ArrayBuffer>();
  private decoded = new Map<string, WavData>();
  private signals = new Map<string, Signal>();
  private results = new Map<string, NodeResult>();

  addFile(fileId: string, buffer: ArrayBuffer) {
    this.files.set(fileId, buffer);
  }

  dropFile(fileId: string) {
    this.files.delete(fileId);
    this.decoded.delete(fileId);
  }

  private wav(fileId: string): WavData {
    let w = this.decoded.get(fileId);
    if (!w) {
      const buf = this.files.get(fileId);
      if (!buf) throw new Error('File not loaded');
      w = parseWav(buf);
      this.decoded.set(fileId, w);
    }
    return w;
  }

  run(nodes: NodeSpec[], edges: EdgeSpec[], emit: (m: WorkerOut) => void) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const inputOf = new Map(edges.map((e) => [e.target, e.source]));
    const sigCache = new Map<string, string | null>();

    // Signature of the signal produced by a node (null if it cannot produce one).
    const signature = (id: string, seen = new Set<string>()): string | null => {
      if (sigCache.has(id)) return sigCache.get(id)!;
      if (seen.has(id)) return null; // cycle
      seen.add(id);
      const n = byId.get(id);
      let s: string | null = null;
      if (n?.type === 'wavSource') {
        s = (n.params as unknown as WavParams).fileId ? `wav${JSON.stringify(n.params)}` : null;
      } else if (n) {
        const up = inputOf.get(id);
        const u = up ? signature(up, seen) : null;
        s = u ? `${n.type}${JSON.stringify(n.params)}<${u}` : null;
      }
      sigCache.set(id, s);
      return s;
    };

    const signalFor = (id: string): Signal => {
      const sig = signature(id);
      if (!sig) throw new Error('No input connected');
      const cached = this.signals.get(sig);
      if (cached) return cached;
      const n = byId.get(id)!;
      let out: Signal;
      if (n.type === 'wavSource') {
        const p = n.params as unknown as WavParams;
        const w = this.wav(p.fileId!);
        const ch = Math.min(p.channel, w.channels.length - 1);
        const src = w.channels[ch];
        const data = new Float64Array(src.length);
        for (let i = 0; i < src.length; i++) data[i] = src[i] * p.fullScale;
        out = {
          fs: w.fs, data, quantity: p.quantity, ref: p.ref, weighting: 'Z', fullScale: p.fullScale,
          unit: unitFor(p.quantity), label: `${p.fileName ?? 'wav'} ch${ch + 1}`,
        };
        const tc = p.tachoChannel ?? -1;
        if (tc >= 0 && tc < w.channels.length) out.tacho = Float64Array.from(w.channels[tc]);
        const rc = p.rightChannel ?? -1;
        if (rc >= 0 && rc < w.channels.length) out.right = Float64Array.from(w.channels[rc], (v) => v * p.fullScale);
      } else if (n.type === 'weighting') {
        const up = signalFor(inputOf.get(id)!);
        const wid = n.params.weighting as WeightingId;
        out = { ...up, data: sosFilter(weightingSos(wid, up.fs), up.data), weighting: wid, label: `${up.label} → ${wid}` };
        if (up.right) out.right = sosFilter(weightingSos(wid, up.fs), up.right);
      } else {
        throw new Error(`${n.type} has no signal output`);
      }
      this.signals.set(sig, out);
      return out;
    };

    for (const n of nodes) {
      try {
        if (n.type === 'wavSource') {
          const p = n.params as unknown as WavParams;
          if (!p.fileId) continue;
          const w = this.wav(p.fileId);
          let peak = 0;
          for (const c of w.channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
          emit({ type: 'result', nodeId: n.id, result: {
            kind: 'source', fs: w.fs, channels: w.channels.length, duration: (w.channels[0]?.length ?? 0) / w.fs,
            bits: w.bitsPerSample, format: w.format, peak,
          } });
          continue;
        }
        if (n.type === 'weighting') continue;
        const sig = signature(n.id);
        if (!sig) {
          const message = inputOf.has(n.id) ? 'Load a WAV file in the source node' : 'Connect an input signal';
          emit({ type: 'error', nodeId: n.id, message });
          continue;
        }
        const cached = this.results.get(sig);
        if (cached) { emit({ type: 'result', nodeId: n.id, result: cached }); continue; }
        emit({ type: 'status', nodeId: n.id, text: 'Computing…' });
        const s = signalFor(inputOf.get(n.id)!);
        const result = analyse(n, s, (t) => emit({ type: 'status', nodeId: n.id, text: t }));
        this.results.set(sig, result);
        emit({ type: 'result', nodeId: n.id, result });
      } catch (e) {
        emit({ type: 'error', nodeId: n.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    // Drop cached signals/results the current graph no longer uses.
    const live = new Set(nodes.map((n) => signature(n.id)).filter(Boolean));
    for (const k of [...this.signals.keys()]) if (!live.has(k)) this.signals.delete(k);
    for (const k of [...this.results.keys()]) if (!live.has(k)) this.results.delete(k);
    emit({ type: 'done' });
  }
}

function unitFor(q: Signal['quantity']): string {
  return { acceleration: 'm/s²', velocity: 'm/s', displacement: 'm', pressure: 'Pa', other: 'FS' }[q];
}

function needPressure(s: Signal, what: string) {
  if (s.quantity !== 'pressure') throw new Error(`${what} needs a sound-pressure signal (set the source quantity to Pa)`);
}

function analyse(n: NodeSpec, s: Signal, status: (t: string) => void): NodeResult {
  const p = n.params;
  switch (n.type) {
    case 'level': {
      const f = timeWeighted(s.data, s.fs, TAU_FAST);
      const sl = timeWeighted(s.data, s.fs, TAU_SLOW, f.history.length);
      return {
        kind: 'level', label: s.label, unit: s.unit, ref: s.ref, weighting: s.weighting, quantity: s.quantity,
        fastMax: f.max, slowMax: sl.max, tFastMax: f.tMax, tSlowMax: sl.tMax,
        rms: rms(s.data), vdv: s.quantity === 'acceleration' ? vdv(s.data, s.fs) : undefined,
        duration: s.data.length / s.fs, fast: f.history, slow: sl.history, dt: f.dt,
      };
    }
    case 'spectrogram': {
      const sp = spectrogram(s.data, s.fs, Number(p.nfft), Number(p.overlap), s.ref, Number(p.fMax ?? 0));
      return { kind: 'spectrogram', label: s.label, unit: s.unit, range: Number(p.range), ...sp };
    }
    case 'loudness': {
      if (s.quantity !== 'pressure') throw new Error('Loudness needs a sound-pressure signal (set the source quantity to Pa)');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      status('Third-octave filtering…');
      const tl = thirdOctaveLevels(s.data, s.fs, Number(p.blockSec));
      const overall = loudnessFromLevels(tl.overall, field);
      const Nt = new Float32Array(tl.blocks.length), St = new Float32Array(tl.blocks.length);
      tl.blocks.forEach((lt, k) => { const r = loudnessFromLevels(lt, field); Nt[k] = r.N; St[k] = r.S; });
      const sorted = Float32Array.from(Nt).sort();
      const N5 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
      return {
        kind: 'loudness', label: s.label, field, N: overall.N, S: overall.S,
        Nmax: Math.max(...Nt), N5, Smean: St.reduce((a, b) => a + b, 0) / St.length,
        Nt, St, dt: tl.blockDt, ns: Float32Array.from(overall.ns),
      };
    }
    case 'roughness': {
      if (s.quantity !== 'pressure') throw new Error('Roughness needs a sound-pressure signal (set the source quantity to Pa)');
      const r = roughness(s.data, s.fs, Number(p.overlap), (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'roughness', label: s.label, ...r };
    }
    case 'loudnessTv': {
      needPressure(s, 'Time-varying loudness');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      status('Filtering…');
      const r = loudnessTimeVarying(s.data, s.fs, field, (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'loudnessTv', label: s.label, field, ...r };
    }
    case 'roughnessEcma': {
      needPressure(s, 'ECMA-418-2 roughness');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      const r = roughnessEcma(s.data, s.fs, field, (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'roughnessEcma', label: s.label, field, ...r };
    }
    case 'loudnessEcma': {
      needPressure(s, 'ECMA-418-2 loudness');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      const r = loudnessEcma(s.data, s.fs, field, (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'loudnessEcma', label: s.label, field, ...r };
    }
    case 'octave': {
      const r = octaveBands(s.data, s.fs, s.ref, Number(p.fraction) === 1 ? 1 : 3);
      return { kind: 'octave', label: s.label, unit: s.unit, ref: s.ref, ...r };
    }
    case 'calibTone': {
      const level = Number(p.level) || 1, t = findCalibTone(s.data, s.fs), fsc = s.fullScale ?? 1;
      return { kind: 'calibTone', label: s.label, unit: s.unit, level, fullScale: fsc, suggested: (fsc * level) / t.toneRms, ...t };
    }
    case 'cepstrum': {
      const r = cepstrum(s.data, s.fs, Number(p.frameSec) || 1, (Number(p.maxMs) || 50) / 1000, (Number(p.minMs) || 1) / 1000);
      return { kind: 'cepstrum', label: s.label, ...r };
    }
    case 'levelStats': {
      const r = levelStatistics(s.data, s.fs, s.ref);
      return { kind: 'levelStats', label: s.label, unit: s.unit, ref: s.ref, weighting: s.weighting, ...r };
    }
    case 'annoyance': {
      needPressure(s, 'Psychoacoustic annoyance');
      status('Loudness…');
      const n5 = loudnessTimeVarying(s.data, s.fs, 'free').N5;
      status('Sharpness…');
      const tl = thirdOctaveLevels(s.data, s.fs, 0.1);
      const sh = Float32Array.from(tl.blocks, (lt) => loudnessFromLevels(lt, 'free').S).sort();
      const pct5 = (a: ArrayLike<number>) => { const v = Float32Array.from(a as ArrayLike<number>).sort(); return v[Math.min(v.length - 1, Math.floor(0.95 * v.length))]; };
      const s5 = sh[Math.min(sh.length - 1, Math.floor(0.95 * sh.length))];
      status('Roughness…');
      const r5 = pct5(roughness(s.data, s.fs, 0.5).R);
      status('Fluctuation…');
      const f5 = pct5(fluctuationStrength(s.data, s.fs).F);
      const a = psychoacousticAnnoyance(n5, s5, f5, r5);
      return { kind: 'annoyance', label: s.label, PA: a.PA, N5: n5, S5: s5, R5: r5, F5: f5, wS: a.wS, wFR: a.wFR };
    }
    case 'orders': {
      const orders = String(p.orders ?? '1,2,3').split(/[\s,;]+/).map(Number).filter((v) => isFinite(v) && v > 0).slice(0, 6);
      const mode = p.mode === 'ramp' ? 'ramp' : 'tacho';
      const r = orderAnalysis(s.data, s.fs, s.tacho, {
        mode, ppr: Math.max(1, Number(p.ppr) || 1), rpm0: Number(p.rpm0) || 0, rpm1: Number(p.rpm1) || 0,
        orders, frameSec: Math.max(0.05, Number(p.frameSec) || 0.25),
      });
      return { kind: 'orders', label: s.label, unit: s.unit, mode, ...r };
    }
    case 'binaural': {
      needPressure(s, 'Binaural analysis');
      if (!s.right) throw new Error('Select the right-ear channel in the WAV source node (this node analyses the selected channel as the left ear)');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      status('Interaural…');
      const ia = interaural(s.data, s.right, s.fs, s.ref);
      const metric = ['roughness', 'fluctuation', 'tonality'].includes(String(p.metric)) ? String(p.metric) : 'loudness';
      const ear = (name: string) => (f: number) => status(`${name} ear… ${Math.round(f * 100)}%`);
      const out = { kind: 'binaural' as const, label: s.label, unit: s.unit, field, metric, ...ia };
      if (metric === 'tonality') {
        const l = tonalityEcma(s.data, s.fs, field, ear('Left')), r = tonalityEcma(s.right, s.fs, field, ear('Right'));
        return { ...out, metricUnit: 'tu_HMS', vL: l.T, vR: r.T, vB: null, tL: l.Tl, tR: r.Tl, tB: null, dtM: l.dt };
      }
      const g = {
        loudness: { spec: specificLoudnessEcma, red: loudnessFromSpecific, unit: 'sone_HMS', v: (r: { N: number }) => r.N, t: (r: { Nt: Float32Array }) => r.Nt },
        roughness: { spec: specificRoughnessEcma, red: roughnessFromSpecific, unit: 'asper_HMS', v: (r: { R: number }) => r.R, t: (r: { Rt: Float32Array }) => r.Rt },
        fluctuation: { spec: specificFluctuationEcma, red: fluctuationFromSpecific, unit: 'vacil_HMS', v: (r: { F: number }) => r.F, t: (r: { Ft: Float32Array }) => r.Ft },
      }[metric as 'loudness' | 'roughness' | 'fluctuation'];
      const sl = g.spec(s.data, s.fs, field, ear('Left')), sr = g.spec(s.right, s.fs, field, ear('Right'));
      const L = g.red(sl), R = g.red(sr), B = g.red(binauralSpecific(sl, sr));
      const val = (r: unknown) => g.v(r as never), ser = (r: unknown) => g.t(r as never);
      return { ...out, metricUnit: g.unit, vL: val(L), vR: val(R), vB: val(B), tL: ser(L), tR: ser(R), tB: ser(B), dtM: B.dt };
    }
    case 'metricRpm': {
      needPressure(s, 'Psychoacoustic metric vs RPM');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      const prog = (f: number) => status(`Computing… ${Math.round(f * 100)}%`);
      const metric = String(p.metric);
      let v: ArrayLike<number>, dt: number, unit: string;
      if (metric === 'loudnessEcma') { const r = loudnessEcma(s.data, s.fs, field, prog); v = r.Nt; dt = r.dt; unit = 'sone_HMS'; }
      else if (metric === 'roughnessEcma') { const r = roughnessEcma(s.data, s.fs, field, prog); v = r.Rt; dt = r.dt; unit = 'asper_HMS'; }
      else if (metric === 'tonalityEcma') { const r = tonalityEcma(s.data, s.fs, field, prog); v = r.Tl; dt = r.dt; unit = 'tu_HMS'; }
      else if (metric === 'fluctuationEcma') { const r = fluctuationEcma(s.data, s.fs, field, prog); v = r.Ft; dt = r.dt; unit = 'vacil_HMS'; }
      else { const r = loudnessTimeVarying(s.data, s.fs, field, prog); v = r.N; dt = r.dt; unit = 'sone'; }
      const mode = p.mode === 'ramp' ? 'ramp' : 'tacho';
      const r = metricVsRpm(v, dt, s.data.length, s.fs, s.tacho, {
        mode, ppr: Math.max(1, Number(p.ppr) || 1), rpm0: Number(p.rpm0) || 0, rpm1: Number(p.rpm1) || 0, orders: [], frameSec: 0.25,
      }, 0.5);
      return { kind: 'metricRpm', label: s.label, metric, unit, ...r };
    }
    case 'fluctuationEcma': {
      needPressure(s, 'ECMA-418-2 fluctuation strength');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      const r = fluctuationEcma(s.data, s.fs, field, (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'fluctuationEcma', label: s.label, field, ...r };
    }
    case 'tonalityEcma': {
      needPressure(s, 'ECMA-418-2 tonality');
      const field = p.field === 'diffuse' ? 'diffuse' : 'free';
      const r = tonalityEcma(s.data, s.fs, field, (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'tonalityEcma', label: s.label, field, ...r };
    }
    case 'fluctuation': {
      needPressure(s, 'Fluctuation strength');
      const r = fluctuationStrength(s.data, s.fs, (f) => status(`Computing… ${Math.round(f * 100)}%`));
      return { kind: 'fluctuation', label: s.label, ...r };
    }
    case 'tonality': {
      needPressure(s, 'Tonality');
      return { kind: 'tonality', label: s.label, ...tonality(s.data, s.fs, s.ref, Number(p.nfft)) };
    }
    case 'impulsivity': {
      needPressure(s, 'Impulsiveness');
      if (s.weighting !== 'Z') throw new Error('Connect the unweighted signal: impulsiveness applies A-weighting itself');
      let peak = 0;
      for (let i = 0; i < s.data.length; i++) peak = Math.max(peak, Math.abs(s.data[i]));
      const a = sosFilter(weightingSos('A', s.fs), s.data);
      return { kind: 'impulsivity', label: s.label, ...impulsivity(a, s.fs, s.ref, peak) };
    }
    default:
      throw new Error(`Unknown node type ${n.type}`);
  }
}
