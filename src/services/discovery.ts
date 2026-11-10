import type { Action } from '../core/flow';
import type { Settings, Store } from '../core/types';
import { getStores } from './api';
import { chooseBeacon, bluetoothErrorMessage } from '../native/browserDevice';

export const STORE_LOOKUP_TIMEOUT_MS = 15_000;
export const DEMO_DISCOVERY_MS = 2_000;
type DiscoveryAction = Extract<Action, { type: 'STORES' | 'FOUND' | 'FAIL' }>;
type DiscoveryOptions = {
  settings: Settings;
  demo: boolean;
  stores: Store[];
  send: (action: DiscoveryAction) => void;
};
type Dependencies = {
  loadStores?: (settings: Settings) => Promise<Store[]>;
  choose?: (names: string[]) => Promise<string | undefined>;
};

// Invoke directly from a click handler: requestDevice needs that click's
// transient user activation. Demo never invokes the Bluetooth adapter.
export function startDiscovery(
  { settings, demo, stores, send }: DiscoveryOptions,
  { loadStores = getStores, choose = chooseBeacon }: Dependencies = {},
) {
  let active = true;
  let demoTimer: ReturnType<typeof setTimeout> | undefined;
  // Bound metadata loading, not the browser's permission/device chooser. The
  // user may need more than 15 seconds to grant OS permission and pick a device.
  const timeout = setTimeout(() => finish({
    type: 'FAIL',
    flow: 'E04',
    message: '매장 정보를 불러오는 데 시간이 걸리고 있어요. 연결을 확인한 뒤 다시 시도해 주세요.',
  }), STORE_LOOKUP_TIMEOUT_MS);

  function finish(action: DiscoveryAction) {
    if (!active) return;
    active = false;
    clearTimeout(timeout);
    clearTimeout(demoTimer);
    send(action);
  }

  function failed(error: unknown, flow: 'V5-01e' | 'E04') {
    finish({
      type: 'FAIL',
      flow,
      message: bluetoothErrorMessage(error),
    });
  }

  try {
    // Call Bluetooth before fetching or awaiting metadata to retain activation.
    const selection = demo ? undefined : choose(stores.map(store => store.beaconName));
    // Attach rejection handlers immediately, including while metadata is pending.
    const selected = selection?.catch(error => {
      failed(error, 'V5-01e');
      return undefined;
    });
    const metadata = loadStores(settings).then(available => {
      clearTimeout(timeout);
      return available;
    }).catch(error => {
      failed(error, 'E04');
      return [];
    });
    void Promise.all([metadata, selected]).then(([available, name]) => {
      if (!active) return;
      send({ type: 'STORES', stores: available });
      if (demo)
        demoTimer = setTimeout(() => finish({ type: 'FOUND', stores: available }), DEMO_DISCOVERY_MS);
      else
        finish({ type: 'FOUND', stores: available.filter(store => store.beaconName === name) });
    });
  } catch (error) {
    failed(error, 'V5-01e');
  }

  return () => {
    active = false;
    clearTimeout(timeout);
    clearTimeout(demoTimer);
  };
}
