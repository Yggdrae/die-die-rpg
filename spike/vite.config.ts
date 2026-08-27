import { defineConfig } from 'vite';

/**
 * Throwaway. Deleted at the freeze tag (task 11).
 *
 * Two things here are not decoration:
 *
 * 1. OPFS SyncAccessHandle requires cross-origin isolation, so without the COOP/COEP
 *    headers the OPFS VFS is unavailable and the spike reports a false negative.
 * 2. Everything is proxied to same-origin. Docker runs inside WSL on this machine and
 *    Chromium cannot reach the WSL VM address (curl can; the browser gets
 *    ERR_CONNECTION_TIMED_OUT, with no proxy configured — a firewall profile on the WSL
 *    adapter). Proxying through Vite sidesteps that, and CORS, and COEP on cross-origin
 *    subresources, all at once.
 */

const WSL = process.env.SPIKE_WSL_HOST ?? '127.0.0.1';

export default defineConfig({
  server: {
    port: 5199,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': {
        target: `http://${WSL}:3099`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/powersync': {
        target: `http://${WSL}:8080`,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/powersync/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', '@powersync/web', '@journeyapps/wa-sqlite'],
  },
});
