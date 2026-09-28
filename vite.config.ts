import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

// Post-build plugin to fix paths for Chrome Extension structure
function chromeExtensionPlugin() {
  return {
    name: 'chrome-extension-fixup',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');

      // Copy content.css to dist/content/
      const contentCss = resolve(__dirname, 'src', 'content', 'content.css');
      const contentDist = resolve(dist, 'content');
      if (!existsSync(contentDist)) mkdirSync(contentDist, { recursive: true });
      if (existsSync(contentCss)) {
        copyFileSync(contentCss, resolve(contentDist, 'content.css'));
      }

      // Copy icons
      const iconsDir = resolve(__dirname, 'public', 'icons');
      const destIcons = resolve(dist, 'icons');
      if (!existsSync(destIcons)) mkdirSync(destIcons, { recursive: true });
      if (existsSync(iconsDir)) {
        const icons = readdirSync(iconsDir);
        for (const icon of icons) {
          copyFileSync(resolve(iconsDir, icon), resolve(destIcons, icon));
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : false,
    minify: process.env.NODE_ENV === 'production',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/background.ts'),
        popup: resolve(__dirname, 'src/popup/popup.html'),
        options: resolve(__dirname, 'src/options/options.html'),
        dictionary: resolve(__dirname, 'src/dictionary/dictionary.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'content') return 'content/content.js';
          if (chunkInfo.name === 'background') return 'background/background.js';
          return '[name]/[name].js';
        },
        chunkFileNames: 'shared/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || '';
          // Route CSS to proper directories
          if (name.endsWith('.css')) {
            if (name.includes('popup')) return 'popup/popup.css';
            if (name.includes('options')) return 'options/options.css';
            if (name.includes('dictionary')) return 'dictionary/dictionary.css';
            return 'assets/[name][extname]';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
  plugins: [chromeExtensionPlugin()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@translation': resolve(__dirname, 'src/translation'),
      '@content': resolve(__dirname, 'src/content'),
    },
  },
});
