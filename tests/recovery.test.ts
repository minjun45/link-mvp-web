import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaults, quote } from '../src/core/domain';
import { initial, reduce, settings, snapshot, type Action } from '../src/core/flow';
import type { Order, Payment, Snapshot, State } from '../src/core/types';
import { complete, getOrder, products, stores } from '../src/services/api';
import { advancePayment, paymentResult } from '../src/services/checkout';
import { persist, readSnapshot } from '../src/services/storage';
import { savePickup } from '../src/services/useApp';

const store = stores[0];
const product = products[0];
const line = { id: 'line', productId: product.id, quantity: 1, options: defaults(product) };
const receipt = quote(store, products, [line]);
const order: Order = {
  id: 'order-1', paymentId: 'paid-1', number: 'A-0042', created: 1,
  snapshot: receipt, status: 'received', demo: true,
};
const payment: Payment = { id: 'pending-2', state: 'ready', provider: 'offline', snapshot: receipt };
const request = { key: 'request-2', storeId: store.id, items: [line], expected: receipt };
const storageKey = 'link-web.state.v1';
let items: Map<string, string>;

beforeEach(() => {
  items = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

const hydrate = (saved?: unknown) => reduce(initial, { type: 'HYDRATE', snapshot: saved, stores, products });
async function reload(state: State | Snapshot) {
  await persist(state);
  return hydrate(await readSnapshot());
}

test.each(['received', 'preparing', 'ready'] as const)(
  'relaunch restores a %s order and waits for a fresh status before opening pickup',
  async status => {
    const active = { ...order, status };
    const restored = await reload(snapshot({
      ...initial, flow: 'V5-10', order: active, history: { [store.id]: active },
    }));
    expect(restored).toMatchObject({
      flow: 'V5-11', order: { status, number: 'A-0042', snapshot: receipt }, orderStatusChecked: false,
    });
    expect(reduce(restored, { type: 'OPEN_ORDER' }).flow).toBe('V5-11');
    const unavailable = reduce(restored, { type: 'ORDER_LOOKUP_FAILED', orderId: order.id });
    expect(unavailable.order).toBe(restored.order);
    expect(unavailable.message).toContain('다시 확인');
    const refreshed = reduce(unavailable, { type: 'ORDER_UPDATED', order: { ...active, status } });
    expect(refreshed.flow).toBe(status === 'ready' ? 'V5-12' : 'V5-11');
    expect(refreshed.orderStatusChecked).toBe(true);
    expect(refreshed.message).toBe('');

    const ready = reduce(refreshed, { type: 'ORDER_UPDATED', order: { ...active, status: 'ready' } });
    const finished = reduce(ready, { type: 'PICKUP_COMPLETE' });
    expect(finished.flow).toBe('V5-13');
    const reopened = await reload(snapshot(finished));
    expect(reopened.flow).toBe('START');
    expect(reopened.order).toBeUndefined();
    expect(reopened.history[store.id].number).toBe('A-0042');
    expect(reduce(reopened, { type: 'ORDER_UPDATED', order: active })).toBe(reopened);
  },
);

test('the local demo keeps one receipt through payment and restarts at every pickup stage', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  try {
    const discovery = reduce(hydrate(), { type: 'DISCOVER', demo: true });
    let state = reduce(discovery, { type: 'FOUND', stores: [store] });
    state = reduce(state, { type: 'CONFIRM_STORE' });
    state = reduce(state, { type: 'MENU_LOADED', products });
    state = reduce(state, { type: 'SELECT_PRODUCT', id: product.id });
    for (const [id, value] of Object.entries(line.options)) {
      state = reduce(state, { type: 'OPTION', id, value });
    }
    state = reduce(state, { type: 'ADD', id: line.id });
    state = reduce(state, { type: 'NAV', flow: 'V5-08' });
    state = reduce(state, { type: 'CHECKOUT', key: 'local-demo' });
    state = reduce(state, (await advancePayment(state, () => true))!);
    expect(state.flow).toBe('PAYMENT_EXTERNAL');

    const approvedPayment = await complete(settings, state.payment!.id, 'success');
    const approved = reduce(state, await paymentResult(settings, approvedPayment));
    expect(approved.flow).toBe('V5-10');
    const originalOrder = approved.order!;

    state = approved;
    for (const [offset, status, flow] of [
      [1, 'received', 'V5-11'], [8_001, 'preparing', 'V5-11'], [25_001, 'ready', 'V5-12'],
    ] as const) {
      clock.mockReturnValue(1_000_000 + offset);
      const restored = await reload(snapshot(state));
      const response = await getOrder(settings, originalOrder.id);
      state = reduce(restored, { type: 'ORDER_UPDATED', order: response });
      expect(state).toMatchObject({ flow, order: { id: originalOrder.id, number: originalOrder.number, status } });
      expect(state.order?.snapshot.total).toBe(receipt.total);
    }
    const finishedPickup = reduce(state, { type: 'PICKUP_COMPLETE' });
    expect(finishedPickup.flow).toBe('V5-13');
    expect(reduce(finishedPickup, { type: 'START_NEW_ORDER' }).flow).toBe('START');
    const finished = await reload(snapshot(finishedPickup));
    expect(finished.flow).toBe('START');
    expect(finished.order).toBeUndefined();
    expect(finished.history[store.id].id).toBe(originalOrder.id);
  } finally {
    clock.mockRestore();
  }
});

test('fresh status can correct a stale ready snapshot without rewriting the approved amount or number', async () => {
  const restored = await reload({ ...initial, order: { ...order, status: 'ready' } });
  const response = { ...order, number: 'different', snapshot: { ...receipt, total: 1 }, status: 'preparing' as const };
  const checked = reduce(restored, { type: 'ORDER_UPDATED', order: response });
  expect(checked).toMatchObject({
    flow: 'V5-11', order: { status: 'preparing', number: order.number, snapshot: receipt },
  });
  expect(reduce(checked, { type: 'ORDER_UPDATED', order: { ...response, paymentId: 'another' } })).toBe(checked);
});

test('pending payment wins over a saved order and a terminal result returns to the saved order', async () => {
  const restored = await reload({ ...initial, order, payment, request });
  expect(restored.flow).toBe('P02-V');
  expect(reduce(restored, { type: 'BACK' })).toBe(restored);
  expect(reduce(restored, { type: 'RETRY_PAYMENT' })).toBe(restored);
  expect(reduce(restored, { type: 'CHECKOUT', key: 'another' })).toBe(restored);
  const cancelled = reduce(restored, { type: 'PAYMENT_RESULT', payment: { ...payment, state: 'cancelled' } });
  expect(cancelled.flow).toBe('P02-C');
  expect(reduce(cancelled, { type: 'RETRY_CHECKOUT', key: 'another' })).toBe(cancelled);
  const restoredOrder = reduce(cancelled, { type: 'BACK' });
  expect(restoredOrder.flow).toBe('V5-11');
  expect(restoredOrder.order?.id).toBe(order.id);
  expect(restoredOrder.payment).toBeUndefined();
});

test('preparation and completion have no Back route into checkout; a ready payment can still be resumed', () => {
  const preparing = reduce({ ...hydrate(), cart: [line], storeId: store.id }, { type: 'CHECKOUT', key: 'original' });
  expect(reduce(preparing, { type: 'BACK' })).toBe(preparing);
  expect(reduce(preparing, { type: 'CHECKOUT', key: 'duplicate' })).toBe(preparing);
  const external = reduce(preparing, { type: 'PAYMENT_READY', payment });
  const verifying = reduce(external, { type: 'BACK' });
  expect(verifying.flow).toBe('P02-V');
  expect(verifying.request?.key).toBe('original');
  expect(reduce(verifying, { type: 'NAV', flow: 'PAYMENT_EXTERNAL' }).flow).toBe('PAYMENT_EXTERNAL');
  const approved = reduce(verifying, {
    type: 'PAYMENT_RESULT', payment: { ...payment, state: 'approved', orderId: order.id },
    order: { ...order, paymentId: payment.id },
  });
  expect(approved.flow).toBe('V5-10');
  expect(reduce(approved, { type: 'BACK' })).toBe(approved);
  expect(reduce(approved, { type: 'PAYMENT_RESULT', payment })).toBe(approved);
  const late = { type: 'PAYMENT_RESULT', payment: { ...payment, state: 'approved' }, order: approved.order } as const;
  const ready = reduce(approved, { type: 'ORDER_UPDATED', order: { ...approved.order!, status: 'ready' } });
  const finished = reduce(reduce(ready, { type: 'OPEN_ORDER' }), { type: 'PICKUP_COMPLETE' });
  expect(reduce(finished, late)).toBe(finished);
});

test('settling a pending payment preserves an earlier active order at the same store', async () => {
  const restored = await reload({ ...initial, order, payment, request });
  const newer: Order = { ...order, id: 'newer', paymentId: payment.id, number: 'A-0043', status: 'ready' };
  const approved = reduce(restored, {
    type: 'PAYMENT_RESULT', payment: { ...payment, state: 'approved', orderId: newer.id }, order: newer,
  });
  expect(approved.flow).toBe('V5-10');
  const pickup = reduce(approved, { type: 'OPEN_ORDER' });
  const nextOrder = reduce(pickup, { type: 'PICKUP_COMPLETE' });
  expect(nextOrder).toMatchObject({ flow: 'V5-13', order, orderStatusChecked: false });
  const home = reduce(nextOrder, { type: 'START_NEW_ORDER' });
  expect(home.flow).toBe('START');
  expect(reduce(home, { type: 'OPEN_ORDER' })).toMatchObject({ flow: 'V5-11', order });
  const reloaded = await reload(snapshot(nextOrder));
  expect(reloaded).toMatchObject({ flow: 'V5-11', order, queuedOrders: undefined });
  expect(reloaded.history[store.id]).toEqual(newer);
});

test('a failed pickup save stays at pickup with its original order and can be retried', async () => {
  const ready: Order = { ...order, status: 'ready' };
  let state: State = { ...initial, flow: 'V5-12', order: ready, history: { [store.id]: ready } };
  await persist(snapshot(state));
  const beforePickup = items.get(storageKey);
  const write = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('storage full');
  });
  const inFlight = { current: false };
  const busy = vi.fn();
  const dispatch = (action: Action) => { state = reduce(state, action); };
  try {
    await savePickup(state, inFlight, busy, dispatch);
    expect(state).toMatchObject({ flow: 'V5-12', order: ready, history: { [store.id]: ready } });
    expect(state.storageNotice).toContain('다시 눌러 주세요');
    expect(items.get(storageKey)).toBe(beforePickup);
    expect(hydrate(await readSnapshot())).toMatchObject({ flow: 'V5-11', order: ready });
    expect(inFlight.current).toBe(false);

    await savePickup(state, inFlight, busy, dispatch);
    expect(state).toMatchObject({ flow: 'V5-13', order: undefined, storageNotice: '' });
    expect(hydrate(await readSnapshot())).toMatchObject({ flow: 'START', order: undefined, history: { [store.id]: ready } });
    expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
  } finally {
    write.mockRestore();
  }
});

