import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// Builds to dist/ with relative asset paths, so the site works under any
// path, e.g. GitHub Pages at <domain>/Arcane-Arena/.
export default defineConfig({
  root: path.join(here, 'client'),
  base: './',
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  server: {
    fs: { allow: [here] },
    proxy: { '/ws': { target: `ws://localhost:${process.env.GAME_PORT || 3000}`, ws: true } },
  },
});
