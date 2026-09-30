import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// Relative base so the build works from any GitHub Pages path.
export default defineConfig({
  base: './',
  plugins: [preact()],
})
