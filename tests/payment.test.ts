import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Request } from '../src/core/types';
import { settings } from '../src/core/flow';
import { defaults, quote } from '../src/core/domain';
import catalog from '../src/data/catalog.json';
import type { Product } from '../src/core/types';
import { prepare, complete, getPayment, getOrder } from '../src/services/api';
const products = catalog.menu as Product[];
const items = [
  {
    id: 'line',
    productId: products[0].id,
    quantity: 1,
    options: defaults(products[0]),
  },
];
const request: Request = {
  key: 'one-durable-request',
  storeId: 'kaist',
  items,
  expected: quote(catalog.stores[0], products, items),
};
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
test('concurrent preparation and approval commit one payment and one order', async () => {
  const [a, b] = await Promise.all([
    prepare(settings, request),
    prepare(settings, request),
  ]);
  expect(a.id).toBe(b.id);
  const [x, y] = await Promise.all([
    complete(settings, a.id, 'success'),
    complete(settings, a.id, 'success'),
  ]);
  expect(x.orderId).toBe(y.orderId);
  expect(x.orderId).toBeTruthy();
  const order = await getOrder(settings, x.orderId!);
  expect(order.snapshot.total).toBe(request.expected.total);
  expect((await getPayment(settings, a.id)).state).toBe('approved');
});
test.each(['cancel', 'fail', 'timeout'] as const)(
  '%s preserves terminal state without creating an order',
  async result => {
    const p = await prepare(settings, request);
    const done = await complete(settings, p.id, result);
    expect(done.orderId).toBeUndefined();
    expect(done.state).toBe(
      result === 'cancel'
        ? 'cancelled'
        : result === 'fail'
        ? 'failed'
        : 'expired',
    );
    await expect(complete(settings, p.id, 'success')).rejects.toThrow();
  },
);
test('an idempotency key cannot change an existing basket', async () => {
  await prepare(settings, request);
  await expect(
    prepare(settings, { ...request, items: [{ ...items[0], quantity: 2 }] }),
  ).rejects.toThrow();
});

test.each(['{', '{"sequence":0,"keys":{},"payments":null,"orders":{}}'])(
  'a damaged local ledger refuses all payment writes and preserves the original bytes',
  async corrupted => {
    const name = 'link-web.ledger.v1';
    localStorage.setItem(name, corrupted);
    await expect(prepare(settings, request)).rejects.toThrow('테스트 결제 기록');
    await expect(complete(settings, 'p1', 'success')).rejects.toThrow('테스트 결제 기록');
    await expect(getOrder(settings, 'o1')).rejects.toThrow('테스트 결제 기록');
    expect(localStorage.getItem(name)).toBe(corrupted);
  },
);

test('an expired local payment stays terminal when a late completion arrives', async () => {
  const p = await prepare(settings, request);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(p.created! + 900_001);
  try {
    expect((await getPayment(settings, p.id)).state).toBe('expired');
    await expect(complete(settings, p.id, 'success')).rejects.toThrow();
    expect((await prepare(settings, request)).id).toBe(p.id);
  } finally {
    clock.mockRestore();
  }
});
