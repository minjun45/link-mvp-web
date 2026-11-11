import { expect, test } from 'vitest';
import { initial, reduce, snapshot } from '../src/core/flow';
import { defaults, quote, sameQuote } from '../src/core/domain';
import type { State, Order, Payment, Product } from '../src/core/types';
import catalog from '../src/data/catalog.json';
const stores = catalog.stores;
const products = catalog.menu as Product[];
const p = products[0];
const start = (): State =>
  reduce(initial, { type: 'HYDRATE', stores, products });
const menu = (): State => ({
  ...start(),
  onboarded: true,
  flow: 'V5-05',
  storeId: stores[0].id,
  selectedStoreId: stores[0].id,
});
const cart = (): State => ({
  ...menu(),
  cart: [{ id: 'one', productId: p.id, quantity: 1, options: defaults(p) }],
});
const order = (s: State): Order => ({
  id: 'order',
  paymentId: 'payment',
  number: 'A-0001',
  created: Date.now(),
  snapshot: quote(stores[0], products, s.cart),
  status: 'received',
  demo: true,
});
test('entry choice is first; optional onboarding returns to entry choice and preserves completion', () => {
  let s = start();
  expect(s.flow).toBe('START');
  s = reduce(s, { type: 'REPLAY_TRAINING' });
  for (const flow of ['V5-O2', 'V5-O3', 'V5-O4', 'START']) {
    s = reduce(s, { type: 'ONBOARD_NEXT' });
    expect(s.flow).toBe(flow);
  }
  expect(s.onboarded).toBe(true);
  expect(
    reduce(initial, {
      type: 'HYDRATE',
      snapshot: snapshot(s),
      stores,
      products,
    }).flow,
  ).toBe('START');
  expect(reduce(start(), { type: 'ONBOARD_SKIP' }).onboarded).toBe(true);
  expect(reduce(s, { type: 'REPLAY_TRAINING' }).flow).toBe('V5-O1');
});
test('restoring old settings drops automatic speech and retains display and server preferences', () => {
  const saved = {
    ...snapshot(initial),
    settings: {
      ...initial.settings,
      voice: true,
      large: true,
      contrast: true,
      mode: 'server' as const,
      serverUrl: 'https://example.test',
    },
  };
  const restored = reduce(initial, { type: 'HYDRATE', snapshot: saved, stores, products });
  expect(restored.settings).not.toHaveProperty('voice');
  expect(snapshot(restored).settings).toMatchObject({
    large: true, contrast: true, mode: 'server', serverUrl: 'https://example.test',
  });
  expect(snapshot(restored).settings).not.toHaveProperty('voice');
});

