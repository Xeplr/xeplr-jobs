import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// EVERY API PREFIX THIS APP CALLS.
//
// A path missing from this list does NOT fail loudly — Vite falls through to
// the SPA and serves index.html, so the fetch succeeds and the JSON parse is
// what breaks: `Unexpected token '<'`. Worse for a GET that feeds a list: the
// page renders EMPTY rather than erroring, which reads as "no jobs yet".
// (xeplr-bi lost an afternoon to exactly this with /warehouse and /cubes.)
const API_PATHS = [
  '/me',
  '/companies',
  '/workspaces',
  '/jobs',
  '/job-occurrences',
  '/actions'
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const API_URL = env.API_URL || 'http://localhost:19003';
  const AUTH_URL = env.AUTH_URL || API_URL;

  const proxy = { '/auth/api': AUTH_URL };
  API_PATHS.forEach((p) => { proxy[p] = API_URL; });

  return {
    plugins: [react()],
    // React must resolve to ONE copy. A host linking this package with file:
    // gets two otherwise — this package's and its own — and hooks throw
    // "invalid hook call" from a component that is perfectly correct.
    resolve: {
      dedupe: ['react', 'react-dom', 'react-router-dom']
    },
    server: {
      port: Number(env.UI_PORT || 19004),
      proxy
    }
  };
});
