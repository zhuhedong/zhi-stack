import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWorkspace, eventually } from './test-workspace.mjs';

let release = 'v1';
const received = [];
let robotError = false;
const source = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/repos/test/demo')) {
    if (req.url.endsWith('/releases/latest'))
      return res.end(
        JSON.stringify({
          tag_name: release,
          published_at: '2026-09-11T00:00:00Z',
          html_url: `https://github.com/test/demo/releases/tag/${release}`,
          body: `release ${release} notes`,
        }),
      );
    if (req.url.endsWith('/readme')) return res.end('# Fixture');
    return res.end(
      JSON.stringify({
        full_name: 'test/demo',
        html_url: 'https://github.com/test/demo',
        description: 'fixture',
        pushed_at: '2026-09-10T00:00:00Z',
      }),
    );
  }
  if (req.method === 'POST') {
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    if (robotError && req.url.startsWith('/wecom'))
      return res.end('{"errcode":93000,"errmsg":"invalid webhook url"}');
    if (req.url.startsWith('/bot')) return res.end('{"ok":true}');
    return res.end('{"errcode":0,"code":0}');
  }
  res.writeHead(404);
  res.end('{}');
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const url = `http://127.0.0.1:${source.address().port}`;

// Minimal SMTP sink (plain, AUTH PLAIN/LOGIN accepted).
const mails = [];
const smtp = createTcp((socket) => {
  let data = false;
  let message = '';
  let auth = '';
  socket.write('220 test ESMTP\r\n');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (data) {
        if (line === '.') {
          data = false;
          mails.push({ message, auth });
          socket.write('250 queued\r\n');
        } else message += line + '\n';
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd.startsWith('AUTH PLAIN')) {
        auth = Buffer.from(line.slice(11), 'base64').toString();
        socket.write('235 ok\r\n');
      } else if (cmd === 'DATA') {
        data = true;
        socket.write('354 go\r\n');
      } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
smtp.listen(0, '127.0.0.1');
await once(smtp, 'listening');

const a = await createWorkspace({ GITHUB_API_BASE: url, GITHUB_TOKEN: '', TELEGRAM_API_BASE: url });
const password = 'InfoHub-notify-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const botToken = '123456:' + 'A'.repeat(35);
try {
  await a.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;

  await a.request('/notifications/channels', 'POST', { name: 'x', kind: 'sms', secret: {} }, 400);
  await a.request(
    '/notifications/channels',
    'POST',
    { name: '企微', kind: 'wecom', secret: { url: 'http://example.com/hook' } },
    400,
  );
  await a.request(
    '/notifications/channels',
    'POST',
    { name: 'TG', kind: 'telegram', config: { chatId: '1' }, secret: { botToken: 'bad' } },
    400,
  );
  const make = (name, kind, secret, config = {}) =>
    a.request('/notifications/channels', 'POST', { name, kind, config, secret }, 201);
  const generic = await make('通用', 'webhook', {
    url: url + '/generic?key=hook-secret-marker',
    signing: 'sign-key',
  });
  const wecom = await make('企业微信', 'wecom', { url: url + '/wecom?key=wecom-secret-marker' });
  await make('钉钉', 'dingtalk', {
    url: url + '/dingtalk?access_token=ding-secret-marker',
    signing: 'SECding',
  });
  await make('飞书', 'feishu', { url: url + '/feishu/hook-feishu-marker', signing: 'feishu-sign' });
  await make('Telegram', 'telegram', { botToken }, { chatId: '-1001' });
  const smtpPort = smtp.address().port;
  await make(
    '邮件',
    'email',
    { password: 'smtp-secret-marker' },
    {
      host: '127.0.0.1',
      port: smtpPort,
      security: 'none',
      username: 'bot',
      from: 'InfoHub <bot@example.com>',
      to: 'me@example.com',
    },
  );
  const listed = await a.request('/notifications/channels');
  assert.equal(listed.channels.length, 6);
  const text = JSON.stringify(listed);
  for (const marker of [
    'hook-secret-marker',
    'wecom-secret-marker',
    'ding-secret-marker',
    'hook-feishu-marker',
    'AAAAAAAA',
    'smtp-secret-marker',
    'sign-key',
  ])
    assert.ok(!text.includes(marker), 'secret leaked in listing: ' + marker);
  assert.equal(listed.channels.find((c) => c.kind === 'wecom').secret.urlHost, '127.0.0.1');
  const raw = (await a.db.query('SELECT secret FROM notification_channels')).rows
    .map((r) => r.secret.toString('latin1'))
    .join('');
  assert.ok(!raw.includes('marker') && !raw.includes('AAAAAAAA'));
  pass('channels validate input; secrets are encrypted at rest and never returned');

  await a.request(`/notifications/channels/${generic.id}/test`, 'POST');
  const test = received.pop();
  assert.equal(test.url, '/generic?key=hook-secret-marker');
  assert.equal(test.body.event, 'release');
  const expected =
    'sha256=' + createHmac('sha256', 'sign-key').update(JSON.stringify(test.body)).digest('hex');
  assert.equal(test.headers['x-infohub-signature'], expected);
  // Update keeps stored secret when omitted.
  await a.request(`/notifications/channels/${generic.id}`, 'PUT', {
    name: '通用 2',
    kind: 'webhook',
    enabled: true,
  });
  await a.request(`/notifications/channels/${generic.id}/test`, 'POST');
  assert.equal(received.pop().url, '/generic?key=hook-secret-marker');
  await a.request(`/notifications/channels/${generic.id}`, 'PUT', { name: '通用', kind: 'wecom' }, 400);
  pass('test sends work; generic webhooks are HMAC-signed; updates keep omitted secrets');

  robotError = true;
  await a.request(`/notifications/channels/${wecom.id}/test`, 'POST', undefined, 400);
  robotError = false;
  const afterError = (await a.request('/notifications/channels')).channels.find((c) => c.id === wecom.id);
  assert.equal(afterError.lastStatus, 'failed');
  assert.match(afterError.lastError, /invalid webhook url/);
  received.length = 0;
  pass('robot-level errors (errcode != 0) are surfaced and recorded');

  const job = await a.request(
    '/jobs',
    'POST',
    { url: 'https://github.com/test/demo', kind: 'repo', project: '', tags: [], requestId: randomUUID() },
    202,
  );
  await eventually(
    async () => (await a.request('/jobs')).find((j) => j.id === job.id)?.status === 'succeeded',
    'repo not collected',
    30000,
  );
  const repoId = (await a.request('/jobs')).find((j) => j.id === job.id).itemId;
  await a.request(
    `/items/${repoId}/subscription`,
    'PUT',
    { enabled: true, intervalHours: 1, revision: 0 },
    204,
  );
  await eventually(
    async () => (await a.request(`/items/${repoId}/subscription`)).checks.length === 1,
    'first check',
    30000,
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(received.length, 0, 'the first observation must not notify');
  release = 'v2';
  await a.request(`/items/${repoId}/subscription/check`, 'POST', undefined, 202);
  await eventually(
    async () => received.length >= 5 && mails.length >= 1,
    'notifications not delivered: ' + JSON.stringify(received.map((r) => r.url)),
    30000,
  );
  const by = (prefix) => received.find((r) => r.url.startsWith(prefix));
  assert.equal(by('/generic').body.release, 'v2');
  assert.equal(by('/generic').body.url, 'https://github.com/test/demo/releases/tag/v2');
  assert.equal(by('/wecom').body.msgtype, 'markdown');
  assert.match(by('/wecom').body.markdown.content, /v2/);
  const ding = by('/dingtalk');
  const params = new URL(url + ding.url).searchParams;
  const ts = params.get('timestamp');
  assert.equal(params.get('sign'), createHmac('sha256', 'SECding').update(`${ts}\nSECding`).digest('base64'));
  assert.equal(ding.body.msgtype, 'markdown');
  const feishu = by('/feishu');
  assert.equal(feishu.body.msg_type, 'text');
  assert.equal(
    feishu.body.sign,
    createHmac('sha256', `${feishu.body.timestamp}\nfeishu-sign`).update('').digest('base64'),
  );
  const tg = by('/bot');
  assert.equal(tg.url, `/bot${botToken}/sendMessage`);
  assert.equal(tg.body.chat_id, '-1001');
  assert.match(tg.body.text, /v2/);
  assert.match(mails[0].message, /Subject: =\?utf-8\?|Subject: .*v2/i);
  assert.match(mails[0].auth, /bot\0smtp-secret-marker/);
  pass(
    'a new release notifies every enabled channel in its native format (WeCom, DingTalk signed, Feishu signed, Telegram, SMTP)',
  );

  await a.request(`/notifications/channels/${wecom.id}`, 'DELETE', undefined, 204);
  await a.request(`/notifications/channels/${wecom.id}`, 'DELETE', undefined, 404);
  await a.request('/notifications/channels', 'GET', undefined, 401, '');
  pass('channels can be deleted; endpoints require a session');
} catch (error) {
  console.error(a.log);
  throw error;
} finally {
  await a.close();
  source.close();
  smtp.close();
}
