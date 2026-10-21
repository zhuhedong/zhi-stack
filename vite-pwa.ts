import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Emits dist/sw.js with the built asset list (no runtime dependency, no inline script). */
export function serviceWorker(): Plugin {
  return {
    name: 'infohub-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => /\.(js|css|woff2?|svg|png|ico|webmanifest)$/.test(name) && !name.endsWith('.map'))
        .map((name) => '/' + name);
      // Public files (icons, manifest) are copied verbatim, outside the bundle.
      const publicDir = new URL('./public/', import.meta.url);
      const walk = (dir: URL, prefix: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(new URL(entry.name + '/', dir), prefix + entry.name + '/')
            : [prefix + entry.name],
        );
      const extra = walk(publicDir, '/');
      const precache = [...new Set([...files, ...extra])].sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./src/pwa/sw.js', import.meta.url), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
