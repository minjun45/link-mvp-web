import { expect, test } from 'vitest';
import { initial, reduce } from '../src/core/flow';
import { defaults, quote } from '../src/core/domain';
import type { State, Product, Order, Payment } from '../src/core/types';
import catalog from '../src/data/catalog.json';
const products = catalog.menu as Product[];
const p = products[0];
const cart = [
  { id: 'line', productId: p.id, quantity: 1, options: defaults(p) },
];
const original = quote(catalog.stores[0], products, cart);
const order: Order = {
  id: 'paid',
  paymentId: 'payment',
  created: Date.now(),
  number: 'A-0001',
  snapshot: original,
  status: 'received',
  demo: true,
};
const payment: Payment = {
  id: 'payment',
  provider: 'offline',
  snapshot: original,
  state: 'approved',
  orderId: order.id,
};
const state: State = {
  ...initial,
  stores: catalog.stores,
  storeId: 'kaist',
  products,
  cart,
  flow: 'P02-V',
};
test('approval clears the paid basket even if catalog prices have since changed', () => {
  const next = reduce(
    {
      ...state,
      products: products.map(x => ({ ...x, price: x.price + 1000 })),
    },
    { type: 'PAYMENT_RESULT', payment, order },
  );
  expect(next.cart).toHaveLength(0);
  expect(next.order?.snapshot.total).toBe(original.total);
});
test('approval preserves a basket the user changed while payment was open', () => {
  const changed = { ...state, cart: [{ ...cart[0], quantity: 2 }] };
  const next = reduce(changed, { type: 'PAYMENT_RESULT', payment, order });
  expect(next.cart[0].quantity).toBe(2);
  expect(next.flow).toBe('V5-10');
});
