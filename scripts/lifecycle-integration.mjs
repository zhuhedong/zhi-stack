import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorkspace, eventually } from './test-workspace.mjs';
import { createR2Fixture } from './r2-fixture.mjs';

let version = 1;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=',
  'base64',
);
const upstream = createServer(async (req, res) => {
  if (req.url === '/image.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  } else if (req.url === '/slow') {
    await new Promise((done) => setTimeout(done, 700));
    res.end('done');
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<html><title>持久化文章</title><article><h1>版本 ${version}</h1><p>这篇文章验证历史版本、图片和跨服务器备份恢复。用户的个人修改必须可以完整恢复。这是内容第 ${version} 版，资料在更新之后仍应保留旧的图片与正文。</p><img src="/image.png"></article></html>`,
    );
  }
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const source = `http://127.0.0.1:${upstream.address().port}`;
const r2 = process.argv.includes('--r2') ? await createR2Fixture() : null;
const a = await createWorkspace(r2?.env || {});
const b = await createWorkspace();
const password = 'InfoHub-product-test-password';
const nextPassword = 'InfoHub-product-test-new-password';
let groups = 0;
function pass(message) {
  console.log(`PASS ${++groups}: ${message}`);
}
function restoreBody(bytes, backupPassword, current = '') {
  const form = new FormData();
  form.set('password', backupPassword);
  form.set('currentPassword', current);
  form.set('confirm', '恢复并替换');
  form.set('backup', new Blob([bytes]), 'workspace.infohub');
  return form;
}
function entries(bytes) {
  const result = new Map();
  // The exported ZIP uses Stored entries. Validate it independently of the writer.
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18);
    const names = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + names).toString();
    const start = offset + 30 + names + extra;
    result.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return result;
}
try {
  await a.boot();
  await b.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  let article = (await a.request('/ingest', 'POST', { url: source + '/article', kind: 'knowledge' }, 201))
    .item;
  const mediaId = article.data.content.match(/\/api\/media\/([a-f0-9-]+)/)[1];
  article = await a.request('/items/' + article.id, 'PUT', {
    ...article,
    data: { ...article.data, content: article.data.content + '\n我的个人修改' },
  });
  const savedRevision = article.revision;
  version = 2;
  article = (await a.request(`/items/${article.id}/refresh`, 'POST')).item;
  assert.ok(!article.data.content.includes('我的个人修改'));
  const history = await a.request(`/items/${article.id}/versions`);
  const savedVersion = history.find((v) => v.revision === savedRevision);
  assert.ok(savedVersion);
  assert.ok(
    (await a.request(`/items/${article.id}/versions/${savedVersion.id}`)).data.content.includes(
      '我的个人修改',
    ),
  );
  assert.deepEqual(Buffer.from(await (await a.raw('/media/' + mediaId)).arrayBuffer()), png);
  await a.request(
    `/items/${article.id}/versions/${savedVersion.id}/restore`,
    'POST',
    { revision: savedRevision },
    409,
  );
  article = await a.request(`/items/${article.id}/versions/${savedVersion.id}/restore`, 'POST', {
    revision: article.revision,
  });
  assert.ok(article.data.content.includes('我的个人修改'));
  pass('revision-safe snapshots restore edited text and original archived image bytes');

  const zipped = entries(Buffer.from(await (await a.raw(`/items/${article.id}/export`)).arrayBuffer()));
  assert.ok(zipped.get('article.md').toString().includes('我的个人修改'));
  assert.ok(!zipped.get('article.md').toString().includes('/api/media/'));
  assert.deepEqual(zipped.get(`images/${mediaId}.png`), png);
  pass('portable Markdown ZIP contains images and rewrites authenticated media references');

  await a.request('/items/' + article.id, 'DELETE', undefined, 204);
  await a.request('/items/' + article.id, 'GET', undefined, 404);
  assert.equal((await a.request('/items')).total, 0);
  assert.equal((await a.request('/trash')).length, 1);
  article = await a.request(`/trash/${article.id}/restore`, 'POST');
  assert.ok(article.data.content.includes('我的个人修改'));
  pass('trash hides active items without removing assets, history or media; restore recovers all');

  let credential = await a.request(
    '/items',
    'POST',
    {
      kind: 'credential',
      title: '凭证',
      category: 'account',
      data: { typeKey: 'account', fields: { password: 'secret-value-one' } },
    },
    201,
  );
  credential = await a.request('/items/' + credential.id, 'PUT', {
    ...credential,
    data: { ...credential.data, fields: { password: 'secret-value-two' } },
  });
  const attachment = new FormData();
  attachment.set('file', new Blob(['private-attachment-content']), 'secret.txt');
  const uploaded = await a.request(`/items/${credential.id}/attachments`, 'POST', attachment, 201);
  const attachmentId = uploaded.id;
  assert.ok(attachmentId);
  const draftId = 'test-credential-draft';
  const draftPayload = { fields: { password: 'private-draft-value' } };
  const draft = await a.request('/drafts/' + draftId, 'PUT', {
    kind: 'credential',
    itemId: credential.id,
    baseRevision: credential.revision,
    payload: draftPayload,
  });
  assert.equal(draft.generation, 1);
  await a.request(
    '/drafts/' + draftId,
    'PUT',
    { kind: 'credential', itemId: credential.id, payload: { changed: true }, generation: 0 },
    409,
  );
  assert.deepEqual((await a.request('/drafts/' + draftId)).payload, draftPayload);
  await a.request('/drafts/' + draftId + '?generation=0', 'DELETE', undefined, 409);
  const rawDraft = (await a.db.query('SELECT payload,encrypted FROM drafts WHERE id=$1', [draftId])).rows[0];
  assert.equal(rawDraft.encrypted, true);
  assert.ok(!rawDraft.payload.includes(Buffer.from('private-draft-value')));
  await a.request('/vault/lock', 'POST');
  await a.request('/drafts/' + draftId, 'GET', undefined, 423);
  assert.equal((await a.request('/drafts')).length, 0);
  await a.request(`/items/${credential.id}/versions`, 'GET', undefined, 423);
  await a.request('/vault/unlock', 'POST', { password });
  pass('recoverable credential drafts are encrypted, versioned and inaccessible while locked');

  const oldCiphertext = (await a.db.query('SELECT secret FROM items WHERE id=$1', [credential.id])).rows[0]
    .secret;
  const oldFile = (await a.db.query('SELECT storage_key FROM attachments WHERE id=$1', [attachmentId]))
    .rows[0].storage_key;
  const originalBytes = r2 ? Buffer.from(r2.objects.get(oldFile)) : readFileSync(resolve(a.storage, oldFile));
  const damage = Buffer.from(originalBytes);
  damage[0] ^= 1;
  if (r2) r2.objects.set(oldFile, damage);
  else writeFileSync(resolve(a.storage, oldFile), damage);
  const failedRotation = await a.raw('/vault/password', 'POST', {
    currentPassword: password,
    newPassword: nextPassword,
  });
  assert.ok(!failedRotation.ok);
  assert.deepEqual(
    (await a.db.query('SELECT secret FROM items WHERE id=$1', [credential.id])).rows[0].secret,
    oldCiphertext,
  );
  if (r2) r2.objects.set(oldFile, originalBytes);
  else writeFileSync(resolve(a.storage, oldFile), originalBytes);
  const oldToken = a.token;
  const peer = (await a.request('/auth/login', 'POST', { password })).token;
  const pendingProbe = a.request('/probe', 'POST', { url: source + '/slow', method: 'GET', headers: [] });
  await new Promise((done) => setTimeout(done, 100));
  const rotated = await a.request('/vault/password', 'POST', {
    currentPassword: password,
    newPassword: nextPassword,
  });
  assert.equal((await pendingProbe).body, 'done');
  a.token = rotated.token;
  await a.request('/items', 'GET', undefined, 401, oldToken);
  await a.request('/items', 'GET', undefined, 401, peer);
  await a.request('/auth/login', 'POST', { password }, 401);
  assert.equal((await a.request('/items/' + credential.id)).data.fields.password, 'secret-value-two');
  const credentialVersion = (await a.request(`/items/${credential.id}/versions`))[0];
  assert.equal(
    (await a.request(`/items/${credential.id}/versions/${credentialVersion.id}`)).data.fields.password,
    'secret-value-one',
  );
  assert.deepEqual((await a.request('/drafts/' + draftId)).payload, draftPayload);
  assert.equal(await (await a.raw('/attachments/' + attachmentId)).text(), 'private-attachment-content');
  assert.notDeepEqual(
    (await a.db.query('SELECT secret FROM items WHERE id=$1', [credential.id])).rows[0].secret,
    oldCiphertext,
  );
  pass(
    'failed rotation rolls back; successful rotation rekeys histories/drafts/files and revokes other sessions',
  );

  const response = await a.raw('/backup/export', 'POST', { password: nextPassword });
  assert.equal(response.status, 200, await response.clone().text());
  const backup = Buffer.from(await response.arrayBuffer());
  assert.ok(backup.subarray(0, 16).toString().startsWith('INFOHUB-BACKUP-1'));
  for (const secret of ['secret-value-two', 'private-attachment-content', '我的个人修改'])
    assert.ok(!backup.includes(Buffer.from(secret)));
  assert.equal((await a.request('/backup/runs'))[0].status, 'success');
  const corrupted = Buffer.from(backup);
  corrupted[corrupted.length - 2] ^= 1;
  const corruptResponse = await b.raw('/backup/restore', 'POST', restoreBody(corrupted, nextPassword));
  assert.equal(corruptResponse.status, 400);
  assert.equal((await b.request('/health')).initialized, false);
  await b.request('/backup/restore', 'POST', restoreBody(backup, nextPassword));
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.equal((await b.request('/items')).total, 2);
  assert.equal((await b.request('/items/' + credential.id)).data.fields.password, 'secret-value-two');
  assert.ok((await b.request('/items/' + article.id)).data.content.includes('我的个人修改'));
  assert.deepEqual(Buffer.from(await (await b.raw('/media/' + mediaId)).arrayBuffer()), png);
  assert.equal(await (await b.raw('/attachments/' + attachmentId)).text(), 'private-attachment-content');
  assert.deepEqual((await b.request('/drafts/' + draftId)).payload, draftPayload);
  assert.equal(
    (await b.request(`/items/${credential.id}/versions/${credentialVersion.id}`)).data.fields.password,
    'secret-value-one',
  );
  pass(
    'encrypted complete backup detects tampering and restores all content into a clean, independently stored instance',
  );

  await b.request('/backup/restore', 'POST', restoreBody(backup, nextPassword, nextPassword), 401, '');
  const before = await b.request('/items');
  await b.request(
    '/backup/restore',
    'POST',
    restoreBody(backup.subarray(0, backup.length - 20), nextPassword, nextPassword),
    400,
  );
  assert.deepEqual(await b.request('/items'), before);
  await b.request('/backup/restore', 'POST', restoreBody(backup, nextPassword, nextPassword));
  await b.request('/items', 'GET', undefined, 401);
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.equal((await b.request('/items')).total, 2);
  pass(
    'existing-instance restore requires identity, preserves data on failure and revokes sessions after replacement',
  );

  const purgedKeys = (
    await b.db.query(
      'SELECT storage_key FROM media WHERE item_id=$1 UNION SELECT storage_key FROM version_media WHERE version_id IN (SELECT id FROM item_versions WHERE item_id=$1)',
      [article.id],
    )
  ).rows.map((row) => row.storage_key);
  await b.request('/items/' + article.id, 'DELETE', undefined, 204);
  await b.request('/trash/' + article.id, 'DELETE', { confirm: 'no' }, 400);
  await b.request('/trash/' + article.id, 'DELETE', { confirm: '永久删除' }, 204);
  assert.equal(
    (await b.db.query('SELECT count(*)::int AS n FROM item_versions WHERE item_id=$1', [article.id])).rows[0]
      .n,
    0,
  );
  await eventually(
    async () =>
      (await b.db.query('SELECT count(*)::int AS n FROM file_objects WHERE key=ANY($1)', [purgedKeys]))
        .rows[0].n === 0,
    'Purged historical media cleanup',
  );
  await b.stop();
  await b.boot();
  b.token = (await b.request('/auth/login', 'POST', { password: nextPassword })).token;
  assert.equal((await b.request('/items/' + credential.id)).data.fields.password, 'secret-value-two');
  pass('explicit purge cleans historical media; restored encrypted data survives a real service restart');
  console.log(`${groups} lifecycle integration groups passed${r2 ? ' (R2 source → local restore)' : ''}.`);
} finally {
  await a.close();
  await b.close();
  upstream.close();
  if (r2) await r2.close();
}
