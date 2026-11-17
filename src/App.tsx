import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, useReactFlow,
  type Connection, type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes, PALETTE } from './nodes/nodes';
import { GraphContext, type GraphState } from './ui/context';
import { parseWav } from './dsp/wav';
import type { NodeKind, NodeResult, NodeSpec, WorkerIn, WorkerOut } from './engine/types';

const defaults = (t: NodeKind) => ({ ...PALETTE.find((p) => p.type === t)!.defaults });

const INITIAL_NODES: Node[] = [
  { id: 'src1', type: 'wavSource', position: { x: 20, y: 60 }, data: defaults('wavSource') },
  { id: 'w1', type: 'weighting', position: { x: 340, y: 60 }, data: defaults('weighting') },
  { id: 'lvl1', type: 'level', position: { x: 700, y: 40 }, data: defaults('level') },
];
const INITIAL_EDGES: Edge[] = [
  { id: 'e1', source: 'src1', target: 'w1' },
  { id: 'e2', source: 'w1', target: 'lvl1' },
];

/** Parameters sent to the worker: drop display-only keys (ui*) and the WAV info blob. */
function toSpec(n: Node): NodeSpec {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.data)) if (!k.startsWith('ui') && k !== 'info') params[k] = v;
  return { id: n.id, type: n.type as NodeKind, params };
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const { updateNodeData, screenToFlowPosition } = useReactFlow();
  const [results, setResults] = useState<Record<string, NodeResult | undefined>>({});
  const [status, setStatus] = useState<Record<string, string | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(0);
  const [autoRun, setAutoRun] = useState(true);
  const worker = useRef<Worker | null>(null);
  const counter = useRef(1);

  useEffect(() => {
    const w = new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'status') setStatus((s) => ({ ...s, [m.nodeId]: m.text }));
      else if (m.type === 'result') {
        setResults((r) => ({ ...r, [m.nodeId]: m.result }));
        setStatus((s) => ({ ...s, [m.nodeId]: undefined }));
        setErrors((s) => ({ ...s, [m.nodeId]: undefined }));
      } else if (m.type === 'error') {
        setErrors((s) => ({ ...s, [m.nodeId]: m.message }));
        setStatus((s) => ({ ...s, [m.nodeId]: undefined }));
        setResults((r) => ({ ...r, [m.nodeId]: undefined }));
      } else if (m.type === 'done') setBusy((b) => b - 1);
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  const post = (m: WorkerIn, transfer: Transferable[] = []) => worker.current?.postMessage(m, transfer);

  // Graph signature excluding positions and display-only keys: re-run only when it changes.
  const specKey = JSON.stringify([
    nodes.map(toSpec),
    edges.map((e) => [e.source, e.target]),
  ]);

  const run = useCallback(() => {
    const specs = nodes.map(toSpec);
    setBusy((b) => b + 1);
    post({ type: 'run', nodes: specs, edges: edges.map((e) => ({ source: e.source, target: e.target })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);

  useEffect(() => {
    if (!autoRun) return;
    const t = setTimeout(run, 250);
    return () => clearTimeout(t);
  }, [run, autoRun]);

  const loadFile = useCallback((nodeId: string, file: File) => {
    file.arrayBuffer().then((buf) => {
      try {
        const w = parseWav(buf);
        const fileId = `${file.name}:${crypto.randomUUID()}`;
        const old = nodes.find((n) => n.id === nodeId)?.data.fileId as string | undefined;
        if (old) post({ type: 'dropFile', fileId: old });
        post({ type: 'file', fileId, buffer: buf }, [buf]);
        setErrors((s) => ({ ...s, [nodeId]: undefined }));
        updateNodeData(nodeId, {
          fileId, fileName: file.name, channel: 0,
          info: { fs: w.fs, channels: w.channels.length, duration: (w.channels[0]?.length ?? 0) / w.fs, bits: w.bitsPerSample, format: w.format },
        });
      } catch (e) {
        setErrors((s) => ({ ...s, [nodeId]: e instanceof Error ? e.message : String(e) }));
      }
    });
  }, [nodes, updateNodeData]);

  const onConnect = useCallback((c: Connection) => {
    // One input per node: a new connection replaces the old one.
    setEdges((es) => addEdge({ ...c, id: `e${Date.now()}` }, es.filter((e) => e.target !== c.target)));
  }, [setEdges]);

  const addNode = (type: NodeKind) => {
    const id = `${type}${++counter.current}`;
    setNodes((ns) => {
      // Columns by role (sources | weightings | analyses); drop below whatever is already in that column.
      const x = type === 'wavSource' ? 20 : type === 'weighting' ? 340 : 700;
      const inCol = ns.filter((n) => Math.abs(n.position.x - x) < 150);
      // Reserve the height a node reaches once its results are shown, so it won't overlap later.
      const fullHeight: Record<string, number> = { level: 400, spectrogram: 560, loudness: 500, roughness: 320 };
      const y = inCol.reduce((m, n) =>
        Math.max(m, n.position.y + Math.max(n.measured?.height ?? 150, fullHeight[n.type ?? ''] ?? 0) + 30), 40);
      const position = ns.length ? { x, y } : screenToFlowPosition({ x: 300, y: 100 });
      return [...ns, { id, type, position, data: defaults(type) }];
    });
  };

  const ctx: GraphState = useMemo(() => ({ results, status, errors, loadFile }), [results, status, errors, loadFile]);

  return (
    <GraphContext.Provider value={ctx}>
      <div className="app">
        <aside className="palette">
          <h1>WaveFlow</h1>
          <p className="muted">Add nodes, wire them left → right. Select a node or edge and press Delete to remove it.</p>
          {PALETTE.map((p) => (
            <button key={p.type} onClick={() => addNode(p.type)}>+ {p.label}</button>
          ))}
          <hr />
          <label className="check"><input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} /> Auto-run on change</label>
          <button className="primary" onClick={run}>Run</button>
          <div className="muted">{busy > 0 ? 'Computing…' : 'Idle'}</div>
        </aside>
        <main>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            fitView minZoom={0.2} deleteKeyCode={['Delete', 'Backspace']}
          >
            <Background gap={20} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </main>
      </div>
    </GraphContext.Provider>
  );
}
