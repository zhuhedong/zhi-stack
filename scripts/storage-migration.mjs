import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import pg from 'pg';
import { createR2Fixture } from './r2-fixture.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
assert.ok(
  process.env.DATABASE_URL,
  'Set DATABASE_URL to a PostgreSQL instance with CREATE DATABASE permission',
);
const dbName = 'infohub_migration_' + Date.now();
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.pathname = '/postgres';
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.pathname = '/' + dbName;
const root = resolve('.local/storage-tests', dbName);
const seedRoot = resolve(root, 'seed');
const targetRoot = resolve(root, 'target');
const r2 = process.argv.includes('--r2') ? await createR2Fixture() : null;
const targetEnv = r2?.env || { FILE_STORAGE: 'local', LOCAL_STORAGE_PATH: targetRoot };
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query('CREATE DATABASE "' + dbName + '"');
const db = new pg.Client({ connectionString: dbUrl.toString() });
await db.connect();
const executable = resolve(
  'server/target/debug/infohub-server' + (process.platform === 'win32' ? '.exe' : ''),
);
const base = 'http://127.0.0.1:33310/api';
let server;
let log = '';
let token;
const password = 'Migration-Only-Master-Password-2026';
async function waitFor(condition, message) {
  const end = Date.now() + 15000;
  while (!(await condition())) {
    assert.ok(Date.now() < end, message);
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function stop() {
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
async function boot(env, failure = false) {
  log = '';
  server = spawn(executable, [], {
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: dbUrl.toString(), BIND_ADDR: '127.0.0.1:33310', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (bytes) => {
    log += bytes;
  });
  server.stderr.on('data', (bytes) => {
    log += bytes;
  });
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) {
      if (failure) {
        assert.notEqual(server.exitCode, 0);
        return;
      }
      throw new Error(log);
    }
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        assert.equal(failure, false, 'Server must refuse to start with invalid storage');
        return;
      }
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Server readiness timed out: ' + log);
}
async function request(path, method = 'GET', body, status = 200) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function upload(item, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), '迁移样本.bin');
  return request('/items/' + item.id + '/attachments', 'POST', form, 201);
}
try {
  if (r2) {
    r2.failProbe = true;
    await boot(r2.env, true);
    r2.failProbe = false;
    assert.equal((await db.query('SELECT count(*)::int AS n FROM items')).rows[0].n, 0);
    console.log('PASS an empty database does not report ready when storage access checks fail');
  }
  // Obtain authentic encrypted fixtures using the public API. Then, only in this
  // generated test database, restore the exact v1 schema to emulate an upgrade.
  await boot({ FILE_STORAGE: 'local', LOCAL_STORAGE_PATH: seedRoot });
  token = (await request('/auth/setup', 'POST', { password })).token;
  const credential = await request(
    '/items',
    'POST',
    { kind: 'credential', title: 'Migration credential', data: { fields: { password: 'Legacy-Secret' } } },
    201,
  );
  const article = await request('/items', 'POST', { kind: 'knowledge', title: 'Migration article' }, 201);
  const secret = Buffer.from('legacy encrypted attachment');
  const plain = Buffer.from('legacy plain attachment');
  const encryptedAttachment = await upload(credential, secret);
  const plainAttachment = await upload(article, plain);
  const oldAttachments = (await db.query('SELECT id,storage_key FROM attachments ORDER BY id')).rows;
  for (const file of oldAttachments) file.bytes = readFileSync(resolve(seedRoot, file.storage_key));
  const imageId = '40404040-1010-4040-8080-202020202020';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=',
    'base64',
  );
  await stop();
  assert.match(dbName, /^infohub_migration_\d+$/);
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, dbName);
  await db.query('BEGIN');
  await db.query('DROP FUNCTION track_file_reference() CASCADE');
  for (const table of ['attachments', 'media']) {
    await db.query('ALTER TABLE ' + table + ' ADD COLUMN content BYTEA');
    if (table === 'attachments') {
      for (const file of oldAttachments)
        await db.query('UPDATE attachments SET content=$2 WHERE id=$1', [file.id, file.bytes]);
    }
    await db.query('ALTER TABLE ' + table + ' ALTER COLUMN content SET NOT NULL');
    await db.query('ALTER TABLE ' + table + ' DROP COLUMN storage_key');
  }
  await db.query('DROP TABLE file_objects');
  await db.query('DELETE FROM _sqlx_migrations WHERE version=2');
  await db.query(
    "INSERT INTO media(id,item_id,source_url,mime,content,sha256) VALUES ($1,$2,'https://example.com/image.png','image/png',$3,'legacy-hash')",
    [imageId, article.id, png],
  );
  await db.query('COMMIT');

  if (r2) {
    r2.failPut = true;
    await boot(targetEnv, true);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM attachments WHERE legacy_content IS NOT NULL')).rows[0]
        .n,
      2,
    );
    r2.failPut = false;
    r2.corruptReads = true;
    await boot(targetEnv, true);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM attachments WHERE legacy_content IS NOT NULL')).rows[0]
        .n,
      2,
    );
    r2.corruptReads = false;
    console.log(
      'PASS failed R2 writes and failed read-back checks preserve all original PostgreSQL file bytes',
    );
  } else {
    mkdirSync(root, { recursive: true });
    const blocked = resolve(root, 'blocked-file');
    writeFileSync(blocked, 'not a directory');
    await boot({ FILE_STORAGE: 'local', LOCAL_STORAGE_PATH: blocked }, true);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM attachments WHERE content IS NOT NULL')).rows[0].n,
      2,
    );
    console.log('PASS invalid disk destination fails startup without modifying legacy file data');
  }
  await boot(targetEnv);
  token = (await request('/auth/login', 'POST', { password })).token;
  for (const [file, expected] of [
    [encryptedAttachment, secret],
    [plainAttachment, plain],
  ]) {
    const response = await fetch(base + '/attachments/' + file.id, {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const image = await fetch(base + '/media/' + imageId, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const fileRead = (key) => (r2 ? r2.objects.get(key) : readFileSync(resolve(targetRoot, key)));
  for (const file of oldAttachments) assert.deepEqual(fileRead(file.storage_key), file.bytes);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('attachments','media','file_objects') AND data_type='bytea'",
      )
    ).rows[0].n,
    0,
  );
  await waitFor(
    async () => (await db.query('SELECT count(*)::int AS n FROM file_objects')).rows[0].n === 3,
    'Migration cleanup did not finish',
  );
  await request('/vault/lock', 'POST');
  assert.equal(
    (
      await fetch(base + '/attachments/' + encryptedAttachment.id, {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).status,
    423,
  );
  console.log(
    'PASS old encrypted/plain attachments and image migrate with unchanged IDs and ciphertext; byte columns removed',
  );
  await stop();
  await boot(
    r2
      ? { ...targetEnv, R2_BUCKET: 'wrong-bucket' }
      : { FILE_STORAGE: 'local', LOCAL_STORAGE_PATH: resolve(root, 'wrong-directory') },
    true,
  );
  assert.match(log, /已有文件使用不同的存储位置/);
  await boot(targetEnv);
  token = (await request('/auth/login', 'POST', { password })).token;
  assert.equal((await request('/items/' + credential.id)).data.fields.password, 'Legacy-Secret');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM file_objects')).rows[0].n, 3);
  if (r2) assert.deepEqual(r2.errors, []);
  console.log(
    'PASS wrong storage location is refused; restarting with correct settings preserves migrated files',
  );
  if (!r2) {
    await stop();
    // Simulate upgrading the previous release's path fingerprint. Contents are
    // verified before any DB reference is converted to the marker's identity.
    const marker = resolve(targetRoot, '.infohub-storage-id');
    rmSync(marker);
    await db.query('UPDATE file_objects SET storage_id=$1', ['local:' + '0'.repeat(64)]);
    await boot(targetEnv);
    const identity = readFileSync(marker, 'utf8');
    assert.equal(
      (await db.query('SELECT DISTINCT storage_id FROM file_objects')).rows[0].storage_id,
      'local:' + identity,
    );
    await stop();
    const relocated = resolve(root, 'relocated');
    cpSync(targetRoot, relocated, { recursive: true });
    await boot({ FILE_STORAGE: 'local', LOCAL_STORAGE_PATH: relocated });
    token = (await request('/auth/login', 'POST', { password })).token;
    const relocatedDownload = await fetch(base + '/attachments/' + encryptedAttachment.id, {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.deepEqual(Buffer.from(await relocatedDownload.arrayBuffer()), secret);
    await stop();
    // Remove only this generated copy, after verifying its absolute boundary.
    const child = relative(root, relocated);
    assert.ok(child === 'relocated' && !child.startsWith('..') && !isAbsolute(child));
    rmSync(relocated, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    mkdirSync(relocated);
    await boot({ FILE_STORAGE: 'local', LOCAL_STORAGE_PATH: relocated }, true);
    assert.match(log, /已有文件使用不同的存储位置/);
    console.log(
      'PASS legacy disk identity upgrade, directory relocation, and empty replacement-volume rejection',
    );
    const publiclyServed = resolve(root, 'public');
    await boot(
      {
        FILE_STORAGE: 'local',
        LOCAL_STORAGE_PATH: resolve(publiclyServed, 'uploads'),
        FRONTEND_DIR: publiclyServed,
      },
      true,
    );
    assert.match(log, /文件存储目录不能位于公开/);
    console.log('PASS file storage under the public frontend directory is rejected');
  }
} finally {
  await stop();
  r2?.close();
  await db.end();
  assert.match(dbName, /^infohub_migration_\d+$/);
  await admin.query('DROP DATABASE "' + dbName + '" WITH (FORCE)');
  await admin.end();
  const within = relative(resolve('.local/storage-tests'), root);
  assert.ok(within === dbName && !within.startsWith('..') && !isAbsolute(within));
  rmSync(root, { recursive: true, force: true });
}
