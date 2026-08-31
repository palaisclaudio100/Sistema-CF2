import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPgCtlFailureDiagnostic,
  buildPgCtlStartArgs,
  isIsolatedWorkDir,
  sanitizePostgresDiagnostic,
  sanitizedTargetEnvironment
} from './backup-restore-gate.mjs';

const root = '/tmp/cf2-backup-restore-test-run';
const dataDir = `${root}/work/pgdata`;
const socketDir = `${root}/work/socket`;
const logPath = `${root}/work/postgres.log`;
const postgresBin = `${root}/postgres/usr/lib/postgresql/18/bin/postgres`;

test('pg_ctl start command pins absolute local paths, socket, log, port and timeout', () => {
  const args = buildPgCtlStartArgs({ dataDir, socketDir, logPath, port: 15432, postgresBin });
  assert.deepEqual(args.slice(0, 10), [
    '-D', dataDir, '-l', logPath, '-w', '-t', '20', '-p', postgresBin, '-o'
  ]);
  assert.equal(args.at(-1), 'start');
  assert.match(args[10], /-h 127\.0\.0\.1/);
  assert.match(args[10], /-p 15432/);
  assert.match(args[10], new RegExp(`-k ${socketDir}`));
  assert.match(args[10], new RegExp(`unix_socket_directories=${socketDir}`));
  assert.match(args[10], /shared_buffers=32MB/);
});

test('cleanup guard accepts only the expected work directory inside a run root', () => {
  const work = `${root}/work`;
  assert.equal(isIsolatedWorkDir(work, work), true);
  assert.equal(isIsolatedWorkDir('/tmp/other/work', work), false);
  assert.equal(isIsolatedWorkDir(root, root), false);
});

test('target process environment excludes every production connection credential', () => {
  const target = sanitizedTargetEnvironment({
    PATH: '/portable/bin', DATABASE_URL: 'postgresql://secret', CF2_DATABASE_URL: 'secret',
    PGHOST: 'private', PGPORT: '5432', PGDATABASE: 'prod', PGUSER: 'user',
    PGPASSWORD: 'password', PGOPTIONS: 'read-only'
  });
  assert.deepEqual(target, { PATH: '/portable/bin' });
});

test('pg_ctl failure diagnostic is bounded, local and redacts credentials', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf2-pgctl-test-'));
  const localData = path.join(temp, 'pgdata');
  const localSocket = path.join(temp, 'socket');
  const localLog = path.join(temp, 'postgres.log');
  const secret = 'postgresql://user:password@dpg-private-a/prod';
  try {
    await fs.mkdir(localData, { mode: 0o700 });
    await fs.mkdir(localSocket, { mode: 0o700 });
    await fs.writeFile(localLog, `safe line\n${secret}\npassword=hunter2\ndpg-private-a\n`);
    const diagnostic = await buildPgCtlFailureDiagnostic({
      exitCode: 1, dataDir: localData, socketDir: localSocket, port: 15432,
      postgresVersion: 'postgres (PostgreSQL) 18.6', logPath: localLog,
      forbiddenValues: [secret]
    });
    assert.equal(diagnostic.phase, 'START_EPHEMERAL_POSTGRES');
    assert.equal(diagnostic.exit_code, 1);
    assert.equal(diagnostic.pgdata.exists, true);
    assert.equal(diagnostic.socket_dir.exists, true);
    assert.equal(diagnostic.socket_dir.within_run_id, true);
    assert.equal(diagnostic.port, 15432);
    assert.doesNotMatch(diagnostic.log_tail, /hunter2|dpg-private|user:password/);
    assert.match(diagnostic.log_tail, /\[REDACTED\]/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('source contains one pg_ctl start and no retry loop', async () => {
  const source = await fs.readFile(new URL('./backup-restore-gate.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/await run\(tool\('pg_ctl'\), buildPgCtlStartArgs\(\{/g) ?? []).length, 1);
  assert.doesNotMatch(source, /retry.*pg_ctl|pg_ctl.*retry/is);
  assert.match(source, /allowFailure: true/);
});

test('sanitizer never emits database URLs, passwords or Render private hosts', () => {
  const output = sanitizePostgresDiagnostic('postgresql://u:p@dpg-secret-a/db password=plain dpg-secret-a');
  assert.doesNotMatch(output, /postgresql:\/\/|plain|dpg-secret/);
});
