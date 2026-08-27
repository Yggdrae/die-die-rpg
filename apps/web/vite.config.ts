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
      manifest: {
        name: 'RPG Companion',
        short_name: 'RPG',
        description: 'Campaign, rules and session operating system for tabletop RPGs.',
        theme_color: '#101014',
        background_color: '#101014',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
    }),
  ],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
  },
});
