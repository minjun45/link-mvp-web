import { expect, test } from 'vitest';
import catalog from '../src/data/catalog.json';
import { quote } from '../src/core/domain';
import { initial, reduce } from '../src/core/flow';
import { staffHelpText } from '../src/ui/staffHelp';

const store = catalog.stores[0];
const cart = [{
  id: 'one', productId: 'americano', quantity: 2,
  options: { temperature: 'ice', size: 'large', shot: 'none' },
}];
const priced = quote(store, catalog.menu, cart);
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
  expect(staffHelpText(restored)).not.toContain(order.number);
  expect(staffHelpText({ ...restored, flow: 'P02-V' })).not.toContain(order.number);
});

test('cart help repeats current choices, quantity and quoted amount, even after an earlier order', () => {
  const state = { ...initial, flow: 'V5-08' as const, order, cart };
  const text = staffHelpText(state, priced);
  for (const value of ['아메리카노', '아이스', '라지', '2개', '6,000원']) expect(text).toContain(value);
  expect(text).not.toContain(order.number);
  expect(staffHelpText(state)).not.toContain('6,000원');
  expect(staffHelpText({ ...state, cart: [] })).toContain('비어');
});
