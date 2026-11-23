import { defineConfig } from 'vite';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// After build, write the list of every output file into sw.js so the browser version works fully offline.
function precache() {
  return {
    name: 'precache',
    closeBundle() {
      const out = 'dist';
      const files = [];
      const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative(out, p)); });
      walk(out);
      const list = ['./', ...files.filter((f) => f !== 'sw.js')].map((f) => (f === './' ? f : './' + f.split('/').map(encodeURIComponent).join('/')));
      const sw = readFileSync(join(out, 'sw.js'), 'utf8').replace('__VERSION__', 'rimal-' + Date.now()).replace('__FILES__', JSON.stringify(list));
      writeFileSync(join(out, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 2000 },
  server: { host: true },
  plugins: [precache()],
});
