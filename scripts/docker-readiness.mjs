import { maintain } from './maintenance.mjs';

export async function waitForContainer(docker, name, { timeoutMs = 90000, pollMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  let lastError = 'No successful health response.';
  function failure(reason) {
    const state = docker(['inspect', '--format', '{{json .State}}', name], false);
    const logs = docker(['logs', '--tail', '100', name], false);
    return new Error(
      `${reason}\nContainer: ${name}\nLast check: ${lastError}\nState: ${state}\nLogs:\n${logs}`,
    );
  }
  while (Date.now() < until) {
    const rawState = docker(['inspect', '--format', '{{json .State}}', name], false);
    let state;
    try {
      state = JSON.parse(rawState);
    } catch {
      // The container may not yet be inspectable; keep the last health failure.
    }
    if (state && ['exited', 'dead'].includes(state.Status)) {
      throw failure('Container exited before becoming ready.');
    }
    try {
      // Docker assigns the host port. Read the current binding on every check,
      // including after restart, instead of retaining the previous address.
      const address = docker(['port', name, '3210/tcp'], false).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Loopback port binding is not available.');
      const base = 'http://' + address;
      const health = await maintain({ command: 'status', base });
      return { base, health };
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw failure('Container did not become ready.');
}

export async function restartContainer(docker, name, options) {
  docker(['restart', name]);
  return waitForContainer(docker, name, options);
}
