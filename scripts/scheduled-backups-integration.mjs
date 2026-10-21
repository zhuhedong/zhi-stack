import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorkspace, eventually } from './test-workspace.mjs';

const dir = resolve('.local/product-tests/scheduled-dir-' + Date.now());
mkdirSync(dir, { recursive: true });
const a = await createWorkspace({ BACKUP_DIR: dir });
const password = 'InfoHub-scheduled-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const note = (title) =>
  a.request(
    '/items',
    'POST',
    {
      kind: 'knowledge',
      title,
      category: 'note',
      project: '',
      tags: [],
      summary: '',
      url: '',
      favorite: false,
      data: { content: title },
    },
    201,
  );
const titles = async () => (await a.request('/items?kind=knowledge')).items.map((i) => i.title).sort();
const runAndWait = async () => {
  const before = (await a.request('/backup/schedule')).backups.length;
  const lastBefore = (await a.request('/backup/schedule')).schedule.lastRunAt;
  await a.request('/backup/schedule/run', 'POST', undefined, 202);
  await eventually(
    async () => {
      const s = await a.request('/backup/schedule');
      return !s.schedule.running && s.schedule.lastRunAt && s.schedule.lastRunAt !== lastBefore;
    },
    'scheduled backup did not finish: ' + a.log,
    30000,
  );
  const s = await a.request('/backup/schedule');
  assert.equal(s.schedule.lastStatus, 'success', s.schedule.lastMessage);
  return { s, before };
};
try {
  await a.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  await note('第一篇');

  let s = await a.request('/backup/schedule');
  assert.equal(s.schedule.enabled, false);
  assert.equal(s.dirAvailable, true);
  assert.equal(s.serviceKey, true);
  await a.request(
    '/backup/schedule',
    'PUT',
    { enabled: true, intervalHours: 24, keep: 2, targets: ['storage', 'dir'], password: '' },
    400,
  );
  await a.request(
    '/backup/schedule',
    'PUT',
    { enabled: true, intervalHours: 24, keep: 2, targets: ['storage', 'dir'], password: 'wrong' },
    401,
  );
  await a.request(
    '/backup/schedule',
    'PUT',
    { enabled: true, intervalHours: 0, keep: 2, targets: ['storage'], password },
    400,
  );
  await a.request(
    '/backup/schedule',
    'PUT',
    { enabled: true, intervalHours: 24, keep: 2, targets: ['nowhere'], password },
    400,
  );
  s = await a.request('/backup/schedule', 'PUT', {
    enabled: true,
    intervalHours: 24,
    keep: 2,
    targets: ['storage', 'dir'],
    password,
  });
  assert.equal(s.schedule.enabled, true);
  assert.equal(s.schedule.hasKey, true);
  const row = (await a.db.query('SELECT wrapped_key FROM backup_schedule')).rows[0];
  assert.ok(!row.wrapped_key.toString('latin1').includes(password));
  pass('enabling validates the password, interval and targets; the derived key is stored wrapped');

  ({ s } = await runAndWait());
  assert.equal(s.backups.length, 2);
  assert.deepEqual(s.backups.map((b) => b.target).sort(), ['dir', 'storage']);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^infohub-.*\.infohub$/);
  assert.ok(!readFileSync(resolve(dir, files[0])).toString('latin1').includes('第一篇'));
  assert.equal(readdirSync(resolve(a.storage, 'backups')).length, 1);
  pass('a run writes an encrypted backup to file storage and BACKUP_DIR');

  await note('第二篇');
  await runAndWait();
  await note('第三篇');
  ({ s } = await runAndWait());
  assert.equal(s.backups.length, 4);
  await runAndWait();
  ({ s } = await runAndWait());
  assert.equal(s.backups.filter((b) => b.target === 'dir').length, 2);
  assert.equal(s.backups.filter((b) => b.target === 'storage').length, 2);
  assert.equal(readdirSync(dir).length, 2);
  assert.equal(readdirSync(resolve(a.storage, 'backups')).length, 2);
  pass('retention keeps the newest N backups per target and deletes pruned files');

  const nextPassword = password + '-rotated';
  a.token = (
    await a.request('/vault/password', 'POST', { currentPassword: password, newPassword: nextPassword })
  ).token;
  await note('改密后');
  ({ s } = await runAndWait());
  const latest = s.backups.find((b) => b.target === 'storage');
  pass('changing the master password re-keys the schedule and backups keep running');

  await note('恢复后应消失');
  const target = { currentPassword: nextPassword, password: nextPassword, confirm: '恢复并替换' };
  await a.request(`/backup/scheduled/${latest.id}/restore`, 'POST', { ...target, confirm: 'no' }, 400);
  await a.request(
    `/backup/scheduled/${latest.id}/restore`,
    'POST',
    { ...target, currentPassword: 'bad' },
    401,
  );
  await a.request(`/backup/scheduled/${latest.id}/restore`, 'POST', { ...target, password: password }, 400);
  await a.request(`/backup/scheduled/${latest.id}/restore`, 'POST', target);
  a.token = (await a.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.deepEqual(await titles(), ['改密后', '第一篇', '第三篇', '第二篇'].sort());
  s = await a.request('/backup/schedule');
  assert.equal(s.schedule.enabled, false);
  assert.equal(s.schedule.hasKey, false);
  assert.ok(s.backups.length >= 1, 'listed backups survive a restore');
  pass(
    'restoring a listed backup replaces data, requires re-auth and confirmation, and disables the schedule',
  );

  const dirBackup = s.backups.find((b) => b.target === 'dir');
  await a.request(`/backup/scheduled/${dirBackup.id}`, 'DELETE', undefined, 204);
  await a.request(`/backup/scheduled/${dirBackup.id}`, 'DELETE', undefined, 404);
  assert.equal(readdirSync(dir).length, 1);
  await a.request('/backup/schedule', 'GET', undefined, 401, '');
  pass('deleting a listed backup removes its file; endpoints require a session');
} catch (error) {
  console.error(a.log);
  throw error;
} finally {
  await a.close();
  rmSync(dir, { recursive: true, force: true });
}
