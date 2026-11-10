import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { settings } from '../src/core/flow';
import { startDiscovery } from '../src/services/discovery';
import type { Settings, Store } from '../src/core/types';
import catalog from '../src/data/catalog.json';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function scan(
  demo: boolean,
  send: Parameters<typeof startDiscovery>[0]['send'],
  loadStores: (settings: Settings) => Promise<Store[]>,
  choose: (names: string[]) => Promise<string | undefined> = () => new Promise(() => {}),
) {
  return startDiscovery({ settings, demo, stores: catalog.stores, send }, { loadStores, choose });
}

test('metadata that takes more than 15 seconds produces a connection error', async () => {
  const send = vi.fn();
  let resolve!: (stores: Store[]) => void;
  scan(false, send, () => new Promise(r => { resolve = r; }));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'FAIL', flow: 'E04' }));
  resolve(catalog.stores);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
});

test('a browser selection after 15 seconds is still accepted once metadata has loaded', async () => {
  const send = vi.fn();
  let resolve!: (name: string) => void;
  scan(false, send, async () => catalog.stores, () => new Promise(r => { resolve = r; }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).not.toHaveBeenCalled();
  resolve(catalog.stores[0].beaconName);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenLastCalledWith({ type: 'FOUND', stores: [catalog.stores[0]] });
});

test('1103: leaving discovery ignores late metadata and cancels its timeout', async () => {
  const send = vi.fn();
  let resolve!: (stores: Store[]) => void;
  const stop = scan(false, send, () => new Promise(r => { resolve = r; }));
  stop();
  resolve(catalog.stores);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).not.toHaveBeenCalled();
});

test('demo discovery shows its loading screen before returning results and cancels the deadline', async () => {
  const send = vi.fn();
  const choose = vi.fn();
  scan(true, send, async () => catalog.stores, choose);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'STORES', stores: catalog.stores });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(send).toHaveBeenLastCalledWith({ type: 'FOUND', stores: catalog.stores });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(choose).not.toHaveBeenCalled();
});

test('leaving demo discovery cancels its delayed success', async () => {
  const send = vi.fn();
  const stop = scan(true, send, async () => catalog.stores);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).toHaveBeenCalledTimes(1);
});

test('network failure remains a connection error instead of later becoming no stores found', async () => {
  const send = vi.fn();
  scan(false, send, async () => { throw new Error('offline'); });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'FAIL', flow: 'E04', message: 'offline' });
});

test('real discovery invokes the browser adapter immediately before metadata loading', async () => {
  const requestDevice = vi.fn(async () => ({ name: catalog.stores[0].beaconName }));
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
  const send = vi.fn();
  const loadStores = vi.fn(async () => catalog.stores);
  startDiscovery({ settings, demo: false, stores: catalog.stores, send }, { loadStores });
  // No await: the request must remain within the initiating click's stack.
  expect(requestDevice).toHaveBeenCalledExactlyOnceWith({
    filters: catalog.stores.map(store => ({ name: store.beaconName })),
  });
  expect(requestDevice.mock.invocationCallOrder[0]).toBeLessThan(loadStores.mock.invocationCallOrder[0]);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenLastCalledWith({ type: 'FOUND', stores: [catalog.stores[0]] });
});

test('denied Bluetooth permission is handled while metadata is pending', async () => {
  const send = vi.fn();
  scan(false, send, () => new Promise(() => {}), async () => { throw new DOMException('denied', 'NotAllowedError'); });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'FAIL', flow: 'V5-01e' }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).toHaveBeenCalledTimes(1);
});

test('a Bluetooth result arriving after cancellation is ignored', async () => {
  const send = vi.fn();
  let resolve!: (name: string) => void;
  const stop = scan(false, send, async () => catalog.stores, () => new Promise(r => { resolve = r; }));
  stop();
  resolve(catalog.stores[0].beaconName);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).not.toHaveBeenCalled();
});
