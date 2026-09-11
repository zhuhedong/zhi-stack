import assert from 'node:assert/strict';
import { createWorkspace } from './test-workspace.mjs';
import { maintain, hashFile } from './maintenance.mjs';
import { join } from 'node:path';
const a = await createWorkspace();
const b = await createWorkspace();
const password = 'InfoHub-insights-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  assert.deepEqual(await a.request('/onboarding'), {
    hidden: false,
    created: false,
    organized: false,
    reused: false,
  });
  const note = await a.request(
    '/items',
    'POST',
    {
      kind: 'knowledge',
      title: '真实操作记录',
      project: '产品验收',
      data: { content: 'private-content-marker' },
    },
    201,
  );
  await a.request(`/items/${note.id}/visit`, 'POST', undefined, 204);
  await a.request(`/items/${note.id}/visit`, 'POST', undefined, 204);
  await a.request('/items?q=private-search-marker');
  const progress = await a.request('/onboarding');
  assert.ok(progress.created && progress.organized && progress.reused);
  await a.request('/onboarding', 'PUT', { hidden: true }, 204);
  const usage = await a.request('/usage');
  assert.equal(usage.activeDays7, 1);
  assert.equal(usage.reusedAssets30, 1);
  assert.ok(usage.firstValueSeconds >= 0);
  assert.equal(usage.totals.find((row) => row.event === 'search').count, 1);
  const records = (await a.db.query('SELECT to_jsonb(e) entry FROM usage_events e')).rows;
  assert.ok(!JSON.stringify(records).includes('private-content-marker'));
  assert.ok(!JSON.stringify(records).includes('private-search-marker'));
  assert.deepEqual(Object.keys(records[0].entry).sort(), ['created_at', 'event', 'id', 'item_id']);
  pass('onboarding follows actual asset actions; local event records contain only approved metadata');

  await a.request('/usage', 'PUT', { enabled: false }, 204);
  const before = (await a.db.query('SELECT count(*)::int count FROM usage_events')).rows[0].count;
  await a.request(`/items/${note.id}/visit`, 'POST', undefined, 204);
  await a.request('/items?q=ignored-secret');
  assert.equal((await a.db.query('SELECT count(*)::int count FROM usage_events')).rows[0].count, before);
  await a.request('/usage', 'DELETE', { confirm: 'wrong' }, 400);
  await a.request('/usage', 'DELETE', { confirm: '清空统计' }, 204);
  const cleared = await a.request('/usage');
  assert.equal(cleared.totals.length, 0);
  assert.equal(cleared.firstValueSeconds, null);
  assert.equal((await a.request('/items/' + note.id)).data.content, 'private-content-marker');
  await a.stop();
  await a.boot();
  a.token = (await a.request('/auth/login', 'POST', { password })).token;
  assert.equal((await a.request('/usage')).preferences.usage_enabled, false);
  assert.equal((await a.request('/onboarding')).hidden, true);
  pass('opt-out survives restart; clearing statistics preserves content and business reading history');

  const feedback = await a.request(
    '/feedback',
    'POST',
    { category: 'usability', message: 'private-feedback-marker：查找时希望更明确', rating: 3 },
    201,
  );
  await a.request('/feedback', 'POST', { category: 'unknown', message: 'bad', rating: 10 }, 400);
  const payload = (await a.db.query('SELECT payload FROM feedback WHERE id=$1', [feedback.id])).rows[0]
    .payload;
  assert.ok(!payload.includes(Buffer.from('private-feedback-marker')));
  await a.request('/vault/lock', 'POST');
  await a.request('/feedback', 'GET', undefined, 423);
  await a.request('/vault/unlock', 'POST', { password });
  await a.request(`/feedback/${feedback.id}`, 'PUT', { resolved: true }, 204);
  const nextPassword = password + '-rotated';
  a.token = (
    await a.request('/vault/password', 'POST', { currentPassword: password, newPassword: nextPassword })
  ).token;
  assert.ok((await a.request('/feedback'))[0].message.includes('private-feedback-marker'));
  const backup = await maintain({
    command: 'backup',
    base: a.base,
    file: join(a.storage, 'insights.infohub'),
    password: nextPassword,
  });
  assert.equal(await hashFile(backup.file), backup.sha256);
  await assert.rejects(
    maintain({ command: 'backup', base: a.base, file: backup.file, password: nextPassword }),
    /exist/i,
  );
  await assert.rejects(
    maintain({ command: 'restore', base: b.base, file: backup.file, backupPassword: nextPassword }),
    /confirm/,
  );
  await maintain({
    command: 'restore',
    base: b.base,
    file: backup.file,
    backupPassword: nextPassword,
    confirm: '恢复并替换',
  });
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.equal((await b.request('/usage')).preferences.usage_enabled, false);
  assert.equal((await b.request('/onboarding')).hidden, true);
  const restored = (await b.request('/feedback'))[0];
  assert.equal(restored.rating, 3);
  assert.equal(restored.resolved, true);
  assert.ok(restored.message.includes('private-feedback-marker'));
  await b.request('/feedback/' + feedback.id, 'DELETE', undefined, 204);
  assert.equal((await b.request('/feedback')).length, 0);
  pass('feedback is encrypted, permission-checked, rekeyed and restored with opt-out/onboarding preferences');
  console.log(`${groups} insights groups passed.`);
} finally {
  await a.close();
  await b.close();
}
