import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export async function eventually(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}
export async function createWorkspace(extraEnv = {}) {
  if (existsSync('.env') && !process.env.DATABASE_URL) process.loadEnvFile('.env');
  assert.ok(process.env.DATABASE_URL, 'Start the development PostgreSQL instance first.');
  const name = 'infohub_product_' + randomUUID().replaceAll('-', '');
  const parent = resolve('.local/product-tests');
  const storage = resolve(parent, name);
  function validateDirectory() {
    const path = relative(parent, storage);
    assert.ok(path && !path.startsWith('..') && !isAbsolute(path) && storage.startsWith(parent));
  }
  validateDirectory();
  mkdirSync(storage, { recursive: true });
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const base = `http://127.0.0.1:${port}/api`;
  let server;
  let log = '';
  let token = '';
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
  async function boot() {
    const binary = resolve(
      process.env.INFOHUB_TEST_BINARY ||
        '.local/product-build/debug/infohub-server' + (process.platform === 'win32' ? '.exe' : ''),
    );
    server = spawn(binary, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: dbUrl.toString(),
        BIND_ADDR: `127.0.0.1:${port}`,
        FRONTEND_DIR: resolve('dist'),
        FILE_STORAGE: 'local',
        LOCAL_STORAGE_PATH: storage,
        ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
        ...extraEnv,
      },
    });
    server.stdout.on('data', (data) => {
      log += data;
    });
    server.stderr.on('data', (data) => {
      log += data;
    });
    await eventually(async () => {
      if (server.exitCode !== null) throw new Error('Isolated server exited: ' + log);
      try {
        return (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    }, 'Isolated server did not start: ' + log);
  }
  async function raw(path, method = 'GET', body, overrideToken = token) {
    return fetch(base + path, {
      method,
      headers: {
        ...(overrideToken ? { Authorization: 'Bearer ' + overrideToken } : {}),
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function request(path, method = 'GET', body, status = 200, overrideToken = token) {
    const response = await raw(path, method, body, overrideToken);
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
  return {
    name,
    storage,
    base,
    db,
    boot,
    stop,
    request,
    raw,
    set token(value) {
      token = value;
    },
    get token() {
      return token;
    },
    get log() {
      return log;
    },
    async close() {
      await stop();
      await db.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      validateDirectory();
      rmSync(storage, { recursive: true, force: true });
    },
  };
}
