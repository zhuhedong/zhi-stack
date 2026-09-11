import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest,
  buildCurl,
  connectionCommand,
  emptyEndpoint,
  endpointPath,
  vscodeFileUrl,
} from '../src/lib/request.ts';
test('path and query encoding, header precedence, and shell quoting survive hostile values', () => {
  const data = {
    fields: { baseUrl: 'https://example.com/v1' },
    globalHeaders: [
      { key: 'Authorization', value: 'global', enabled: true },
      { key: 'X-Disabled', value: 'never', enabled: false },
    ],
  };
  const ep = {
    ...emptyEndpoint(),
    method: 'POST',
    path: '/items/{id}',
    pathParams: [{ key: 'id', value: 'a/b', enabled: true }],
    queryParams: [{ key: 'q', value: 'hello & 中文', enabled: true }],
    customHeaders: [{ key: 'authorization', value: "Bearer don't", enabled: true }],
    requestBody: '{"name":"O\'Brien"}',
  };
  const request = buildRequest(data, ep);
  assert.equal(new URL(request.url).pathname, '/v1/items/a%2Fb');
  assert.equal(new URL(request.url).searchParams.get('q'), 'hello & 中文');
  assert.equal(request.headers.length, 1);
  assert.equal(request.headers[0].value, "Bearer don't");
  const curl = buildCurl(data, ep);
  assert.ok(curl.includes("'\\''"));
  assert.ok(!curl.includes('never'));
  assert.equal(buildRequest(data, { ...ep, method: 'GET' }).body, undefined);
});
test('connection commands do not put database passwords in shell arguments', () => {
  const command = connectionCommand({
    typeKey: 'postgresql',
    fields: { host: "db'host", username: 'reader', database: 'app', password: 'secret-value' },
  });
  assert.ok(command.includes('--password'));
  assert.ok(!command.includes('secret-value'));
  assert.ok(command.includes("'\\''"));
});

test('HEAD cURL uses header-only mode and GET/HEAD suppress the body', () => {
  const data = { fields: { baseUrl: 'https://example.com/' } };
  const ep = { ...emptyEndpoint(), method: 'HEAD', requestBody: 'must-not-send' };
  assert.equal(buildRequest(data, ep).body, undefined);
  assert.match(buildCurl(data, ep), /^curl --head /);
  assert.ok(!buildCurl(data, ep).includes('must-not-send'));
  for (const baseUrl of ['', 'ftp://example.com', 'not-a-url']) {
    assert.throws(() => buildRequest({ fields: { baseUrl } }, emptyEndpoint()));
  }
});

test('all protocol presets generate their documented tools and preserve shell argument boundaries', () => {
  const fields = {
    host: 'db.example',
    username: 'user name',
    database: 'db;name',
    password: 'private-value',
    apiKey: 'key-value',
    url: 'https://example.com/login',
  };
  for (const [typeKey, prefix] of Object.entries({
    postgresql: 'psql ',
    mysql: 'mysql ',
    redis: 'redis-cli ',
    mongodb: 'mongosh ',
    ssh: 'ssh ',
    milvus: 'curl ',
    qdrant: 'curl ',
    account: 'https://',
  })) {
    const command = connectionCommand({ typeKey, fields });
    assert.ok(command.startsWith(prefix), typeKey);
    if (['postgresql', 'mysql', 'redis', 'mongodb', 'ssh'].includes(typeKey))
      assert.ok(!command.includes(fields.password), typeKey);
  }
  assert.match(connectionCommand({ typeKey: 'postgresql', fields }), /--dbname='db;name'/);
});

test('base and endpoint queries retain their values and operation servers override the root', () => {
  const data = { fields: { baseUrl: 'https://root.example/v1/?api_key=a%2Fb' } };
  const ep = {
    ...emptyEndpoint(),
    path: '/echo?fixed=a%26b',
    queryParams: [{ key: 'q', value: '中文 & ?/#', enabled: true }],
  };
  const url = new URL(buildRequest(data, ep).url);
  assert.equal(url.pathname, '/v1/echo');
  assert.equal(url.searchParams.get('api_key'), 'a/b');
  assert.equal(url.searchParams.get('fixed'), 'a&b');
  assert.equal(url.searchParams.get('q'), '中文 & ?/#');
  assert.equal(
    new URL(buildRequest(data, { ...ep, baseUrl: 'https://operation.example/v2' }).url).origin,
    'https://operation.example',
  );
  for (const baseUrl of ['https://user:pass@example.com', 'https://example.com#lost'])
    assert.throws(() => buildRequest({ fields: { baseUrl } }, ep));
});

test('editing routes updates path parameter fields without losing retained values', () => {
  const ep = {
    ...emptyEndpoint(),
    pathParams: [
      { key: 'id', value: '订单/a?b', enabled: true },
      { key: 'old', value: 'remove', enabled: true },
    ],
  };
  const updated = { ...ep, ...endpointPath(ep, '/tenants/{tenant}/orders/{id}/{id}') };
  assert.deepEqual(
    updated.pathParams.map((p) => p.key),
    ['tenant', 'id'],
  );
  assert.equal(updated.pathParams[1].value, '订单/a?b');
  assert.throws(() => buildRequest({ fields: { baseUrl: 'https://example.com' } }, updated), /tenant/);
  updated.pathParams[0].value = 't';
  assert.equal(
    new URL(buildRequest({ fields: { baseUrl: 'https://example.com' } }, updated).url).pathname,
    '/tenants/t/orders/%E8%AE%A2%E5%8D%95%2Fa%3Fb/%E8%AE%A2%E5%8D%95%2Fa%3Fb',
  );
});
test('browser VS Code links keep a usable Windows drive colon', () => {
  assert.equal(vscodeFileUrl('D:/develop/my-project'), 'vscode://file/D:/develop/my-project');
  assert.equal(vscodeFileUrl('D:\\develop\\my-project'), 'vscode://file/D:/develop/my-project');
  assert.ok(!vscodeFileUrl('D:/develop/my-project').includes('D%3A'));
  assert.equal(
    vscodeFileUrl('/home/user/my project'),
    'vscode://file//home/user/my%20project',
  );
});
