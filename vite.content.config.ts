import path from 'path'
import { defineConfig } from 'vite'

// Content script build: Chrome MV3 content scripts can't be ES modules,
// so this bundles src/content/index.ts into one plain IIFE file.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'src/content/index.ts'),
      name: 'PointerContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
})
