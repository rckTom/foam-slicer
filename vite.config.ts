// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Relative asset paths, so the page works from any subpath.
// The OpenCascade module is loaded as is (its wasm through ?url), not pre-bundled.
export default defineConfig({
  base: './',
  plugins: [vue()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
})
