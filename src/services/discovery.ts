import type { Action } from '../core/flow';
import type { Settings, Store } from '../core/types';
import { getStores } from './api';
import { chooseBeacon } from '../native/browserDevice';

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

  function finish(action: DiscoveryAction) {
    if (!active) return;
    active = false;
    clearTimeout(demoTimer);
    send(action);
  }

  function failed(error: unknown, flow: 'V5-01e' | 'E04') {
    const denied = error instanceof DOMException && error.name === 'NotAllowedError';
    finish({
      type: 'FAIL',
      flow,
      message: denied
        ? '브라우저에서 블루투스 권한을 허용한 뒤 다시 시도해 주세요.'
        : error instanceof Error ? error.message : '매장을 찾지 못했어요. 다시 찾거나 이름으로 검색해 주세요.',
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
    const metadata = loadStores(settings).catch(error => {
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
    clearTimeout(demoTimer);
  };
}
