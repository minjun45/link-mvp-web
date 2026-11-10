import { afterEach, expect, test, vi } from 'vitest';
import { chooseBeacon, inspectBeacon, getBluetoothStatus } from '../src/native/browserDevice';

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
  await expect(inspectBeacon()).rejects.toThrow('Web Bluetooth');
});

test('Samsung Internet is identified without a Chrome-only browser gate', async () => {
  adapter();
  const requestDevice = vi.fn(async () => ({ name: 'LINK-KAIST' }));
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 15) SamsungBrowser/29.0 Chrome/132.0 Mobile',
    userActivation: { isActive: true },
    bluetooth: { requestDevice },
  });
  expect(getBluetoothStatus()).toMatchObject({ browser: '삼성 인터넷 29.0', secure: true, api: true });
  await chooseBeacon(['LINK-KAIST']);
  expect(requestDevice).toHaveBeenCalledTimes(1);
  expect(getBluetoothStatus().request).toMatchObject({ phase: 'selected', userActivation: true });
});

test('blocked permission keeps its original error for diagnostics', async () => {
  adapter();
  vi.stubGlobal('navigator', {
    userActivation: { isActive: false },
    bluetooth: { requestDevice: vi.fn(async () => { throw new DOMException('Must be handling a user gesture', 'SecurityError'); }) },
  });
  await expect(inspectBeacon()).rejects.toThrow('[SecurityError]');
  expect(getBluetoothStatus().request).toMatchObject({
    phase: 'failed', userActivation: false, error: 'SecurityError: Must be handling a user gesture',
  });
});
