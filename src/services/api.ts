import type {
  Settings,
  Store,
  Product,
  Quote,
  Request,
  Payment,
  Order,
} from '../core/types';
import { quote, key, sameQuote, status } from '../core/domain';
import { isOrder, isPayment, isRecord, matchesQuoteItems } from '../core/savedData';
import { serial } from './storage';
import catalog from '../data/catalog.json';
export const stores = catalog.stores as Store[];
export const products = catalog.menu as Product[];
type Ledger = {
  sequence: number;
  keys: Record<string, string>;
  payments: Record<string, Payment>;
  orders: Record<string, Order>;
};
const ledgerKey = 'link-web.ledger.v1';
function getLedger(): Ledger {
  const text = localStorage.getItem(ledgerKey);
  if (text === null) return { sequence: 0, keys: {}, payments: {}, orders: {} };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Keep the original storage entry for recovery.
  }
  if (isLedger(value)) return value;
  throw new Error('저장된 테스트 결제 기록을 읽을 수 없어요. 새 결제 전에 기존 주문을 확인해 주세요.');
}

function isLedger(value: unknown): value is Ledger {
  if (!isRecord(value) || typeof value.sequence !== 'number' ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !isRecord(value.keys) || !isRecord(value.payments) || !isRecord(value.orders))
    return false;

  const { keys, payments, orders, sequence } = value;
  const paymentIds = Object.values(keys);
  if (paymentIds.length !== Object.keys(payments).length ||
      new Set(paymentIds).size !== paymentIds.length ||
      !paymentIds.every(id => typeof id === 'string' && Object.hasOwn(payments, id)))
    return false;

  const numbers = new Set<string>();
  return Object.entries(payments).every(([id, payment]) => isPayment(payment) && payment.id === id &&
      (payment.state !== 'approved' || (!!payment.orderId && Object.hasOwn(orders, payment.orderId)))) &&
    Object.entries(orders).every(([id, order]) => {
      if (!isOrder(order) || order.id !== id || numbers.has(order.number)) return false;
      const number = /^A-(\d+)$/.exec(order.number);
      if (!number || Number(number[1]) > sequence) return false;
      numbers.add(order.number);
      const payment = payments[order.paymentId];
      return isPayment(payment) && payment.state === 'approved' &&
        payment.orderId === id && sameQuote(payment.snapshot, order.snapshot);
    });
}

const isExpired = (payment: Payment) =>
  payment.created !== undefined && Date.now() - payment.created > 900_000;
