import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createWorkspace } from './test-workspace.mjs';

const run = promisify(execFile);
const a = await createWorkspace();
const password = 'InfoHub-tokens-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const as =
  (token) =>
  (path, method = 'GET', body, status = 200) =>
    a.request(path, method, body, status, token);
try {
  await a.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  const note = await a.request(
    '/items',
    'POST',
    {
      kind: 'knowledge',
      title: '调度器原理',
      category: 'note',
      project: '',
      tags: ['rust'],
      summary: '',
      url: '',
      favorite: false,
      data: { content: '工作窃取调度器的实现细节。' },
    },
    201,
  );
  const secret = await a.request(
    '/items',
    'POST',
    {
      kind: 'credential',
      title: '数据库',
      category: 'database',
      project: '',
      tags: [],
      summary: '',
      url: '',
      favorite: false,
      data: { fields: { host: 'db.local', password: 'credential-secret-marker' } },
    },
    201,
  );

  await a.request('/tokens', 'POST', { name: '', scopes: ['read'] }, 400);
  await a.request('/tokens', 'POST', { name: 'x', scopes: ['admin'] }, 400);
  await a.request('/tokens', 'POST', { name: 'x', scopes: ['read'], expiresInDays: 0 }, 400);
  const read = await a.request('/tokens', 'POST', { name: '只读', scopes: ['read'], expiresInDays: 30 }, 201);
  const write = await a.request('/tokens', 'POST', { name: '读写', scopes: ['write', 'read'] }, 201);
  assert.match(read.token, /^ihp_[0-9a-f]{64}$/);
  assert.deepEqual(write.scopes, ['read', 'write']);
  assert.ok(read.expiresAt);
  const rows = (await a.db.query('SELECT token_hash FROM api_tokens')).rows.map((r) => r.token_hash);
  assert.ok(rows.includes(createHash('sha256').update(read.token).digest('hex')));
  assert.ok(!JSON.stringify(await a.db.query('SELECT * FROM api_tokens')).includes(read.token));
  const listed = await a.request('/tokens');
  assert.ok(!JSON.stringify(listed).includes(read.token.slice(12)));
  pass('tokens are validated, shown once and stored only as SHA-256');

  const r = as(read.token);
  const found = await r('/items?q=调度');
  assert.equal(found.items[0].id, note.id);
  assert.equal((await r('/items/' + note.id)).data.content, '工作窃取调度器的实现细节。');
  await r('/items/' + secret.id, 'GET', undefined, 423);
  assert.ok(!JSON.stringify(await r('/items?kind=credential')).includes('credential-secret-marker'));
  await r('/items', 'POST', { kind: 'knowledge', title: 'x', data: {} }, 403);
  await r('/items/' + note.id, 'PUT', { ...note }, 403);
  await r('/items/' + note.id, 'DELETE', undefined, 403);
  await r('/backup/export', 'POST', { password }, 403);
  await r('/tokens', 'GET', undefined, 403);
  await r('/tokens', 'POST', { name: 'escalate', scopes: ['write'] }, 403);
  await r('/vault/password', 'POST', { currentPassword: password, newPassword: 'x'.repeat(12) }, 403);
  await r('/items/' + note.id + '/export', 'GET', undefined, 403);
  const w = as(write.token);
  const created = await w(
    '/items',
    'POST',
    { kind: 'knowledge', title: '令牌笔记', category: 'note', data: { content: '来自脚本' } },
    201,
  );
  assert.equal(created.title, '令牌笔记');
  await w(
    '/items',
    'POST',
    { kind: 'credential', title: '令牌凭据', category: 'database', data: { fields: { password: 'p' } } },
    423,
  );
  const job = await w(
    '/jobs',
    'POST',
    { url: 'https://example.invalid/x', kind: '', project: '', tags: [], requestId: randomUUID() },
    202,
  );
  assert.ok(job.id);
  assert.ok((await a.request('/tokens')).tokens.find((t) => t.id === read.id).lastUsedAt);
  pass('scopes and the route allowlist are enforced; tokens never unlock encrypted credential data');

  const mcp = (token, body, status = 200) => a.request('/mcp', 'POST', body, status, token);
  const init = await mcp(read.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const old = await mcp(read.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(old.result.protocolVersion, '2025-06-18');
  assert.equal(
    (await a.raw('/mcp', 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, read.token)).status,
    202,
  );
  const tools = await mcp(read.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(
    tools.result.tools.map((t) => t.name),
    ['search_items', 'get_item', 'save_url', 'create_note'],
  );
  const search = await mcp(read.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_items', arguments: { query: '调度' } },
  });
  assert.equal(search.result.isError, false);
  assert.equal(search.result.structuredContent.items[0].id, note.id);
  assert.match(search.result.content[0].text, /调度器原理/);
  const get = await mcp(read.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_item', arguments: { id: note.id } },
  });
  assert.equal(get.result.structuredContent.content, '工作窃取调度器的实现细节。');
  const denied = await mcp(read.token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'create_note', arguments: { title: 'x', content: 'y' } },
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /write/);
  const made = await mcp(write.token, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'create_note', arguments: { title: 'MCP 笔记', content: '正文', tags: ['mcp'] } },
  });
  assert.equal(made.result.isError, false);
  const saved = await mcp(write.token, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'save_url', arguments: { url: 'https://example.invalid/y' } },
  });
  assert.equal(saved.result.structuredContent.queued, true);
  const unknown = await mcp(read.token, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'rm_rf', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
  assert.equal((await mcp(read.token, { jsonrpc: '2.0', id: 9, method: 'nope' })).error.code, -32601);
  const batch = await mcp(read.token, [
    { jsonrpc: '2.0', id: 10, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/x' },
  ]);
  assert.equal(batch.length, 1);
  await a.request('/mcp', 'GET', undefined, 405, read.token);
  pass('MCP initialize/tools/list/tools/call work with per-tool scopes and JSON-RPC errors');

  const env = { ...process.env, INFOHUB_URL: a.base.replace(/\/api$/, ''), INFOHUB_TOKEN: write.token };
  const cli = await run(process.execPath, ['cli/infohub.mjs', 'search', '调度'], { env });
  assert.match(cli.stdout, new RegExp(note.id));
  const cliNote = await run(
    process.execPath,
    ['cli/infohub.mjs', 'note', 'CLI 笔记', '命令行正文', '--tag', 'cli'],
    { env },
  );
  assert.match(cliNote.stdout, /已创建笔记/);
  const shown = await run(process.execPath, ['cli/infohub.mjs', 'get', note.id], { env });
  assert.match(shown.stdout, /工作窃取/);
  pass('the CLI searches, reads and creates notes with a token');

  await a.request('/tokens/' + read.id, 'DELETE', undefined, 204);
  await a.request('/tokens/' + read.id, 'DELETE', undefined, 404);
  await r('/items', 'GET', undefined, 401);
  await a.db.query("UPDATE api_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [write.id]);
  await w('/items', 'GET', undefined, 401);
  const after = (await a.request('/tokens')).tokens;
  assert.ok(after.find((t) => t.id === read.id).revokedAt);
  assert.equal(after.find((t) => t.id === write.id).expired, true);
  await a.request('/items', 'GET', undefined, 401, 'ihp_' + '0'.repeat(64));
  pass('revoked and expired tokens are rejected immediately');
} catch (error) {
  console.error(a.log);
  throw error;
} finally {
  await a.close();
}
