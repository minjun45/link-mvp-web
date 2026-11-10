import { expect, test } from 'vitest';
import { initial, reduce } from '../src/core/flow';
import { defaults } from '../src/core/domain';
import type { Product, State } from '../src/core/types';
import catalog from '../src/data/catalog.json';

const products = catalog.menu as Product[];
const stores = catalog.stores;
const start = () => reduce(
  reduce(initial, { type: 'HYDRATE', stores, products }),
  { type: 'DISCOVER' },
);

test('1103: missing-store guidance leads to name search and back restores the filtered discovery list', () => {
  let s = reduce(start(), { type: 'FOUND', stores });
  s = reduce(s, { type: 'QUERY', value: '링크' });
  s = reduce(s, { type: 'NAV', flow: 'V5-02e' });
  expect(s.query).toBe('');
  s = reduce(s, { type: 'NAV', flow: 'V5-02s' });
  s = reduce(s, { type: 'QUERY', value: '이음' });
  s = reduce(s, { type: 'BACK' });
  expect(s.flow).toBe('V5-02e');
  s = reduce(s, { type: 'BACK' });
  expect(s.flow).toBe('V5-02');
  expect(s.query).toBe('링크');
});

test('entry choices select real or demo discovery; demo always uses local test data', () => {
  const saved = { ...start(), settings: { ...initial.settings, mode: 'server' as const, serverUrl: 'https://example.test' } };
  expect(reduce(saved, { type: 'DISCOVER' })).toMatchObject({ flow: 'V5-01', discovery: 'ble', settings: { mode: 'server' } });
  expect(reduce(saved, { type: 'DISCOVER', demo: true })).toMatchObject({ flow: 'V5-01', discovery: 'demo', settings: { mode: 'local' } });
});

test('back from a Bluetooth-selected store returns to entry choices without inventing a store list', () => {
  const cart = [{ id: 'saved', productId: products[0].id, quantity: 2, options: defaults(products[0]) }];
  const confirmed = reduce({ ...start(), storeId: stores[0].id, cart }, {
    type: 'FOUND', stores: [stores[0]],
  });
  expect(confirmed.flow).toBe('V5-03');
  const home = reduce(confirmed, { type: 'BACK' });
  expect(home).toMatchObject({
    flow: 'START', found: [], selectedStoreId: undefined,
    backStack: [], query: '', cart, storeId: stores[0].id,
  });
  expect(reduce(home, { type: 'FOUND', stores: [stores[0]], revision: confirmed.revision })).toBe(home);
});

test('back from a demo store restores the visited list, search, and expanded page', () => {
  let s = reduce(start(), { type: 'DISCOVER', demo: true });
  s = reduce(s, { type: 'FOUND', stores });
  s = reduce(s, { type: 'QUERY', value: '링크' });
  s = reduce(s, { type: 'MORE_STORES' });
  s = reduce(s, { type: 'SELECT_STORE', id: stores[0].id });
  expect(s.flow).toBe('V5-03');
  expect(reduce(s, { type: 'BACK' })).toMatchObject({
    flow: 'V5-02', discovery: 'demo', found: stores,
    query: '링크', storeLimit: 6,
  });
});

test('name search remains the back destination even after a Bluetooth selection', () => {
  let s = reduce(start(), { type: 'FOUND', stores: [stores[0]] });
  s = reduce(s, { type: 'NAV', flow: 'V5-02s' });
  s = reduce(s, { type: 'QUERY', value: '이음' });
  s = reduce(s, { type: 'SELECT_STORE', id: stores[1].id });
  expect(reduce(s, { type: 'BACK' })).toMatchObject({
    flow: 'V5-02s', query: '이음', found: [stores[0]],
  });
});

test('late results cannot replace the entry screen after stopping discovery', () => {
  const scanning = start();
  const home = reduce(scanning, { type: 'BACK' });
  expect(home.flow).toBe('START');
  expect(reduce(home, { type: 'FOUND', stores, revision: scanning.revision })).toBe(home);
  expect(reduce(home, { type: 'FAIL', flow: 'V5-01e', message: 'late', revision: scanning.revision })).toBe(home);
});

