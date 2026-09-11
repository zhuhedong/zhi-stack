import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWorkspace, eventually } from './test-workspace.mjs';

let release = 'v1';
let failArticle = true;
let holdRestart = true;
let failRepo = false;
const source = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/slow' || (req.url === '/restart' && holdRestart)) return;
  if (req.url === '/retry' && failArticle) {
    res.writeHead(503);
    res.end('try later');
    return;
  }
  if (req.url.startsWith('/repos/test/demo')) {
    res.setHeader('Content-Type', 'application/json');
    if (failRepo) {
      res.writeHead(503);
      res.end('{}');
      return;
    }
    if (req.url.endsWith('/releases/latest'))
      res.end(
        JSON.stringify({
          tag_name: release,
          published_at: '2026-09-11T00:00:00Z',
          html_url: `https://github.com/test/demo/releases/tag/${release}`,
          body: `release ${release} notes`,
        }),
      );
    else if (req.url.endsWith('/readme')) res.end('# Fixture README');
    else
      res.end(
        JSON.stringify({
          full_name: 'test/demo',
          html_url: 'https://github.com/test/demo',
          language: 'Rust',
          stargazers_count: 42,
          description: 'fixture',
          pushed_at: release === 'v1' ? '2026-09-10T00:00:00Z' : '2026-09-11T00:00:00Z',
        }),
      );
    return;
  }
  if (req.url.startsWith('/openapi')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Private queued API', version: '1' },
        paths: { '/echo': { get: { summary: 'Echo' } } },
      }),
    );
    return;
  }
  res.end(
    `<html><title>队列验收 ${req.url}</title><article><p>${'可离线阅读的文章内容与实际任务背景。'.repeat(10)}</p>${req.url === '/article' ? '<a href="https://github.com/test/demo">文中代码</a>' : ''}</article></html>`,
  );
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const url = `http://127.0.0.1:${source.address().port}`;
const a = await createWorkspace({ GITHUB_API_BASE: url, GITHUB_TOKEN: '' });
const b = await createWorkspace({ GITHUB_API_BASE: url, GITHUB_TOKEN: '' });
const password = 'InfoHub-background-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const enqueue = (path, kind = 'knowledge', requestId = randomUUID()) =>
  a.request('/jobs', 'POST', { url: url + path, kind, project: '队列项目', tags: ['队列'], requestId }, 202);
