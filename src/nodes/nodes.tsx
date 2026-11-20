import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { play, playingNode, stop as stopPlayback, subscribe } from '../ui/player';
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
      {/* a running computation supersedes the previous run's error, which would otherwise look current */}
      {status[id] && <div className="node-status">{status[id]}</div>}
      {!status[id] && errors[id] && <div className="node-error">⚠ {errors[id]}</div>}
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
  const playing = useSyncExternalStore(subscribe, playingNode) === id;
  useEffect(() => () => { if (playingNode() === id) stopPlayback(); }, [id]);
  const vol = typeof d.uiVolume === 'number' ? d.uiVolume : 0.5;
  return (
    <Shell id={id} title="WAV file" accent="#2a78d6" output>
      <input className="nodrag" type="file" accept=".wav,audio/wav"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(id, f); }} />
      {!info && typeof d.fileName === 'string' && (
        <div className="hint">Select {d.fileName} again — saved graphs don't contain the audio.</div>
      )}
      {info && (
        <div className="info">
          <b>{String(d.fileName)}</b><br />
          {info.fs} Hz · {info.channels} ch · {info.bits}-bit {info.format} · {info.duration.toFixed(2)} s
        </div>
      )}
      {info && (
        <div className="row">
          <button className="nodrag play" onClick={() => (playing ? stopPlayback() : play(id, Number(d.channel), vol ** 2))}>
            {playing ? '■ Stop' : '▶ Play'}
          </button>
          <label className="field">
            <span>Volume</span>
            <input className="nodrag" type="range" min={0} max={1} step={0.05} value={vol}
              onChange={(e) => set({ uiVolume: Number(e.target.value) })} />
          </label>
        </div>
      )}
      {info && info.channels > 1 && (
        <Field label="Channel">
          <select className="nodrag" value={Number(d.channel)} onChange={(e) => set({ channel: Number(e.target.value) })}>
            {Array.from({ length: info.channels }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
          </select>
        </Field>
      )}
      {info && info.channels > 1 && (
        <Field label="Tacho channel (for orders)">
          <select className="nodrag" value={typeof d.tachoChannel === 'number' ? d.tachoChannel : -1} onChange={(e) => set({ tachoChannel: Number(e.target.value) })}>
            <option value={-1}>none</option>
            {Array.from({ length: info.channels }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
          </select>
        </Field>
      )}
      {info && info.channels > 1 && (
        <Field label="Right ear channel (for binaural)">
          <select className="nodrag" value={typeof d.rightChannel === 'number' ? d.rightChannel : -1} onChange={(e) => set({ rightChannel: Number(e.target.value) })}>
            <option value={-1}>none</option>
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
        <Field label="Hz axis">
          <select className="nodrag" value={d.uiLog ? 1 : 0} onChange={(e) => set({ uiLog: e.target.value === '1' })}>
            <option value={0}>Linear</option><option value={1}>Log</option>
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
            top={Math.ceil(res.maxDb)} range={range} unitLabel="dB" logF={!!d.uiLog} />
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

// ───────────────────────── Loudness, time-varying ─────────────────────────
export function LoudnessTvNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'loudnessTv' ? r : undefined;
  return (
    <Shell id={id} title="Loudness, time-varying (ISO 532-1)" accent="#d94f8b" input>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>N max</td><td>{res.Nmax.toFixed(2)} sone @ {res.tNmax.toFixed(2)} s ({res.LNmax.toFixed(1)} phon)</td></tr>
              <tr><td>N mean</td><td>{res.Nmean.toFixed(2)} sone</td></tr>
              <tr><td>N5 / N10 / N50 / N95</td><td>{res.N5.toFixed(2)} / {res.N10.toFixed(2)} / {res.N50.toFixed(2)} / {res.N95.toFixed(2)} sone</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="sone" height={120} series={[{ label: 'N(t)', data: res.N, dt: res.dt, color: SERIES[0] }]} />
          <div className="hint">Resolution 2 ms; resampled to 48 kHz as the standard requires. Nx = loudness exceeded in x % of the time.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Roughness, ECMA-418-2 ─────────────────────────
export function RoughnessEcmaNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'roughnessEcma' ? r : undefined;
  return (
    <Shell id={id} title="Roughness (ECMA-418-2, Sottek)" accent="#c2410c" input>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>R (90th percentile)</td><td><b>{res.R.toFixed(3)} asper<sub>HMS</sub></b></td></tr>
              <tr><td>R max</td><td>{res.max.toFixed(3)} asper<sub>HMS</sub></td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="asper" height={110} series={[{ label: 'R(t)', data: res.Rt, dt: res.dt, color: SERIES[0] }]} />
          <LinePlot yLabel="asper/Bark" xLabel="Bark" height={110} series={[{ label: 'R′(z), time average', data: res.specific, dt: 0.5, x0: 0.25, color: SERIES[1] }]} />
          <div className="hint">Hearing-model roughness: 1 kHz, 60 dB, 100 % AM at 70 Hz = 1 asper. Needs ≥ 1 s of Pa. The first 0.32 s are excluded from the statistics.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Loudness, ECMA-418-2 ─────────────────────────
export function LoudnessEcmaNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'loudnessEcma' ? r : undefined;
  return (
    <Shell id={id} title="Loudness (ECMA-418-2, Sottek)" accent="#b45309" input>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>N (power average)</td><td><b>{res.N.toFixed(2)} sone<sub>HMS</sub></b></td></tr>
              <tr><td>N max</td><td>{res.Nmax.toFixed(2)} sone<sub>HMS</sub></td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="sone" height={110} series={[{ label: 'N(t)', data: res.Nt, dt: res.dt, color: SERIES[0] }]} />
          <LinePlot yLabel="sone/Bark" xLabel="Bark" height={110} series={[{ label: 'N′(z), average', data: res.specific, dt: 0.5, x0: 0.25, color: SERIES[1] }]} />
          <div className="hint">Hearing-model loudness (tonal + noise loudness): 1 kHz, 40 dB tone = 1 sone. Needs ≥ 0.5 s of Pa; the first 0.3 s are excluded.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Octave / third-octave bands ─────────────────────────
export function OctaveNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'octave' ? r : undefined;
  return (
    <Shell id={id} title="Octave / third-octave bands" accent="#4d7c0f" input>
      <Field label="Bands">
        <select className="nodrag" value={Number(d.fraction)} onChange={(e) => set({ fraction: Number(e.target.value) })}>
          <option value={3}>1/3 octave</option><option value={1}>Octave</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody><tr><td>Total</td><td><b>{dB(res.total)} {refText(res.ref, res.unit)}</b></td></tr></tbody>
          </table>
          <LinePlot yLabel="dB" xLabel="band #" height={130} series={[
            { label: 'Leq', data: res.leq, dt: 1, color: SERIES[0] },
            { label: 'Lmax (frame)', data: res.lmax, dt: 1, color: SERIES[1] },
          ]} />
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            <table className="results">
              <tbody>
                {res.fc.map((f, i) => (
                  <tr key={f}><td>#{i} · {f >= 1000 ? `${+(f / 1000).toPrecision(3)} k` : Math.round(f)} Hz</td><td>{dB(res.leq[i])} / {dB(res.lmax[i])} dB</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint">Leq / max over {res.frameSec.toFixed(2)} s frames; exact IEC 61260 band edges from a Hann-windowed FFT. Bands narrower than 2 bins are dropped.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Cepstrum ─────────────────────────
export function CepstrumNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'cepstrum' ? r : undefined;
  return (
    <Shell id={id} title="Cepstrum" accent="#0e7490" input>
      <Field label="Frame (s)">
        <input className="nodrag" type="number" min={0.05} step="any" value={Number(d.frameSec)} onChange={(e) => set({ frameSec: Number(e.target.value) || 1 })} />
      </Field>
      <Field label="Max quefrency (ms)">
        <input className="nodrag" type="number" min={2} step="any" value={Number(d.maxMs)} onChange={(e) => set({ maxMs: Number(e.target.value) || 50 })} />
      </Field>
      <Field label="Ignore below (ms)">
        <input className="nodrag" type="number" min={0} step="any" value={Number(d.minMs)} onChange={(e) => set({ minMs: Number(e.target.value) || 1 })} />
      </Field>
      {res && (
        <>
          <LinePlot yLabel="cepstrum" xLabel="ms" height={150} series={[{ label: 'c(q)', data: res.c, dt: res.dq * 1000, color: SERIES[0] }]} />
          {res.fundamental && <div><b>Line spacing {res.fundamental.freq.toFixed(1)} Hz</b> (q = {(res.fundamental.q * 1000).toFixed(2)} ms)</div>}
          <table className="results">
            <tbody>
              {res.peaks.map((p) => (
                <tr key={p.q}><td>{(p.q * 1000).toFixed(2)} ms → {p.freq.toFixed(1)} Hz</td><td>{p.amp.toFixed(3)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="hint">Real cepstrum of the log spectrum averaged over {res.frames} Hann frames of {res.frameSec.toFixed(2)} s. A peak at q means spectral lines spaced 1/q apart (harmonics, sidebands); multiples of q are rahmonics. Strongest local maxima listed.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Calibration tone ─────────────────────────
export function CalibToneNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const { updateNodeData, getEdges, getNode } = useReactFlow();
  const r = useGraph().results[id];
  const res = r?.kind === 'calibTone' ? r : undefined;
  return (
    <Shell id={id} title="Calibration tone" accent="#475569" input>
      <Field label="Calibrator level (RMS, signal units)">
        <input className="nodrag" type="number" min={0} step="any" value={Number(d.level)} onChange={(e) => set({ level: Number(e.target.value) || 1 })} />
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Tone frequency</td><td><b>{res.freq.toFixed(1)} Hz</b></td></tr>
              <tr><td>Tone RMS</td><td>{+res.toneRms.toPrecision(4)} {res.unit}</td></tr>
              <tr><td>Tone share of power</td><td>{(100 * res.toneShare).toFixed(1)} %</td></tr>
              <tr><td>Full scale now</td><td>{+res.fullScale.toPrecision(5)} {res.unit}</td></tr>
              <tr><td>Full scale for {res.level} {res.unit}</td><td><b>{+res.suggested.toPrecision(5)} {res.unit}</b></td></tr>
            </tbody>
          </table>
          <button className="nodrag" onClick={() => {
            let src = getEdges().find((e) => e.target === id)?.source;
            while (src && getNode(src)?.type !== 'wavSource') src = getEdges().find((e) => e.target === src)?.source;
            if (src) updateNodeData(src, { fullScale: Number(res.suggested.toPrecision(6)) });
          }}>Set full scale on the WAV node</button>
          <div className="hint">Connect directly to the WAV node of the calibrator recording. Typical levels: 94 dB SPL = 1.002 Pa, 114 dB = 10.02 Pa; vibration calibrators 1 or 10 m/s² at 159.2 Hz. Below ~90 % tone share the recording is not a clean calibrator tone.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Level statistics ─────────────────────────
export function LevelStatsNode({ id }: NodeProps) {
  const r = useGraph().results[id];
  const res = r?.kind === 'levelStats' ? r : undefined;
  return (
    <Shell id={id} title="Level statistics (Leq, Lx)" accent="#be185d" input>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Leq ({res.weighting})</td><td><b>{dB(res.leq)} dB</b></td></tr>
              <tr><td>Peak</td><td>{dB(res.lpeak)} dB</td></tr>
              <tr><td>Fast max / min</td><td>{dB(res.lfMax)} / {dB(res.lfMin)} dB</td></tr>
              {res.percentiles.map((p) => <tr key={p.x}><td>L{p.x}</td><td>{dB(p.level)} dB</td></tr>)}
            </tbody>
          </table>
          <div className="hint">{refText(res.ref, res.unit)}. Lx = Fast level exceeded x % of the time (125 ms detector, 100 Hz sampling).</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Psychoacoustic annoyance ─────────────────────────
export function AnnoyanceNode({ id }: NodeProps) {
  const r = useGraph().results[id];
  const res = r?.kind === 'annoyance' ? r : undefined;
  return (
    <Shell id={id} title="Psychoacoustic annoyance (Zwicker)" accent="#9f1239" input>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>PA</td><td><b>{res.PA.toFixed(2)}</b></td></tr>
              <tr><td>N5</td><td>{res.N5.toFixed(2)} sone</td></tr>
              <tr><td>S5</td><td>{res.S5.toFixed(2)} acum</td></tr>
              <tr><td>R5</td><td>{res.R5.toFixed(3)} asper</td></tr>
              <tr><td>F5</td><td>{res.F5.toFixed(3)} vacil</td></tr>
              <tr><td>w<sub>S</sub> / w<sub>FR</sub></td><td>{res.wS.toFixed(3)} / {res.wFR.toFixed(3)}</td></tr>
            </tbody>
          </table>
          <div className="hint">PA = N5 (1 + √(w<sub>S</sub>² + w<sub>FR</sub>²)). N5 from ISO 532-1 time-varying loudness; sharpness, roughness and fluctuation are 5 %-exceeded values of this app's Daniel &amp; Weber and Fastl-type nodes (not the ECMA ones). Needs Pa.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Order analysis / vs RPM ─────────────────────────
export function OrdersNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'orders' ? r : undefined;
  const tacho = d.mode !== 'ramp';
  return (
    <Shell id={id} title="Order analysis (vs RPM)" accent="#a16207" input>
      <Field label="Speed from">
        <select className="nodrag" value={tacho ? 'tacho' : 'ramp'} onChange={(e) => set({ mode: e.target.value })}>
          <option value="tacho">Tacho channel (set in WAV node)</option><option value="ramp">Linear RPM ramp</option>
        </select>
      </Field>
      {tacho ? (
        <Field label="Pulses per revolution">
          <input className="nodrag" type="number" min={1} step={1} value={Number(d.ppr)} onChange={(e) => set({ ppr: Number(e.target.value) || 1 })} />
        </Field>
      ) : (
        <>
          <Field label="RPM at start">
            <input className="nodrag" type="number" step="any" value={Number(d.rpm0)} onChange={(e) => set({ rpm0: Number(e.target.value) || 0 })} />
          </Field>
          <Field label="RPM at end">
            <input className="nodrag" type="number" step="any" value={Number(d.rpm1)} onChange={(e) => set({ rpm1: Number(e.target.value) || 0 })} />
          </Field>
        </>
      )}
      <Field label="Orders to track">
        <input className="nodrag" type="text" value={String(d.orders)} onChange={(e) => set({ orders: e.target.value })} />
      </Field>
      <Field label="Frame (s)">
        <input className="nodrag" type="number" min={0.05} step={0.05} value={Number(d.frameSec)} onChange={(e) => set({ frameSec: Number(e.target.value) || 0.25 })} />
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Speed range</td><td><b>{res.rpmMin.toFixed(0)} – {res.rpmMax.toFixed(0)} rpm</b></td></tr>
              <tr><td>Revolutions</td><td>{res.revolutions.toFixed(0)}</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="rpm" height={100} series={[{ label: 'rpm', data: res.rpm, dt: res.rpmDt, color: SERIES[0] }]} />
          <LinePlot yLabel={`${res.unit} RMS`} xLabel="rpm" height={120} series={[
            { label: 'overall', data: res.levelVsRpm, dt: res.rpmStep, x0: res.rpmLo, color: SERIES[0] },
            ...res.tracks.slice(0, 2).map((t, i) => ({ label: `order ${t.order}`, data: t.amp, dt: res.rpmStep, x0: res.rpmLo, color: SERIES[i + 1] })),
          ]} />
          <LinePlot yLabel={`${res.unit} RMS`} xLabel="order" height={110} series={[{ label: 'order spectrum', data: res.spectrum, dt: res.orderStep, color: SERIES[2] }]} />
          <div className="hint">Order tracking by heterodyne at k·φ(t); the first two tracked orders are plotted. Order spectrum: 64 samples/rev resampling, 16-rev frames (resolution 1/16 order, up to order 32).</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Binaural analysis ─────────────────────────
export function BinauralNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'binaural' ? r : undefined;
  return (
    <Shell id={id} title="Binaural analysis (ECMA-418-2)" accent="#6d28d9" input>
      <Field label="Metric">
        <select className="nodrag" value={String(d.metric)} onChange={(e) => set({ metric: e.target.value })}>
          <option value="loudness">Loudness</option><option value="roughness">Roughness</option>
          <option value="fluctuation">Fluctuation strength</option><option value="tonality">Tonality (per ear only)</option>
        </select>
      </Field>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              {res.vB !== null && <tr><td>Binaural</td><td><b>{res.vB.toFixed(3)} {res.metricUnit}</b></td></tr>}
              <tr><td>Left / right</td><td>{res.vL.toFixed(3)} / {res.vR.toFixed(3)}</td></tr>
              <tr><td>Leq left / right</td><td>{res.leqL.toFixed(1)} / {res.leqR.toFixed(1)} dB</td></tr>
              <tr><td>ILD (L − R)</td><td>{res.ild.toFixed(1)} dB</td></tr>
              <tr><td>IACC</td><td>{res.iacc.toFixed(2)}</td></tr>
              <tr><td>ITD</td><td>{(res.itd * 1000).toFixed(2)} ms</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel={res.metricUnit} height={130} series={[
            { label: 'left', data: res.tL, dt: res.dtM, color: SERIES[0] },
            { label: 'right', data: res.tR, dt: res.dtM, color: SERIES[1] },
            ...(res.tB ? [{ label: 'binaural', data: res.tB, dt: res.dtM, color: SERIES[2] }] : []),
          ]} />
          <LinePlot yLabel="IACC" height={90} yMin={0} yMax={1} series={[{ label: 'IACC', data: res.iaccT, dt: res.dt, color: SERIES[3] }]} />
          <div className="hint">The selected channel is the left ear; pick the right ear in the WAV node. Binaural loudness, roughness and fluctuation: quadratic mean of the left and right specific values (clauses 8.1.5, 7.1.11, 9.1.15). The standard defines no binaural tonality, so tonality is shown per ear. IACC: broadband, lags ±1 ms, per 1 s frame. Needs Pa, already diffuse- or free-field equalised. Roughness needs ≥ 1 s, fluctuation ≥ 2 s.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Psychoacoustic metric vs RPM ─────────────────────────
export function MetricRpmNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'metricRpm' ? r : undefined;
  const tacho = d.mode !== 'ramp';
  return (
    <Shell id={id} title="Psychoacoustic metric vs RPM" accent="#a16207" input>
      <Field label="Metric">
        <select className="nodrag" value={String(d.metric)} onChange={(e) => set({ metric: e.target.value })}>
          <option value="loudnessTv">Loudness (ISO 532-1)</option><option value="loudnessEcma">Loudness (ECMA-418-2)</option>
          <option value="roughnessEcma">Roughness (ECMA-418-2)</option><option value="tonalityEcma">Tonality (ECMA-418-2)</option>
          <option value="fluctuationEcma">Fluctuation (ECMA-418-2)</option>
        </select>
      </Field>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      <Field label="Speed from">
        <select className="nodrag" value={tacho ? 'tacho' : 'ramp'} onChange={(e) => set({ mode: e.target.value })}>
          <option value="tacho">Tacho channel (set in WAV node)</option><option value="ramp">Linear RPM ramp</option>
        </select>
      </Field>
      {tacho ? (
        <Field label="Pulses per revolution">
          <input className="nodrag" type="number" min={1} step={1} value={Number(d.ppr)} onChange={(e) => set({ ppr: Number(e.target.value) || 1 })} />
        </Field>
      ) : (
        <>
          <Field label="RPM at start">
            <input className="nodrag" type="number" step="any" value={Number(d.rpm0)} onChange={(e) => set({ rpm0: Number(e.target.value) || 0 })} />
          </Field>
          <Field label="RPM at end">
            <input className="nodrag" type="number" step="any" value={Number(d.rpm1)} onChange={(e) => set({ rpm1: Number(e.target.value) || 0 })} />
          </Field>
        </>
      )}
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Speed range</td><td><b>{res.rpmMin.toFixed(0)} – {res.rpmMax.toFixed(0)} rpm</b></td></tr>
              <tr><td>Frames used</td><td>{res.frames}</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel={res.unit} xLabel="rpm" height={150} series={[
            { label: 'mean', data: res.mean, dt: res.rpmStep, x0: res.rpmLo, color: SERIES[0] },
            { label: 'max', data: res.max, dt: res.rpmStep, x0: res.rpmLo, color: SERIES[1] },
          ]} />
          <div className="hint">Metric frames are placed at k·Δt and binned (40 bins) by the shaft speed at that time (averaged over ≥ 0.1 s). The first 0.5 s is skipped (filter start-up). Needs Pa.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Fluctuation strength, ECMA-418-2 ─────────────────────────
export function FluctuationEcmaNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'fluctuationEcma' ? r : undefined;
  return (
    <Shell id={id} title="Fluctuation (ECMA-418-2, Sottek)" accent="#0f766e" input>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>F (90th percentile)</td><td><b>{res.F.toFixed(3)} vacil<sub>HMS</sub></b></td></tr>
              <tr><td>F max</td><td>{res.max.toFixed(3)} vacil<sub>HMS</sub></td></tr>
              <tr><td>Prominent (F &gt; 0.2)</td><td>{res.F > 0.2 ? 'yes' : 'no'}</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="vacil" height={110} series={[{ label: 'F(t)', data: res.Ft, dt: res.dt, color: SERIES[0] }]} />
          <LinePlot yLabel="vacil/Bark" xLabel="Bark" height={110} series={[{ label: 'F′(z), time average', data: res.specific, dt: 0.5, x0: 0.25, color: SERIES[1] }]} />
          <div className="hint">Hearing-model fluctuation strength: 1 kHz, 60 dB, 100 % AM at 4 Hz = 1 vacil (reads 1.00 here). Needs ≥ 2 s of Pa; about 1–2 s of compute per second of audio. The first 0.7 s are excluded from the statistics.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Tonality, ECMA-418-2 ─────────────────────────
export function TonalityEcmaNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'tonalityEcma' ? r : undefined;
  return (
    <Shell id={id} title="Tonality (ECMA-418-2, Sottek)" accent="#7c3aed" input>
      <Field label="Field">
        <select className="nodrag" value={String(d.field)} onChange={(e) => set({ field: e.target.value })}>
          <option value="free">Free</option><option value="diffuse">Diffuse</option>
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>T (mean of T(t) &gt; 0.02)</td><td><b>{res.T.toFixed(3)} tu<sub>HMS</sub></b></td></tr>
              <tr><td>T max</td><td>{res.Tmax.toFixed(3)} tu<sub>HMS</sub></td></tr>
              <tr><td>Prominent (T′ &gt; 0.4)</td><td>{res.prominent.length ? '' : 'none'}</td></tr>
              {res.prominent.slice(0, 5).map((t) => (
                <tr key={t.band}><td>{t.f.toFixed(0)} Hz</td><td>{t.T.toFixed(3)} tu<sub>HMS</sub></td></tr>
              ))}
            </tbody>
          </table>
          <LinePlot yLabel="tu" height={110} series={[{ label: 'T(t)', data: res.Tl, dt: res.dt, color: SERIES[0] }]} />
          <LinePlot yLabel="tu/Bark" xLabel="Bark" height={110} series={[{ label: 'T′(z), average', data: res.specific, dt: 0.5, x0: 0.25, color: SERIES[1] }]} />
          <div className="hint">Hearing-model tonality: 1 kHz, 40 dB tone = 1 tu. Needs ≥ 0.5 s of Pa; slow (≈ 1 s per second of audio). The first 0.3 s are excluded from the statistics.</div>
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

// ───────────────────────── Fluctuation strength ─────────────────────────
export function FluctuationNode({ id }: NodeProps) {
  const r = useGraph().results[id];
  const res = r?.kind === 'fluctuation' ? r : undefined;
  return (
    <Shell id={id} title="Fluctuation strength" accent="#9b6cd6" input>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Mean</td><td>{res.mean.toFixed(3)} vacil</td></tr>
              <tr><td>Max</td><td>{res.max.toFixed(3)} vacil</td></tr>
              <tr><td>Dominant modulation</td><td>{res.fmod.toFixed(1)} Hz</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="vacil" height={110} series={[{ label: 'F(t)', data: res.F, dt: res.dt, x0: res.windowSec / 2, color: SERIES[0] }]} />
          <div className="hint">Simplified Fastl model on {res.windowSec.toFixed(0)} s windows, scaled so 1 kHz / 60 dB / 100 % AM at 4 Hz = 1 vacil. Needs ≥ 1 s of Pa and fs ≥ 32 kHz.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Tonality ─────────────────────────
export function TonalityNode({ id, data }: NodeProps) {
  const d = data as Data;
  const set = useParams(id);
  const r = useGraph().results[id];
  const res = r?.kind === 'tonality' ? r : undefined;
  return (
    <Shell id={id} title="Tonality (Nordic, TNR, PR, Aures)" accent="#1baf7a" input>
      <Field label="FFT size">
        <select className="nodrag" value={Number(d.nfft)} onChange={(e) => set({ nfft: Number(e.target.value) })}>
          {[4096, 8192, 16384, 32768].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>Tonality (Aures), mean / max</td><td>{res.Kmean.toFixed(2)} / {res.Kmax.toFixed(2)} tu</td></tr>
              <tr><td>Max TNR</td><td>{isFinite(res.tnrMax) ? `${res.tnrMax.toFixed(1)} dB @ ${res.fTnr.toFixed(0)} Hz` : 'no tones'}</td></tr>
              <tr><td>Max PR</td><td>{isFinite(res.prMax) ? `${res.prMax.toFixed(1)} dB` : '–'}</td></tr>
              <tr><td>Nordic K<sub>t</sub> (avg spectrum)</td><td><b>{res.kt.toFixed(1)} dB</b></td></tr>
              <tr><td>K<sub>t</sub> per frame, mean / max</td><td>{res.ktMean.toFixed(1)} / {res.ktFrameMax.toFixed(1)} dB</td></tr>
            </tbody>
          </table>
          {res.tones.length > 0 && (
            <table className="results">
              <thead><tr><th>Tone</th><th>Level</th><th>TNR</th><th>PR</th><th>ΔL<sub>ta</sub></th><th>K<sub>t</sub></th><th>Prominent</th></tr></thead>
              <tbody>
                {res.tones.map((t) => (
                  <tr key={t.f}><td>{t.f.toFixed(0)} Hz</td><td>{t.levelDb.toFixed(1)}</td><td>{t.tnr.toFixed(1)}</td><td>{t.pr.toFixed(1)}</td><td>{t.dLta.toFixed(1)}</td><td>{t.kt.toFixed(1)}</td><td>{t.prominent ? 'yes' : 'no'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <LinePlot yLabel="tu" height={110} series={[{ label: 'K(t)', data: res.K, dt: res.dt, x0: res.frameSec / 2, color: SERIES[0] }]} />
          <div className="hint">Tones from the average spectrum ({res.frameSec.toFixed(2)} s frames); prominence limits per ECMA-74 (TNR ≥ 8 dB, PR ≥ 9 dB above 1 kHz). Nordic K_t after Nordtest NT ACOU 112 / ISO 1996-2 Annex D. Aures value is approximate.</div>
        </>
      )}
    </Shell>
  );
}

// ───────────────────────── Impulsiveness ─────────────────────────
export function ImpulsivityNode({ id }: NodeProps) {
  const r = useGraph().results[id];
  const res = r?.kind === 'impulsivity' ? r : undefined;
  return (
    <Shell id={id} title="Impulsiveness (LAI − LAF)" accent="#c48a00" input>
      {res && (
        <>
          <table className="results">
            <tbody>
              <tr><td>L<sub>AF,max</sub></td><td>{res.lafMax.toFixed(1)} dB @ {res.tLaf.toFixed(2)} s</td></tr>
              <tr><td>L<sub>AI,max</sub></td><td>{res.laiMax.toFixed(1)} dB @ {res.tLai.toFixed(2)} s</td></tr>
              <tr><td>L<sub>AI,max</sub> − L<sub>AF,max</sub></td><td><b>{res.diff.toFixed(1)} dB</b></td></tr>
              <tr><td>L<sub>Aeq</sub></td><td>{res.laeq.toFixed(1)} dB</td></tr>
              <tr><td>Peak (unweighted)</td><td>{res.peak.toFixed(1)} dB</td></tr>
              <tr><td>Crest factor</td><td>{res.crest.toFixed(1)} dB</td></tr>
            </tbody>
          </table>
          <LinePlot yLabel="dB(A)" height={120} series={[
            { label: 'LAF', data: res.laf, dt: res.dt, color: SERIES[0] },
            { label: 'LAI', data: res.lai, dt: res.dt, color: SERIES[1] },
          ]} />
          <div className="hint">Applies A-weighting itself — connect the unweighted signal. Fast τ 125 ms; Impulse rise 35 ms, decay 1.5 s.</div>
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
  loudnessTv: LoudnessTvNode,
  roughnessEcma: RoughnessEcmaNode,
  tonalityEcma: TonalityEcmaNode,
  fluctuationEcma: FluctuationEcmaNode,
  loudnessEcma: LoudnessEcmaNode,
  octave: OctaveNode,
  levelStats: LevelStatsNode,
  annoyance: AnnoyanceNode,
  orders: OrdersNode,
  metricRpm: MetricRpmNode,
  binaural: BinauralNode,
  cepstrum: CepstrumNode,
  calibTone: CalibToneNode,
  fluctuation: FluctuationNode,
  tonality: TonalityNode,
  impulsivity: ImpulsivityNode,
};

export const PALETTE: { type: NodeKind; label: string; defaults: Data }[] = [
  { type: 'wavSource', label: 'WAV file', defaults: { channel: 0, fullScale: 1, quantity: 'acceleration', ref: 1e-6 } },
  { type: 'weighting', label: 'Frequency weighting', defaults: { weighting: 'Wb' } },
  { type: 'level', label: 'Fast / Slow max level', defaults: {} },
  { type: 'spectrogram', label: 'Moving FFT', defaults: { nfft: 4096, overlap: 0.5, fMax: 0, uiRange: 60 } },
  { type: 'loudness', label: 'Loudness & sharpness', defaults: { field: 'free', blockSec: 0.1 } },
  { type: 'loudnessTv', label: 'Loudness, time-varying (ISO 532-1)', defaults: { field: 'free' } },
  { type: 'roughnessEcma', label: 'Roughness (ECMA-418-2)', defaults: { field: 'free' } },
  { type: 'tonalityEcma', label: 'Tonality (ECMA-418-2)', defaults: { field: 'free' } },
  { type: 'roughness', label: 'Roughness', defaults: { overlap: 0.5 } },
  { type: 'loudnessEcma', label: 'Loudness (ECMA-418-2)', defaults: { field: 'free' } },
  { type: 'octave', label: 'Octave / third-octave bands', defaults: { fraction: 3 } },
  { type: 'levelStats', label: 'Level statistics (Leq, Lx)', defaults: {} },
  { type: 'annoyance', label: 'Psychoacoustic annoyance', defaults: {} },
  { type: 'binaural', label: 'Binaural analysis', defaults: { metric: 'loudness', field: 'free' } },
  { type: 'calibTone', label: 'Calibration tone', defaults: { level: 1 } },
  { type: 'cepstrum', label: 'Cepstrum', defaults: { frameSec: 1, maxMs: 50, minMs: 1 } },
  { type: 'metricRpm', label: 'Psychoacoustic metric vs RPM', defaults: { metric: 'loudnessTv', field: 'free', mode: 'tacho', ppr: 1, rpm0: 1000, rpm1: 3000 } },
  { type: 'orders', label: 'Order analysis (vs RPM)', defaults: { mode: 'tacho', ppr: 1, rpm0: 1000, rpm1: 3000, orders: '1,2,3,4', frameSec: 0.25 } },
  { type: 'fluctuationEcma', label: 'Fluctuation strength (ECMA-418-2)', defaults: { field: 'free' } },
  { type: 'fluctuation', label: 'Fluctuation strength', defaults: {} },
  { type: 'tonality', label: 'Tonality (Nordic, TNR, PR, Aures)', defaults: { nfft: 16384 } },
  { type: 'impulsivity', label: 'Impulsiveness (LAI − LAF)', defaults: {} },
];
