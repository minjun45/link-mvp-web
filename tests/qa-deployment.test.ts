import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { assertQaNode, qaSettings, verifyQaDisk } from '../scripts/qa-config';
import { PaymentDatabase } from '../scripts/kakaopay-db';
import { DatabaseSync } from 'node:sqlite';

const frontend = 'https://link-preflight.vercel.app';
const backend = 'https://link-preflight.onrender.com';
const environment = () => ({
  LINK_QA_ORIGIN: frontend,
  RENDER_EXTERNAL_URL: backend,
  LINK_QA_ACCESS_KEY: randomBytes(32).toString('hex'),
  KAKAOPAY_DEV_SECRET_KEY: 'DEV' + randomBytes(16).toString('hex'),
  LINK_QA_DB_PATH: '/var/data/link.sqlite',
  PORT: '10000',
});

const vercel = {
  LINK_QA_ORIGIN: frontend, LINK_QA_RENDER_ORIGIN: backend,
  VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'feature/kakaopay-test-payment',
  VERCEL_PROJECT_PRODUCTION_URL: new URL(frontend).host,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (const file of ['qa.sqlite', 'qa.sqlite-wal', 'qa.sqlite-shm', 'config.json', 'static/index.html'])
      rmSync(join(dir, file), { force: true });
    if (existsSync(join(dir, 'static'))) rmdirSync(join(dir, 'static'));
    rmdirSync(dir);
  }
});
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'link-qa-preflight-')));
  dirs.push(dir);
  return dir;
};

test('Render QA pins the security release floor within the Node 24 LTS line', () => {
  expect(() => assertQaNode('24.22.3')).not.toThrow();
  expect(() => assertQaNode('24.23.0')).not.toThrow();
  for (const version of ['24.22.1', '24.22.2', '24.9.0', '22.23.5', '26.13.0'])
    expect(() => assertQaNode(version)).toThrow('24.22.3');
});

test('QA settings reject production, malformed origins, weak access keys and absent values', () => {
  const valid = environment();
  expect(qaSettings(valid)).toMatchObject({ origin: frontend, upstream: backend, port: 10000 });
  for (const input of [
    { KAKAOPAY_CID: 'OPERATING_CID' },
    { KAKAOPAY_DEV_SECRET_KEY: 'PROD-placeholder' },
    { LINK_QA_ACCESS_KEY: 'short' },
    { LINK_QA_ORIGIN: 'https://link-mvp-web.vercel.app' },
    { LINK_QA_ORIGIN: frontend + '/path' },
    { LINK_QA_ORIGIN: 'http://link-preflight.vercel.app' },
    { RENDER_EXTERNAL_URL: 'https://unapproved.example.test' },
    { LINK_QA_DB_PATH: undefined },
    { PORT: '65536' },
  ]) expect(() => qaSettings({ ...valid, ...input })).toThrow('Invalid QA server configuration');
});

test('requires a separate writable persistent mount, beyond mere directory creation', () => {
  const dir = scratch();
  const file = join(dir, 'qa.sqlite');
  const entry = (mode: string, filesystem = 'ext4') =>
    `38 18 0:30 / ${dir} ${mode} - ${filesystem} test-volume ${mode}`;
  expect(() => verifyQaDisk(file, () => '', () => {})).toThrow();
  expect(() => verifyQaDisk(file, () => entry('rw', 'tmpfs'), () => {})).toThrow();
  expect(() => verifyQaDisk(file, () => entry('ro'), () => {})).toThrow();
  expect(() => verifyQaDisk(file, () => entry('rw'), () => { throw new Error('writing denied'); })).toThrow('writing denied');
  expect(() => verifyQaDisk(file, () => entry('rw'), () => {})).not.toThrow();
});

test('native hosted process refuses startup before opening an unmounted database', () => {
  const filename = join(scratch(), 'qa.sqlite');
  const settings = environment();
  const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/kakaopay-local.ts', '--qa'], {
    env: { ...process.env, ...settings, LINK_QA_DB_PATH: filename },
    timeout: 5000, encoding: 'utf8',
  });
  expect(run.status).toBe(1);
  const logs = run.stdout + run.stderr;
  expect(logs).not.toContain(settings.KAKAOPAY_DEV_SECRET_KEY);
  expect(logs).not.toContain(settings.LINK_QA_ACCESS_KEY);
  expect(() => readFileSync(filename)).toThrow();
});

test('SQLite handles an actual writer lock and rejects an unsupported schema', () => {
  const path = join(scratch(), 'qa.sqlite');
  const typed = new PaymentDatabase(path);
  const other = new DatabaseSync(path);
  try {
    other.exec('BEGIN IMMEDIATE');
    expect(() => typed.newSession()).toThrow(/locked/i);
    other.exec('ROLLBACK');
    const record = typed.newSession();
    expect(typed.session(record.id)).toEqual(record);
    other.exec('PRAGMA user_version = 55');
  } finally {
    other.close();
    typed.close();
  }
  expect(() => new PaymentDatabase(path)).toThrow('Unsupported payment database schema');
}, 7500);

test('can only stamp QA metadata in the approved Vercel Production target', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'static'));
  const filename = join(dir, 'static/index.html');
  const normal = '<html><head></head><body></body></html>';
  writeFileSync(filename, normal);
  for (const scope of [
    { VERCEL_ENV: 'preview' },
    { VERCEL_GIT_COMMIT_REF: 'main' },
    { VERCEL_PROJECT_PRODUCTION_URL: 'link-mvp-web.vercel.app' },
    { VERCEL_PROJECT_PRODUCTION_URL: '' },
    { LINK_QA_RENDER_ORIGIN: '' },
  ]) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/qa-vercel.ts', dir], {
      env: { ...process.env, ...vercel, ...scope }, timeout: 5000, encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(readFileSync(filename, 'utf8')).toBe(normal);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  }
});

test('generates a QA-only v3 output with a fixed rewrite and no backend credentials', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'static'));
  const filename = join(dir, 'static/index.html');
  writeFileSync(filename, '<html><head></head><body></body></html>');
  const fake = environment();
  const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/qa-vercel.ts', dir], {
    env: { ...process.env, ...fake, ...vercel }, timeout: 5000, encoding: 'utf8',
  });
  expect(run.status).toBe(0);
  const page = readFileSync(filename, 'utf8');
  const config = readFileSync(join(dir, 'config.json'), 'utf8');
  expect(page).toContain('name="link-kakaopay-qa" content="' + frontend + '"');
  expect(JSON.parse(config)).toMatchObject({ version: 3, routes: [{ dest: backend + '/$1' }, { dest: '/index.html' }, { handle: 'filesystem' }] });
  expect(page + config).not.toContain(fake.LINK_QA_ACCESS_KEY);
  expect(page + config).not.toContain(fake.KAKAOPAY_DEV_SECRET_KEY);
});
