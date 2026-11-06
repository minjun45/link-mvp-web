import type { Snapshot } from '../core/types';
const snapshotKey = 'link-web.state.v1';
let pending: Promise<unknown> = Promise.resolve();
export async function readSnapshot(): Promise<Snapshot | undefined> {
  const text = localStorage.getItem(snapshotKey);
  if (!text) return;
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
export function persist(value: Snapshot): Promise<void> {
  const encoded = JSON.stringify(value);
  return serial(async () => localStorage.setItem(snapshotKey, encoded));
}
export function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.catch(() => {}).then(() => {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request('link-web-storage', work) : work();
  });
  pending = next;
  return next;
}
