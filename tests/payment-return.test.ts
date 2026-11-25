import { afterEach, expect, test, vi } from 'vitest';
import { defaults, quote } from '../src/core/domain';
import { initial, reduce, snapshot } from '../src/core/flow';
import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER, type Payment, type State } from '../src/core/types';
import * as Device from '../src/native/browserDevice';
import { paymentChannel } from '../src/native/paymentChannel';
import { getPayment, products, stores } from '../src/services/api';
import { advancePayment, openKakaoCheckout } from '../src/services/checkout';
import { watchPaymentReturn } from '../src/services/paymentReturn';
import { persist, readSnapshot, serial } from '../src/services/storage';

const connection = { mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN } as const;
const product = products[0];
const cart = [{ id: 'line', productId: product.id, options: defaults(product), quantity: 1 }];
const receipt = quote(stores[0], products, cart);
const payment: Payment = {
  id: 'mock-payment', provider: KAKAO_TEST_PROVIDER, state: 'ready', connection, snapshot: receipt,
  redirect: KAKAO_TEST_ORIGIN + '/checkout/mock-payment', checkoutAvailable: { pc: true, mobile: true },
};
const state: State = {
  ...initial, kakaoTest: true, flow: 'PAYMENT_EXTERNAL', payment, cart,
  request: { key: 'mock-request', storeId: stores[0].id, items: cart, expected: receipt, connection },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([
  [{ userAgent: 'Windows desktop', platform: 'Win32', maxTouchPoints: 10 }, 'pc'],
  [{ userAgent: 'Mozilla Android tablet' }, 'mobile'],
  [{ userAgent: 'Mozilla iPhone Safari' }, 'mobile'],
  [{ userAgent: 'Mozilla Macintosh Safari', platform: 'MacIntel', maxTouchPoints: 5 }, 'mobile'],
  [{ userAgent: 'Mozilla Macintosh Safari', platform: 'MacIntel', maxTouchPoints: 0 }, 'pc'],
  [{ userAgent: 'Reduced UA', userAgentData: { mobile: true } }, 'mobile'],
] as const)('identifies the actual browser channel for %j', (profile, result) => {
  expect(paymentChannel(profile)).toBe(result);
});

test('awaits the storage lock before navigating the same tab and ignores a double click', async () => {
  const assign = vi.fn();
  const open = vi.fn();
  const setItem = vi.fn();
  vi.stubGlobal('window', { open, location: { origin: KAKAO_TEST_ORIGIN, assign } });
  vi.stubGlobal('navigator', { userAgent: 'iPhone' });
  vi.stubGlobal('localStorage', { setItem });
  const pending = deferred<void>();
  const active = serial(() => pending.promise);
  const opening = { current: false };
  const report = vi.fn();
  const leaving = openKakaoCheckout(state, opening, () => true, report);
  await openKakaoCheckout(state, opening, () => true, report);
  expect(assign).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();

  pending.resolve();
  await Promise.all([active, leaving]);
  expect(setItem).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(setItem.mock.calls[0][1]);
  expect(saved).toMatchObject({ request: state.request, payment: { id: payment.id, connection, snapshot: receipt } });
  expect(assign).toHaveBeenCalledExactlyOnceWith(payment.redirect + '?channel=mobile');
  expect(setItem.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
  expect(open).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test('blocks a missing mobile channel, a storage failure and a forged checkout address', async () => {
  const assign = vi.fn();
  const open = vi.fn();
  const setItem = vi.fn().mockImplementationOnce(() => { throw new Error('storage full'); });
  vi.stubGlobal('window', { open, location: { origin: KAKAO_TEST_ORIGIN, assign } });
  vi.stubGlobal('navigator', { userAgent: 'Android' });
  vi.stubGlobal('localStorage', { setItem });
  const report = vi.fn();
  const opening = { current: false };

  await openKakaoCheckout({ ...state, payment: { ...payment, checkoutAvailable: { pc: true, mobile: false } } },
    opening, () => true, report);
  expect(setItem).not.toHaveBeenCalled();
  await openKakaoCheckout(state, opening, () => true, report);
  expect(report).toHaveBeenLastCalledWith('결제 복구 정보를 저장하지 못했어요. 다시 시도해 주세요.');
  expect(opening.current).toBe(false);
  await openKakaoCheckout({ ...state, payment: { ...payment, redirect: 'https://other.test' } },
    opening, () => true, report);
  expect(report).toHaveBeenLastCalledWith('카카오페이 결제창 주소를 확인할 수 없어요.');
  expect(assign).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();

  Device.openPayment('https://legacy.example.test/checkout', 'https://legacy.example.test');
  expect(open).toHaveBeenCalledExactlyOnceWith('https://legacy.example.test/checkout', '_blank', 'noopener,noreferrer');
});

function lifecycle() {
  const browser = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const pageShow = (persisted: boolean) => browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
  return { browser: browser as unknown as Window & typeof browser, page: page as unknown as Document & typeof page, pageShow };
}

test('coalesces page show, focus, visibility and manual reads into a bounded foreground round', async () => {
  vi.useFakeTimers();
  const { browser, page, pageShow } = lifecycle();
  const waiting = deferred<boolean>();
  const check = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(waiting.promise).mockResolvedValue(false);
  const watcher = watchPaymentReturn(check, true, browser, page);
  pageShow(false);
  browser.dispatchEvent(new Event('focus'));
  page.dispatchEvent(new Event('visibilitychange'));
  watcher.checkNow();
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(1);
  for (let count = 0; count < 10; count++) browser.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(2500);
  expect(check).toHaveBeenCalledTimes(1);
  waiting.resolve(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(check).toHaveBeenCalledTimes(3);
  watcher.close();
});

test('waits for resumed hydration, skips background reads and wakes after the network reconnects', async () => {
  vi.useFakeTimers();
  const { browser, page, pageShow } = lifecycle();
  const check = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const watcher = watchPaymentReturn(check, false, browser, page);
  pageShow(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(check).not.toHaveBeenCalled();

  Object.assign(page, { visibilityState: 'hidden' });
  browser.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(check).not.toHaveBeenCalled();

  Object.assign(page, { visibilityState: 'visible' });
  Object.assign(browser.navigator, { onLine: false });
  page.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(check).not.toHaveBeenCalled();

  Object.assign(browser.navigator, { onLine: true });
  browser.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(1);
  browser.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(6000);
  expect(check).toHaveBeenCalledTimes(1);
  watcher.close();
});

test('uses one payment GET even if two rehydration contexts share the in-flight read', async () => {
  const waiting = deferred<Response>();
  const fetcher = vi.fn(() => waiting.promise);
  vi.stubGlobal('location', { origin: KAKAO_TEST_ORIGIN });
  vi.stubGlobal('fetch', fetcher);
  const first = getPayment(connection, payment.id);
  const second = getPayment(connection, payment.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  waiting.resolve(Response.json(payment));
  expect(await Promise.all([first, second])).toEqual([payment, payment]);
});

test('retains the stored order amount when lookup returns an inconsistent approval', async () => {
  vi.stubGlobal('location', { origin: KAKAO_TEST_ORIGIN });
  const fetcher = vi.fn(async () => Response.json({
    ...payment, state: 'approved', orderId: 'wrong-order', snapshot: { ...receipt, total: 1 },
  }));
  vi.stubGlobal('fetch', fetcher);
  const action = await advancePayment(state, () => true);
  expect(action).toMatchObject({ type: 'PAYMENT_RESULT', payment, error: expect.any(String) });
  expect(action).not.toHaveProperty('order');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('rejects a queued write from a frozen page and restores the latest completed snapshot', async () => {
  const newest = JSON.stringify({ ...snapshot(state), request: undefined, payment: undefined, cart: [] });
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => newest, setItem });
  const waiting = deferred<void>();
  const running = serial(() => waiting.promise);
  let allowed = true;
  const staleWrite = persist(snapshot(state), () => allowed);
  const rejected = expect(staleWrite).rejects.toMatchObject({ name: 'AbortError' });
  allowed = false;
  waiting.resolve();
  await running;
  await rejected;
  const restored = reduce(state, { type: 'HYDRATE', snapshot: await readSnapshot(), stores, products, resumed: true, kakaoTest: true });
  expect(setItem).not.toHaveBeenCalled();
  expect(restored).toMatchObject({ payment: undefined, request: undefined, flow: 'START', revision: state.revision + 1 });
});

test('retains the current focus revision for identical reads and moves only on a confirmed terminal result', () => {
  expect(reduce(state, { type: 'PAYMENT_RESULT', payment: { ...payment } })).toBe(state);
  const uncertain = reduce(state, { type: 'PAYMENT_RESULT', payment: { ...payment, state: 'review' } });
  expect(uncertain).toMatchObject({ flow: state.flow, revision: state.revision, payment: { state: 'review' } });
  expect(reduce(uncertain, { type: 'PAYMENT_RESULT', payment: { ...payment, state: 'review' } })).toBe(uncertain);
  expect(reduce(state, { type: 'PAYMENT_RESULT', payment: { ...payment, state: 'cancelled' } }).flow).toBe('P02-C');
  expect(reduce(state, { type: 'PAYMENT_RESULT', payment: { ...payment, state: 'failed' } }).flow).toBe('P02-F');
});
