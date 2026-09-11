import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const brand = resolve(root, 'assets/brand');
const staging = resolve(root, '.local/infohub-icons');
const desktop = resolve(root, 'src-tauri/icons');
const publicDir = resolve(root, 'public');
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');

function render(source, directory, sizes = []) {
  const result = spawnSync(
    process.execPath,
    [cli, 'icon', source, '--output', directory, ...sizes.flatMap((n) => ['--png', String(n)])],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Tauri icon generation failed.');
}

await mkdir(staging, { recursive: true });
await mkdir(desktop, { recursive: true });
await mkdir(publicDir, { recursive: true });
render(resolve(brand, 'infohub.svg'), resolve(staging, 'platforms'));
render(resolve(brand, 'infohub.svg'), resolve(staging, 'large'), [48, 64, 180, 512, 1024]);
render(resolve(brand, 'infohub-small.svg'), resolve(staging, 'small'), [16, 24, 32]);

// Copy desktop assets only; Tauri's temporary Android/iOS exports stay outside the source tree.
for (const name of await readdir(resolve(staging, 'platforms'))) {
  if (/^(?:icon\.(?:png|ico|icns)|(?:32x32|128x128(?:@2x)?|StoreLogo|Square\d+x\d+Logo)\.png)$/.test(name)) {
    await copyFile(resolve(staging, 'platforms', name), resolve(desktop, name));
  }
}
await copyFile(resolve(staging, 'small/32x32.png'), resolve(desktop, '32x32.png'));

// PNG-backed ICO frames retain transparency and use the optically adjusted mark below 48 px.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(
  sizes.map((size) =>
    readFile(
      size <= 32
        ? resolve(staging, `small/${size}x${size}.png`)
        : size <= 64
          ? resolve(staging, `large/${size}x${size}.png`)
          : resolve(staging, 'platforms', size === 128 ? '128x128.png' : '128x128@2x.png'),
    ),
  ),
);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
frames.forEach((frame, index) => {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
const ico = Buffer.concat([directory, ...frames]);
await writeFile(resolve(desktop, 'icon.ico'), ico);
await writeFile(resolve(publicDir, 'favicon.ico'), ico);
await copyFile(resolve(brand, 'infohub-small.svg'), resolve(publicDir, 'favicon.svg'));
await copyFile(resolve(brand, 'infohub.svg'), resolve(publicDir, 'app-icon.svg'));
await copyFile(resolve(staging, 'large/180x180.png'), resolve(publicDir, 'apple-touch-icon.png'));
await copyFile(resolve(staging, 'large/1024x1024.png'), resolve(brand, 'infohub-1024.png'));
await copyFile(resolve(staging, 'large/512x512.png'), resolve(brand, 'infohub-512.png'));
console.log('InfoHub icons generated: desktop, browser, Apple touch icon, and editable SVG sources.');
