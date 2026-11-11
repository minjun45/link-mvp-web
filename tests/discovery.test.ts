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

test('Bluetooth selection stays pending without a deadline and accepts a late choice', async () => {
  const send = vi.fn();
  let select!: (name: string) => void;
  scan(false, send, async () => catalog.stores, () => new Promise(resolve => { select = resolve; }));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(send).not.toHaveBeenCalled();
  select(catalog.stores[0].beaconName);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenLastCalledWith({ type: 'FOUND', stores: [catalog.stores[0]] });
  expect(send).toHaveBeenCalledTimes(2);
});

test('slow store metadata does not expire a completed device selection', async () => {
  const send = vi.fn();
  let resolve!: (stores: Store[]) => void;
  scan(false, send, () => new Promise(r => { resolve = r; }), async () => catalog.stores[0].beaconName);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).not.toHaveBeenCalled();
  resolve(catalog.stores);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenLastCalledWith({ type: 'FOUND', stores: [catalog.stores[0]] });
});

test('leaving discovery ignores late metadata', async () => {
  const send = vi.fn();
  let resolve!: (stores: Store[]) => void;
  const stop = scan(false, send, () => new Promise(r => { resolve = r; }));
  stop();
  resolve(catalog.stores);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).not.toHaveBeenCalled();
});

test('demo discovery shows its loading screen before returning results exactly once', async () => {
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
