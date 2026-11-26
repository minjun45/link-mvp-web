import { accessSync, constants, lstatSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isQaOrigin } from '../src/core/types.ts';
import { isDevKey } from './kakaopay-provider.ts';

export const QA_NODE_MINIMUM = '24.22.3';

export function assertQaNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const [major, minor, patch] = match?.slice(1).map(Number) ?? [];
  const [, minimumMinor, minimumPatch] = QA_NODE_MINIMUM.split('.').map(Number);
  if (major !== 24 || minor < minimumMinor || (minor === minimumMinor && patch < minimumPatch))
    throw new Error('Node.js ' + QA_NODE_MINIMUM + ' or newer Node 24 LTS is required for QA');
}

export function renderOrigin(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/.test(value);
}

export function qaSettings(env: NodeJS.ProcessEnv) {
  const { LINK_QA_ORIGIN: origin, RENDER_EXTERNAL_URL: upstream, LINK_QA_ACCESS_KEY: accessKey,
    KAKAOPAY_DEV_SECRET_KEY: devKey, LINK_QA_DB_PATH: databasePath } = env;
  const port = Number(env.PORT);
  if (!isQaOrigin(origin) || !renderOrigin(upstream) ||
      !accessKey || !/^[a-zA-Z0-9_-]{32,128}$/.test(accessKey) || !isDevKey(devKey) ||
      (env.KAKAOPAY_CID !== undefined && env.KAKAOPAY_CID !== 'TC0ONETIME') ||
      !databasePath || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid QA server configuration');
  }
  const publicAccess = env.LINK_QA_PUBLIC_ACCESS === 'true';
  return { origin, upstream, accessKey, devKey, databasePath, port, publicAccess };
}

export function verifyQaDisk(
  databasePath: string,
  mountInfo = () => readFileSync('/proc/self/mountinfo', 'utf8'),
  checkWrite = (path: string) => {
    accessSync(path, constants.W_OK | constants.X_OK);
    if (statfsSync(path).bavail < 1) throw new Error('QA disk is full');
  },
) {
  if (!isAbsolute(databasePath) || resolve(databasePath) !== databasePath || !databasePath.endsWith('.sqlite'))
    throw new Error('Invalid QA database path');
  const directory = dirname(databasePath);
  const mount = mountInfo().split('\n').some(line => {
    const [left, right] = line.split(' - ', 2);
    const fields = left.split(' ');
    const filesystem = right?.split(' ')[0];
    return !!filesystem && !['tmpfs', 'ramfs', 'overlay', 'devtmpfs'].includes(filesystem) &&
      fields[4] === directory && directory !== '/' && fields[5]?.split(',').includes('rw');
  });
  if (!mount || realpathSync(directory) !== directory) throw new Error('Writable QA disk is not mounted');
  checkWrite(directory);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = lstatSync(databasePath + suffix, { throwIfNoEntry: false });
    if (file && (!file.isFile() || file.nlink !== 1)) throw new Error('Invalid QA database file');
  }
}
