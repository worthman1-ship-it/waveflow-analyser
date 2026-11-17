// Small canvas charts for use inside flow nodes: a multi-series line plot with a hover
// crosshair readout, and a spectrogram heatmap (single-hue sequential ramp) with a cell readout.
import { useEffect, useRef, useState } from 'react';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a']; // categorical slots 1–3 (validated order)
const INK = '#52514e', GRID = '#e6e5e0', SURFACE = '#fcfcfb';
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

export interface Series { label: string; data: ArrayLike<number>; dt: number; color: string; x0?: number }

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(+v.toPrecision(12));
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : String(+v.toPrecision(4)));

function setupCanvas(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

const PAD = { l: 44, r: 8, t: 8, b: 24 };

export function LinePlot({ series, width = 300, height = 150, xLabel = 's', yLabel, yMin, yMax }: {
  series: Series[]; width?: number; height?: number; xLabel?: string; yLabel: string; yMin?: number; yMax?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  let lo = Infinity, hi = -Infinity, xMax = 0;
  for (const s of series) {
    for (let i = 0; i < s.data.length; i++) { const v = s.data[i]; if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    xMax = Math.max(xMax, (s.x0 ?? 0) + s.data.length * s.dt);
  }
  if (yMin !== undefined) lo = yMin;
  if (yMax !== undefined) hi = yMax;
  if (hi - lo < 1e-12) { hi = lo + 1; }
  const pw = width - PAD.l - PAD.r, ph = height - PAD.t - PAD.b;
  const X = (t: number) => PAD.l + (t / (xMax || 1)) * pw;
  const Y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * ph;

  useEffect(() => {
    const g = setupCanvas(ref.current!, width, height);
    g.fillStyle = SURFACE; g.fillRect(0, 0, width, height);
    g.font = '10px system-ui'; g.fillStyle = INK; g.strokeStyle = GRID; g.lineWidth = 1;
    for (const v of niceTicks(lo, hi)) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(width - PAD.r, y); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(fmt(v), PAD.l - 4, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const t of niceTicks(0, xMax, 5)) g.fillText(fmt(t), X(t), height - PAD.b + 4);
    g.save(); g.translate(10, PAD.t + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText(yLabel, 0, 0); g.restore();
    g.textAlign = 'right'; g.fillText(xLabel, width - PAD.r, height - 11);

    g.save(); g.beginPath(); g.rect(PAD.l, PAD.t, pw, ph); g.clip();
    for (const s of series) {
      g.strokeStyle = s.color; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
      let pen = false;
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        if (!isFinite(v)) { pen = false; continue; }
        const x = X((s.x0 ?? 0) + (i + 0.5) * s.dt), y = Y(v);
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      }
      g.stroke();
    }
    g.restore();
    if (hover !== null) {
      g.strokeStyle = INK; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(hover), PAD.t); g.lineTo(X(hover), PAD.t + ph); g.stroke(); g.setLineDash([]);
    }
  });

  const readout = hover === null ? null : series.map((s) => {
    const i = Math.floor((hover - (s.x0 ?? 0)) / s.dt);
    return i >= 0 && i < s.data.length ? `${s.label} ${fmt(s.data[i])}` : null;
  }).filter(Boolean).join(' · ');

  return (
    <div className="plot nodrag">
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <canvas
        ref={ref}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = ((e.clientX - r.left - PAD.l) / pw) * xMax;
          setHover(t >= 0 && t <= xMax ? t : null);
        }}
        onMouseLeave={() => setHover(null)}
      />
      <div className="readout">{readout ? `${fmt(hover!)} ${xLabel}: ${readout}` : ' '}</div>
    </div>
  );
}

function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  const ch = (h: string, k: number) => parseInt(h.slice(1 + 2 * k, 3 + 2 * k), 16);
  return [0, 1, 2].map((k) => Math.round(ch(a, k) + (ch(b, k) - ch(a, k)) * f)) as [number, number, number];
}

export function Heatmap({ db, frames, bins, dt, df, top, range, unitLabel, width = 360, height = 200 }: {
  db: Float32Array; frames: number; bins: number; dt: number; df: number; top: number; range: number; unitLabel: string;
  width?: number; height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ f: number; b: number } | null>(null);
  const pw = width - PAD.l - PAD.r, ph = height - PAD.t - PAD.b;
  const tMax = frames * dt, fMax = bins * df;

  useEffect(() => {
    const g = setupCanvas(ref.current!, width, height);
    g.fillStyle = SURFACE; g.fillRect(0, 0, width, height);
    const img = new ImageData(frames, bins);
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        const [r, gg, bb] = rampColor((db[f * bins + b] - (top - range)) / range);
        const p = ((bins - 1 - b) * frames + f) * 4;
        img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = bb; img.data[p + 3] = 255;
      }
    }
    const off = document.createElement('canvas');
    off.width = frames; off.height = bins;
    off.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(off, PAD.l, PAD.t, pw, ph);
    g.font = '10px system-ui'; g.fillStyle = INK;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of niceTicks(0, fMax)) g.fillText(fmt(v), PAD.l - 4, PAD.t + (1 - v / fMax) * ph);
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const t of niceTicks(0, tMax, 5)) g.fillText(fmt(t), PAD.l + (t / tMax) * pw, height - PAD.b + 4);
    g.save(); g.translate(10, PAD.t + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText('Hz', 0, 0); g.restore();
    g.textAlign = 'right'; g.fillText('s', width - PAD.r, height - 11);
  }, [db, frames, bins, dt, df, top, range, width, height, pw, ph, fMax, tMax]);

  return (
    <div className="plot nodrag">
      <canvas
        ref={ref}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = Math.floor(((e.clientX - r.left - PAD.l) / pw) * frames);
          const b = Math.floor((1 - (e.clientY - r.top - PAD.t) / ph) * bins);
          setHover(f >= 0 && f < frames && b >= 0 && b < bins ? { f, b } : null);
        }}
        onMouseLeave={() => setHover(null)}
      />
      <div className="colorbar">
        <span>{fmt(top - range)}</span>
        <i style={{ background: `linear-gradient(90deg, ${RAMP.join(',')})` }} />
        <span>{fmt(top)} {unitLabel}</span>
      </div>
      <div className="readout">
        {hover ? `${fmt(hover.f * dt)} s, ${fmt(hover.b * df)} Hz: ${db[hover.f * bins + hover.b].toFixed(1)} ${unitLabel}` : ' '}
      </div>
    </div>
  );
}
