import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import pg from 'pg';
import { createR2Fixture } from './r2-fixture.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL or run npm run db:dev first.');
const keep = process.argv.includes('--keep');
const dbName = 'infohub_test_' + Date.now();
const storageRoot = resolve('.local/storage-tests', dbName);
const r2 = process.argv.includes('--r2') ? await createR2Fixture() : null;
const fileRead = (key) => (r2 ? r2.objects.get(key) : readFileSync(resolve(storageRoot, key)));
const fileExists = (key) => (r2 ? r2.objects.has(key) : existsSync(resolve(storageRoot, key)));
async function waitFor(condition, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    assert.ok(Date.now() < end, message);
    await new Promise((done) => setTimeout(done, 100));
  }
}
const removed = (key) => waitFor(() => !fileExists(key), 'File cleanup timed out: ' + key);
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.pathname = '/postgres';
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = '/' + dbName;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query('CREATE DATABASE "' + dbName + '"');
const db = new pg.Client({ connectionString: testUrl.toString() });
await db.connect();
const password = 'InfoHub-Verification-Only-2026';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=',
  'base64',
);
let articleVersion = 1;
const spec = {
  openapi: '3.0.3',
  info: { title: '订单中心接口 · 验收示例', version: '1.0' },
  servers: [{ url: '/' }],
  paths: {
    '/echo/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'order-1001' } },
      ],
      patch: {
        summary: '更新订单并回显真实请求',
        tags: ['订单模块'],
        parameters: [
          { name: 'channel', in: 'query', required: true, schema: { type: 'string', example: 'web' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { amount: { type: 'number', example: 398 } } },
            },
          },
        },
      },
    },
    '/health': { get: { summary: '服务健康检查' } },
  },
};
const fixture = createServer(async (req, res) => {
  if (req.url === '/openapi.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(spec));
  } else if (req.url === '/swagger-ui') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><script>SwaggerUIBundle({url:"/openapi.json"})</script></html>');
  } else if (req.url?.startsWith('/article')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<html><head><title>Rust 异步与 PostgreSQL 实践 · 验收文章</title><meta name="author" content="InfoHub 验收"><meta name="description" content="真实采集、离线图片、正文编辑与持久化验证。"></head><body><article><h1>Rust 异步与 PostgreSQL 实践</h1><p>这是本地验收站点提供的文章正文，包含中文和代码。它用于验证服务端确实下载并转换 HTML，保存文章正文与资源，当前版本：' +
        articleVersion +
        (req.url.startsWith('/article-swagger') ? '，这篇文章讨论 SwaggerUIBundle 的使用方式' : '') +
        '。</p><h2>事务与连接池</h2><p>使用事务提交业务数据，失败时回滚，让多步操作保持一致。</p><pre><code>SELECT current_database();</code></pre><img src="/image.png" alt="示例插图"><script>alert("unsafe")</script></article></body></html>',
    );
  } else if (req.url === '/image.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  } else if (req.url === '/redirect-private') {
    res.writeHead(302, { Location: 'http://localhost:' + fixture.address().port + '/article' });
    res.end();
  } else if (req.url === '/too-large') {
    res.setHeader('Content-Length', 9 * 1024 * 1024);
    res.end(Buffer.alloc(9 * 1024 * 1024));
  } else if (req.url === '/unavailable') {
    res.writeHead(503);
    res.end('Service unavailable');
  } else if (req.url === '/bad-article') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<html><title>Just a moment</title><article>Verification required. Please wait to continue reading this article.</article></html>',
    );
  } else if (req.url === '/slow') {
    await new Promise((done) => setTimeout(done, 1500));
    res.end('slow-response');
  } else if (req.url?.startsWith('/echo')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.statusCode = 201;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Fixture', 'real-http');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"ok"}');
  }
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port;
const port = keep ? 3211 : 33210;
let server;
let serverLog = '';
let token = '';
const base = 'http://127.0.0.1:' + port + '/api';
async function boot() {
  const executable = resolve(
    'server/target/debug/infohub-server' + (process.platform === 'win32' ? '.exe' : ''),
  );
  assert.ok(existsSync(executable), 'Build the server with cargo build --manifest-path server/Cargo.toml');
  server = spawn(executable, [], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      BIND_ADDR: '127.0.0.1:' + port,
      FRONTEND_DIR: resolve('dist'),
      ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
      FILE_STORAGE: 'local',
      LOCAL_STORAGE_PATH: storageRoot,
      ...(r2?.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => {
    serverLog += c;
  });
  server.stderr.on('data', (c) => {
    serverLog += c;
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/health', { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    if (server.exitCode !== null) throw new Error('Test server exited: ' + serverLog);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Test server did not become ready: ' + serverLog);
}
async function stopServer() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
async function request(path, method = 'GET', body, expected = 200) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  assert.equal(response.status, expected, method + ' ' + path + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : undefined;
}
let checks = 0;
function pass(label) {
  checks++;
  console.log('PASS ' + label);
}
async function cleanup() {
  await stopServer();
  fixture.close();
  r2?.close();
  await db.end();
  // dbName is generated above and is never derived from a user's database name.
  assert.match(dbName, /^infohub_test_\d+$/);
  await admin.query('DROP DATABASE "' + dbName + '" WITH (FORCE)');
  await admin.end();
  const storageRelative = relative(resolve('.local/storage-tests'), storageRoot);
  assert.ok(storageRelative && !storageRelative.startsWith('..') && !isAbsolute(storageRelative));
  assert.equal(storageRelative, dbName);
  rmSync(storageRoot, { recursive: true, force: true });
}
try {
  await boot();
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('attachments','media','file_objects') AND data_type='bytea'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await request('/health')).initialized, false);
  await request('/items', 'GET', undefined, 401);
  await request('/auth/setup', 'POST', { password: 'short' }, 400);
  token = (await request('/auth/setup', 'POST', { password })).token;
  await request('/auth/setup', 'POST', { password }, 409);
  await request('/auth/login', 'POST', { password: 'incorrect-password' }, 401);
  pass('first-run initialization, authorization and invalid password handling');

  let article = await request(
    '/items',
    'POST',
    {
      kind: 'knowledge',
      title: '事务与连接池',
      category: 'note',
      tags: ['PostgreSQL', '数据库'],
      summary: '用于验证中文搜索',
      data: { content: '# 连接池\n\n唯一正文关键词 transaction-check。' },
    },
    201,
  );
  article = await request('/items/' + article.id, 'PUT', {
    ...article,
    favorite: true,
    data: { ...article.data, content: '# 已编辑\n\ntransaction-check 内容已保存。' },
  });
  assert.equal(article.revision, 2);
  await request('/items/' + article.id, 'PUT', { ...article, revision: 1 }, 409);
  assert.equal((await request('/items?q=transaction-check')).total, 1);
  assert.equal((await request('/items?q=' + encodeURIComponent('数据库'))).total, 1);
  assert.equal((await request('/items?q=' + encodeURIComponent("' OR 1=1--"))).total, 0);
  assert.equal((await request('/items?favorite=true')).total, 1);
  assert.equal((await request('/items?limit=1&offset=1')).items.length, 0);
  pass('CRUD, Markdown persistence, Chinese/content search, favorites and conflict control');

  for (const data of [
    { content: { invalid: true } },
    { fields: { password: ['invalid'] } },
    { globalHeaders: [{ key: 'X-Test', value: 'sample', enabled: 'yes' }] },
    { swaggerEndpoints: [{ method: 'RUN', path: '/invalid' }] },
    { imagesCount: { invalid: true } },
    { stars: -1 },
  ]) {
    await request('/items', 'POST', { kind: 'credential', title: 'Invalid payload', data }, 400);
  }
  assert.equal((await request('/items?q=Invalid%20payload')).total, 0);
  pass('malformed asset payloads are rejected before persistence');

  const repo = await request(
    '/items',
    'POST',
    {
      kind: 'repo',
      title: 'infohub/verification',
      category: 'Rust',
      summary: '验收用仓库记录',
      data: {
        localWorkspacePath: process.cwd(),
        cookbookNotes: '# 实践笔记\n\n数据库连接由服务端统一维护。',
      },
    },
    201,
  );
  assert.match((await request('/items/' + repo.id)).data.cookbookNotes, /数据库/);
  pass('repository workspace and cookbook notes persistence');

  const credential = await request(
    '/items',
    'POST',
    {
      kind: 'credential',
      title: 'PostgreSQL 主库 · 验收示例',
      category: 'sql',
      project: 'InfoHub 验收项目',
      summary: 'confidential-description',
      url: 'https://example.com/private',
      data: {
        typeKey: 'postgresql',
        fields: {
          host: 'private-database.example',
          port: '5432',
          database: 'infohub',
          username: 'test_user',
          password: 'Credential-Only-For-Verification',
        },
        globalHeaders: [{ key: 'Authorization', value: 'Bearer test-token', enabled: true }],
      },
    },
    201,
  );
  const stored = (await db.query('SELECT data, secret, summary, url FROM items WHERE id=$1', [credential.id]))
    .rows[0];
  assert.deepEqual(stored.data, {});
  assert.equal(stored.summary, '');
  assert.equal(stored.url, '');
  assert.ok(!stored.secret.includes(Buffer.from('Credential-Only-For-Verification')));
  const listing = await request('/items?kind=credential');
  assert.deepEqual(listing.items[0].data, {});
  assert.equal((await request('/items?q=private-database')).total, 1);
  pass('credential payload is encrypted in PostgreSQL; metadata lists omit secret values');

  const form = new FormData();
  form.append('file', new Blob(['attachment-private-content'], { type: 'application/pdf' }), '接口说明.pdf');
  const attachment = await request('/items/' + credential.id + '/attachments', 'POST', form, 201);
  const download = await fetch(base + '/attachments/' + attachment.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(await download.text(), 'attachment-private-content');
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8/);
  const storedAttachment = (
    await db.query('SELECT storage_key, encrypted FROM attachments WHERE id=$1', [attachment.id])
  ).rows[0];
  assert.equal(storedAttachment.encrypted, true);
  assert.ok(!fileRead(storedAttachment.storage_key).includes(Buffer.from('attachment-private-content')));
  assert.equal(
    fileRead(storedAttachment.storage_key).length,
    Buffer.byteLength('attachment-private-content') + 28,
  );
  pass('attachment upload/download and encrypted external files; PostgreSQL contains no file byte columns');

  await request('/vault/lock', 'POST');
  await request('/items/' + credential.id, 'GET', undefined, 423);
  await request('/attachments/' + attachment.id, 'GET', undefined, 423);
  await request('/probe', 'POST', { url: fixtureUrl + '/echo', method: 'GET' }, 423);
  await request('/items/' + credential.id, 'DELETE', undefined, 423);
  await request('/items/' + credential.id, 'PUT', credential, 423);
  await request('/items', 'POST', { ...credential, title: 'Locked create' }, 423);
  await request('/items/' + credential.id + '/attachments', 'GET', undefined, 423);
  await request('/attachments/' + attachment.id, 'DELETE', undefined, 423);
  const lockedUpload = new FormData();
  lockedUpload.append('file', new Blob(['locked']), 'locked.txt');
  await request('/items/' + credential.id + '/attachments', 'POST', lockedUpload, 423);
  assert.equal((await request('/items?q=private-database')).total, 0);
  assert.equal((await request('/items/' + article.id)).title, article.title);
  await request('/vault/unlock', 'POST', { password: 'wrong-password' }, 401);
  await request('/vault/unlock', 'POST', { password });
  assert.equal(
    (await request('/items/' + credential.id)).data.fields.password,
    'Credential-Only-For-Verification',
  );
  pass('server-enforced vault lock, password verification, and independent article access');

  const archived = await request('/ingest', 'POST', { url: fixtureUrl + '/article', kind: 'knowledge' }, 201);
  assert.equal(archived.item.data.imagesCount, 1);
  assert.ok(archived.item.data.content.includes('/api/media/'));
  assert.ok(!archived.item.data.content.includes('alert('));
  const media = (await db.query('SELECT id, storage_key FROM media WHERE item_id=$1', [archived.item.id]))
    .rows[0];
  assert.deepEqual(fileRead(media.storage_key), png);
  const mediaResponse = await fetch(base + '/media/' + media.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), png);
  assert.equal((await fetch(base + '/media/' + media.id)).status, 401);
  articleVersion = 2;
  const refreshedArticle = await request('/items/' + archived.item.id + '/refresh', 'POST');
  await removed(media.storage_key);
  assert.equal('swaggerEndpoints' in refreshedArticle.item.data, false);
  assert.ok(refreshedArticle.item.data.content.includes('2。'));
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM media WHERE item_id=$1', [archived.item.id])).rows[0]
      .count,
    1,
  );
  await request('/ingest', 'POST', { url: fixtureUrl + '/article' }, 409);
  await request('/ingest', 'POST', { url: 'file:///secret' }, 400);
  await request('/ingest', 'POST', { url: fixtureUrl.replace('127.0.0.1', 'localhost') + '/article' }, 400);
  pass('real HTML capture, offline image bytes, refresh cleanup, deduplication and SSRF protection');

  let apiItem = (
    await request('/ingest', 'POST', { url: fixtureUrl + '/swagger-ui', project: 'InfoHub 验收项目' }, 201)
  ).item;
  assert.equal(apiItem.data.swaggerEndpoints.length, 2);
  assert.equal(apiItem.data.swaggerEndpoints[0].pathParams[0].value, 'order-1001');
  apiItem.data.globalHeaders = [{ key: 'Authorization', value: 'Bearer fixture-only', enabled: true }];
  apiItem.data.fields.customSecret = 'custom-connection-value';
  apiItem.data.description = '用户填写的服务备注';
  apiItem.data.swaggerEndpoints[0].baseUrl = fixtureUrl + '/custom-server';
  apiItem.data.swaggerEndpoints[0].queryParams[0].value = 'user-custom-value';
  apiItem = await request('/items/' + apiItem.id, 'PUT', apiItem);
  spec.paths['/echo/{id}'].patch.parameters.push({
    name: 'tenant',
    in: 'query',
    required: true,
    schema: { type: 'string', example: 'default-tenant' },
  });
  await request('/items/' + apiItem.id + '/refresh', 'POST');
  apiItem = await request('/items/' + apiItem.id);
  assert.equal(apiItem.data.fields.customSecret, 'custom-connection-value');
  assert.equal(apiItem.data.description, '用户填写的服务备注');
  assert.equal(apiItem.data.swaggerEndpoints[0].baseUrl, fixtureUrl + '/custom-server');
  assert.equal(apiItem.data.globalHeaders[0].value, 'Bearer fixture-only');
  assert.equal(
    apiItem.data.swaggerEndpoints[0].queryParams.find((p) => p.key === 'channel').value,
    'user-custom-value',
  );
  assert.equal(
    apiItem.data.swaggerEndpoints[0].queryParams.find((p) => p.key === 'tenant').value,
    'default-tenant',
  );
  const inline = await request(
    '/items',
    'POST',
    {
      kind: 'credential',
      title: '粘贴规范测试',
      data: {
        fields: { swaggerUrl: fixtureUrl + '/openapi.json', apiKey: 'inline-custom-key' },
        importSpec: JSON.stringify(spec),
      },
    },
    201,
  );
  assert.equal(inline.category, 'http');
  assert.equal(inline.data.fields.apiKey, 'inline-custom-key');
  pass('Swagger UI discovery, OpenAPI import, request samples and preserving headers on sync');

  const formSpec = {
    openapi: '3.0.3',
    servers: [{ url: 'https://root.example/unused' }],
    paths: {
      '/echo/form': {
        post: {
          servers: [{ url: fixtureUrl + '/?preset=a%2Fb' }],
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': { example: { username: '用户 & one', password: 'a+b=c' } },
            },
          },
        },
      },
    },
  };
  const formApi = await request(
    '/items',
    'POST',
    { kind: 'credential', title: '表单导入', data: { importSpec: JSON.stringify(formSpec) } },
    201,
  );
  const formEndpoint = formApi.data.swaggerEndpoints[0];
  assert.equal(formEndpoint.baseUrl, fixtureUrl + '/?preset=a%2Fb');
  const formTarget = new URL(formEndpoint.baseUrl);
  formTarget.pathname = formEndpoint.path;
  const formResponse = await request('/probe', 'POST', {
    url: formTarget.toString(),
    method: formEndpoint.method,
    body: formEndpoint.requestBody,
    headers: formEndpoint.customHeaders,
  });
  const formEcho = JSON.parse(formResponse.body);
  assert.equal(new URLSearchParams(formEcho.body).get('username'), '用户 & one');
  assert.equal(new URLSearchParams(formEcho.body).get('password'), 'a+b=c');
  assert.equal(formEcho.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(formEcho.url, '/echo/form?preset=a%2Fb');
  await request('/items/' + formApi.id, 'DELETE', undefined, 204);
  const autoArticle = (await request('/ingest', 'POST', { url: fixtureUrl + '/article-swagger' }, 201))
    .item;
  assert.equal(autoArticle.kind, 'knowledge');
  assert.match(autoArticle.data.content, /SwaggerUIBundle/);
  await request('/items/' + autoArticle.id, 'DELETE', undefined, 204);
  const forcedArticle = (
    await request('/ingest', 'POST', { url: fixtureUrl + '/article-swagger', kind: 'knowledge' }, 201)
  ).item;
  assert.equal(forcedArticle.kind, 'knowledge');
  await request('/items/' + forcedArticle.id, 'DELETE', undefined, 204);
  pass('operation server overrides, encoded form requests and explicit article collection type');

  const searchItem = await request(
    '/items',
    'POST',
    {
      kind: 'repo',
      title: '路径搜索验证',
      category: 'Rust',
      data: {
        localWorkspacePath: 'D:\\项目\\workspace',
        cookbookNotes: '引号 "literal" 和换行\n第二行',
        stars: 0,
      },
    },
    201,
  );
  for (const q of ['D:\\项目\\workspace', '"literal"', '换行\n第二行']) {
    const found = await request('/items?q=' + encodeURIComponent(q));
    assert.equal(found.total, 1);
    assert.equal(found.items[0].id, searchItem.id);
    assert.equal(found.items[0].data.cookbookNotes, undefined);
  }
  assert.equal((await request('/items?kind=repo')).items.find((v) => v.id === searchItem.id).data.stars, 0);
  await request('/items/' + searchItem.id, 'DELETE', undefined, 204);
  pass('literal path, quote and multiline search; list responses omit full bodies');

  const probe = await request('/probe', 'POST', {
    url: fixtureUrl + '/echo/order-1001?channel=web',
    method: 'PATCH',
    headers: [{ key: 'X-Test', value: 'real-request', enabled: true }],
    body: '{"amount":398}',
  });
  assert.equal(probe.status, 201);
  assert.equal(probe.headers['x-fixture'], 'real-http');
  assert.equal(JSON.parse(probe.body).method, 'PATCH');
  assert.equal(JSON.parse(probe.body).headers['x-test'], 'real-request');
  assert.equal(JSON.parse(probe.body).body, '{"amount":398}');
  await request(
    '/probe',
    'POST',
    {
      url: fixtureUrl + '/echo',
      method: 'GET',
      headers: [{ key: 'Host', value: 'evil.test', enabled: true }],
    },
    400,
  );
  await request('/missing', 'GET', undefined, 404);
  pass('real upstream HTTP method, headers, body, response status and duration');

  await stopServer();
  await boot();
  await request('/items', 'GET', undefined, 401);
  token = (await request('/auth/login', 'POST', { password })).token;
  assert.equal(
    (await request('/items/' + credential.id)).data.fields.password,
    'Credential-Only-For-Verification',
  );
  assert.equal((await request('/health')).initialized, true);
  const persistedDownload = await fetch(base + '/attachments/' + attachment.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(await persistedDownload.text(), 'attachment-private-content');
  pass('server restart persistence and session invalidation');

  await request('/items/' + inline.id, 'DELETE', undefined, 204);
  await request('/attachments/' + attachment.id, 'DELETE', undefined, 204);
  await removed(storedAttachment.storage_key);
  assert.equal((await request('/items/' + credential.id + '/attachments')).length, 0);
  pass('item and attachment deletion');

  const bulk = [];
  for (let i = 0; i < 205; i++) {
    bulk.push(
      await request(
        '/items',
        'POST',
        {
          kind: 'knowledge',
          title: '分页验收 ' + String(i).padStart(3, '0'),
          category: 'note',
          project: '分页验收',
          tags: [' pagination ', 'pagination'],
          favorite: i < 4,
          data: { content: 'bulk-body-' + i },
        },
        201,
      ),
    );
  }
  const firstPage = await request('/items?q=' + encodeURIComponent('分页验收') + '&limit=100');
  const secondPage = await request('/items?q=' + encodeURIComponent('分页验收') + '&limit=100&offset=100');
  const lastPage = await request('/items?q=' + encodeURIComponent('分页验收') + '&limit=100&offset=200');
  assert.equal(firstPage.total, 205);
  assert.deepEqual([firstPage.items.length, secondPage.items.length, lastPage.items.length], [100, 100, 5]);
  assert.equal(
    new Set([...firstPage.items, ...secondPage.items, ...lastPage.items].map((i) => i.id)).size,
    205,
  );
  assert.equal(
    (
      await request(
        '/items?kind=knowledge&category=note&project=' + encodeURIComponent('分页验收') + '&favorite=true',
      )
    ).total,
    4,
  );
  assert.deepEqual(firstPage.items[0].tags, ['pagination']);
  assert.equal(
    firstPage.dimensions.filter((d) => d.project === '分页验收').reduce((n, d) => n + d.count, 0),
    205,
  );
  pass('205-row pagination without duplicates, combined filters, dimensions and tag normalization');

  for (const invalid of [
    { kind: 'invalid', title: 'bad' },
    { kind: 'knowledge', title: '   ' },
    { kind: 'knowledge', title: 'x'.repeat(501) },
    { kind: 'knowledge', title: 'bad', url: 'javascript:alert(1)' },
    { kind: 'knowledge', title: 'bad', tags: Array(51).fill('tag') },
  ])
    await request('/items', 'POST', invalid, 400);
  await request('/items/' + article.id, 'PUT', { ...article, revision: undefined }, 400);
  await request('/items/' + article.id, 'PUT', { ...article, kind: 'repo' }, 409);
  await request('/items/' + repo.id + '/refresh', 'POST', undefined, 400);
  await request('/items?q=' + 'a'.repeat(501), 'GET', undefined, 400);
  pass('invalid types, empty/oversized titles, unsafe URLs, missing revisions and absent sync sources');

  for (const reference of ['https://example.com/external.json#/User', '#/components/schemas/Missing']) {
    const broken = {
      openapi: '3.0.3',
      info: { title: 'Broken' },
      paths: {
        '/test': {
          post: { requestBody: { content: { 'application/json': { schema: { $ref: reference } } } } },
        },
      },
    };
    await request(
      '/items',
      'POST',
      { kind: 'credential', title: 'Broken import', data: { importSpec: JSON.stringify(broken) } },
      400,
    );
  }
  await request(
    '/items',
    'POST',
    { kind: 'credential', title: 'Bad version', data: { importSpec: '{"openapi":"4.0","paths":{}}' } },
    400,
  );
  const yaml = await request(
    '/items',
    'POST',
    {
      kind: 'credential',
      title: 'YAML 验收',
      data: {
        importSpec:
          'swagger: "2.0"\ninfo:\n  title: Legacy\nhost: example.com\nbasePath: /v1\nconsumes: [text/plain]\npaths:\n  /message:\n    post:\n      parameters:\n        - in: body\n          name: body\n          schema:\n            type: string\n            example: hello\n',
      },
    },
    201,
  );
  assert.equal(yaml.data.swaggerEndpoints[0].customHeaders[0].value, 'text/plain');
  assert.equal(yaml.data.swaggerEndpoints[0].requestBody, 'hello');
  await request('/items/' + yaml.id, 'DELETE', undefined, 204);
  pass('nested invalid OpenAPI refs rejected; Swagger 2 YAML import and declared Content-Type');

  const binary = await request('/probe', 'POST', { url: fixtureUrl + '/image.png', method: 'GET' });
  assert.equal(binary.body, '');
  assert.deepEqual(Buffer.from(binary.bodyBase64, 'base64'), png);
  const head = await request('/probe', 'POST', { url: fixtureUrl + '/health', method: 'HEAD' });
  assert.equal(head.size, 0);
  assert.equal(head.body, '');
  assert.equal((await request('/probe', 'POST', { url: fixtureUrl + '/too-large', method: 'HEAD' })).size, 0);
  const noBody = await request('/probe', 'POST', {
    url: fixtureUrl + '/echo',
    method: 'GET',
    body: 'must-not-send',
  });
  assert.equal(JSON.parse(noBody.body).body, '');
  assert.equal(
    (await request('/probe', 'POST', { url: fixtureUrl + '/unavailable', method: 'GET' })).status,
    503,
  );
  for (const change of [
    { method: 'CONNECT' },
    { headers: [{ key: 'X-Test', value: 'bad\r\nvalue' }] },
    { headers: [{ key: 'bad name', value: 'x' }] },
    { body: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { url: fixtureUrl + '/too-large' },
    { url: 'ftp://example.com/file' },
  ])
    await request('/probe', 'POST', { url: fixtureUrl + '/echo', method: 'POST', ...change }, 400);
  const headersProbe = await request('/probe', 'POST', {
    url: fixtureUrl + '/echo',
    method: 'OPTIONS',
    headers: [
      { key: 'X-Same', value: 'old' },
      { key: 'x-same', value: 'new' },
      { key: 'X-Off', value: 'hidden', enabled: false },
    ],
  });
  assert.equal(JSON.parse(headersProbe.body).headers['x-same'], 'new');
  assert.equal(JSON.parse(headersProbe.body).headers['x-off'], undefined);
  pass(
    'lossless binary response, HEAD/OPTIONS, upstream errors, header validation and body/response size limits',
  );

  for (const path of ['/redirect-private', '/unavailable', '/bad-article']) {
    const count = (await request('/items')).total;
    await request('/ingest', 'POST', { url: fixtureUrl + path }, 400);
    assert.equal((await request('/items')).total, count);
  }
  await request('/ingest', 'POST', { url: fixtureUrl + '/article', kind: 'invalid' }, 400);
  pass('blocked redirects, upstream failures and challenge pages never create incomplete assets');

  const fileItem = await request('/items', 'POST', { kind: 'knowledge', title: '附件边界测试' }, 201);
  const large = new FormData();
  const fileBytes = Buffer.alloc(10 * 1024 * 1024, 65);
  large.append('file', new Blob([fileBytes]), '中文 空格.bin');
  const largeFile = await request('/items/' + fileItem.id + '/attachments', 'POST', large, 201);
  const largeDownload = await fetch(base + '/attachments/' + largeFile.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.deepEqual(Buffer.from(await largeDownload.arrayBuffer()), fileBytes);
  const oversized = new FormData();
  oversized.append('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]), 'too-large.bin');
  await request('/items/' + fileItem.id + '/attachments', 'POST', oversized, 400);
  assert.equal((await request('/items/' + fileItem.id + '/attachments')).length, 1);
  await request('/items/' + fileItem.id, 'DELETE', undefined, 204);
  await removed('attachments/' + largeFile.id);
  await request('/attachments/' + largeFile.id, 'GET', undefined, 404);
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM attachments WHERE item_id=$1', [fileItem.id])).rows[0]
      .count,
    0,
  );
  pass('10 MB attachment boundary, exact bytes, oversized rejection and cascading deletion');

  const disposable = await request('/ingest', 'POST', { url: fixtureUrl + '/article?cascade' }, 201);
  const disposableMedia = (await db.query('SELECT id FROM media WHERE item_id=$1', [disposable.item.id]))
    .rows[0].id;
  await request('/items/' + disposable.item.id, 'DELETE', undefined, 204);
  await removed('media/' + disposableMedia);
  await request('/media/' + disposableMedia, 'GET', undefined, 404);
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM media WHERE item_id=$1', [disposable.item.id]))
      .rows[0].count,
    0,
  );
  assert.equal((await request('/items/' + archived.item.id)).data.imagesCount, 1);
  pass('deleting an article cascades its media without affecting other archived articles');

  const integrityForm = new FormData();
  integrityForm.append('file', new Blob(['storage-integrity']), '../same-name.txt');
  const integrity = await request('/items/' + article.id + '/attachments', 'POST', integrityForm, 201);
  const integrityKey = 'attachments/' + integrity.id;
  assert.deepEqual(fileRead(integrityKey), Buffer.from('storage-integrity'));
  if (r2) r2.objects.set(integrityKey, Buffer.from('STORAGE-INTEGRITY'));
  else writeFileSync(resolve(storageRoot, integrityKey), 'STORAGE-INTEGRITY');
  await request('/attachments/' + integrity.id, 'GET', undefined, 503);
  if (r2) r2.objects.delete(integrityKey);
  else rmSync(resolve(storageRoot, integrityKey));
  await request('/attachments/' + integrity.id, 'GET', undefined, 503);
  await request('/attachments/' + integrity.id, 'DELETE', undefined, 204);
  pass('missing or corrupted external files produce a controlled error; missing-file deletion is idempotent');

  if (r2) {
    r2.failPut = true;
    const failed = new FormData();
    failed.append('file', new Blob(['failed-upload']), 'failed.txt');
    await request('/items/' + article.id + '/attachments', 'POST', failed, 503);
    assert.equal((await request('/items/' + article.id + '/attachments')).length, 0);
    r2.failPut = false;
    const retryForm = new FormData();
    retryForm.append('file', new Blob(['delete-retry']), 'retry.txt');
    const retry = await request('/items/' + article.id + '/attachments', 'POST', retryForm, 201);
    r2.failDelete = true;
    await request('/attachments/' + retry.id, 'DELETE', undefined, 204);
    assert.equal(fileExists('attachments/' + retry.id), true);
    await request('/attachments/' + retry.id, 'GET', undefined, 404);
    await waitFor(
      async () =>
        (
          await db.query('SELECT cleanup_attempts FROM file_objects WHERE key=$1', [
            'attachments/' + retry.id,
          ])
        ).rows[0]?.cleanup_attempts > 0,
      'Deletion failure was not queued',
    );
    r2.failDelete = false;
    await db.query('UPDATE file_objects SET delete_after=now() WHERE delete_after IS NOT NULL');
    await stopServer();
    await boot();
    token = (await request('/auth/login', 'POST', { password })).token;
    await removed('attachments/' + retry.id);
    await waitFor(
      async () =>
        (await db.query('SELECT count(*)::int AS n FROM file_objects WHERE delete_after IS NOT NULL')).rows[0]
          .n === 0,
      'Garbage queue did not drain',
    );
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM file_objects WHERE delete_after IS NOT NULL')).rows[0]
        .n,
      0,
    );
    assert.deepEqual(r2.errors, []);
    assert.ok(r2.requests > 20);
    pass(
      'R2 SigV4 protocol, failed writes, durable deletion retries and abandoned-upload cleanup after restart',
    );
    const slowForm = new FormData();
    slowForm.append('file', new Blob(['slow-delete']), 'slow.txt');
    const slowFile = await request('/items/' + article.id + '/attachments', 'POST', slowForm, 201);
    r2.deleteDelayMs = 6000;
    const started = Date.now();
    await request('/attachments/' + slowFile.id, 'DELETE', undefined, 204);
    assert.ok(Date.now() - started < 2000, 'Slow storage must not block the deletion HTTP response');
    await request('/attachments/' + slowFile.id, 'GET', undefined, 404);
    await removed('attachments/' + slowFile.id);
    r2.deleteDelayMs = 0;
    pass('R2 deletes longer than five seconds finish in the background without blocking the user');
  } else {
    // A duplicate ingest staged an image before the SQL unique constraint rejected it.
    await db.query('UPDATE file_objects SET delete_after=now() WHERE delete_after IS NOT NULL');
    const abandoned = (await db.query('SELECT key FROM file_objects WHERE delete_after IS NOT NULL LIMIT 1'))
      .rows[0];
    assert.ok(abandoned);
    const staging = resolve(storageRoot, abandoned.key + '#99');
    writeFileSync(staging, 'interrupted atomic write');
    await stopServer();
    await boot();
    token = (await request('/auth/login', 'POST', { password })).token;
    await waitFor(
      async () =>
        (await db.query('SELECT count(*)::int AS n FROM file_objects WHERE delete_after IS NOT NULL')).rows[0]
          .n === 0,
      'Disk garbage queue did not drain',
    );
    assert.equal(existsSync(staging), false);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM file_objects WHERE delete_after IS NOT NULL')).rows[0]
        .n,
      0,
    );
    pass('abandoned files and interrupted atomic-write staging files are cleaned on restart');
  }

  const originalToken = token;
  token = (await request('/auth/login', 'POST', { password })).token;
  await request('/auth/logout', 'POST', undefined, 204);
  await request('/items', 'GET', undefined, 401);
  token = originalToken;
  assert.equal((await request('/session')).unlocked, true);
  const security = await fetch(base + '/health', { headers: { Origin: 'http://untrusted.example' } });
  assert.equal(security.headers.get('access-control-allow-origin'), null);
  assert.equal(security.headers.get('cache-control'), 'no-store');
  assert.equal(security.headers.get('x-content-type-options'), 'nosniff');
  const allowed = await fetch(base + '/health', { headers: { Origin: 'http://tauri.localhost' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
  pass('logout revokes only its own session; no-store and native/web origin restrictions');
  if (process.env.RUN_NETWORK_TESTS === '1') {
    const github = await request('/ingest', 'POST', { url: 'https://github.com/tokio-rs/axum' }, 201);
    assert.equal(github.item.title, 'tokio-rs/axum');
    assert.ok(github.item.data.stars > 0);
    assert.ok(github.item.data.readme.length > 0);
    pass('live GitHub metadata, release and README capture');
  }
  console.log('\n' + checks + ' integration groups passed against genuine PostgreSQL.');
  if (keep) {
    mkdirSync('.local', { recursive: true });
    const stopFile = resolve('.local', dbName + '.stop');
    writeFileSync(
      '.local/verification.json',
      JSON.stringify({ url: base.slice(0, -4), password, database: dbName, fixtureUrl, stopFile }, null, 2),
      { mode: 0o600 },
    );
    console.log(
      'UI verification server available at ' +
        base.slice(0, -4) +
        '; isolated test credentials in .local/verification.json.',
    );
    await new Promise((resolveKeep) => {
      const finish = () => {
        clearInterval(watcher);
        resolveKeep();
      };
      const watcher = setInterval(() => {
        if (existsSync(stopFile)) finish();
      }, 250);
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    });
    if (existsSync(stopFile)) rmSync(stopFile);
  }
} finally {
  await cleanup();
}
