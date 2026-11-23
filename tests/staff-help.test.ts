import { expect, test } from 'vitest';
import catalog from '../src/data/catalog.json';
import { quote } from '../src/core/domain';
import { initial, reduce } from '../src/core/flow';
import type { State } from '../src/core/types';
import { staffHelpText } from '../src/ui/staffHelp';

const store = catalog.stores[0];
const cart = [{
  id: 'one', productId: 'americano', quantity: 2,
  options: { temperature: 'ice', size: 'large', shot: 'none' },
}];
const priced = quote(store, catalog.menu, cart);
const dessert = { id: 'two', productId: 'cookie', quantity: 3, options: {} };
const order = {
  id: 'previous', number: 'A-0042', demo: true, paymentId: 'p', created: 1,
  snapshot: priced, status: 'ready' as const,
};

test('a saved order number is still available at pickup but is never shown on a new visit', () => {
  const restored = reduce(initial, {
    type: 'HYDRATE', stores: catalog.stores, products: catalog.menu,
    snapshot: { ...initial, order, history: { [store.id]: order } },
  });
  expect(staffHelpText({ ...restored, flow: 'V5-12' })).toContain(order.number);
  expect(staffHelpText(restored)).toContain(order.number);
  expect(staffHelpText(restored)).toContain('준비 상태를 확인해 주세요.');
  const ready = reduce(restored, { type: 'ORDER_UPDATED', order });
  expect(staffHelpText(ready)).toContain('받는 위치로 안내해 주세요.');
  const finished = reduce(ready, { type: 'PICKUP_COMPLETE' });
  expect(staffHelpText(finished)).not.toContain(order.number);
  expect(staffHelpText({ ...restored, flow: 'P02-V' })).not.toContain(order.number);
});

test('cart help repeats current choices, quantity and quoted amount, even after an earlier order', () => {
  const state: State = { ...initial, flow: 'V5-08', order, cart, products: catalog.menu };
  const text = staffHelpText(state, priced);
  for (const value of ['아메리카노', '아이스', '라지', '2잔', '6,000원']) expect(text).toContain(value);
  expect(text).not.toContain(order.number);
  expect(staffHelpText(state)).not.toContain('6,000원');
  expect(staffHelpText({ ...state, cart: [] })).toContain('비어');
});

const drinkLine = '아메리카노 · 아이스 · 라지 · 추가 안 함 · 2잔';
const dessertLine = '초콜릿 쿠키 · 3개';

test.each([
  ['drinks', cart, [drinkLine]],
  ['desserts', [dessert], [dessertLine]],
  ['mixed orders', [...cart, dessert], [drinkLine, dessertLine]],
] as const)('cart help uses the unit of each item for %s', (_, lines, expected) => {
  const state: State = { ...initial, flow: 'V5-08', cart: [...lines], products: catalog.menu };
  const text = staffHelpText(state, quote(store, catalog.menu, state.cart));
  expect(text.split('\n').slice(1, -1)).toEqual(expected);
});
