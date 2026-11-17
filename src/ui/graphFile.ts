// Graph persistence: JSON save/open files and a browser autosave.
// WAV data is not stored — only the file name, so the WAV node can ask for it again.
import type { Edge, Node } from '@xyflow/react';
import { PALETTE } from '../nodes/nodes';

const FORMAT = 'waveflow-graph';
const AUTOSAVE_KEY = 'waveflow.graph';
const KINDS = new Set<string>(PALETTE.map((p) => p.type));

export interface GraphFile {
  format: typeof FORMAT;
  version: 1;
  nodes: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string }[];
}

export function serializeGraph(nodes: Node[], edges: Edge[]): GraphFile {
  return {
    format: FORMAT,
    version: 1,
    nodes: nodes.map((n) => {
      // fileId/info describe a WAV loaded in this browser session only.
      const { fileId: _f, info: _i, ...data } = n.data;
      return { id: n.id, type: n.type!, position: { x: n.position.x, y: n.position.y }, data };
    }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/** Parse and validate a graph file; throws with a readable message if it isn't one. */
export function parseGraph(text: string): { nodes: Node[]; edges: Edge[] } {
  let g: GraphFile;
  try { g = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  if (g?.format !== FORMAT || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    throw new Error('Not a WaveFlow graph file');
  }
  const nodes: Node[] = g.nodes
    .filter((n) => KINDS.has(n.type))
    .map((n) => ({
      id: String(n.id),
      type: n.type,
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
      // Defaults first, so graphs saved before a parameter existed still get a value for it.
      data: { ...PALETTE.find((p) => p.type === n.type)!.defaults, ...n.data },
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = g.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ id: String(e.id), source: e.source, target: e.target }));
  return { nodes, edges };
}

export function loadAutosave(): { nodes: Node[]; edges: Edge[] } | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? parseGraph(text) : null;
  } catch {
    return null;
  }
}

export function writeAutosave(nodes: Node[], edges: Edge[]) {
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeGraph(nodes, edges))); } catch { /* storage full/blocked */ }
}

export function downloadGraph(nodes: Node[], edges: Edge[], name = 'waveflow-graph.json') {
  const blob = new Blob([JSON.stringify(serializeGraph(nodes, edges), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
