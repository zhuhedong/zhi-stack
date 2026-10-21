import assert from 'node:assert/strict';
import { createWorkspace } from './test-workspace.mjs';

const a = await createWorkspace();
const password = 'InfoHub-cjk-password';
let groups = 0;
const pass = (message) => console.log(`PASS ${++groups}: ${message}`);
const note = (title, content, extra = {}) =>
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
      data: { content },
      ...extra,
    },
    201,
  );
const titles = async (q) =>
  (await a.request('/items?q=' + encodeURIComponent(q) + '&limit=50')).items.map((i) => i.title).sort();
try {
  await a.boot();
  a.token = (await a.request('/auth/setup', 'POST', { password })).token;
  await note('异步运行时', 'Tokio 的调度器使用工作窃取算法，任务在线程之间迁移。');
  await note('数据库索引', '倒排索引与 B 树索引的区别；全文检索需要分词。');
  await note('调料清单', '盐、糖、酱油。');
  await note('English only', 'work stealing scheduler in Rust');
  await note('日本語メモ', 'スケジューラの説明。');
  await note('조사', '한국어 검색 테스트');

  // Function parity: PostgreSQL grams == the Rust query grams' superset logic.
  const grams = (await a.db.query("SELECT infohub_cjk_grams('调度器,ab 中') AS g")).rows[0].g.sort();
  assert.deepEqual(grams, ['中', '器', '度', '度器', '调', '调度'].sort());
  pass('the SQL gram function produces CJK unigrams and bigrams per run without extensions');

  assert.deepEqual(await titles('调'), ['异步运行时', '调料清单']);
  assert.deepEqual(await titles('索引'), ['数据库索引']);
  assert.deepEqual(await titles('调度器'), ['异步运行时']);
  assert.deepEqual(await titles('盐'), ['调料清单']);
  assert.deepEqual(await titles('度调'), []);
  pass('one- and two-character Chinese queries match, and adjacency is verified');

  assert.deepEqual(await titles('调度 线程'), ['异步运行时']);
  assert.deepEqual(await titles('调度 索引'), []);
  assert.deepEqual(await titles('tokio 窃取'), ['异步运行时']);
  assert.deepEqual(await titles('"work stealing"'), ['English only']);
  assert.deepEqual(await titles('stealing work'), ['English only']);
  assert.deepEqual(await titles('スケジューラ'), ['日本語メモ']);
  assert.deepEqual(await titles('검색'), ['조사']);
  pass('whitespace-separated terms are AND-ed, quoted phrases stay together; Japanese and Korean work');

  const long = '填充'.repeat(110000) + '尾部关键字';
  const t0 = Date.now();
  await note('超长文章', long);
  assert.ok(Date.now() - t0 < 5000, 'indexing a 220k-character article took ' + (Date.now() - t0) + ' ms');
  assert.deepEqual(await titles('关键'), ['超长文章']);
  const row = (
    await a.db.query(
      "SELECT '*' = ANY(grams) AS marked, cardinality(grams) AS n FROM item_search s JOIN items i ON i.id=s.item_id WHERE i.title='超长文章'",
    )
  ).rows[0];
  assert.equal(row.marked, true);
  assert.ok(row.n < 20);
  pass('texts beyond the gram budget are indexed quickly and still found (marked, LIKE-verified)');

  const item = (await a.request('/items?q=' + encodeURIComponent('调料'))).items[0];
  await a.request('/items/' + item.id, 'PUT', {
    ...(await a.request('/items/' + item.id)),
    data: { content: '花椒与八角' },
  });
  assert.deepEqual(await titles('花椒'), ['调料清单']);
  assert.deepEqual(await titles('酱油'), []);
  pass('the gram index follows item updates through the trigger');

  for (let i = 0; i < 300; i++)
    await a.db.query(
      "INSERT INTO items(id,kind,title,category,project,tags,summary,url,data,favorite) VALUES(gen_random_uuid(),'knowledge',$1,'note','', '{}','','',$2,false)",
      ['填充 ' + i, JSON.stringify({ content: 'lorem ipsum ' + i })],
    );
  await a.db.query('ANALYZE item_search');
  const plan = (
    await a.db.query(
      "SET enable_seqscan=off; EXPLAIN SELECT item_id FROM item_search WHERE text LIKE '%调%' AND (grams @> ARRAY['调']::text[] OR grams @> '{*}'::text[])",
    )
  )[1].rows
    .map((r) => r['QUERY PLAN'])
    .join('\n');
  assert.match(plan, /item_search_grams/, plan);
  assert.deepEqual(await titles('调'), ['异步运行时', '调料清单']);
  pass('CJK term lookups can use the GIN gram index');
} catch (error) {
  console.error(a.log);
  throw error;
} finally {
  await a.close();
}
