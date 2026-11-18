// Audio playback of the WAV behind a source node (Web Audio). Clips live on the main thread only.
interface Clip { fs: number; channels: Float64Array[] }
const clips = new Map<string, Clip>();
let ctx: AudioContext | null = null;
let current: { nodeId: string; src: AudioBufferSourceNode; started: number; duration: number } | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((f) => f());
/** Subscribe to play/stop changes (for useSyncExternalStore). */
export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const playingNode = () => current?.nodeId ?? null;

export function setClip(nodeId: string, clip: Clip | undefined) {
  if (current?.nodeId === nodeId) stop();
  if (clip) clips.set(nodeId, clip); else clips.delete(nodeId);
  notify();
}
export const hasClip = (nodeId: string) => clips.has(nodeId);

export function stop() {
  if (!current) return;
  const { src } = current;
  current = null;
  src.onended = null;
  try { src.stop(); } catch { /* already stopped */ }
  notify();
}

/** Play one channel of the node's WAV at its own sample rate. */
export function play(nodeId: string, channel: number, gain = 1) {
  const clip = clips.get(nodeId);
  if (!clip) return;
  stop();
  ctx ??= new AudioContext();
  void ctx.resume();
  const data = clip.channels[Math.min(channel, clip.channels.length - 1)];
  const buf = ctx.createBuffer(1, data.length, clip.fs);
  buf.copyToChannel(Float32Array.from(data), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.onended = () => { if (current?.src === src) { current = null; notify(); } };
  src.start();
  current = { nodeId, src, started: ctx.currentTime, duration: buf.duration };
  notify();
}
