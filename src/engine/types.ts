import type { WeightingId } from '../dsp/weighting';

export type Quantity = 'acceleration' | 'velocity' | 'displacement' | 'pressure' | 'other';

export const QUANTITIES: Record<Quantity, { unit: string; ref: number; label: string }> = {
  acceleration: { unit: 'm/s²', ref: 1e-6, label: 'Acceleration' },
  velocity: { unit: 'm/s', ref: 1e-9, label: 'Velocity' },
  displacement: { unit: 'm', ref: 1e-12, label: 'Displacement' },
  pressure: { unit: 'Pa', ref: 2e-5, label: 'Sound pressure' },
  other: { unit: 'FS', ref: 1, label: 'Other (full scale)' },
};

export interface WavParams { fileId?: string; fileName?: string; channel: number; fullScale: number; quantity: Quantity; ref: number }
export interface WeightingParams { weighting: WeightingId }
export interface LevelParams { [k: string]: never }
export interface SpectrogramParams { nfft: number; overlap: number; range: number }
export interface LoudnessParams { field: 'free' | 'diffuse'; blockSec: number }
export interface RoughnessParams { overlap: number }

export type NodeKind = 'wavSource' | 'weighting' | 'level' | 'spectrogram' | 'loudness' | 'roughness';

export interface NodeSpec { id: string; type: NodeKind; params: Record<string, unknown> }
export interface EdgeSpec { source: string; target: string }

/** A calibrated signal flowing along an edge. */
export interface Signal {
  fs: number;
  data: Float64Array;
  quantity: Quantity;
  unit: string;
  ref: number;
  /** Human-readable processing chain, e.g. "pile.wav ch1 → Wb". */
  label: string;
  weighting: WeightingId;
}

export interface LevelResult {
  kind: 'level';
  label: string; unit: string; ref: number; weighting: string; quantity: Quantity;
  fastMax: number; slowMax: number; tFastMax: number; tSlowMax: number;
  rms: number; vdv?: number; duration: number;
  fast: Float32Array; slow: Float32Array; dt: number;
}
export interface SpectrogramResult {
  kind: 'spectrogram';
  label: string; unit: string;
  db: Float32Array; frames: number; bins: number; dt: number; df: number;
  avgDb: Float32Array; avgDf: number; maxDb: number; range: number;
}
export interface LoudnessResult {
  kind: 'loudness';
  label: string; field: string;
  N: number; S: number; Nmax: number; N5: number; Smean: number;
  Nt: Float32Array; St: Float32Array; dt: number; ns: Float32Array;
}
export interface RoughnessResultMsg {
  kind: 'roughness';
  label: string; R: Float32Array; dt: number; frameSec: number; mean: number; max: number;
}
export interface SourceResult {
  kind: 'source'; fs: number; channels: number; duration: number; bits: number; format: string; peak: number;
}
export type NodeResult = LevelResult | SpectrogramResult | LoudnessResult | RoughnessResultMsg | SourceResult;

export type WorkerIn =
  | { type: 'file'; fileId: string; buffer: ArrayBuffer }
  | { type: 'dropFile'; fileId: string }
  | { type: 'run'; nodes: NodeSpec[]; edges: EdgeSpec[] };

export type WorkerOut =
  | { type: 'status'; nodeId: string; text: string }
  | { type: 'result'; nodeId: string; result: NodeResult }
  | { type: 'error'; nodeId: string; message: string }
  | { type: 'done' };