test('double pickup clicks save once and keep unrelated orders and pending payment', async () => {
  const ready: Order = { ...order, status: 'ready' };
  const waiting: Order = { ...order, id: 'waiting', number: 'A-0043' };
  let state: State = {
    ...initial, flow: 'V5-12', order: ready, history: { [store.id]: ready },
    queuedOrders: [waiting], request, payment,
  };
  const write = vi.spyOn(localStorage, 'setItem');
  const dispatch = vi.fn((action: Action) => { state = reduce(state, action); });
  const busy = vi.fn();
  const inFlight = { current: false };
  try {
    const first = savePickup(state, inFlight, busy, dispatch);
    const duplicate = savePickup(state, inFlight, busy, dispatch);
    expect(state.flow).toBe('V5-12');
    await Promise.all([first, duplicate]);
    expect(write).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'PICKUP_COMPLETE' });
    expect(state).toMatchObject({ flow: 'V5-13', order: waiting, request, payment });
    expect(reduce(state, { type: 'START_NEW_ORDER' })).toMatchObject({ flow: 'START', order: waiting, request, payment });
    expect(hydrate(await readSnapshot())).toMatchObject({ flow: 'P02-V', order: waiting, request, payment });
    expect(state.history[store.id]).toEqual(ready);
  } finally {
    write.mockRestore();
  }
});

