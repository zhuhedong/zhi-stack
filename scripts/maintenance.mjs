import { openAsBlob, createReadStream, createWriteStream } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function baseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP(S) service URL without credentials, query or fragment.');
  return (
    url
      .toString()
      .replace(/\/+$/, '')
      .replace(/\/api$/, '') + '/api'
  );
}
export async function maintain({ command, base, file, password, backupPassword, confirm }) {
  const api = baseUrl(base);
  let token = '';
  async function call(path, method = 'GET', body) {
    const response = await fetch(api + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(command === 'status' ? 5000 : 30 * 60 * 1000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Maintenance request failed (${response.status}).`);
    }
    return response;
  }
  const health = await (await call('/health')).json();
  if (command === 'status') return health;
  if (!['backup', 'restore'].includes(command) || !file)
    throw new Error('Use status, backup --file PATH, or restore --file PATH --confirm 恢复并替换.');
  if (command === 'restore' && confirm !== '恢复并替换')
    throw new Error('Restore requires --confirm 恢复并替换.');
  if ((command === 'backup' || health.initialized) && !password)
    throw new Error('Set INFOHUB_PASSWORD to the current workbench password.');
  if (command === 'restore' && !backupPassword)
    throw new Error('Set INFOHUB_BACKUP_PASSWORD to the password used when the backup was made.');
  try {
    if (health.initialized) token = (await (await call('/auth/login', 'POST', { password })).json()).token;
    if (command === 'backup') {
      const target = resolve(file);
      // Reserve the destination exclusively; never replace an operator's existing backup.
      const reservation = await open(target, 'wx');
      await reservation.close();
      const temp = target + '.' + randomUUID() + '.partial';
      try {
        const response = await call('/backup/export', 'POST', { password });
        if (!response.body) throw new Error('Backup response is empty.');
        const hash = createHash('sha256');
        let size = 0;
        const meter = new Transform({
          transform(chunk, _encoding, done) {
            hash.update(chunk);
            size += chunk.length;
            done(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          meter,
          createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
        );
        const handle = await open(temp, 'r');
        const expectedMagic = Buffer.from('INFOHUB-BACKUP-1\n');
        const magic = Buffer.alloc(expectedMagic.length);
        await handle.read(magic, 0, magic.length, 0);
        await handle.close();
        if (!magic.equals(expectedMagic)) throw new Error('The server did not return a supported backup.');
        await rename(temp, target);
        return { file: target, bytes: size, sha256: hash.digest('hex'), version: health.version };
      } catch (error) {
        await unlink(temp).catch(() => {});
        await unlink(target).catch(() => {});
        throw error;
      }
    }
    const form = new FormData();
    form.set('password', backupPassword);
    form.set('confirm', confirm);
    if (health.initialized) form.set('currentPassword', password);
    form.set('backup', await openAsBlob(resolve(file)), 'restore.infohub');
    return await (await call('/backup/restore', 'POST', form)).json();
  } finally {
    if (token) await call('/auth/logout', 'POST').catch(() => {});
  }
}
export function argumentsOf(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  const parsed = { command };
  for (let index = 0; index < options.length; index += 2) {
    if (!options[index].startsWith('--') || options[index + 1] === undefined)
      throw new Error('Options require --name VALUE.');
    parsed[options[index].slice(2)] = options[index + 1];
  }
  return parsed;
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = argumentsOf();
    const result = await maintain({
      ...args,
      base: args.base || process.env.INFOHUB_URL || 'http://127.0.0.1:3210',
      password: process.env.INFOHUB_PASSWORD,
      backupPassword: process.env.INFOHUB_BACKUP_PASSWORD,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
