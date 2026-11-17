/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5193, strictPort: true },
  worker: { format: 'es' },
  test: { environment: 'node' },
});
