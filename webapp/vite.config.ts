import { defineConfig, type Plugin, type UserConfig } from 'vite';
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

// index.html carries a CSP meta tag for local mode (public/_headers applies on
// Cloudflare Pages only). `vite dev` needs two more sources than the built app:
// the inline React Refresh preamble and the HMR websocket. This plugin adds
// them for the dev server only, so the build keeps the strict policy.
function devCsp(): Plugin {
  const SCRIPT = "script-src 'self'";
  const CONNECT = "connect-src 'self'";
  return {
    name: 'trove-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!html.includes(SCRIPT) || !html.includes(CONNECT)) {
        throw new Error('trove-dev-csp: the CSP meta tag in index.html changed shape');
      }
      return html
        .replace(SCRIPT, `${SCRIPT} 'unsafe-inline'`)
        .replace(CONNECT, `${CONNECT} ws://127.0.0.1:5174 ws://localhost:5174`);
    },
  };
}

export default defineConfig({
  plugins: [react(), devCsp()],
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
