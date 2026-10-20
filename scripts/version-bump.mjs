// Usage: npm run version:bump 0.2.3
// Updates package.json (+ lock), src-tauri/tauri.conf.json and src-tauri/Cargo.toml (+ lock).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) {
  console.error('用法：npm run version:bump <x.y.z>');
  process.exit(1);
}
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'inherit' });
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
const cargoPath = 'src-tauri/Cargo.toml';
const cargo = readFileSync(cargoPath, 'utf8');
const next = cargo.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
if (next === cargo && !cargo.includes(`version = "${version}"`)) throw new Error('Cargo.toml 中没找到 [package] version');
writeFileSync(cargoPath, next);
try {
  execFileSync('cargo', ['update', '-p', 'app', '--offline', '--manifest-path', cargoPath], { stdio: 'inherit' });
} catch {
  console.warn('未能更新 src-tauri/Cargo.lock，请稍后运行：cargo update -p app --manifest-path src-tauri/Cargo.toml');
}
console.log(`版本已改为 ${version}。提交并合并到 main 后会自动发布 v${version}。`);
