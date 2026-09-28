import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/content/content.ts'),
      name: 'UdemyDualSubtitles',
      formats: ['iife'],
      fileName: () => 'content/content.js',
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@translation': resolve(__dirname, 'src/translation'),
      '@content': resolve(__dirname, 'src/content'),
    },
  },
});