const get = async (id) => (await a.request('/jobs')).find((job) => job.id === id);
async function wait(id, status) {
  await eventually(
    async () => (await get(id))?.status === status,
    `job ${id} did not reach ${status}: ${JSON.stringify(await get(id))}`,
    30000,
  );
  return get(id);
}
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  const id = randomUUID();
  await enqueue('/article', 'knowledge', id);
  await enqueue('/article', 'knowledge', id);
  const finished = await wait(id, 'succeeded');
  assert.equal(finished.attempts, 1);
  const note = await a.request('/items/' + finished.itemId);
  assert.equal(note.project, '队列项目');
  assert.ok(note.data.content.includes('文中代码'));
  const relations = await a.request(`/items/${note.id}/relations`);
  assert.equal(relations.length, 1);
  const repoId = relations[0].id;
  const duplicate = await enqueue('/article');
  const duplicateDone = await wait(duplicate.id, 'succeeded');
  assert.equal(duplicateDone.itemId, note.id);
  assert.ok(duplicateDone.output.warnings.some((value) => value.includes('已收录')));
  assert.equal((await a.request('/items?kind=knowledge')).total, 1);
  pass('durable ingestion is idempotent, preserves project/tags and captures repository provenance');

  const failed = await enqueue('/retry');
  await wait(failed.id, 'failed');
  failArticle = false;
  await a.request(`/jobs/${failed.id}/retry`, 'POST', undefined, 204);
  assert.equal((await wait(failed.id, 'succeeded')).attempts, 2);
  const cancelled = await enqueue('/slow');
  await wait(cancelled.id, 'running');
  await a.request(`/jobs/${cancelled.id}/cancel`, 'POST', undefined, 204);
  await wait(cancelled.id, 'cancelled');
  assert.equal((await a.request('/items?q=' + encodeURIComponent('/slow'))).total, 0);
  const restarted = await enqueue('/restart');
  await wait(restarted.id, 'running');
  await a.stop();
  holdRestart = false;
  await a.boot();
  a.token = (await a.request('/auth/login', 'POST', { password })).token;
  const resumed = await wait(restarted.id, 'succeeded');
  assert.equal(resumed.attempts, 2);
  assert.equal(
    (await a.db.query('SELECT count(*)::int count FROM items WHERE url=$1', [url + '/restart'])).rows[0]
      .count,
    1,
  );
  pass('failed jobs retry; active work cancels; restart resumes without creating duplicate assets');

  const blocker = await enqueue('/slow');
  await wait(blocker.id, 'running');
  const encrypted = await enqueue('/openapi?token=private-job-marker', '');
  await a.request('/vault/lock', 'POST');
  await a.request(`/jobs/${blocker.id}/cancel`, 'POST', undefined, 204);
  await wait(encrypted.id, 'waiting_unlock');
  const hidden = await get(encrypted.id);
  assert.equal(hidden.input, null);
  const bytes = (await a.db.query('SELECT payload FROM ingest_jobs WHERE id=$1', [encrypted.id])).rows[0]
    .payload;
  assert.ok(!bytes.includes(Buffer.from('private-job-marker')));
  await a.stop();
  await a.boot();
  a.token = (await a.request('/auth/login', 'POST', { password })).token;
  const credentialJob = await wait(encrypted.id, 'succeeded');
  const credential = await a.request('/items/' + credentialJob.itemId);
  assert.equal(credential.kind, 'credential');
  pass(
    'auto/OpenAPI job payloads are encrypted, hidden while locked, and resume after unlocking across restart',
  );

  let repo = await a.request('/items/' + repoId);
  repo = await a.request('/items/' + repoId, 'PUT', {
    ...repo,
    data: { ...repo.data, cookbookNotes: '必须保留的实践笔记' },
  });
  await a.request(
    `/items/${repoId}/subscription`,
    'PUT',
    { enabled: true, intervalHours: 1, revision: 0 },
    204,
  );
  await eventually(
    async () => (await a.request(`/items/${repoId}/subscription`)).checks.length === 1,
    'initial subscription check did not finish',
  );
  let subscription = (await a.request(`/items/${repoId}/subscription`)).subscription;
  assert.equal(subscription.unread, false);
  release = 'v2';
  await a.request(`/items/${repoId}/subscription/check`, 'POST', undefined, 202);
  await eventually(
    async () =>
      (await a.request(`/items/${repoId}/subscription`)).subscription.snapshot.latestRelease === 'v2',
    'manual update did not finish',
  );
  subscription = (await a.request(`/items/${repoId}/subscription`)).subscription;
  assert.equal(subscription.unread, true);
  assert.equal((await a.request('/items/' + repoId)).data.cookbookNotes, '必须保留的实践笔记');
  assert.equal((await a.request('/items/' + repoId)).revision, repo.revision);
  await a.request(`/items/${repoId}/subscription/seen`, 'POST', { signature: subscription.signature }, 204);
  assert.equal((await a.request(`/items/${repoId}/subscription`)).subscription.unread, false);
  release = 'v3';
  await a.db.query('UPDATE repo_subscriptions SET next_check_at=now() WHERE item_id=$1', [repoId]);
  // Persist the schedule and restart. The worker processes the due record without an open client.
  await a.stop();
  await a.boot();
  a.token = (await a.request('/auth/login', 'POST', { password })).token;
  await eventually(
    async () =>
      (await a.request(`/items/${repoId}/subscription`)).subscription.snapshot.latestRelease === 'v3',
    'scheduled check did not survive restart',
    40000,
  );
  failRepo = true;
  await a.request(`/items/${repoId}/subscription/check`, 'POST', undefined, 202);
  await eventually(
    async () => (await a.request(`/items/${repoId}/subscription`)).checks[0].status === 'failed',
    'failed check was not recorded',
  );
  failRepo = false;
  subscription = (await a.request(`/items/${repoId}/subscription`)).subscription;
  assert.equal(subscription.snapshot.latestRelease, 'v3');
  assert.equal(subscription.unread, true);
  await a.request(
    `/items/${repoId}/subscription`,
    'PUT',
    { enabled: false, intervalHours: 1, revision: subscription.revision },
    204,
  );
  await a.request(
    `/items/${repoId}/subscription`,
    'PUT',
    { enabled: false, intervalHours: 1, revision: subscription.revision },
    409,
  );
  pass(
    'subscriptions persist schedules, unread release/push changes and failures while leaving repository notes untouched',
  );

  const nextPassword = password + '-rotated';
  a.token = (
    await a.request('/vault/password', 'POST', { currentPassword: password, newPassword: nextPassword })
  ).token;
  assert.ok((await get(encrypted.id)).input.url.includes('private-job-marker'));
  const backup = await a.raw('/backup/export', 'POST', { password: nextPassword });
  assert.equal(backup.status, 200);
  const form = new FormData();
  form.set('password', nextPassword);
  form.set('confirm', '恢复并替换');
  form.set('backup', new Blob([await backup.arrayBuffer()]), 'background.infohub');
  await b.request('/backup/restore', 'POST', form);
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  const restored = (await b.request('/jobs')).find((job) => job.id === encrypted.id);
  assert.equal(restored.status, 'succeeded');
  assert.ok(restored.input.url.includes('private-job-marker'));
  const radar = await b.request(`/items/${repoId}/subscription`);
  assert.equal(radar.subscription.snapshot.latestRelease, 'v3');
  assert.ok(radar.checks.length >= 3);
  pass(
    'job input/output rekey with the vault and complete backups restore jobs, subscriptions and check history',
  );
  console.log(`${groups} background groups passed.`);
} finally {
  source.closeAllConnections();
  await new Promise((resolve) => source.close(resolve));
  await a.close();
  await b.close();
}
