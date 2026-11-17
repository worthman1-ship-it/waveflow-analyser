import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { parseGraph, serializeGraph } from './graphFile';

describe('graph file', () => {
  const nodes: Node[] = [
    { id: 'a', type: 'wavSource', position: { x: 1, y: 2 },
      data: { channel: 1, fullScale: 9.81, quantity: 'acceleration', ref: 1e-6, fileName: 'x.wav', fileId: 'x.wav:123', info: { fs: 1 } } },
    { id: 'b', type: 'spectrogram', position: { x: 3, y: 4 }, data: { nfft: 1024, overlap: 0.75, uiRange: 80 } },
  ];
  const edges: Edge[] = [{ id: 'e', source: 'a', target: 'b' }];

  it('round-trips settings and drops session-only WAV data', () => {
    const g = parseGraph(JSON.stringify(serializeGraph(nodes, edges)));
    expect(g.edges).toEqual(edges);
    expect(g.nodes[0].position).toEqual({ x: 1, y: 2 });
    expect(g.nodes[0].data).toMatchObject({ channel: 1, fullScale: 9.81, fileName: 'x.wav' });
    expect(g.nodes[0].data.fileId).toBeUndefined();
    expect(g.nodes[0].data.info).toBeUndefined();
    // Saved values win; parameters missing from an older file get defaults.
    expect(g.nodes[1].data).toMatchObject({ nfft: 1024, overlap: 0.75, uiRange: 80, fMax: 0 });
  });

  it('rejects other JSON and drops dangling edges and unknown node types', () => {
    expect(() => parseGraph('{"a":1}')).toThrow('Not a WaveFlow graph file');
    expect(() => parseGraph('nope')).toThrow('Not a JSON file');
    const g = parseGraph(JSON.stringify({
      format: 'waveflow-graph', version: 1,
      nodes: [{ id: 'a', type: 'level', position: { x: 0, y: 0 }, data: {} }, { id: 'z', type: 'bogus', position: { x: 0, y: 0 }, data: {} }],
      edges: [{ id: 'e', source: 'z', target: 'a' }],
    }));
    expect(g.nodes.map((n) => n.id)).toEqual(['a']);
    expect(g.edges).toEqual([]);
  });
});