test('partially damaged shopping data keeps valid lines, per-store history and legacy settings', async () => {
  items.set(storageKey, JSON.stringify({
    cart: [line, null, { ...line, quantity: 3 }, { ...line, id: 'broken', options: null }],
    history: { [store.id]: order, missing: null, unrelated: order },
    settings: { dark: true, contrast: 'true', large: true, voice: true, mode: 'local' },
  }));
  const state = hydrate(await readSnapshot());
  expect(state.flow).toBe('START');
  expect(state.cart).toEqual([line]);
  expect(state.history).toEqual({ [store.id]: order });
  expect(state.settings).toEqual({ ...settings, dark: true, large: true });
  expect(state.storageNotice).toContain('장바구니');
});

test.each([{ cart: null }, {}, undefined])('starts safely with incomplete snapshot %j', value => {
  const state = hydrate(value);
  expect(state).toMatchObject({ flow: 'START', cart: [], history: {}, settings, recoveryRequired: false });
});

test('invalid JSON fails reading and an unreadable root puts checkout in recovery without changing storage', async () => {
  items.set(storageKey, '{"broken');
  const value = await readSnapshot().catch(() => null);
  const state = hydrate(value);
  expect(state.flow).toBe('P02-V');
  expect(state.recoveryRequired).toBe(true);
  expect(reduce(state, { type: 'BACK' })).toBe(state);
  expect(reduce(state, { type: 'CHECKOUT', key: 'new' }).request).toBeUndefined();
  expect(items.get(storageKey)).toBe('{"broken');
});

test.each([
  { request: { key: 'corrupt' }, order },
  { payment: { ...payment, snapshot: null }, request, order },
  { order: { ...order, number: null }, payment },
  { settings: { mode: 'server', serverUrl: 1 }, payment, order },
])('damaged financial fields block a new payment while keeping usable records', partial => {
  const state = hydrate({ ...initial, ...partial, cart: [line] });
  expect(state.flow).toBe('P02-V');
  expect(state.recoveryRequired).toBe(true);
  expect(state.cart).toEqual([line]);
  expect(reduce(state, { type: 'CHECKOUT', key: 'new' }).request?.key).not.toBe('new');
  if (state.order) expect(reduce(state, { type: 'NAV', flow: 'V5-11' }).order).toBe(state.order);
});
