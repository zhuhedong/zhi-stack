import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { waitForContainer, restartContainer } from './docker-readiness.mjs';

async function healthServer(t, generation) {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ version: '0.2.0', generation }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const address = '127.0.0.1:' + server.address().port;
  return { address, base: 'http://' + address, paths };
}

test('restart uses the new published port for health checks and subsequent HTTP requests', async (t) => {
  const before = await healthServer(t, 1);
  const after = await healthServer(t, 2);
  let current = before;
  const docker = (args) => {
    if (args[0] === 'restart') {
      current = after;
      return 'fixture-app';
    }
    if (args[0] === 'inspect') return JSON.stringify({ Status: 'running', Running: true });
    if (args[0] === 'port') return current.address;
    throw new Error('Unexpected Docker operation: ' + args[0]);
  };
  const initial = await waitForContainer(docker, 'fixture-app');
  assert.equal(initial.base, before.base);
  const restarted = await restartContainer(docker, 'fixture-app');
  assert.equal(restarted.base, after.base);
  assert.equal(restarted.health.generation, 2);
  assert.equal((await (await fetch(restarted.base + '/api/items')).json()).generation, 2);
  assert.deepEqual(before.paths, ['/api/health']);
  assert.deepEqual(after.paths, ['/api/health', '/api/items']);
});

test('readiness retries while the published binding is not yet available', async (t) => {
  const service = await healthServer(t, 1);
  let reads = 0;
  const docker = (args) => {
    if (args[0] === 'inspect') return JSON.stringify({ Status: 'running', Running: true });
    if (args[0] === 'port') return ++reads === 1 ? '' : service.address;
    throw new Error('Unexpected Docker operation: ' + args[0]);
  };
  const ready = await waitForContainer(docker, 'fixture-app', { pollMs: 1 });
  assert.equal(ready.base, service.base);
  assert.equal(reads, 2);
});

test('a crashed container fails immediately with its state and logs', async () => {
  const docker = (args) => {
    if (args[0] === 'inspect') return JSON.stringify({ Status: 'exited', ExitCode: 1 });
    if (args[0] === 'logs') return 'database connection refused';
    throw new Error('Unexpected Docker operation: ' + args[0]);
  };
  await assert.rejects(waitForContainer(docker, 'fixture-app'), (error) => {
    assert.match(error.message, /Container exited before becoming ready/);
    assert.match(error.message, /"ExitCode":1/);
    assert.match(error.message, /database connection refused/);
    return true;
  });
});
