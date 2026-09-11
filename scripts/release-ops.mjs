import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { maintain, argumentsOf, hashFile } from './maintenance.mjs';

const args = argumentsOf();
const base = args.base || process.env.INFOHUB_URL || 'http://127.0.0.1:3210';
const compose = resolve(args.compose || 'compose.yaml');
const envFile = resolve(args['env-file'] || '.env');
function docker(arguments_, extraEnv = {}) {
  const result = spawnSync('docker', arguments_, {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error || result.status !== 0)
    throw new Error(`Docker command failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const composeArgs = ['compose', '--env-file', envFile, '-f', compose];
async function waitHealth(expected) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const value = await maintain({ command: 'status', base });
      if (value.version === expected) return value;
    } catch {
      /* Container may still be starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    'The expected server version did not become healthy. Retain the recovery record and use a fresh recovery instance.',
  );
}
try {
  if (args.command === 'upgrade') {
    if (
      !args.image ||
      !/^[A-Za-z0-9][A-Za-z0-9./:@_-]+$/.test(args.image) ||
      (!args.image.includes(':') && !args.image.includes('@')) ||
      args.image.endsWith(':latest')
    )
      throw new Error('Provide --image with an explicit version tag or digest.');
    const expected = args['expect-version'] || args.image.match(/:v?(\d+\.\d+\.\d+)$/)?.[1];
    if (!expected) throw new Error('A digest/custom image tag also requires --expect-version.');
    if (!readFileSync(compose, 'utf8').includes('${INFOHUB_IMAGE'))
      throw new Error('The compose app image must use INFOHUB_IMAGE.');
    docker(['version']);
    const container = docker([...composeArgs, 'ps', '-q', 'app']);
    if (!container || container.includes('\n')) throw new Error('Expected one running app service.');
    const oldImage = docker(['inspect', '--format', '{{.Image}}', container]);
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const directory = resolve(args['backup-dir'] || '.local/recovery');
    mkdirSync(directory, { recursive: true });
    const backup = await maintain({
      command: 'backup',
      base,
      file: resolve(directory, id + '.infohub'),
      password: process.env.INFOHUB_PASSWORD,
    });
    const recordPath = resolve(directory, id + '.json');
    const record = {
      format: 1,
      status: 'backed-up',
      createdAt: new Date().toISOString(),
      oldImage,
      oldVersion: backup.version,
      requestedImage: args.image,
      expectedVersion: expected,
      compose,
      envFile,
      base,
      backup,
    };
    writeFileSync(recordPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Encrypted backup and recovery record: ' + recordPath);
    try {
      docker(['pull', args.image]);
      const newImage = docker(['image', 'inspect', '--format', '{{.Id}}', args.image]);
      docker([...composeArgs, 'up', '-d', '--no-deps', '--no-build', 'app'], { INFOHUB_IMAGE: newImage });
      await waitHealth(expected);
      record.status = 'healthy';
      record.runningImage = newImage;
      console.log(
        'Upgrade health check passed. Keep the previous image and encrypted backup until acceptance is complete.',
      );
    } catch (error) {
      record.status = 'failed';
      throw error;
    } finally {
      writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    }
  } else if (args.command === 'rollback') {
    if (!args.record || !args['recovery-url'] || args.confirm !== '恢复并替换')
      throw new Error('Rollback requires --record PATH --recovery-url URL --confirm 恢复并替换.');
    const record = JSON.parse(readFileSync(resolve(args.record), 'utf8'));
    if (record.format !== 1 || !record.oldVersion || !record.backup?.file || !record.backup?.sha256)
      throw new Error('Invalid recovery record.');
    const backupFile = args.file
      ? resolve(args.file)
      : resolve(dirname(resolve(args.record)), record.backup.file);
    if ((await hashFile(backupFile)) !== record.backup.sha256)
      throw new Error('Backup checksum does not match the recovery record.');
    const health = await maintain({ command: 'status', base: args['recovery-url'] });
    if (health.initialized || health.version !== record.oldVersion)
      throw new Error(
        `Use an empty recovery instance running ${record.oldVersion}, with a separate database and file directory. Do not attach the previous image to the upgraded database.`,
      );
    await maintain({
      command: 'restore',
      base: args['recovery-url'],
      file: backupFile,
      backupPassword: process.env.INFOHUB_BACKUP_PASSWORD,
      confirm: args.confirm,
    });
    console.log(
      'Previous-version data restored. Validate the recovery URL, then switch the client or reverse proxy to it.',
    );
  } else throw new Error('Use upgrade or rollback. See docs/operations.md.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
