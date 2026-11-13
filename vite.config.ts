import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/unit/**/*.test.ts'] },
} as any);
