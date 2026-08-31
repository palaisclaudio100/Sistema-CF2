import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TABLES = Object.freeze([
  'objects', 'decisions', 'tasks', 'verifications', 'proofs', 'audit',
  'outbox', 'idempotency', 'jobs', 'meta', 'schema_migrations'
]);
const STARTED_AT = new Date().toISOString();
const RUN_ID = process.env.CF2_GATE_RUN_ID ?? crypto.randomUUID();
const WORK_DIR = path.resolve(process.env.CF2_GATE_WORK_DIR ?? `/tmp/cf2-gate-${RUN_ID}`);
const RESULT_PREFIX = 'CF2_BACKUP_RESTORE_GATE_RESULT=';
const PG_START_TIMEOUT_SECONDS = 20;

export function postgresTool(binDir, name) {
  if (!path.isAbsolute(binDir)) throw new Error('PG18_BIN_NOT_ABSOLUTE');
  return path.join(binDir, name);
}

export function buildPgCtlStartArgs({ dataDir, logPath, socketDir, port, postgresBin, timeoutSeconds = PG_START_TIMEOUT_SECONDS }) {
  for (const value of [dataDir, logPath, socketDir, postgresBin]) {
    if (!path.isAbsolute(value) || /\s/.test(value)) throw new Error('POSTGRES_LOCAL_PATH_INVALID');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('POSTGRES_LOCAL_PORT_INVALID');
  const options = [
    '-F', '-h', '127.0.0.1', '-p', String(port), '-k', socketDir,
    '-c', 'listen_addresses=127.0.0.1',
    '-c', `unix_socket_directories=${socketDir}`,
    '-c', 'shared_buffers=32MB', '-c', 'max_connections=10',
    '-c', 'fsync=off', '-c', 'synchronous_commit=off'
  ].join(' ');
  return [
    '-D', dataDir, '-l', logPath, '-w', '-t', String(timeoutSeconds),
    '-p', postgresBin, '-o', options, 'start'
  ];
}

export function sanitizePostgresDiagnostic(value, forbiddenValues = []) {
  let sanitized = String(value ?? '');
  for (const forbidden of forbiddenValues.filter(Boolean)) {
    sanitized = sanitized.split(String(forbidden)).join('[REDACTED]');
  }
  return sanitized
    .replace(/postgres(?:ql)?:\/\/[^\s'\"]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/dpg-[a-z0-9-]+/gi, '[REDACTED_RENDER_HOST]')
    .replace(/(?:password|passwd|pwd)\s*[=:]\s*[^\s]+/gi, 'password=[REDACTED]')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-20)
    .join('\n')
    .slice(0, 4000);
}

export function isIsolatedWorkDir(workDir, expectedRoot) {
  return path.resolve(expectedRoot) === path.resolve(workDir)
    && path.basename(path.dirname(path.resolve(workDir))).startsWith('cf2-backup-restore-');
}

export function sanitizedTargetEnvironment(environment = process.env) {
  const target = { ...environment };
  for (const name of [
    'DATABASE_URL', 'CF2_DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE',
    'PGUSER', 'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'
  ]) delete target[name];
  return target;
}

export async function buildPgCtlFailureDiagnostic({ exitCode, dataDir, socketDir, port, postgresVersion, logPath, forbiddenValues = [] }) {
  const [dataStat, socketStat, logText] = await Promise.all([
    fs.stat(dataDir).catch(() => null),
    fs.stat(socketDir).catch(() => null),
    fs.readFile(logPath, 'utf8').catch(() => '')
  ]);
  return {
    phase: 'START_EPHEMERAL_POSTGRES',
    exit_code: exitCode,
    pgdata: { exists: Boolean(dataStat), mode: dataStat ? (dataStat.mode & 0o777).toString(8).padStart(3, '0') : null },
    socket_dir: {
      exists: Boolean(socketStat),
      mode: socketStat ? (socketStat.mode & 0o777).toString(8).padStart(3, '0') : null,
      within_run_id: socketDir.startsWith(`${path.dirname(dataDir)}${path.sep}`)
    },
    port,
    postgres_version: postgresVersion,
    log_tail: sanitizePostgresDiagnostic(logText, forbiddenValues)
  };
}

function safeError(error) {
  const value = String(error?.message ?? error ?? 'UNKNOWN_ERROR');
  return value.replace(/[^A-Z0-9_:.=-]/gi, '_').slice(0, 180);
}

function run(command, args, { env = process.env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exitCode => {
      const result = { exitCode, stdout, stderr };
      if (exitCode !== 0 && !allowFailure) {
        reject(Object.assign(new Error(`COMMAND_FAILED_${path.basename(command)}_${exitCode}`), { result }));
      } else {
        resolve(result);
      }
    });
  });
}

