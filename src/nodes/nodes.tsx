import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import type { ReactNode } from 'react';
import { useGraph } from '../ui/context';
import { Heatmap, LinePlot, SERIES } from '../ui/plots';
import { WEIGHTINGS } from '../dsp/weighting';
import { toDb } from '../dsp/levels';
import { QUANTITIES, type NodeKind, type Quantity } from '../engine/types';

type Data = Record<string, unknown>;

function useParams(id: string) {
  const { updateNodeData } = useReactFlow();
  return (patch: Data) => updateNodeData(id, patch);
}

function Shell({ id, title, accent, input, output, children }: {
  id: string; title: string; accent: string; input?: boolean; output?: boolean; children: ReactNode;
}) {
  const { status, errors } = useGraph();
  return (
    <div className="node" style={{ borderTopColor: accent }}>
      {input && <Handle type="target" position={Position.Left} />}
      <div className="node-title">{title}</div>
      <div className="node-body">{children}</div>
      {errors[id] && <div className="node-error">⚠ {errors[id]}</div>}
      {!errors[id] && status[id] && <div className="node-status">{status[id]}</div>}
      {output && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

const sig = (v: number) => (isFinite(v) ? v.toPrecision(3) : '–');
const dB = (v: number) => (isFinite(v) ? v.toFixed(1) : '–');
const refText = (ref: number, unit: string) => `dB re ${ref.toExponential(0).replace('e', '×10^').replace('+', '')} ${unit}`;

// ───────────────────────── WAV source ─────────────────────────
interface WavInfo { fs: number; channels: number; duration: number; bits: number; format: string }

export function WavSourceNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const { loadFile } = useGraph();
  const info = d.info as WavInfo | undefined;
  const q = d.quantity as Quantity;
  return (
    <Shell id={id} title="WAV file" accent="#2a78d6" output>
      <input className="nodrag" type="file" accept=".wav,audio/wav"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(id, f); }} />
      {info && (
        <div className="info">
          <b>{String(d.fileName)}</b><br />
          {info.fs} Hz · {info.channels} ch · {info.bits}-bit {info.format} · {info.duration.toFixed(2)} s
        </div>
      )}
      {info && info.channels > 1 && (
        <Field label="Channel">
          <select className="nodrag" value={Number(d.channel)} onChange={(e) => set({ channel: Number(e.target.value) })}>
            {Array.from({ length: info.channels }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
          </select>
        </Field>
      )}
      <Field label="Quantity">
        <select className="nodrag" value={q}
          onChange={(e) => { const nq = e.target.value as Quantity; set({ quantity: nq, ref: QUANTITIES[nq].ref }); }}>
          {Object.entries(QUANTITIES).map(([k, v]) => <option key={k} value={k}>{v.label} ({v.unit})</option>)}
        </select>
      </Field>
      <Field label={`Full scale (1.0) = [${QUANTITIES[q].unit}]`}>
        <input className="nodrag" type="number" step="any" value={Number(d.fullScale)}
          onChange={(e) => set({ fullScale: Number(e.target.value) || 0 })} />
      </Field>
      <Field label={`dB reference [${QUANTITIES[q].unit}]`}>
        <input className="nodrag" type="number" step="any" value={Number(d.ref)}
          onChange={(e) => set({ ref: Number(e.target.value) || 1 })} />
      </Field>
    </Shell>
  );
}

// ───────────────────────── Weighting ─────────────────────────
export function WeightingNode({ id, data }: NodeProps) {
  const set = useParams(id);
  const groups = [...new Set(WEIGHTINGS.map((w) => w.group))];
  return (
    <Shell id={id} title="Frequency weighting" accent="#1baf7a" input output>
      <select className="nodrag wide" value={String((data as Data).weighting)} onChange={(e) => set({ weighting: e.target.value })}>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {WEIGHTINGS.filter((w) => w.group === g).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </optgroup>
        ))}
      </select>
    </Shell>
  );
}

