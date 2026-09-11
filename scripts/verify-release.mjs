import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceFingerprint } from './source-fingerprint.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const manifestVersion = (path) => readFileSync(path, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [
  manifestVersion('server/Cargo.toml'),
  manifestVersion('src-tauri/Cargo.toml'),
  JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version,
];
if (versions.some((value) => value !== version))
  throw new Error('Frontend, API and desktop versions must match.');
if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL)
  throw new Error(
    'Full release verification requires a PostgreSQL DATABASE_URL with CREATE DATABASE privilege. Tests create isolated databases.',
  );
const target = resolve('.local/product-build');
const binary = resolve(target, 'debug', 'infohub-server' + (process.platform === 'win32' ? '.exe' : ''));
const env = { ...process.env, INFOHUB_TEST_BINARY: binary, CARGO_TARGET_DIR: target, RUN_NETWORK_TESTS: '0' };
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start this gate with npm run verify:release.');
const node = process.execPath;
const npm = (script) => [node, [npmCli, 'run', script]];
const steps = [
  ['lint', ...npm('lint')],
  ['frontend build', ...npm('build')],
  ['request compiler', ...npm('test:request')],
  ['UI interactions', ...npm('test:ui')],
  ['server connections', ...npm('test:connection')],
  ['server tests', 'cargo', ['test', '--manifest-path', 'server/Cargo.toml', '--locked']],
  [
    'server Clippy',
    'cargo',
    ['clippy', '--manifest-path', 'server/Cargo.toml', '--locked', '--all-targets', '--', '-D', 'warnings'],
  ],
  ['isolated server build', 'cargo', ['build', '--manifest-path', 'server/Cargo.toml', '--locked']],
  ['business integration', node, ['scripts/integration.mjs']],
  ['business R2 protocol', node, ['scripts/integration.mjs', '--r2']],
  ['lifecycle integration', node, ['scripts/lifecycle-integration.mjs']],
  ['lifecycle R2 protocol', node, ['scripts/lifecycle-integration.mjs', '--r2']],
  ['library integration', node, ['scripts/library-integration.mjs']],
  ['API workspace', node, ['scripts/api-workspace-integration.mjs']],
  ['background queue and subscriptions', node, ['scripts/background-integration.mjs']],
  ['insights and maintenance CLI', node, ['scripts/insights-integration.mjs']],
  ['legacy local migration', node, ['scripts/storage-migration.mjs']],
  ['legacy R2 migration', node, ['scripts/storage-migration.mjs', '--r2']],
];
if (process.argv.includes('--docker')) steps.push(['Docker image smoke', node, ['scripts/docker-smoke.mjs']]);
if (process.platform === 'win32')
  steps.splice(
    8,
    0,
    [
      'desktop tests',
      'cargo',
      ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--target-dir', 'src-tauri/target', '--locked'],
    ],
    [
      'desktop Clippy',
      'cargo',
      [
        'clippy',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--target-dir',
        'src-tauri/target',
        '--locked',
        '--all-targets',
        '--',
        '-D',
        'warnings',
      ],
    ],
  );
const report = {
  version,
  sourceFingerprint: sourceFingerprint(),
  startedAt: new Date().toISOString(),
  platform: process.platform,
  checks: [],
  status: 'running',
  excluded: [
    'Browser/native visual verification',
    'Physical installation on a second machine',
    'Real cloud/R2 deployment',
    'Real participant trial',
  ],
};
if (!process.argv.includes('--docker'))
  report.excluded.push('Docker image smoke (run verify:release -- --docker where Docker is available)');
async function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => {
      console.error(error.message);
      resolve(-1);
    });
    child.once('exit', (code) => resolve(code ?? -1));
  });
}
try {
  for (const [name, command, args] of steps) {
    console.log('\nRelease check: ' + name);
    const start = Date.now();
    const code = await run(command, args);
    report.checks.push({ name, exitCode: code, seconds: Math.round((Date.now() - start) / 100) / 10 });
    if (code !== 0) throw new Error(name + ' failed.');
  }
  if (sourceFingerprint() !== report.sourceFingerprint)
    throw new Error('Source files changed during verification. Run the gate again on the final source.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  mkdirSync('.local/verification', { recursive: true });
  writeFileSync('.local/verification/latest.json', JSON.stringify(report, null, 2));
  console.log(`Release gate ${report.status}: .local/verification/latest.json`);
}