function sourceEnvironment(rawUrl) {
  if (!rawUrl) throw new Error('DATABASE_URL_MISSING');
  const url = new URL(rawUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL_PROTOCOL_INVALID');
  if (!/^dpg-[a-z0-9]+-a$/.test(url.hostname)) throw new Error('SOURCE_NOT_RENDER_INTERNAL_POSTGRES');
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.CF2_DATABASE_URL;
  Object.assign(env, {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: 'require',
    PGOPTIONS: '-c default_transaction_read_only=on'
  });
  return env;
}

function parseJsonLine(stdout) {
  const line = stdout.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('{'));
  if (!line) throw new Error('SQL_JSON_RESULT_MISSING');
  return JSON.parse(line);
}

async function psqlJson(sql, env) {
  const result = await run('psql', ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1', '--command', sql], { env });
  return parseJsonLine(result.stdout);
}

function snapshotSql() {
  const countEntries = TABLES.map(table => `'${table}', (SELECT count(*)::bigint FROM ${table})`).join(', ');
  return `BEGIN READ ONLY;
SELECT json_build_object(
  'transaction_read_only', current_setting('transaction_read_only'),
  'server_version', current_setting('server_version'),
  'server_version_num', current_setting('server_version_num'),
  'state_version', (SELECT value #>> '{}' FROM meta WHERE key='state_version'),
  'counts', json_build_object(${countEntries}),
  'migrations', (SELECT coalesce(json_agg(version ORDER BY version), '[]'::json) FROM schema_migrations),
  'tables', (SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]'::json) FROM pg_tables WHERE schemaname='public'),
  'constraints', (SELECT coalesce(json_agg(conname ORDER BY conname), '[]'::json) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
  'indexes', (SELECT coalesce(json_agg(indexname ORDER BY indexname), '[]'::json) FROM pg_indexes WHERE schemaname='public'),
  'foreign_keys', (SELECT coalesce(json_agg(conname ORDER BY conname), '[]'::json) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND contype='f')
)::text;
COMMIT;`;
}

function normalizeSnapshot(value) {
  return {
    ...value,
    state_version: Number(value.state_version),
    counts: Object.fromEntries(Object.entries(value.counts ?? {}).map(([key, count]) => [key, Number(count)])),
    migrations: [...(value.migrations ?? [])].sort(),
    tables: [...(value.tables ?? [])].sort(),
    constraints: [...(value.constraints ?? [])].sort(),
    indexes: [...(value.indexes ?? [])].sort(),
    foreign_keys: [...(value.foreign_keys ?? [])].sort()
  };
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
const result = {
  run_id: RUN_ID,
  started_at: STARTED_AT,
  finished_at: null,
  source_read_only: false,
  source_state_version_before: null,
  source_state_version_after: null,
  source_counts: null,
  dump_sha256: null,
  dump_bytes: null,
  dump_exit: null,
  restore_exit: null,
  restored_counts: null,
  restored_state_version: null,
  migration: null,
  constraints_pass: false,
  indexes_pass: false,
  foreign_keys_pass: false,
  cleanup_pass: false,
  result: 'FAIL'
};

let pgStarted = false;
let dataDir;
let targetEnv;
let socketDir;
let postgresLog;
let selectedPort;

try {
  await fs.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
  const pg18Bin = path.resolve(process.env.PG18_BIN ?? '');
  if (!path.isAbsolute(pg18Bin) || !pg18Bin.includes(`${path.sep}tmp${path.sep}`)) throw new Error('PG18_BIN_INVALID');
  const tool = name => postgresTool(pg18Bin, name);
  const sourceEnv = sourceEnvironment(process.env.DATABASE_URL);
  const source = normalizeSnapshot(await psqlJson(snapshotSql(), sourceEnv));
  if (source.transaction_read_only !== 'on') throw new Error('SOURCE_READ_ONLY_NOT_CONFIRMED');
  if (!equal(source.tables, [...TABLES].sort())) throw new Error('SOURCE_TABLE_SET_INVALID');
  result.source_read_only = true;
  result.source_state_version_before = source.state_version;
  result.source_counts = source.counts;
  result.migration = source.migrations;

  const versions = {};
  for (const tool of ['postgres', 'initdb', 'pg_ctl', 'pg_dump', 'pg_restore', 'psql']) {
    const version = await run(postgresTool(pg18Bin, tool), ['--version']);
    versions[tool] = `${version.stdout}${version.stderr}`.trim();
    if (!/\b18\.6\b/.test(versions[tool])) throw new Error(`TOOL_VERSION_INVALID_${tool}`);
  }
  const sourceMajor = Math.floor(Number(source.server_version_num) / 10000);
  if (sourceMajor !== 18) throw new Error('SOURCE_MAJOR_NOT_18');

  const dumpPath = path.join(WORK_DIR, 'source.dump');
  const dumpStarted = new Date().toISOString();
  const dump = await run(tool('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath], { env: sourceEnv, allowFailure: true });
  result.dump_exit = dump.exitCode;
  if (dump.exitCode !== 0) throw new Error('PG_DUMP_FAILED');
  result.dump_bytes = (await fs.stat(dumpPath)).size;
  result.dump_sha256 = await fileSha256(dumpPath);

  const after = normalizeSnapshot(await psqlJson(snapshotSql(), sourceEnv));
  result.source_state_version_after = after.state_version;
  if (after.transaction_read_only !== 'on') throw new Error('SOURCE_AFTER_READ_ONLY_NOT_CONFIRMED');
  if (source.state_version !== after.state_version) throw new Error('SOURCE_CHANGED_DURING_DUMP');

  selectedPort = await freePort();
  dataDir = path.join(WORK_DIR, 'pgdata');
  socketDir = path.join(WORK_DIR, 'socket');
  postgresLog = path.join(WORK_DIR, 'postgres.log');
  await fs.mkdir(socketDir, { mode: 0o700 });
  const localProcessEnv = sanitizedTargetEnvironment(process.env);
  await run(tool('initdb'), ['--pgdata', dataDir, '--username=postgres', '--auth=trust', '--encoding=UTF8', '--no-locale'], { env: localProcessEnv });
  const pgCtlStart = await run(tool('pg_ctl'), buildPgCtlStartArgs({
    dataDir,
    logPath: postgresLog,
    socketDir,
    port: selectedPort,
    postgresBin: tool('postgres')
  }), { env: localProcessEnv, allowFailure: true });
  if (pgCtlStart.exitCode !== 0) {
    result.pg_ctl_diagnostic = await buildPgCtlFailureDiagnostic({
      exitCode: pgCtlStart.exitCode,
      dataDir,
      socketDir,
      port: selectedPort,
      postgresVersion: versions.postgres,
      logPath: postgresLog,
      forbiddenValues: [process.env.DATABASE_URL]
    });
    throw new Error('PG_CTL_START_FAILED');
  }
  pgStarted = true;
  targetEnv = { ...localProcessEnv, PGHOST: socketDir, PGPORT: String(selectedPort), PGDATABASE: 'postgres', PGUSER: 'postgres', PGSSLMODE: 'disable' };

  const database = `cf2_restore_${crypto.randomBytes(6).toString('hex')}`;
  await run(tool('createdb'), ['--host', socketDir, '--port', String(selectedPort), '--username', 'postgres', database], { env: targetEnv });
  const restoreEnv = { ...targetEnv, PGDATABASE: database };
  const restore = await run(tool('pg_restore'), [
    '--exit-on-error', '--no-owner', '--no-privileges',
    '--host', socketDir, '--port', String(selectedPort), '--username', 'postgres',
    '--dbname', database, dumpPath
  ], { env: restoreEnv, allowFailure: true });
  result.restore_exit = restore.exitCode;
  if (restore.exitCode !== 0) throw new Error('PG_RESTORE_FAILED');

  const restored = normalizeSnapshot(await psqlJson(snapshotSql(), restoreEnv));
  result.restored_counts = restored.counts;
  result.restored_state_version = restored.state_version;
  result.constraints_pass = source.constraints.length > 0 && equal(source.constraints, restored.constraints);
  result.indexes_pass = source.indexes.length > 0 && equal(source.indexes, restored.indexes);
  result.foreign_keys_pass = source.foreign_keys.length > 0 && equal(source.foreign_keys, restored.foreign_keys);

  const dataPass = equal(source.counts, restored.counts)
    && source.state_version === restored.state_version
    && equal(source.migrations, restored.migrations)
    && equal(source.tables, restored.tables);
  if (!dataPass) throw new Error('SOURCE_RESTORE_MISMATCH');
  if (!result.constraints_pass || !result.indexes_pass || !result.foreign_keys_pass) throw new Error('SCHEMA_VERIFICATION_FAILED');
  result.result = 'PASS';
  result.dump_started_at = dumpStarted;
} catch (error) {
  result.error = safeError(error);
} finally {
  let stopPass = !pgStarted;
  if (pgStarted && dataDir) {
    const pg18Bin = path.resolve(process.env.PG18_BIN ?? '');
    const stopped = await run(postgresTool(pg18Bin, 'pg_ctl'), ['-D', dataDir, '-w', '-t', String(PG_START_TIMEOUT_SECONDS), '-m', 'fast', 'stop'], { env: targetEnv, allowFailure: true }).catch(() => ({ exitCode: 1 }));
    stopPass = stopped.exitCode === 0;
  }
  const expectedRoot = path.resolve(process.env.CF2_GATE_WORK_DIR ?? '');
  const isolated = isIsolatedWorkDir(WORK_DIR, expectedRoot);
  if (isolated) await fs.rm(WORK_DIR, { recursive: true, force: true });
  const removed = isolated && !(await fs.stat(WORK_DIR).then(() => true).catch(() => false));
  result.cleanup_pass = stopPass && removed;
  if (!result.cleanup_pass) result.result = 'FAIL';
  result.finished_at = new Date().toISOString();
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

if (result.result !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
