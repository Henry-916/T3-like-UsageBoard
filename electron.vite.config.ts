import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Some Electron-based IDE terminals set this for their Node subprocesses.
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'renderer-content-security-policy',
        apply: 'build',
        transformIndexHtml: {
          order: 'post',
          handler: () => [{
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'"
            },
            injectTo: 'head-prepend'
          }]
        }
      }
    ]
  }
})
