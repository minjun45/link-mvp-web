import { afterEach, expect, test, vi } from 'vitest';
import { chooseBeacon, inspectBeacon } from '../src/native/browserDevice';

afterEach(() => vi.unstubAllGlobals());

function adapter() {
  const connect = vi.fn();
  const requestDevice = vi.fn(async () => ({ name: 'Galaxy test', gatt: { connect } }));
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
  return { requestDevice, connect };
}

test('normal discovery retains exact store-name filtering', async () => {
  const { requestDevice } = adapter();
  await chooseBeacon(['LINK-KAIST', 'LINK-KAIST', 'LINK-IEUM']);
  expect(requestDevice).toHaveBeenCalledExactlyOnceWith({ filters: [{ name: 'LINK-KAIST' }, { name: 'LINK-IEUM' }] });
});

test('diagnostics requests unfiltered BLE candidates immediately and reads only the chosen name', async () => {
  const { requestDevice, connect } = adapter();
  const result = inspectBeacon();
  expect(requestDevice).toHaveBeenCalledExactlyOnceWith({ acceptAllDevices: true });
  expect(await result).toBe('Galaxy test');
  expect(connect).not.toHaveBeenCalled();
});

test('insecure pages are rejected before requesting device access', async () => {
  const { requestDevice } = adapter();
  vi.stubGlobal('window', { isSecureContext: false });
  await expect(inspectBeacon()).rejects.toThrow('HTTPS');
  expect(requestDevice).not.toHaveBeenCalled();
});

test('unsupported browsers get a useful error', async () => {
  adapter();
  vi.stubGlobal('navigator', {});
  await expect(inspectBeacon()).rejects.toThrow('노트북 Chrome');
});
