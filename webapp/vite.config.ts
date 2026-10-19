import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// sql.js ships its WASM as an asset that must be served alongside the JS.
// A postinstall script copies it into public/; the DB loader points sql.js's
// locateFile() at /sql-wasm.wasm.
//
// The `test` block below is consumed by Vitest. Vitest ships its own vite
// dependency; reading the config through `vitest/config` triggers a
// duplicated-plugin-type error against our top-level vite. We keep vite's
// defineConfig and widen the type for `test`.
type ViteConfigWithTest = UserConfig & { test: Record<string, unknown> };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    // Never ship sourcemaps to production; `vite dev` serves its own.
    sourcemap: false,
  },
  optimizeDeps: {
    include: ['sql.js'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
} as ViteConfigWithTest);
