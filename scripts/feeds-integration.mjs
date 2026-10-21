import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWorkspace, eventually } from './test-workspace.mjs';

let posts = [1, 2, 3];
let broken = false;
const source = createServer((req, res) => {
  const base = `http://127.0.0.1:${source.address().port}`;
  if (req.url === '/rss.xml') {
    if (broken) {
      res.writeHead(500);
      return res.end('down');
    }
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    const items = [...posts]
      .reverse()
      .map((n) => `<item><title>文章 ${n}</title><link>${base}/post/${n}</link><guid>post-${n}</guid></item>`)
      .join('');
    return res.end(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>测试博客</title><link>${base}/</link>${items}</channel></rss>`,
    );
  }
  if (req.url === '/atom.xml') {
    res.setHeader('Content-Type', 'application/atom+xml');
    return res.end(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 源</title><entry><id>a1</id><title>A1</title><link href="${base}/post/a1"/></entry></feed>`,
    );
  }
  if (req.url === '/page') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<html><title>not a feed</title></html>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<html><title>订阅文章 ${req.url}</title><article><p>${'订阅源自动收录的文章正文。'.repeat(12)}</p></article></html>`,
  );
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const url = `http://127.0.0.1:${source.address().port}`;
const a = await createWorkspace();
const b = await createWorkspace({ ALLOWED_PRIVATE_HOSTS: '' });
const password = 'InfoHub-feeds-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const titles = async () => (await a.request('/items?kind=knowledge')).items.map((item) => item.title).sort();
const settled = async () =>
  (await a.request('/jobs')).every((job) => !['queued', 'running'].includes(job.status));
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  b.token = (await b.request('/auth/setup', 'POST', { password })).token;

  const added = await a.request(
    '/feeds',
    'POST',
    { url: url + '/rss.xml', project: '订阅项目', intervalMinutes: 15, backfill: 2 },
    201,
  );
  assert.equal(added.feed.title, '测试博客');
  assert.equal(added.entries, 3);
  assert.equal(added.queued, 2);
  await a.request('/feeds', 'POST', { url: url + '/rss.xml' }, 409);
  await a.request('/feeds', 'POST', { url: url + '/page' }, 400);
  await eventually(
    async () => (await titles()).length === 2 && (await settled()),
    'backfill not collected',
    30000,
  );
  assert.deepEqual(await titles(), ['订阅文章 /post/2', '订阅文章 /post/3']);
  const note = (await a.request('/items?kind=knowledge')).items[0];
  assert.equal(note.project, '订阅项目');
  pass('adding a feed validates it, rejects duplicates and non-feeds, and backfills the newest entries');

  posts = [1, 2, 3, 4];
  await a.request(`/feeds/${added.feed.id}/check`, 'POST', undefined, 202);
  await eventually(
    async () => (await titles()).length === 3 && (await settled()),
    'new entry not collected',
    30000,
  );
  assert.ok((await titles()).includes('订阅文章 /post/4'));
  await a.request(`/feeds/${added.feed.id}/check`, 'POST', undefined, 202);
  await eventually(
    async () =>
      (await a.request('/feeds'))[0].checking === false && (await a.request('/feeds'))[0].collected === 3,
    'check did not finish',
  );
  await new Promise((done) => setTimeout(done, 500));
  assert.equal((await titles()).length, 3);
  pass('periodic checks queue only unseen entries as ingest jobs');

  broken = true;
  await a.request(`/feeds/${added.feed.id}/check`, 'POST', undefined, 202);
  await eventually(
    async () => (await a.request('/feeds'))[0].lastError.includes('500'),
    'error not recorded',
  );
  broken = false;
  await a.request(
    `/feeds/${added.feed.id}`,
    'PUT',
    { enabled: false, intervalMinutes: 60, project: '订阅项目', tags: [] },
    204,
  );
  await a.request(`/feeds/${added.feed.id}/check`, 'POST', undefined, 400);
  await a.request(`/feeds/${added.feed.id}`, 'PUT', { enabled: true, intervalMinutes: 5, tags: [] }, 400);
  pass('fetch failures are reported; paused feeds are not checked; settings are validated');

  const opml = `<?xml version="1.0"?><opml version="2.0"><body><outline text="g"><outline type="rss" text="Atom 源" xmlUrl="${url}/atom.xml"/><outline xmlUrl="${url}/rss.xml"/><outline xmlUrl="file:///etc/passwd"/></outline></body></opml>`;
  const imported = await (
    await fetch(a.base + '/feeds/opml', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + a.token },
      body: opml,
    })
  ).json();
  assert.deepEqual(imported, { added: 1, skipped: 1, invalid: 1 });
  await eventually(
    async () =>
      (await a.request('/feeds')).some((feed) => feed.url.endsWith('/atom.xml') && feed.lastCheckedAt),
    'imported feed not primed',
  );
  await new Promise((done) => setTimeout(done, 500));
  assert.equal((await titles()).length, 3, 'imported feeds must not collect their backlog');
  const exported = await (await a.raw('/feeds/opml')).text();
  assert.ok(exported.includes(`xmlUrl="${url}/atom.xml"`) && exported.includes('text="测试博客"'));
  pass('OPML import primes feeds without collecting the backlog; export lists all feeds');

  await a.request(`/feeds/${added.feed.id}`, 'DELETE', undefined, 204);
  assert.equal((await a.request('/feeds')).length, 1);
  assert.equal((await titles()).length, 3);
  await a.request(`/feeds/${added.feed.id}`, 'DELETE', undefined, 404);
  pass('removing a feed keeps collected articles');

  const blocked = await b.raw('/feeds', 'POST', { url: url + '/rss.xml' });
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /内网|保留网段/);
  assert.equal((await b.raw('/feeds', 'GET', undefined, '')).status, 401);
  pass('feeds respect the SSRF guard and require a session');
  console.log(`Feed integration passed: ${groups} groups`);
} catch (error) {
  console.error(a.log.slice(-4000));
  throw error;
} finally {
  await a.close();
  await b.close();
  source.close();
}
