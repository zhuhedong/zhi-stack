import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function sourceFingerprint() {
  const paths = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const files = [...new Set(paths)]
    .filter(
      (path) =>
        !path.startsWith('release/') &&
        !path.startsWith('.local/') &&
        (/\.(rs|tsx?|m?js|json|toml|sql|ya?ml|css|ps1|html|svg|png|ico|icns)$/.test(path) ||
          path.endsWith('Cargo.lock') ||
          ['Dockerfile', '.dockerignore', '.env.example', '.env.external-pg.example'].includes(path)),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file + '\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(sourceFingerprint());
