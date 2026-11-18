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
import { roughnessEcma } from '../dsp/roughnessEcma';
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
          fs: w.fs, data, quantity: p.quantity, ref: p.ref, weighting: 'Z',
          unit: unitFor(p.quantity), label: `${p.fileName ?? 'wav'} ch${ch + 1}`,
        };
      } else if (n.type === 'weighting') {
        const up = signalFor(inputOf.get(id)!);
        const wid = n.params.weighting as WeightingId;
        out = { ...up, data: sosFilter(weightingSos(wid, up.fs), up.data), weighting: wid, label: `${up.label} → ${wid}` };
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