// ───────────────────────── Fast / Slow level ─────────────────────────
export function LevelNode({ id }: NodeProps) {
  const r = useGraph().results[id];
  const res = r?.kind === 'level' ? r : undefined;
  return (
    <Shell id={id} title="Fast / Slow max level" accent="#eb6834" input>
      {!res && <div className="hint">Connect a signal and run.</div>}
      {res && (
        <>
          <div className="info">{res.label}</div>
          <table className="results">
            <thead><tr><th /><th>{res.unit} (rms)</th><th>{refText(res.ref, res.unit)}</th><th>at</th></tr></thead>
            <tbody>
              <tr><td>Max Fast</td><td>{sig(res.fastMax)}</td><td>{dB(toDb(res.fastMax, res.ref))}</td><td>{res.tFastMax.toFixed(2)} s</td></tr>
              <tr><td>Max Slow</td><td>{sig(res.slowMax)}</td><td>{dB(toDb(res.slowMax, res.ref))}</td><td>{res.tSlowMax.toFixed(2)} s</td></tr>
              <tr><td>RMS / Leq</td><td>{sig(res.rms)}</td><td>{dB(toDb(res.rms, res.ref))}</td><td>{res.duration.toFixed(1)} s</td></tr>
              {res.vdv !== undefined && <tr><td>VDV</td><td>{sig(res.vdv)}</td><td colSpan={2}>m/s^1.75</td></tr>}
            </tbody>
          </table>
          <LinePlot
            yLabel="dB"
            yMax={Math.ceil(toDb(res.fastMax, res.ref) / 5) * 5 + 5}
            yMin={Math.ceil(toDb(res.fastMax, res.ref) / 5) * 5 - 55}
            series={[
              { label: 'Fast', data: Array.from(res.fast, (v) => toDb(v, res.ref)), dt: res.dt, color: SERIES[0] },
              { label: 'Slow', data: Array.from(res.slow, (v) => toDb(v, res.ref)), dt: res.dt, color: SERIES[1] },
            ]}
          />
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Moving FFT ─────────────────────────
export function SpectrogramNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'spectrogram' ? r : undefined;
  const range = Number(d.uiRange ?? 60);
  return (
    <Shell id={id} title="Moving FFT (spectrogram)" accent="#6250d6" input>
      <div className="row">
        <Field label="FFT size">
          <select className="nodrag" value={Number(d.nfft)} onChange={(e) => set({ nfft: Number(e.target.value) })}>
            {[256, 512, 1024, 2048, 4096, 8192, 16384, 32768].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Overlap">
          <select className="nodrag" value={Number(d.overlap)} onChange={(e) => set({ overlap: Number(e.target.value) })}>
            {[0, 0.5, 0.75, 0.875].map((n) => <option key={n} value={n}>{n * 100}%</option>)}
          </select>
        </Field>
        <Field label="Max freq">
          <select className="nodrag" value={Number(d.fMax ?? 0)} onChange={(e) => set({ fMax: Number(e.target.value) })}>
            {[0, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50].map((n) => <option key={n} value={n}>{n ? `${n} Hz` : 'Nyquist'}</option>)}
          </select>
        </Field>
        <Field label="Range dB">
          <select className="nodrag" value={range} onChange={(e) => set({ uiRange: Number(e.target.value) })}>
            {[30, 40, 60, 80, 100, 120].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>
      {res && (
        <>
          <div className="info">{res.label} · Δf {res.avgDf.toFixed(2)} Hz · Hann · bin RMS</div>
          <Heatmap db={res.db} frames={res.frames} bins={res.bins} dt={res.dt} df={res.df}
            top={Math.ceil(res.maxDb)} range={range} unitLabel="dB" />
          <LinePlot yLabel="dB" xLabel="Hz" height={120}
            yMin={Math.ceil(res.maxDb) - range} yMax={Math.ceil(res.maxDb)}
            series={[{ label: 'Average spectrum', data: res.avgDb.subarray(0, Math.ceil((res.bins * res.df) / res.avgDf)), dt: res.avgDf, x0: -res.avgDf / 2, color: SERIES[0] }]} />
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Loudness & sharpness ─────────────────────────
export function LoudnessNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'loudness' ? r : undefined;
  return (
    <Shell id={id} title="Loudness & sharpness (Zwicker)" accent="#e87ba4" input>
      <div className="row">
        <Field label="Field">
          <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
            <option value="free">Free</option><option value="diffuse">Diffuse</option>
          </select>
        </Field>
        <Field label="Block">
          <select className="nodrag" value={Number(d.blockSec)} onChange={(e) => set({ blockSec: Number(e.target.value) })}>
            {[0.05, 0.1, 0.2, 0.5, 1].map((n) => <option key={n} value={n}>{n * 1000} ms</option>)}
          </select>
        </Field>
      </div>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>N (whole file, ISO 532-1 stationary)</td><td>{res.N.toFixed(2)} sone</td></tr>
              <tr><td>N max / N5 (per block)</td><td>{res.Nmax.toFixed(2)} / {res.N5.toFixed(2)} sone</td></tr>
              <tr><td>Sharpness S (DIN 45692)</td><td>{res.S.toFixed(2)} acum</td></tr>
              <tr><td>Sharpness mean (per block)</td><td>{res.Smean.toFixed(2)} acum</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="sone" height={110} series={[{ label: 'N(t)', data: res.Nt, dt: res.dt, color: SERIES[0] }]} />
          <LinePlot yLabel="acum" height={110} series={[{ label: 'S(t)', data: res.St, dt: res.dt, color: SERIES[0] }]} />
          <div className="hint">Per-block values apply the stationary method to each block; they are not the ISO 532-1 time-varying method.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Roughness ─────────────────────────
export function RoughnessNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'roughness' ? r : undefined;
  return (
    <Shell id={id} title="Roughness (Daniel & Weber)" accent="#e34948" input>
      <Field label="Frame overlap">
        <select className="nodrag" value={Number(d.overlap)} onChange={(e) => set({ overlap: Number(e.target.value) })}>
          {[0, 0.5, 0.75].map((n) => <option key={n} value={n}>{n * 100}%</option>)}
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Mean</td><td>{res.mean.toFixed(3)} asper</td></tr>
              <tr><td>Max</td><td>{res.max.toFixed(3)} asper</td></tr>
              <tr><td>Frame</td><td>{(res.frameSec * 1000).toFixed(0)} ms</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="asper" height={110} series={[{ label: 'R(t)', data: res.R, dt: res.dt, color: SERIES[0] }]} />
        </>
      )}
    </Shell>
  );
}

export const nodeTypes = {
  wavSource: WavSourceNode,
  weighting: WeightingNode,
  level: LevelNode,
  spectrogram: SpectrogramNode,
  loudness: LoudnessNode,
  roughness: RoughnessNode,
};

export const PALETTE: { type: NodeKind; label: string; defaults: Data }[] = [
  { type: 'wavSource', label: 'WAV file', defaults: { channel: 0, fullScale: 1, quantity: 'acceleration', ref: 1e-6 } },
  { type: 'weighting', label: 'Frequency weighting', defaults: { weighting: 'Wb' } },
  { type: 'level', label: 'Fast / Slow max level', defaults: {} },
  { type: 'spectrogram', label: 'Moving FFT', defaults: { nfft: 4096, overlap: 0.5, fMax: 0, uiRange: 60 } },
  { type: 'loudness', label: 'Loudness & sharpness', defaults: { field: 'free', blockSec: 0.1 } },
  { type: 'roughness', label: 'Roughness', defaults: { overlap: 0.5 } },
];
