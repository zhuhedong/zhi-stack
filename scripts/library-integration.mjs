import assert from 'node:assert/strict';
import { createWorkspace } from './test-workspace.mjs';
const a = await createWorkspace();
const b = await createWorkspace();
const password = 'InfoHub-library-test-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  let project = await a.request('/projects', 'POST', { name: '支付项目', description: '恢复上下文' });
  const note = await a.request(
    '/items',
    'POST',
    {
      kind: 'knowledge',
      title: '支付重试',
      project: '支付项目',
      tags: ['旧标签', '后端'],
      data: { content: '指数退避与中文正文。' },
    },
    201,
  );
  const repo = await a.request(
    '/items',
    'POST',
    {
      kind: 'repo',
      title: '代码仓库',
      project: '支付项目',
      tags: ['旧标签'],
      data: { readme: 'README 中的支付重试方案', cookbookNotes: '实践笔记' },
    },
    201,
  );
  const credential = await a.request(
    '/items',
    'POST',
    {
      kind: 'credential',
      title: '测试数据库',
      project: '支付项目',
      tags: ['待合并'],
      data: { typeKey: 'postgresql', fields: { host: 'private-library-marker' } },
    },
    201,
  );
  assert.ok(credential.id);
  assert.equal((await a.request('/projects'))[0].count, 3);
  assert.deepEqual(
    new Set((await a.request('/projects/' + project.id)).items.map((i) => i.kind)),
    new Set(['knowledge', 'repo', 'credential']),
  );
  project = await a.request('/projects/' + project.id, 'PUT', { ...project, name: '支付二期' });
  assert.equal((await a.request('/items?project=' + encodeURIComponent('支付二期'))).total, 3);
  await a.request('/projects/' + project.id, 'PUT', { ...project, revision: 1 }, 409);
  await a.request(`/items/${note.id}/relations`, 'POST', { targetId: repo.id, label: '实现代码' }, 204);
  assert.equal((await a.request(`/items/${repo.id}/relations`))[0].id, note.id);
  await a.request(`/items/${note.id}/relations`, 'POST', { targetId: note.id, label: '自身' }, 400);
  pass(
    'project overview spans all asset types; rename propagates atomically and relations are navigable both ways',
  );

  const results = await a.request('/items?q=' + encodeURIComponent('支付重试'));
  assert.equal(results.items[0].id, note.id);
  assert.equal(results.items[1].id, repo.id);
  assert.ok(results.items[1].matchSnippet.includes('README'));
  assert.equal(results.items[1].data.readme, undefined);
  const privateResults = await a.request('/items?q=private-library-marker');
  assert.equal(privateResults.total, 1);
  assert.ok(!JSON.stringify(privateResults).includes('private-library-marker'));
  await a.request('/vault/lock', 'POST');
  assert.equal((await a.request('/items?q=private-library-marker')).total, 0);
  await a.request('/vault/unlock', 'POST', { password });
  pass('relevance ranks title hits first and returns useful snippets without leaking encrypted field values');

  await a.request(`/items/${note.id}/visit`, 'POST', undefined, 204);
  await a.request(`/items/${note.id}/visit`, 'POST', undefined, 204);
  await a.request(`/items/${repo.id}/visit`, 'POST', undefined, 204);
  assert.equal((await a.request('/items?view=recent')).items[0].id, repo.id);
  assert.equal((await a.request('/items?view=frequent')).items[0].id, note.id);
  const reading = await a.request(`/items/${note.id}/state`);
  await a.request(
    `/items/${note.id}/state`,
    'PUT',
    { ...reading, later: true, progress: 45, annotation: '独立批注不会覆盖原文' },
    204,
  );
  await a.request(`/items/${note.id}/state`, 'PUT', { ...reading, annotation: '旧窗口覆盖' }, 409);
  assert.equal((await a.request('/items?view=later')).items[0].id, note.id);
  assert.equal((await a.request('/items?q=' + encodeURIComponent('独立批注'))).items[0].id, note.id);
  assert.equal((await a.request(`/items/${note.id}/state`)).progress, 45);
  pass('recent/frequent views, read-later, progress and separately version-checked annotations work');

  await a.request('/items/batch', 'POST', {
    ids: [note.id, repo.id],
    project: '研究资料',
    addTags: ['统一标签'],
    archived: true,
  });
  assert.equal((await a.request('/items')).total, 1);
  assert.equal((await a.request('/items?view=archived')).total, 2);
  await a.request('/items/batch', 'POST', { ids: [note.id, repo.id], archived: false });
  await a.request('/vault/lock', 'POST');
  await a.request('/tags/merge', 'POST', { from: ['旧标签', '待合并'], to: '主题标签' }, 423);
  assert.ok((await a.request('/items/' + note.id)).tags.includes('旧标签'));
  await a.request('/vault/unlock', 'POST', { password });
  await a.request('/tags/merge', 'POST', { from: ['旧标签', '待合并'], to: '主题标签' }, 204);
  assert.equal((await a.request('/items?tag=' + encodeURIComponent('主题标签'))).total, 3);
  assert.ok(!(await a.request('/tags')).some((t) => t.name === '旧标签'));
  pass('bulk organization and tag merging honor vault permissions and update matching filters');

  await a.request('/views', 'POST', {
    name: '常用查询',
    filters: { q: 'private-library-marker', project: '支付二期', sort: 'relevance' },
  });
  const stored = (await a.db.query('SELECT filters FROM saved_views')).rows[0].filters;
  assert.ok(!stored.includes(Buffer.from('private-library-marker')));
  await a.request('/vault/lock', 'POST');
  assert.equal((await a.request('/views'))[0].filters, null);
  await a.request('/vault/unlock', 'POST', { password });
  const nextPassword = password + '-new';
  a.token = (
    await a.request('/vault/password', 'POST', { currentPassword: password, newPassword: nextPassword })
  ).token;
  assert.equal((await a.request('/views'))[0].filters.q, 'private-library-marker');
  const backupResponse = await a.raw('/backup/export', 'POST', { password: nextPassword });
  assert.equal(backupResponse.status, 200);
  const form = new FormData();
  form.set('password', nextPassword);
  form.set('confirm', '恢复并替换');
  form.set('backup', new Blob([await backupResponse.arrayBuffer()]), 'library.infohub');
  await b.request('/backup/restore', 'POST', form);
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.equal((await b.request('/views'))[0].filters.q, 'private-library-marker');
  assert.equal((await b.request(`/items/${note.id}/state`)).annotation, '独立批注不会覆盖原文');
  assert.equal((await b.request(`/items/${note.id}/relations`))[0].id, repo.id);
  assert.ok((await b.request('/projects')).some((p) => p.name === '研究资料'));
  pass('saved filters are encrypted, rekeyed and restored with projects, relations and reading records');
  console.log(`${groups} library integration groups passed.`);
} finally {
  await a.close();
  await b.close();
}
