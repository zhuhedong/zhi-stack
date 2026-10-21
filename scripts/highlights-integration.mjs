import assert from 'node:assert/strict';
import { createWorkspace } from './test-workspace.mjs';

const a = await createWorkspace();
const b = await createWorkspace();
const password = 'InfoHub-highlights-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  const article = await a.request(
    '/items',
    'POST',
    {
      kind: 'knowledge',
      title: '划线文章',
      category: 'note',
      project: '',
      tags: [],
      summary: '',
      url: '',
      favorite: false,
      data: { content: '第一段讲调度器。\n\n第二段讲工作窃取。' },
    },
    201,
  );
  const repo = await a.request(
    '/items',
    'POST',
    {
      kind: 'repo',
      title: 'demo',
      category: 'Rust',
      project: '',
      tags: [],
      summary: '',
      url: '',
      favorite: false,
      data: {},
    },
    201,
  );
  const created = await a.request(
    `/items/${article.id}/highlights`,
    'POST',
    {
      quote: '工作窃取',
      prefix: '第二段讲',
      suffix: '。',
      startOffset: 13,
      color: 'green',
      note: '记住 zebra-marker 这个概念',
    },
    201,
  );
  assert.equal(created.color, 'green');
  assert.equal(created.revision, 1);
  await a.request(`/items/${article.id}/highlights`, 'POST', { quote: ' ', startOffset: 0 }, 400);
  await a.request(
    `/items/${article.id}/highlights`,
    'POST',
    { quote: 'x', startOffset: 0, color: 'red' },
    400,
  );
  await a.request(`/items/${repo.id}/highlights`, 'POST', { quote: 'x', startOffset: 0 }, 400);
  await a.request(`/items/${article.id}/highlights`, 'POST', { quote: '调度器', startOffset: 4 }, 201);
  const list = await a.request(`/items/${article.id}/highlights`);
  assert.deepEqual(
    list.map((h) => h.quote),
    ['调度器', '工作窃取'],
  );
  pass('highlights are created with validated color/quote, only on articles, ordered by position');

  const updated = await a.request(`/highlights/${created.id}`, 'PUT', {
    color: 'pink',
    note: '改过的笔记 zebra-marker',
    revision: 1,
  });
  assert.equal(updated.revision, 2);
  await a.request(`/highlights/${created.id}`, 'PUT', { color: 'pink', note: 'stale', revision: 1 }, 409);
  const found = await a.request('/items?q=zebra-marker');
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, article.id);
  assert.ok(found.items[0].matchSnippet.includes('zebra-marker'));
  assert.equal((await a.request('/items?q=' + encodeURIComponent('工作窃取'))).total, 1);
  const recent = await a.request('/highlights');
  assert.equal(recent[0].itemTitle, '划线文章');
  pass('notes update with optimistic revisions and are searchable; recent list spans articles');

  // Re-sync / edit keeps highlights (re-anchoring happens client-side).
  await a.request('/items/' + article.id, 'PUT', {
    ...article,
    data: { content: '新增导语。\n\n第一段讲调度器。\n\n第二段讲工作窃取。' },
  });
  assert.equal((await a.request(`/items/${article.id}/highlights`)).length, 2);
  pass('editing the article keeps its highlights');

  const backup = await a.raw('/backup/export', 'POST', { password });
  assert.equal(backup.status, 200);
  const form = new FormData();
  form.set('password', password);
  form.set('confirm', '恢复并替换');
  form.set('backup', new Blob([await backup.arrayBuffer()]), 'highlights.infohub');
  await b.request('/backup/restore', 'POST', form);
  b.token = (await b.request('/auth/login', 'POST', { password })).token;
  const restored = await b.request(`/items/${article.id}/highlights`);
  assert.equal(restored.length, 2);
  assert.equal(restored.find((h) => h.id === created.id).note, '改过的笔记 zebra-marker');
  pass('backups include highlights and notes');

  await a.request(`/highlights/${created.id}`, 'DELETE', undefined, 204);
  await a.request(`/highlights/${created.id}`, 'DELETE', undefined, 404);
  assert.equal((await a.request('/items?q=zebra-marker')).total, 0);
  assert.equal((await a.raw(`/items/${article.id}/highlights`, 'GET', undefined, '')).status, 401);
  pass('deleting removes the note from search; highlights require a session');
  console.log(`Highlight integration passed: ${groups} groups`);
} catch (error) {
  console.error(a.log.slice(-3000));
  throw error;
} finally {
  await a.close();
  await b.close();
}
