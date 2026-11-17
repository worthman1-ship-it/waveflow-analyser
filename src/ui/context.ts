import { createContext, useContext } from 'react';
import type { NodeResult } from '../engine/types';

export interface GraphState {
  results: Record<string, NodeResult | undefined>;
  status: Record<string, string | undefined>;
  errors: Record<string, string | undefined>;
  loadFile: (nodeId: string, file: File) => void;
}

export const GraphContext = createContext<GraphState>({
  results: {}, status: {}, errors: {}, loadFile: () => {},
});

export const useGraph = () => useContext(GraphContext);
