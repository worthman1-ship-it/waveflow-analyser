// Audio playback of the WAV behind a source node (Web Audio). Clips live on the main thread only.
interface Clip { fs: number; channels: Float64Array[] }
const clips = new Map<string, Clip>();
const buffers = new Map<string, AudioBuffer>();
/** Where each node's playback stopped (s); play() resumes from here. */
const positions = new Map<string, number>();
let ctx: AudioContext | null = null;
let current: { nodeId: string; src: AudioBufferSourceNode; started: number; offset: number; duration: number } | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((f) => f());
/** Subscribe to play/stop changes (for useSyncExternalStore). */
export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const playingNode = () => current?.nodeId ?? null;

/** Current playback position (s): live while playing, otherwise where it stopped (0 at the start or after the end). */
export function position(nodeId: string): number {
  if (current?.nodeId === nodeId && ctx) return Math.min(current.duration, current.offset + ctx.currentTime - current.started);
  return positions.get(nodeId) ?? 0;
}

export function setClip(nodeId: string, clip: Clip | undefined) {
  if (current?.nodeId === nodeId) stop();
  positions.delete(nodeId);
  for (const k of [...buffers.keys()]) if (k.startsWith(`${nodeId}:`)) buffers.delete(k);
  if (clip) clips.set(nodeId, clip); else clips.delete(nodeId);
  notify();
}
export const hasClip = (nodeId: string) => clips.has(nodeId);

export function stop() {
  if (!current) return;
  const { src, nodeId } = current;
  positions.set(nodeId, position(nodeId));
  current = null;
  src.onended = null;
  try { src.stop(); } catch { /* already stopped */ }
  notify();
}

/** Play one channel of the node's WAV at its own sample rate, from `from` seconds (default: where it last stopped). */
export function play(nodeId: string, channel: number, gain = 1, from?: number) {
  const clip = clips.get(nodeId);
  if (!clip) return;
  const start = from ?? positions.get(nodeId) ?? 0;
  stop();
  ctx ??= new AudioContext();
  void ctx.resume();
  const ch = Math.min(channel, clip.channels.length - 1), key = `${nodeId}:${ch}`;
  let buf = buffers.get(key);
  if (!buf) {
    buf = ctx.createBuffer(1, clip.channels[ch].length, clip.fs);
    buf.copyToChannel(Float32Array.from(clip.channels[ch]), 0);
    buffers.set(key, buf);
  }
  const off = Math.max(0, Math.min(start, Math.max(0, buf.duration - 0.01)));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.onended = () => { if (current?.src === src) { current = null; positions.set(nodeId, 0); notify(); } };
  src.start(0, off);
  current = { nodeId, src, started: ctx.currentTime, offset: off, duration: buf.duration };
  notify();
}

/** Jump to `t` seconds: restarts playback there if playing, otherwise sets where Play will begin. */
export function seek(nodeId: string, channel: number, gain: number, t: number) {
  if (current?.nodeId === nodeId) play(nodeId, channel, gain, t);
  else { positions.set(nodeId, Math.max(0, t)); notify(); }
}
