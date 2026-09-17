import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Hosts differ in whether the app sits at the domain root. GitHub Pages serves
 * from `/<repo>/`, Vercel and Netlify from `/`. Everything that needs to know —
 * asset URLs, the manifest's start_url and scope, the service worker's
 * navigation fallback — is derived from this one value.
 *
 *   BASE_PATH=/my-timeline/ npm run build
 */
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'My Timeline',
        short_name: 'Timeline',
        description: 'Ten years of where you were and what you did, assembled on your own device.',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Photo bytes and tiles are deliberately not precached; the app shell is.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
      },
    }),
  ],
  server: { host: true, port: 5173 },
})
