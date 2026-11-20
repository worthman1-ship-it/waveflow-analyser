import type { WeightingId } from '../dsp/weighting';
import type { FluctuationResult } from '../dsp/fluctuation';
import type { TonalityResult } from '../dsp/tonality';
import type { ImpulsivityResult } from '../dsp/impulsivity';
import type { LoudnessTvResult } from '../dsp/loudnessTv';
import type { RoughnessEcmaResult } from '../dsp/roughnessEcma';
import type { TonalityEcmaResult } from '../dsp/tonalityEcma';
import type { FluctuationEcmaResult } from '../dsp/fluctuationEcma';
import type { LoudnessEcmaResult } from '../dsp/loudnessEcma';
import type { OctaveResult } from '../dsp/octave';
import type { LevelStatsResult } from '../dsp/levelStats';
import type { OrderResult } from '../dsp/orders';
import type { MetricRpmResult } from '../dsp/metricRpm';
import type { InterauralResult } from '../dsp/binaural';
import type { EventsResult } from '../dsp/events';
import type { CalibToneResult } from '../dsp/calibTone';
import type { CepstrumResult } from '../dsp/cepstrum';

export type Quantity = 'acceleration' | 'velocity' | 'displacement' | 'pressure' | 'other';

export const QUANTITIES: Record<Quantity, { unit: string; ref: number; label: string }> = {
  acceleration: { unit: 'm/s²', ref: 1e-6, label: 'Acceleration' },
  velocity: { unit: 'm/s', ref: 1e-9, label: 'Velocity' },
  displacement: { unit: 'm', ref: 1e-12, label: 'Displacement' },
  pressure: { unit: 'Pa', ref: 2e-5, label: 'Sound pressure' },
  other: { unit: 'FS', ref: 1, label: 'Other (full scale)' },
};

export interface WavParams { fileId?: string; fileName?: string; channel: number; fullScale: number; quantity: Quantity; ref: number; tachoChannel?: number; rightChannel?: number }
export interface WeightingParams { weighting: WeightingId }
export interface LevelParams { [k: string]: never }
export interface SpectrogramParams { nfft: number; overlap: number; range: number }
export interface LoudnessParams { field: 'free' | 'diffuse'; blockSec: number }
export interface RoughnessParams { overlap: number }

export type NodeKind = 'wavSource' | 'weighting' | 'level' | 'spectrogram' | 'loudness' | 'roughness' | 'fluctuation' | 'tonality' | 'impulsivity' | 'loudnessTv' | 'roughnessEcma' | 'tonalityEcma' | 'fluctuationEcma' | 'loudnessEcma' | 'octave' | 'levelStats' | 'annoyance' | 'orders' | 'metricRpm' | 'binaural' | 'cepstrum' | 'calibTone' | 'events';

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
  /** Raw tacho channel of the same file (for order analysis), if one was selected. */
  tacho?: Float64Array;
  /** Right ear channel of a binaural pair (the signal itself is the left ear), calibrated like `data`. */
  right?: Float64Array;
  /** Physical value of digital full scale used to calibrate the source (for the calibration-tone node). */
  fullScale?: number;
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
export type FluctuationResultMsg = FluctuationResult & { kind: 'fluctuation'; label: string };
export type TonalityResultMsg = TonalityResult & { kind: 'tonality'; label: string };
export type ImpulsivityResultMsg = ImpulsivityResult & { kind: 'impulsivity'; label: string };
export type LoudnessTvResultMsg = LoudnessTvResult & { kind: 'loudnessTv'; label: string; field: string };
export type RoughnessEcmaResultMsg = RoughnessEcmaResult & { kind: 'roughnessEcma'; label: string; field: string };
export type TonalityEcmaResultMsg = TonalityEcmaResult & { kind: 'tonalityEcma'; label: string; field: string };
export type FluctuationEcmaResultMsg = FluctuationEcmaResult & { kind: 'fluctuationEcma'; label: string; field: string };
export type LoudnessEcmaResultMsg = LoudnessEcmaResult & { kind: 'loudnessEcma'; label: string; field: string };
export type OctaveResultMsg = OctaveResult & { kind: 'octave'; label: string; unit: string; ref: number };
export type LevelStatsResultMsg = LevelStatsResult & { kind: 'levelStats'; label: string; unit: string; ref: number; weighting: string };
export interface AnnoyanceResultMsg {
  kind: 'annoyance'; label: string; PA: number; N5: number; S5: number; R5: number; F5: number; wS: number; wFR: number;
}
export type OrdersResultMsg = OrderResult & { kind: 'orders'; label: string; unit: string; mode: string };
export type MetricRpmResultMsg = MetricRpmResult & { kind: 'metricRpm'; label: string; metric: string; unit: string };
export type BinauralResultMsg = InterauralResult & {
  kind: 'binaural'; label: string; unit: string; field: string;
  /** The metric analysed per ear and its unit; the binaural entries are null for tonality (not defined by the standard). */
  metric: string; metricUnit: string;
  vL: number; vR: number; vB: number | null;
  tL: Float32Array; tR: Float32Array; tB: Float32Array | null; dtM: number;
};
export type CepstrumResultMsg = CepstrumResult & { kind: 'cepstrum'; label: string };
export type CalibToneResultMsg = CalibToneResult & { kind: 'calibTone'; label: string; unit: string; level: number; fullScale: number; suggested: number };
export type EventsResultMsg = EventsResult & { kind: 'events'; label: string };
export interface SourceResult {
  kind: 'source'; fs: number; channels: number; duration: number; bits: number; format: string; peak: number;
}
export type NodeResult = LevelResult | SpectrogramResult | LoudnessResult | RoughnessResultMsg | FluctuationResultMsg | TonalityResultMsg | ImpulsivityResultMsg | LoudnessTvResultMsg | RoughnessEcmaResultMsg | TonalityEcmaResultMsg | FluctuationEcmaResultMsg | LoudnessEcmaResultMsg | OctaveResultMsg | LevelStatsResultMsg | AnnoyanceResultMsg | OrdersResultMsg | MetricRpmResultMsg | BinauralResultMsg | CepstrumResultMsg | CalibToneResultMsg | EventsResultMsg | SourceResult;

export type WorkerIn =
  | { type: 'file'; fileId: string; buffer: ArrayBuffer }
  | { type: 'dropFile'; fileId: string }
  | { type: 'run'; nodes: NodeSpec[]; edges: EdgeSpec[] };

export type WorkerOut =
  | { type: 'status'; nodeId: string; text: string }
  | { type: 'result'; nodeId: string; result: NodeResult }
  | { type: 'error'; nodeId: string; message: string }
  | { type: 'done' };
