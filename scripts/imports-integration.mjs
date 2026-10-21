import assert from 'node:assert/strict';
import { createWorkspace } from './test-workspace.mjs';

const a = await createWorkspace();
const password = 'InfoHub-imports-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const base = { project: '', tags: [], summary: '', favorite: false };
try {
  await a.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  await a.request(
    '/items',
    'POST',
    {
      ...base,
      kind: 'knowledge',
      title: 'A',
      category: 'blog',
      url: 'https://a.example/',
      data: { content: '' },
    },
    201,
  );
  const vault = await a.request(
    '/items',
    'POST',
    {
      ...base,
      kind: 'credential',
      title: 'GitHub',
      category: 'account',
      url: '',
      data: {
        typeKey: 'account',
        fields: {
          url: 'https://github.com/login',
          username: 'Me',
          password: 'imported-secret-marker',
          totp: 'JBSWY3DPEHPK3PXP',
        },
      },
    },
    201,
  );
  await a.request(
    '/items',
    'POST',
    {
      ...base,
      kind: 'credential',
      title: 'Shop API',
      category: 'http',
      url: '',
      data: { typeKey: 'rest_api', fields: { baseUrl: '{{baseUrl}}' }, swaggerEndpoints: [] },
    },
    201,
  );
  const existing = await a.request('/import/existing', 'POST', {
    urls: ['https://a.example/', 'https://new.example/'],
  });
  assert.deepEqual(existing.urls, ['https://a.example/']);
  assert.ok(existing.unlocked);
  assert.ok(existing.vault.includes('vault|github|github.com|me'));
  assert.ok(existing.vault.includes('api|shop api'));
  assert.ok(!JSON.stringify(existing).includes('imported-secret-marker'));
  pass('import preview dedupe keys cover article URLs, vault accounts and API collections without secrets');

  const row = (await a.db.query('SELECT data::text, secret FROM items WHERE id=$1', [vault.id])).rows[0];
  assert.ok(!row.data.includes('imported-secret-marker') && !row.data.includes('JBSWY3DPEHPK3PXP'));
  assert.ok(!row.secret.includes(Buffer.from('imported-secret-marker')));
  assert.equal((await a.request('/items/' + vault.id)).data.fields.totp, 'JBSWY3DPEHPK3PXP');
  pass('imported vault fields, including TOTP secrets, are encrypted at rest');

  await a.request('/vault/lock', 'POST');
  const locked = await a.request('/import/existing', 'POST', { urls: [] });
  assert.equal(locked.unlocked, false);
  assert.deepEqual(locked.vault, []);
  await a.request('/import/existing', 'POST', { urls: Array(20001).fill('x') }, 400);
  pass('a locked vault reveals no vault keys; oversized lookups are rejected');
  console.log(`Import integration passed: ${groups} groups`);
} catch (error) {
  console.error(a.log.slice(-3000));
  throw error;
} finally {
  await a.close();
}