export class ApiError extends Error {
  constructor(public code: number, message: string, public reason?: string) {
    super(message);
  }
}
export function validateServer(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error('서버 주소를 확인해 주세요.');
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !['', '/'].includes(u.pathname)
  )
    throw new Error('서버의 기본 주소만 입력해 주세요.');
  if (
    u.protocol !== 'https:' &&
    !(
      import.meta.env.DEV &&
      u.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(u.hostname)
    )
  )
    throw new Error(
      'HTTPS 주소를 입력해 주세요. 개발용 앱은 로컬 HTTP도 지원해요.',
    );
  return value.trim().replace(/\/$/, '');
}
async function http<T>(s: Settings, path: string, data?: unknown): Promise<T> {
  const base = validateServer(s.serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(base + '/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await r.json();
    if (!r.ok)
      throw new ApiError(
        r.status,
        body.error || '요청을 완료하지 못했어요.',
        body.code,
      );
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new Error(
      '서버 연결을 확인하고 다시 시도해 주세요. 담아 둔 메뉴는 그대로 있어요.',
    );
  } finally {
    clearTimeout(timer);
  }
}
export async function getStores(s: Settings) {
  if (s.mode === 'local') return stores;
  await http(s, '/config');
  return (await http<{ stores: Store[] }>(s, '/stores')).stores;
}
export async function getMenu(s: Settings, id: string) {
  if (s.mode === 'local') {
    if (!stores.find(x => x.id === id)?.open)
      throw new ApiError(409, '지금은 주문할 수 없어요.');
    return products;
  }
  return (
    await http<{ menu: Product[] }>(s, `/stores/${encodeURIComponent(id)}/menu`)
  ).menu;
}
export async function revalidate(s: Settings, r: Request): Promise<Quote> {
  if (s.mode === 'local')
    return quote(
      stores.find(x => x.id === r.storeId),
      products,
      r.items,
    );
  return http(s, '/quote', { storeId: r.storeId, items: r.items });
}
export async function prepare(s: Settings, r: Request): Promise<Payment> {
  if (s.mode === 'server')
    return http(s, '/payments', {
      key: r.key,
      storeId: r.storeId,
      items: r.items,
      expected: r.expected,
    });
  return serial(async () => {
    const l = getLedger();
    if (Object.hasOwn(l.keys, r.key)) {
      const p = l.payments[l.keys[r.key]];
      if (p.snapshot.storeId !== r.storeId || !sameQuote(p.snapshot, r.expected) ||
          !matchesQuoteItems(r.items, p.snapshot))
        throw new Error('이전 결제 내용을 먼저 확인해 주세요.');
      return p;
    }
    const expected = await revalidate(s, r);
    if (!sameQuote(r.expected, expected))
      throw new ApiError(409, '주문 내용이 바뀌었어요.', 'PRICE_CHANGED');
    const p: Payment = {
      id: key(),
      state: 'ready',
      provider: 'offline',
      snapshot: expected,
      created: Date.now(),
    };
    l.keys = { ...l.keys, [r.key]: p.id };
    l.payments[p.id] = p;
    localStorage.setItem(ledgerKey, JSON.stringify(l));
    return p;
  });
}
export async function getPayment(s: Settings, id: string): Promise<Payment> {
  if (s.mode === 'server') return http(s, `/payments/${id}`);
  return serial(async () => {
    const l = getLedger();
    const p = Object.hasOwn(l.payments, id) ? l.payments[id] : undefined;
    if (!p) throw new Error('이 기기의 결제 정보를 찾을 수 없어요.');
    if (p.state === 'ready' && isExpired(p)) {
      p.state = 'expired';
      localStorage.setItem(ledgerKey, JSON.stringify(l));
    }
    return p;
  });
}
export async function complete(
  s: Settings,
  id: string,
  result: 'success' | 'cancel' | 'fail' | 'timeout',
): Promise<Payment> {
  if (s.mode === 'server')
    return http(s, `/payments/${id}/complete`, { result });
  return serial(async () => {
    const l = getLedger();
    const p = Object.hasOwn(l.payments, id) ? l.payments[id] : undefined;
    if (!p) throw new Error('결제 정보를 찾지 못했어요.');
    if (p.state === 'approved') return p;
    if (p.state !== 'ready')
      throw new Error('이미 종료된 결제예요. 상태를 다시 확인해 주세요.');
    if (isExpired(p)) {
      p.state = 'expired';
    } else if (result === 'success') {
      l.sequence++;
      const order: Order = {
        id: key(),
        paymentId: p.id,
        number: `A-${String(l.sequence).padStart(4, '0')}`,
        created: Date.now(),
        snapshot: p.snapshot,
        status: 'received',
        demo: true,
      };
      p.state = 'approved';
      p.orderId = order.id;
      l.orders[order.id] = order;
    } else
      p.state =
        result === 'cancel'
          ? 'cancelled'
          : result === 'fail'
          ? 'failed'
          : 'expired';
    localStorage.setItem(ledgerKey, JSON.stringify(l));
    return p;
  });
}
export async function getOrder(s: Settings, id: string): Promise<Order> {
  if (s.mode === 'server') return http(s, `/orders/${id}`);
  const l = getLedger();
  const o = Object.hasOwn(l.orders, id) ? l.orders[id] : undefined;
  if (!o) throw new Error('주문을 찾지 못했어요.');
  return { ...o, status: status(o.created) };
}
