import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaults, quote } from '../src/core/domain';
import { initial, reduce, settings, snapshot } from '../src/core/flow';
import type { Order, Payment, State } from '../src/core/types';
import { products, stores } from '../src/services/api';
import { advancePayment, paymentResult } from '../src/services/checkout';
import { persist, readSnapshot } from '../src/services/storage';

const store = stores[0];
const item = products[0];
const cart = [{ id: 'line', productId: item.id, quantity: 1, options: defaults(item) }];
const receipt = quote(store, products, cart);
const ready: Payment = {
  id: 'p1', state: 'ready', provider: 'kakao-test', snapshot: receipt, created: 1,
};
const order: Order = {
  id: 'o1', paymentId: ready.id, number: 'A-0001', created: 1,
  snapshot: receipt, status: 'preparing', demo: true,
};
const approved: Payment = { ...ready, state: 'approved', orderId: order.id };
const server = { ...settings, mode: 'server' as const, serverUrl: 'https://mvp.test' };
const cartState: State = { ...initial, flow: 'V5-08', settings: server, cart, stores, products, storeId: store.id };
const newCheckout = () => reduce(cartState, { type: 'CHECKOUT', key: 'checkout-key' });
const check = (state: State) => advancePayment(state, () => true);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fetchMock = vi.fn();

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test('a mock payment with a null redirect can be prepared and resumed after reload', async () => {
  const payment = { ...ready, provider: 'mock', redirect: null };
  fetchMock.mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json(payment, 201));
  const started = newCheckout();
  const prepared = reduce(started, (await check(started))!);
  expect(prepared).toMatchObject({ flow: 'PAYMENT_EXTERNAL', payment });

  await persist(snapshot(prepared));
  const restored = reduce(initial, { type: 'HYDRATE', snapshot: await readSnapshot(), stores, products });
  expect(restored).toMatchObject({ flow: 'P02-V', recoveryRequired: false, payment });
  fetchMock.mockClear().mockResolvedValueOnce(json(payment));
  const verified = reduce(restored, (await check(restored))!);
  expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
    ['GET', 'https://mvp.test/api/payments/p1'],
  ]);
  expect(reduce(verified, { type: 'NAV', flow: 'PAYMENT_EXTERNAL' })).toMatchObject({
    flow: 'PAYMENT_EXTERNAL', payment,
  });
});

test('lost preparation response only replays the original request after a deliberate retry', async () => {
  const started = newCheckout();
  const keys: string[] = [];
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/quote')) return json(receipt);
    if (url.endsWith('/payments')) {
      keys.push(JSON.parse(String(init.body)).key);
      if (keys.length === 1) throw new Error('response lost');
      return json(ready);
    }
    if (url.endsWith('/payments/p1')) return json(approved);
    if (url.endsWith('/orders/o1')) return json(order);
    throw new Error('unexpected request');
  });
  const failure = reduce(started, (await check(started))!);
  expect(failure.flow).toBe('P02-V');
  expect(failure.request?.key).toBe('checkout-key');
  const restored = reduce(initial, { type: 'HYDRATE', snapshot: snapshot(failure), stores, products });
  expect(await check(restored)).toBeUndefined();
  expect(keys).toEqual(['checkout-key']);
  const verifying = reduce(restored, { type: 'NAV', flow: 'P02-V' });
  const recovered = reduce(verifying, (await check(verifying))!);
  expect(keys).toEqual(['checkout-key', 'checkout-key']);
  expect(recovered).toMatchObject({ flow: 'V5-10', cart: [], order, request: undefined, payment: undefined });
});

test('known approval survives order-query failure and recovery fetches only the same order', async () => {
  const state = reduce(newCheckout(), { type: 'PAYMENT_READY', payment: ready });
  const verifying = reduce(state, { type: 'BACK' });
  fetchMock.mockResolvedValueOnce(json(approved)).mockRejectedValueOnce(new Error('order response lost'));
  const delayed = reduce(verifying, (await check(verifying))!);
  expect(delayed.flow).toBe('P02-V');
  expect(delayed.payment).toEqual(approved);
  expect(delayed.request).toBe(verifying.request);
  expect(reduce(delayed, { type: 'PAYMENT_RESULT', payment: ready })).toBe(delayed);
  expect(reduce(delayed, { type: 'NAV', flow: 'PAYMENT_EXTERNAL' })).toBe(delayed);

  fetchMock.mockClear().mockResolvedValueOnce(json(order));
  const restored = reduce(initial, { type: 'HYDRATE', snapshot: snapshot(delayed), stores, products });
  const finished = reduce(restored, (await check(restored))!);
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://mvp.test/api/orders/o1']);
  expect(finished.order?.snapshot.total).toBe(receipt.total);
  expect(finished.flow).toBe('V5-10');
});