test('going back through guidance or settings never restores a scanner without a user gesture', () => {
  const scanning = start();
  const help = reduce(scanning, { type: 'NAV', flow: 'V5-02e' });
  expect(reduce(help, { type: 'BACK' }).flow).toBe('START');
  const settings = reduce(scanning, { type: 'NAV', flow: 'SETTINGS' });
  expect(reduce(settings, { type: 'BACK' }).flow).toBe('START');
});

test('pending payment recovery takes priority over starting either discovery mode', () => {
  const pending = reduce({
    ...start(),
    storeId: stores[0].id,
    settings: { ...initial.settings, mode: 'server' },
    cart: [{ id: 'one', productId: products[0].id, quantity: 1, options: defaults(products[0]) }],
  }, { type: 'CHECKOUT', key: 'pending' });
  expect(pending.request).toBeDefined();
  const attempted = reduce(pending, { type: 'DISCOVER', demo: true });
  expect(attempted).toMatchObject({ flow: 'P02-V', settings: { mode: 'server' }, request: pending.request });
  expect(reduce(pending, { type: 'NAV', flow: 'START' }).flow).toBe('P02-V');
});

test('1103: no match leads to 01e; name search confirms a store and can return to its query', () => {
  let s = reduce(start(), { type: 'FOUND', stores: [] });
  expect(s.flow).toBe('V5-01e');
  s = reduce(s, { type: 'NAV', flow: 'V5-02s' });
  s = reduce(s, { type: 'QUERY', value: '이음' });
  s = reduce(s, { type: 'SELECT_STORE', id: stores[1].id });
  expect(s.flow).toBe('V5-03');
  s = reduce(s, { type: 'BACK' });
  expect(s.flow).toBe('V5-02s');
  expect(s.query).toBe('이음');
});

test('1103: retry clears discovery drafts without losing the existing basket', () => {
  const cart = [{ id: 'saved', productId: products[0].id, quantity: 2, options: defaults(products[0]) }];
  let s: State = { ...start(), storeId: stores[0].id, cart };
  s = reduce(s, { type: 'FOUND', stores });
  s = reduce(s, { type: 'QUERY', value: '링크' });
  s = reduce(s, { type: 'MORE_STORES' });
  s = reduce(s, { type: 'DISCOVER' });
  expect(s).toMatchObject({
    flow: 'V5-01', query: '', found: [], storeLimit: 3,
    backStack: [], discoveryReady: false, cart,
  });
});

test('1103: confirming a different store requires explicit basket clearing', () => {
  const cart = [{ id: 'saved', productId: products[0].id, quantity: 2, options: defaults(products[0]) }];
  let s: State = { ...start(), storeId: stores[0].id, cart };
  s = reduce(s, { type: 'NAV', flow: 'V5-02s' });
  s = reduce(s, { type: 'SELECT_STORE', id: stores[1].id });
  s = reduce(s, { type: 'CONFIRM_STORE' });
  expect(s).toMatchObject({ flow: 'V5-03', error: 'CHANGE_STORE', cart });
  s = reduce(s, { type: 'CONFIRM_STORE', clear: true });
  expect(s).toMatchObject({ flow: 'V5-04', storeId: stores[1].id, cart: [] });
  expect(reduce(s, { type: 'MENU_LOADED', products }).flow).toBe('V5-05');
});

test('1103: returning from loading skips the loader and restores the store search', () => {
  let s = reduce(start(), { type: 'NAV', flow: 'V5-02s' });
  s = reduce(s, { type: 'QUERY', value: '링크' });
  s = reduce(s, { type: 'SELECT_STORE', id: stores[0].id });
  s = reduce(s, { type: 'CONFIRM_STORE' });
  s = reduce(s, { type: 'NAV', flow: 'V5-02s' });
  expect(s.flow).toBe('V5-02s');
  expect(s.query).toBe('');
  expect(reduce(s, { type: 'BACK' }).flow).toBe('V5-03');
});
