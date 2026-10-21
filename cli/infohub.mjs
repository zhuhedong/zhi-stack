#!/usr/bin/env node
// InfoHub command-line client (Node 18+, no dependencies).
//   INFOHUB_URL=https://hub.example.com INFOHUB_TOKEN=ihp_… node cli/infohub.mjs search 调度器
// Commands: search <query> [--kind knowledge|repo|credential] [--limit N]
//           get <id> | save <url> [--kind knowledge|repo] [--project P] [--tag T]…
//           note <title> [content|-] [--project P] [--tag T]…
const [command, ...rest] = process.argv.slice(2);
const base = (process.env.INFOHUB_URL || '').replace(/\/+$/, '');
const token = process.env.INFOHUB_TOKEN || '';
function usage(message) {
  if (message) console.error(message);
  console.error(`用法:
  infohub search <关键词> [--kind knowledge|repo|credential] [--limit N]
  infohub get <id>
  infohub save <url> [--kind knowledge|repo] [--project 项目] [--tag 标签]...
  infohub note <标题> [正文|-] [--project 项目] [--tag 标签]...
环境变量: INFOHUB_URL（服务地址）, INFOHUB_TOKEN（个人 API 令牌 ihp_…）`);
  process.exit(2);
}
if (!command || command === 'help' || command === '--help') usage();
if (!base || !/^https?:\/\//.test(base)) usage('请设置 INFOHUB_URL');
if (!token.startsWith('ihp_')) usage('请设置 INFOHUB_TOKEN（在“数据与安全 → API 令牌”中创建）');
const positional = [];
const options = { tag: [] };
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const value = rest[++i];
    if (value === undefined) usage('缺少参数值：' + arg);
    if (key === 'tag') options.tag.push(value);
    else options[key] = value;
  } else positional.push(arg);
}
async function call(path, init = {}) {
  const response = await fetch(base + '/api' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    console.error(`错误 ${response.status}: ${body.error || text}`);
    process.exit(1);
  }
  return body;
}
async function stdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
switch (command) {
  case 'search': {
    const params = new URLSearchParams({ q: positional.join(' '), limit: options.limit || '20' });
    if (options.kind) params.set('kind', options.kind);
    const { items, total } = await call('/items?' + params);
    for (const item of items)
      console.log(`${item.id}  [${item.kind}] ${item.title}${item.url ? '  ' + item.url : ''}`);
    console.error(`共 ${total} 条`);
    break;
  }
  case 'get': {
    if (!positional[0]) usage('缺少 id');
    const item = await call('/items/' + encodeURIComponent(positional[0]));
    console.log(`# ${item.title}\n${item.url ? item.url + '\n' : ''}`);
    console.log(item.data?.content || item.summary || '');
    break;
  }
  case 'save': {
    if (!positional[0]) usage('缺少 URL');
    const job = await call('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        url: positional[0],
        kind: options.kind || '',
        project: options.project || '',
        tags: options.tag,
        requestId: crypto.randomUUID(),
      }),
    });
    console.log(`已加入收录队列：${job.id}（${job.status}）`);
    break;
  }
  case 'note': {
    if (!positional[0]) usage('缺少标题');
    const content =
      positional[1] === '-' || (positional[1] === undefined && !process.stdin.isTTY)
        ? await stdin()
        : positional[1] || '';
    const item = await call('/items', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'knowledge',
        title: positional[0],
        category: 'note',
        project: options.project || '',
        tags: options.tag,
        summary: '',
        url: '',
        favorite: false,
        data: { content },
      }),
    });
    console.log(`已创建笔记：${item.id}`);
    break;
  }
  default:
    usage('未知命令：' + command);
}
