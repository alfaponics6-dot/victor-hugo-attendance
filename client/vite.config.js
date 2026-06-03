import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest mode: we ship our own SW source (src/sw.js) so we
      // can add a `sync` event handler for true Background Sync (drains
      // queued writes even when the tab is closed, on browsers that
      // support SyncManager — Android Chrome/Edge; iOS Safari does not).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      // 'prompt' (not 'autoUpdate'): a freshly installed SW does NOT take over
      // automatically. UpdatePrompt surfaces a dismissable banner and the user
      // taps to reload — this avoids the auto-reload-on-controllerchange glitch
      // documented in main.jsx and never interrupts in-progress attendance
      // marking. Registration is handled by useRegisterSW (virtual:pwa-
      // register/react) in UpdatePrompt, so disable the auto-injected script.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: [
        'Logo-Universidad-EARTH_academico-300x257.png',
        'login-bg.jpg',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
      ],
      manifest: {
        name: 'Asistencia EF 2026',
        short_name: 'Asistencia',
        description: 'Plataforma de Asistencia Digital — Escenario Forestal 2026',
        theme_color: '#0a0a0a',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'es',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Maskable variant has extra padding so OS-level icon shape
          // cropping (Android round/squircle, iOS rounded square) doesn't
          // chop the EARTH logo. Renders inside the OS-chosen safe area.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2,ico}'],
      },
      // SW in dev disrupts HMR; exercise via `npm run build && preview`.
      devOptions: { enabled: false, type: 'module' },
    }),
  ],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: false,
    cors: false,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_API_PORT || 3000}`,
        changeOrigin: true,
      }
    }
  }
})
