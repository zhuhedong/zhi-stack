import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let built;
/**
 * Path of the server binary used by integration tests. INFOHUB_TEST_BINARY
 * selects a prebuilt executable; otherwise the debug build is compiled (an
 * incremental no-op when up to date) so tests never run a stale binary.
 */
export function serverBinary() {
  if (process.env.INFOHUB_TEST_BINARY) {
    const binary = resolve(process.env.INFOHUB_TEST_BINARY);
    if (!existsSync(binary)) throw new Error('INFOHUB_TEST_BINARY does not exist: ' + binary);
    return binary;
  }
  if (built) return built;
  const result = spawnSync('cargo', ['build', '--manifest-path', 'server/Cargo.toml', '--locked'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error('cargo build failed: ' + (result.error?.message || 'exit ' + result.status));
  const target = process.env.CARGO_TARGET_DIR || 'server/target';
  built = resolve(target, 'debug', 'infohub-server' + (process.platform === 'win32' ? '.exe' : ''));
  return built;
}

/** Adds the one-time setup token to setup and fresh-instance restore requests. */
export function withSetupToken(path, body, setupToken) {
  if (path === '/auth/setup' && body && typeof body === 'object' && !(body instanceof FormData))
    return 'setupToken' in body ? body : { ...body, setupToken };
  if (
    path === '/backup/restore' &&
    body instanceof FormData &&
    !body.get('currentPassword') &&
    !body.has('setupToken')
  ) {
    const form = new FormData();
    form.set('setupToken', setupToken);
    for (const [key, value] of body.entries()) form.append(key, value);
    return form;
  }
  return body;
}
