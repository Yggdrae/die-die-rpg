import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * PWA shell only.
 *
 * The application must be installable because a session runs where the network does not
 * (`PRD.md` s.5.3, s.76). The local database that makes offline real is feature 03; this
 * config only establishes that the app installs and serves its own assets.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['sync-assets/**/*.js', 'icons/*.png'],
      workbox: { maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 },
      manifest: {
        name: 'RPG Companion',
        short_name: 'RPG',
        description: 'Campaign, rules and session operating system for tabletop RPGs.',
        theme_color: '#101014',
        background_color: '#101014',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  // Playwright harnesses load by dynamic import; pre-bundle their deps so a cold dev server does
  // not re-optimize and reload pages mid-test.
  optimizeDeps: { entries: ['index.html', 'src/**/*e2e-harness.{ts,tsx}'] },
  // The PowerSync web client references its own worker modules; the app passes the pinned copied
  // workers explicitly, but the bundler still has to emit ES (code-split) worker chunks.
  worker: { format: 'es' },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
