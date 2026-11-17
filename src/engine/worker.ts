import { GraphRunner } from './run';
import type { WorkerIn, WorkerOut } from './types';

const runner = new GraphRunner();
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'file') runner.addFile(m.fileId, m.buffer);
  else if (m.type === 'dropFile') runner.dropFile(m.fileId);
  else if (m.type === 'run') runner.run(m.nodes, m.edges, post);
};