test('08: zero/one/multiple scan results and three-at-a-time lists', () => {
  expect(reduce(menu(), { type: 'FOUND', stores: [] }).flow).toBe('V5-01e');
  expect(reduce(menu(), { type: 'FOUND', stores: [stores[0]] }).flow).toBe(
    'V5-03',
  );
  let s = reduce(menu(), { type: 'FOUND', stores });
  expect(s.flow).toBe('V5-02');
  expect(s.storeLimit).toBe(3);
  expect(reduce(s, { type: 'MORE_STORES' }).storeLimit).toBe(6);
});
test('08: back from the demo store list returns to entry choices instead of rescanning', () => {
  const demo = reduce(reduce(menu(), { type: 'DISCOVER', demo: true }), {
    type: 'FOUND',
    stores,
  });
  expect(demo).toMatchObject({ flow: 'V5-02', discovery: 'demo' });
  expect(reduce(demo, { type: 'BACK' })).toMatchObject({
    flow: 'START',
    discovery: 'ble',
    found: [],
    backStack: [],
    query: '',
    selectedStoreId: undefined,
  });
});
test('09: store confirmation loads menu; history offers reorder only for that store', () => {
  let s = reduce(menu(), { type: 'CONFIRM_STORE' });
  expect(s.flow).toBe('V5-04');
  expect(reduce(s, { type: 'MENU_LOADED', products }).flow).toBe('V5-05');
  s = { ...s, history: { [stores[0].id]: order(cart()) } };
  expect(reduce(s, { type: 'MENU_LOADED', products }).flow).toBe('V5-R1');
  expect(
    reduce({ ...s, storeId: stores[1].id }, { type: 'MENU_LOADED', products })
      .flow,
  ).toBe('V5-05');
});
test('09: temperature must be selected, add returns menu with cart; edit saves directly to cart', () => {
  let s = reduce(menu(), { type: 'SELECT_PRODUCT', id: p.id });
  expect(s.flow).toBe('V5-06');
  s = reduce(s, { type: 'ADD', id: 'one' });
  expect(s.cart).toHaveLength(0);
  expect(s.missingGroup).toBe('temperature');
  s = reduce(s, { type: 'OPTION', id: 'temperature', value: 'ice' });
  s = reduce(s, { type: 'ADD', id: 'one' });
  expect(s.flow).toBe('V5-05c');
  expect(s.cart).toHaveLength(1);
  s = reduce(s, { type: 'SELECT_PRODUCT', id: p.id, lineId: 'one' });
  expect(s.flow).toBe('V5-08e');
  s = reduce(s, { type: 'QUANTITY', value: 2 });
  s = reduce(s, { type: 'ADD', id: 'unused' });
  expect(s.flow).toBe('V5-08');
  expect(s.cart[0].quantity).toBe(2);
  expect(s.cart[0].id).toBe('one');
});
test('09: back restores the exact menu and option screens without undoing a cart addition', () => {
  const reorder = { ...menu(), flow: 'V5-R1' as const };
  let s = reduce(reorder, { type: 'NAV', flow: 'V5-05' });
  expect(reduce(s, { type: 'BACK' }).flow).toBe('V5-R1');
  s = reduce(s, { type: 'SELECT_PRODUCT', id: p.id });
  s = reduce(s, { type: 'OPTION', id: 'temperature', value: 'ice' });
  s = reduce(s, { type: 'ADD', id: 'one' });
  const added = s;
  expect(reduce(added, { type: 'BACK' })).toMatchObject({
    flow: 'V5-06',
    productId: p.id,
    selected: { temperature: 'ice' },
    cart: added.cart,
  });
  s = reduce(added, { type: 'NAV', flow: 'V5-08' });
  s = reduce(s, { type: 'SELECT_PRODUCT', id: p.id, lineId: 'one' });
  s = reduce(s, { type: 'ADD', id: 'unused' });
  expect(reduce(s, { type: 'BACK' })).toMatchObject({
    flow: 'V5-05c',
    message: added.message,
  });
});
test('09: a recent item opens the normal option screen with its saved options', () => {
  const last = order(cart());
  const s = reduce(
    { ...menu(), history: { [stores[0].id]: last } },
    {
      type: 'SELECT_PRODUCT',
      id: p.id,
      recent: true,
    },
  );
  expect(s).toMatchObject({
    flow: 'V5-06',
    selected: last.snapshot.items[0].options,
    quantity: 1,
  });
});
test('pickup returns to discovery choices without losing order history', () => {
  const last = { ...order(cart()), status: 'ready' as const };
  const pickup: State = {
    ...menu(),
    flow: 'V5-12',
    discovery: 'demo',
    order: last,
    history: { [stores[0].id]: last },
  };
  const reset = reduce(pickup, { type: 'PICKUP_COMPLETE' });
  expect(reset).toMatchObject({
    flow: 'START',
    onboarded: true,
    history: pickup.history,
    backStack: [],
  });
  expect(reduce(reset, { type: 'DISCOVER', demo: true })).toMatchObject({
    flow: 'V5-01',
    discovery: 'demo',
  });
  expect(
    reduce({ ...pickup, discovery: 'ble' }, { type: 'PICKUP_COMPLETE' }).flow,
  ).toBe('START');
});
test('08: quick defaults is an opt-in path; many options use wizard and summary', () => {
  let s = reduce(
    { ...menu(), settings: { ...initial.settings, quickOptions: true } },
    { type: 'SELECT_PRODUCT', id: p.id },
  );
  expect(s.flow).toBe('V5-06s');
  expect(reduce(s, { type: 'ADD', id: 'one' }).flow).toBe('V5-05c');
  const many = {
    ...p,
    options: [...p.options, { ...p.options[0], id: 'fourth' }],
  };
  s = reduce(
    { ...menu(), products: [many] },
    { type: 'SELECT_PRODUCT', id: p.id },
  );
  expect(s.flow).toBe('V5-M3');
  expect(reduce(s, { type: 'STEP_REST_DEFAULT' }).flow).toBe('V5-M4');
});
test('08: reorder bypasses options/cart but still makes a canonical quote and durable request', () => {
  const last = order(cart());
  let s = reduce(
    { ...menu(), history: { [stores[0].id]: last } },
    { type: 'CHECKOUT', key: 'idempotent-key', reorder: true },
  );
  expect(s.flow).toBe('V5-09');
  expect(s.request?.expected.total).toBe(last.snapshot.total);
  const restored = reduce(initial, {
    type: 'HYDRATE',
    snapshot: snapshot(s),
    stores,
    products,
  });
  expect(restored.flow).toBe('P02-V');
  expect(restored.request?.key).toBe('idempotent-key');
});
test('payment success remains on explicit V5-10 until user opens order status', () => {
  const original = cart();
  const o = order(original);
  const payment: Payment = {
    id: 'payment',
    state: 'approved',
    provider: 'offline',
    snapshot: o.snapshot,
    orderId: o.id,
  };
  let s = reduce(original, { type: 'PAYMENT_RESULT', payment, order: o });
  expect(s.flow).toBe('V5-10');
  expect(s.cart).toHaveLength(0);
  s = reduce(s, { type: 'ORDER_UPDATED', order: { ...o, status: 'ready' } });
  expect(s.flow).toBe('V5-10');
  expect(reduce(s, { type: 'OPEN_ORDER' }).flow).toBe('V5-12');
});
test('price changes interrupt payment; cancellation retains cart and uncertain verification does not loop', () => {
  let s = reduce(cart(), { type: 'CHECKOUT', key: 'payment-key' });
  s = reduce(s, {
    type: 'PRICE_CHANGED',
    quote: { ...s.request!.expected, total: 4000 },
    products,
  });
  expect(s.flow).toBe('P01-E1');
  expect(s.request).toBeUndefined();
  expect(s.cart).toHaveLength(1);
  expect(reduce(s, { type: 'ACCEPT_CHANGED' }).flow).toBe('V5-08');
  const payment: Payment = {
    id: 'payment',
    state: 'ready',
    provider: 'offline',
    snapshot: quote(stores[0], products, s.cart),
  };
  s = { ...s, flow: 'P02-V' };
  const next = reduce(s, { type: 'PAYMENT_RESULT', payment });
  expect(next.revision).toBe(s.revision);
  expect(
    reduce(s, { type: 'FAIL', flow: 'P02-V', message: 'offline' }).revision,
  ).toBe(s.revision);
  expect(
    reduce(s, {
      type: 'PAYMENT_RESULT',
      payment: { ...payment, state: 'cancelled' },
    }).cart,
  ).toHaveLength(1);
});
test('connection switches cannot discard a pending payment', () => {
  let s = reduce(cart(), { type: 'CHECKOUT', key: 'payment-key' });
  s = reduce(s, { type: 'SETTINGS', value: { mode: 'server' } });
  expect(s.settings.mode).toBe('local');
  expect(s.request).toBeDefined();
});
test('quote equality ignores object key insertion order but detects unit price changes', () => {
  const q = quote(stores[0], products, cart().cart);
  const equivalent = {
    ...q,
    items: q.items.map(l => ({
      ...l,
      options: Object.fromEntries(Object.entries(l.options).reverse()),
    })),
  };
  expect(sameQuote(q, equivalent)).toBe(true);
  expect(sameQuote(q, { ...q, total: q.total + 100 })).toBe(false);
});
