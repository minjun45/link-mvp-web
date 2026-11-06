import type { Store, Product, Line, Quote, Order } from './types';
export const key = () =>
  `link_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}_${Math.random().toString(36).slice(2)}`;
export const money = (n: number) =>
  `${Math.round(n).toLocaleString('ko-KR')}원`;
export function quote(
  store: Store | undefined,
  products: Product[],
  cart: Line[],
): Quote {
  if (!store?.open) throw new Error('지금은 이 매장에서 주문할 수 없어요.');
  if (!cart.length || cart.length > 30)
    throw new Error('메뉴를 1개 이상, 30종류 이하로 담아 주세요.');
  const items = cart.map(l => {
    const p = products.find(x => x.id === l.productId);
    if (!p || p.soldOut)
      throw new Error('품절되었거나 주문할 수 없는 메뉴가 있어요.');
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 20)
      throw new Error('수량은 1개부터 20개까지 선택해 주세요.');
    if (Object.keys(l.options).some(id => !p.options.some(g => g.id === id)))
      throw new Error('옵션을 다시 확인해 주세요.');
    const choices = p.options.map(g => {
      const c = g.choices.find(x => x.id === l.options[g.id]);
      if (!c) throw new Error(`${g.name} 옵션을 선택해 주세요.`);
      return c;
    });
    const unitPrice = p.price + choices.reduce((a, c) => a + c.price, 0);
    return {
      productId: p.id,
      name: p.name,
      quantity: l.quantity,
      options: l.options,
      labels: choices.map(c => c.name),
      unitPrice,
      total: unitPrice * l.quantity,
    };
  });
  return {
    storeId: store.id,
    storeName: store.name,
    items,
    total: items.reduce((a, l) => a + l.total, 0),
    quantity: items.reduce((a, l) => a + l.quantity, 0),
  };
}
export const sameQuote = (a: Quote, b: Quote) =>
  a.storeId === b.storeId &&
  a.total === b.total &&
  a.quantity === b.quantity &&
  a.items.length === b.items.length &&
  a.items.every((x, i) => {
    const y = b.items[i];
    return (
      x.productId === y.productId &&
      x.quantity === y.quantity &&
      x.unitPrice === y.unitPrice &&
      x.total === y.total &&
      Object.keys(x.options).length === Object.keys(y.options).length &&
      Object.entries(x.options).every(([k, v]) => y.options[k] === v)
    );
  });
export const status = (created: number, now = Date.now()): Order['status'] =>
  now - created < 8000
    ? 'received'
    : now - created < 25000
    ? 'preparing'
    : 'ready';
export const defaults = (p: Product) =>
  Object.fromEntries(p.options.map(g => [g.id, g.choices[0].id]));
export const initialOptions = (p: Product) =>
  Object.fromEntries(
    p.options
      .filter(g => !(g.required && g.id === 'temperature'))
      .map(g => [g.id, g.choices[0].id]),
  );
export const fromOrder = (o: Order): Line[] =>
  o.snapshot.items.map((i, n) => ({
    id: `${o.id}-${n}`,
    productId: i.productId,
    quantity: i.quantity,
    options: { ...i.options },
  }));
export function frequent(history: Order | undefined, products: Product[]) {
  return [...new Set(history?.snapshot.items.map(l => l.productId) || [])]
    .map(id => products.find(p => p.id === id))
    .filter((p): p is Product => !!p && !p.soldOut)
    .slice(0, 2);
}
