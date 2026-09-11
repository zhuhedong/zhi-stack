import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWorkspace, eventually } from './test-workspace.mjs';

const a = await createWorkspace();
const b = await createWorkspace();
const password = 'InfoHub-api-workspace-password';
let groups = 0;
const pass = (value) => console.log(`PASS ${++groups}: ${value}`);
let calls = 0;
const source = createServer(async (req, res) => {
  calls++;
  if (req.url === '/slow') {
    req.on('close', () => res.destroy());
    return;
  }
  if (req.url === '/large') {
    res.end('\x01'.repeat(2 * 1024 * 1024));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({ authorization: req.headers.authorization, body, secret: 'private-response-marker' }),
  );
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const url = `http://127.0.0.1:${source.address().port}`;
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  const data = {
    typeKey: 'rest',
    fields: { baseUrl: '{{base}}' },
    environments: [
      {
        id: 'staging',
        name: '预发',
        variables: [
          { key: 'base', value: url, enabled: true },
          { key: 'token', value: 'private-request-marker', enabled: true },
        ],
      },
    ],
    activeEnvironment: 'staging',
  };
  const item = await a.request(
    '/items',
    'POST',
    { kind: 'credential', category: 'http', title: '接口工作区', data },
    201,
  );
  const requestId = randomUUID();
  const request = {
    url,
    method: 'POST',
    headers: [{ key: 'Authorization', value: 'private-request-marker', enabled: true }],
    body: '{"message":"你好"}',
    itemId: item.id,
    requestId,
    environment: '预发',
  };
  const result = await a.request('/probe', 'POST', request);
  assert.equal(result.status, 200);
  const detail = await a.request(`/items/${item.id}/requests/${requestId}`);
  assert.equal(detail.request.body, request.body);
  assert.equal(detail.response.body, result.body);
  assert.equal(detail.status, 'completed');
  const stored = (await a.db.query('SELECT payload FROM api_history WHERE id=$1', [requestId])).rows[0]
    .payload;
  assert.ok(!stored.includes(Buffer.from('private-request-marker')));
  assert.ok(!stored.includes(Buffer.from('private-response-marker')));
  await a.request('/probe', 'POST', request, 409);
  const list = await a.request(`/items/${item.id}/requests`);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].environment, '预发');
  await a.request('/vault/lock', 'POST');
  await a.request(`/items/${item.id}/requests`, 'GET', undefined, 423);
  await a.request(`/items/${item.id}/requests/${requestId}`, 'GET', undefined, 423);
  await a.request('/vault/unlock', 'POST', { password });
  pass(
    'environment and complete request/response history remain encrypted; locked sessions cannot read them',
  );

  const earlyId = randomUUID();
  const before = calls;
  await a.request(`/items/${item.id}/requests/${earlyId}/cancel`, 'POST', undefined, 204);
  await a.request('/probe', 'POST', { ...request, requestId: earlyId }, 408);
  assert.equal(calls, before);
  const slowId = randomUUID();
  const slow = a.raw('/probe', 'POST', { ...request, url: url + '/slow', requestId: slowId });
  await eventually(
    async () =>
      (await a.request(`/items/${item.id}/requests`)).items.some(
        (row) => row.id === slowId && row.status === 'running',
      ),
    'request was not recorded before execution',
  );
  const started = Date.now();
  await a.request(`/items/${item.id}/requests/${slowId}/cancel`, 'POST', undefined, 204);
  assert.equal((await slow).status, 408);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await a.request(`/items/${item.id}/requests/${slowId}`)).status, 'cancelled');
  await a.request(`/items/${item.id}/requests/${slowId}`, 'DELETE', undefined, 204);
  await a.request(`/items/${item.id}/requests/${slowId}`, 'GET', undefined, 404);
  pass(
    'cancel-before-start sends no traffic; cancelling an active request interrupts I/O and prevents late results',
  );

  const largeId = randomUUID();
  await a.request('/probe', 'POST', { ...request, url: url + '/large', method: 'GET', requestId: largeId });
  assert.equal((await a.request(`/items/${item.id}/requests/${largeId}`)).response.truncated, true);
  // Simulate a process dying after recording the request but before finishing it.
  await a.db.query("UPDATE api_history SET status='running' WHERE id=$1", [earlyId]);
  await a.stop();
  await a.boot();
  a.token = (await a.request('/auth/login', 'POST', { password })).token;
  assert.equal((await a.request(`/items/${item.id}/requests/${earlyId}`)).status, 'interrupted');
  pass(
    'large escaped responses are bounded in history; restart marks unfinished requests without replaying side effects',
  );

  const nextPassword = password + '-rotated';
  const oldToken = a.token;
  a.token = (
    await a.request('/vault/password', 'POST', { currentPassword: password, newPassword: nextPassword })
  ).token;
  await a.request('/session', 'GET', undefined, 401, oldToken);
  assert.equal(
    (await a.request(`/items/${item.id}/requests/${requestId}`)).request.headers[0].value,
    'private-request-marker',
  );
  const backup = await a.raw('/backup/export', 'POST', { password: nextPassword });
  assert.equal(backup.status, 200);
  const form = new FormData();
  form.set('password', nextPassword);
  form.set('confirm', '恢复并替换');
  form.set('backup', new Blob([await backup.arrayBuffer()]), 'api.infohub');
  await b.request('/backup/restore', 'POST', form);
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.deepEqual((await b.request('/items/' + item.id)).data.environments, data.environments);
  assert.equal((await b.request(`/items/${item.id}/requests/${requestId}`)).response.body, result.body);
  await b.request('/probe', 'POST', {
    ...detail.request,
    itemId: item.id,
    requestId: randomUUID(),
    environment: detail.environment,
  });
  pass(
    'rekey, clean-instance restore and replay preserve environments and encrypted history, including bounded large responses',
  );
  console.log(`${groups} API workspace groups passed.`);
} finally {
  source.closeAllConnections();
  await new Promise((resolve) => source.close(resolve));
  await a.close();
  await b.close();
}
