import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// This helper runs a genuine PostgreSQL server locally; it is not an in-memory emulator.
const directory = resolve('.local');
mkdirSync(directory, { recursive: true });
const configFile = resolve(directory, 'postgres.json');
const config = existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, 'utf8'))
  : { user: 'infohub', password: randomBytes(24).toString('hex'), port: 55432 };
if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const pg = new EmbeddedPostgres({
  databaseDir: resolve(directory, 'postgres'),
  user: config.user,
  password: config.password,
  port: config.port,
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1'],
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: (message) => {
    if (process.env.PG_DEBUG) console.log(String(message));
  },
  onError: (message) => console.error(String(message)),
});
if (!existsSync(resolve(directory, 'postgres', 'PG_VERSION'))) await pg.initialise();
let pgCtl;
function runCtl(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(pgCtl, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', rejectRun);
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error('pg_ctl failed. See .local/postgres.log')),
    );
  });
}
if (process.platform === 'win32') {
  const binaries = await import('@embedded-postgres/windows-x64');
  pgCtl = resolve(dirname(binaries.postgres), 'pg_ctl.exe');
  try {
    await runCtl(['-D', resolve(directory, 'postgres'), 'status']);
  } catch {
    await runCtl([
      '-D',
      resolve(directory, 'postgres'),
      '-l',
      resolve(directory, 'postgres.log'),
      '-o',
      '-h 127.0.0.1 -p ' + config.port,
      '-w',
      'start',
    ]);
  }
} else await pg.start();
const client = pg.getPgClient('postgres', '127.0.0.1');
await client.connect();
if (!(await client.query("SELECT 1 FROM pg_database WHERE datname = 'infohub'")).rowCount)
  await client.query('CREATE DATABASE infohub');
await client.end();
const url = 'postgres://' + config.user + ':' + config.password + '@127.0.0.1:' + config.port + '/infohub';
if (!existsSync('.env'))
  writeFileSync(
    '.env',
    'DATABASE_URL=' + url + '\nBIND_ADDR=127.0.0.1:3210\nFRONTEND_DIR=dist\nALLOWED_PRIVATE_HOSTS=\n',
    { mode: 0o600 },
  );
console.log(
  'PostgreSQL ready on 127.0.0.1:' +
    config.port +
    '. Local credentials are in .local/postgres.json; .env is ready.',
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (pgCtl) await runCtl(['-D', resolve(directory, 'postgres'), '-m', 'fast', '-w', 'stop']);
  else await pg.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 60000);
