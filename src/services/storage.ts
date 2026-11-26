import { initial, settings, snapshot } from '../core/flow';
import { restoreSnapshot } from '../core/savedData';
import type { Snapshot } from '../core/types';

const snapshotKey = 'link-web.state.v2';
const legacyKey = 'link-web.state.v1';
const presentation = ['dark', 'contrast', 'staffHelp', 'large', 'quickOptions'] as const;
const empty = snapshot(initial);
let pending: Promise<unknown> = Promise.resolve();
let stateDatabase: Promise<IDBDatabase> | undefined;

export class SnapshotConflict extends Error {
  constructor() {
    super('The saved order changed in another tab');
  }
}

function legacySnapshot() {
  return localStorage.getItem(snapshotKey) ?? localStorage.getItem(legacyKey);
}

function decode(text: string | null | undefined): unknown {
  return text == null ? undefined : JSON.parse(text);
}

export function readSnapshot(): Promise<unknown> {
  return withSnapshot('readonly', value => value);
}

function commerce(value: Snapshot) {
  const { settings: { mode, serverUrl }, onboarded: _onboarded, ...orderData } = value;
  return JSON.stringify({ mode, serverUrl, ...orderData }, (_key, field: unknown) =>
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.keys(field).sort().map(key => [key, (field as Record<string, unknown>)[key]]))
      : field);
}

function withSnapshot<T>(
  mode: IDBTransactionMode,
  work: (current: unknown, save: (encoded: string) => void) => T,
): Promise<T> {
  if (typeof document === 'undefined') {
    return serial(async () => work(decode(legacySnapshot()), value => localStorage.setItem(snapshotKey, value)));
  }
  stateDatabase ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('link-web-state', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('snapshots');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return stateDatabase.then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', mode);
    const store = transaction.objectStore('snapshots');
    const read = store.get(snapshotKey);
    let result: T;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
    read.onsuccess = () => {
      try {
        // Read and write the authoritative value in the same transaction.
        result = work(decode(read.result ?? legacySnapshot()), value => store.put(value, snapshotKey));
      } catch (error) {
        reject(error);
        transaction.abort();
      }
    };
  }));
}

export function persist(
  value: Snapshot,
  canWrite = () => true,
  before: Snapshot = empty,
  verifyCommerce = false,
): Promise<void> {
  return withSnapshot('readwrite', (stored, save) => {
    if (!canWrite()) throw new DOMException('Page state changed', 'AbortError');
    const { snapshot: current, recoveryRequired } = restoreSnapshot(stored, settings);
    const expected = commerce(before);
    const desired = commerce(value);
    const commerceChanged = expected !== desired;
    const controlCommerce = verifyCommerce || commerceChanged;
    const saved = controlCommerce ? commerce(current) : '';
    const conflict = controlCommerce && (recoveryRequired || (saved !== expected && saved !== desired));
    if (recoveryRequired) throw new SnapshotConflict();

    // Settings changes are per field. The commerce group is compare-and-swap,
    // so a stale cart or receipt cannot clear or revive another tab's order.
    const merged = { ...(commerceChanged && !conflict ? value : current) };
    const nextSettings = { ...current.settings, mode: merged.settings.mode, serverUrl: merged.settings.serverUrl };
    for (const key of presentation) {
      if (value.settings[key] !== before.settings[key]) nextSettings[key] = value.settings[key];
    }
    merged.settings = nextSettings;
    merged.onboarded = current.onboarded || value.onboarded;
    const encoded = JSON.stringify(merged);
    if ((verifyCommerce && !conflict) || encoded !== JSON.stringify(current)) save(encoded);
    return conflict;
  }).then(conflict => {
    if (conflict) throw new SnapshotConflict();
  });
}

export function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.catch(() => {}).then(() => {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request('link-web-storage', work) : work();
  });
  pending = next;
  return next;
}
