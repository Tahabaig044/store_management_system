import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
    // Opening the offline database (35 tables) in fake-indexeddb plus WebCrypto is slow when the whole suite
    // runs in parallel; a 5 s limit produced timeouts (never wrong results) on loaded machines.
    testTimeout: 20000,
    // The default "forks" pool hangs in some sandboxed local dev environments
    // (process spawning restricted), so fall back to "threads" there. CI
    // (and normal local machines) should use Vitest's default "forks" pool -
    // "threads" hits a jsdom/Node worker_threads incompatibility there
    // (`webidl.util.markAsUncloneable is not a function`) that forks avoids
    // entirely by not using worker_threads' structured-clone messaging.
    pool: process.env.VITEST_SANDBOXED_ENV ? 'threads' : undefined,
  },
});