test('if the order response does not match the approved receipt, approval remains pending order lookup', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...order, snapshot: { ...receipt, total: receipt.total + 1000 } }));
  const action = await paymentResult(server, approved);
  expect(action).toMatchObject({ type: 'PAYMENT_RESULT', payment: approved });
  expect(action).not.toHaveProperty('order');
});

test('a status request error preserves the payment ID and disables reopening until verified', async () => {
  const external = reduce(newCheckout(), { type: 'PAYMENT_READY', payment: ready });
  const verifying = reduce(external, { type: 'BACK' });
  fetchMock.mockRejectedValueOnce(new Error('response lost'));
  const failedLookup = reduce(verifying, (await check(verifying))!);
  expect(failedLookup).toMatchObject({ flow: 'P02-V', payment: ready });
  expect(failedLookup.error).toBeTruthy();
  expect(reduce(failedLookup, { type: 'NAV', flow: 'PAYMENT_EXTERNAL' })).toBe(failedLookup);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each([
  ['cancelled', 'P02-C'], ['failed', 'P02-F'], ['expired', 'P02-T'],
] as const)('confirmed %s returns through its terminal screen with the basket intact', async (state, flow) => {
  fetchMock.mockResolvedValueOnce(json({ ...ready, state }));
  const external = reduce(newCheckout(), { type: 'PAYMENT_READY', payment: ready });
  const verifying = reduce(external, { type: 'BACK' });
  const ended = reduce(verifying, (await check(verifying))!);
  expect(ended.flow).toBe(flow);
  expect(ended.cart).toEqual(cart);
  expect(reduce(ended, { type: 'RETRY_PAYMENT' })).toMatchObject({
    flow: 'V5-08', cart, payment: undefined, request: undefined,
  });
});

test('a late quote after the screen becomes inactive cannot initiate payment', async () => {
  const state = newCheckout();
  let current = true;
  fetchMock.mockImplementationOnce(async () => {
    current = false;
    return json(receipt);
  });
  expect(await advancePayment(state, () => current)).toBeUndefined();
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://mvp.test/api/quote']);
});

test('changed price refreshes the menu and the next checkout uses the updated price', async () => {
  const revised = [{ ...item, price: item.price + 500 }];
  fetchMock.mockResolvedValueOnce(json(quote(store, revised, cart))).mockResolvedValueOnce(json({ menu: revised }));
  const started = newCheckout();
  const changed = reduce(started, (await check(started))!);
  expect(changed).toMatchObject({ flow: 'P01-E1', request: undefined, cart });
  const back = reduce(changed, { type: 'ACCEPT_CHANGED' });
  expect(reduce(back, { type: 'CHECKOUT', key: 'retry-price' }).request?.expected.total).toBe(receipt.total + 500);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('a ready receipt whose price changed during preparation cannot open the old checkout', async () => {
  const adjusted = { ...ready, snapshot: { ...receipt, total: receipt.total + 1000 } };
  fetchMock.mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json(adjusted));
  const started = newCheckout();
  const uncertain = reduce(started, (await check(started))!);
  expect(uncertain).toMatchObject({ flow: 'P02-V', payment: adjusted, request: started.request, cart });
  expect(uncertain.error).toContain('결제 금액이 일치하지 않아요');
  expect(reduce(uncertain, { type: 'NAV', flow: 'PAYMENT_EXTERNAL' })).toBe(uncertain);
});

test('revalidation rejecting newly sold-out stock keeps the original basket and loads the latest menu', async () => {
  const products = [{ ...item, soldOut: true }];
  fetchMock.mockResolvedValueOnce(json({ error: '품절된 메뉴예요.' }, 409))
    .mockResolvedValueOnce(json({ menu: products }));
  const started = newCheckout();
  const rejected = reduce(started, (await check(started))!);
  expect(rejected).toMatchObject({ flow: 'P01-E2', cart, products, request: undefined });
  const returned = reduce(rejected, { type: 'RETRY_PAYMENT' });
  expect(reduce(returned, { type: 'CHECKOUT', key: 'another' }).request).toBeUndefined();
  expect(reduce(returned, { type: 'REMOVE', id: cart[0].id }).cart).toEqual([]);
});
