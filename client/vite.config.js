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
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        'Logo-Universidad-EARTH_academico-300x257.png',
        'login-bg.jpg',
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
        // TODO Phase 4: replace with proper 192/512 icons. The EARTH logo
        // is 300x257; browsers will install but Lighthouse will warn.
        icons: [
          {
            src: 'Logo-Universidad-EARTH_academico-300x257.png',
            sizes: '300x257',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2,ico}'],
        navigateFallback: '/index.html',
        // Never SPA-fallback API requests — they must reach the network
        // (or fail cleanly so the runtime cache can serve a stale copy).
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Cached responses are scoped to whoever was logged in when they
            // were stored. Acceptable while the device is single-user (one
            // leader = one tablet); revisit if device-sharing becomes common.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/api/') && request.method === 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-get',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // SW in dev disrupts HMR; we'll exercise it via `npm run build && preview`.
      devOptions: { enabled: false },
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
