import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Automation Studio lives at the repo root. The legacy attendance app under
// client/ and server/ has its own tooling and is intentionally left untouched.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    open: false,
  },
})
