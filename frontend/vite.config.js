import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// BizOS is served under osnuvora.com/BizOS/, not the domain root - every built
// asset reference, the manifest and the service worker all need this same
// prefix (see index.html's %BASE_URL% uses and public/service-worker.js).
const BASE_PATH = '/BizOS/'

// https://vite.dev/config/
export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
})
