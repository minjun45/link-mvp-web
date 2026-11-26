import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER, isQaOrigin, type Connection, type Line, type Order, type Payment, type PricedLine, type Quote, type Request, type Settings, type Snapshot } from './types.ts';

type RecordValue = Record<string, unknown>;

export const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown): value is string => isString(value) && value.trim().length > 0;
const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isOptions = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isString);

export function isLine(value: unknown): value is Line {
  return isRecord(value) && isId(value.id) && isId(value.productId) &&
    isCount(value.quantity) && value.quantity <= 20 && isOptions(value.options);
}

function isPricedLine(value: unknown): value is PricedLine {
  return isRecord(value) && isId(value.productId) && isString(value.name) &&
    isCount(value.quantity) && isOptions(value.options) &&
    Array.isArray(value.labels) && value.labels.every(isString) &&
    isAmount(value.unitPrice) && isAmount(value.total);
}

function isQuote(value: unknown): value is Quote {
  return isRecord(value) && isId(value.storeId) && isString(value.storeName) &&
    isAmount(value.total) && isCount(value.quantity) &&
    Array.isArray(value.items) && value.items.length > 0 && value.items.every(isPricedLine);
}

export function matchesQuoteItems(lines: Line[], quote: Quote): boolean {
  return lines.length === quote.items.length && lines.every((line, index) => {
    const priced = quote.items[index];
    return line.productId === priced.productId && line.quantity === priced.quantity &&
      Object.keys(line.options).length === Object.keys(priced.options).length &&
      Object.entries(line.options).every(([id, value]) => priced.options[id] === value);
  });
}

function isConnection(value: unknown): value is Connection {
  return isRecord(value) && (
    value.mode === 'local' || (value.mode === 'server' && isId(value.serverUrl)) ||
    (value.mode === KAKAO_TEST_PROVIDER && (value.serverUrl === KAKAO_TEST_ORIGIN || isQaOrigin(value.serverUrl)))
  );
}

const validConnection = (value: unknown) => value === undefined || isConnection(value);

export function isRequest(value: unknown): value is Request {
  return isRecord(value) && isId(value.key) && isId(value.storeId) &&
    Array.isArray(value.items) && value.items.every(isLine) &&
    isQuote(value.expected) && value.storeId === value.expected.storeId && validConnection(value.connection) &&
    matchesQuoteItems(value.items, value.expected);
}

const paymentStates = new Set<unknown>([
  'ready', 'preparing', 'approving', 'review', 'approved', 'cancelled', 'failed', 'expired',
]);

export function isPayment(value: unknown): value is Payment {
  return isRecord(value) && isId(value.id) && paymentStates.has(value.state) &&
    isId(value.provider) && isQuote(value.snapshot) && validConnection(value.connection) &&
    (value.orderId === undefined || isId(value.orderId)) &&
    (value.redirect == null || isString(value.redirect)) &&
    (value.checkoutAvailable === undefined || (isRecord(value.checkoutAvailable) &&
      typeof value.checkoutAvailable.pc === 'boolean' && typeof value.checkoutAvailable.mobile === 'boolean')) &&
    (value.created === undefined || isAmount(value.created));
}

export function isOrder(value: unknown): value is Order {
  return isRecord(value) && isId(value.id) && isId(value.paymentId) &&
    isId(value.number) && isAmount(value.created) && isQuote(value.snapshot) &&
    (value.status === 'received' || value.status === 'preparing' || value.status === 'ready') &&
    typeof value.demo === 'boolean' && validConnection(value.connection);
}

export function orderHistoryKey(storeId: string, connection?: Connection) {
  return connection?.mode === KAKAO_TEST_PROVIDER ? `${KAKAO_TEST_PROVIDER}:${storeId}` : storeId;
}

const displaySettings = ['dark', 'contrast', 'staffHelp', 'large', 'quickOptions'] as const;

export function restoreSnapshot(value: unknown, defaults: Settings) {
  const saved = isRecord(value) ? value : {};
  const preferences = isRecord(saved.settings) ? saved.settings : {};
  const settings = { ...defaults };
  for (const name of displaySettings) {
    if (typeof preferences[name] === 'boolean') settings[name] = preferences[name];
  }
  if (preferences.mode === 'local' || preferences.mode === 'server') settings.mode = preferences.mode;
  if (isString(preferences.serverUrl)) settings.serverUrl = preferences.serverUrl;

  const lines = Array.isArray(saved.cart) ? saved.cart.filter(isLine) : [];
  const uniqueLines = new Map<string, Line>();
  for (const line of lines) {
    if (!uniqueLines.has(line.id)) uniqueLines.set(line.id, line);
  }
  const cart = [...uniqueLines.values()].slice(0, 30);
  const history = Object.fromEntries(
    Object.entries(isRecord(saved.history) ? saved.history : {})
      .filter((entry): entry is [string, Order] =>
        isOrder(entry[1]) && entry[0] === orderHistoryKey(entry[1].snapshot.storeId, entry[1].connection)),
  );
  const request = isRequest(saved.request) ? saved.request : undefined;
  const payment = isPayment(saved.payment) ? saved.payment : undefined;
  const queued = Array.isArray(saved.queuedOrders) ? saved.queuedOrders.filter(isOrder) : [];
  const order = isOrder(saved.order) ? saved.order : queued[0];
  const queuedOrders = [...new Map(queued.filter(item => item.id !== order?.id)
    .map(item => [item.id, item])).values()];
  const needsLegacyConnection = [request, payment, order, ...queuedOrders].some(item => item && !item.connection);
  const invalidConnection = needsLegacyConnection &&
    (preferences.mode === 'server'
      ? !settings.serverUrl.trim()
      : preferences.mode !== 'local' &&
        (preferences.mode !== undefined || !!request || (!!payment && payment.provider !== 'offline') ||
          (!!order && !order.demo)));
  const recoveryRequired =
    (value !== undefined && !isRecord(value)) ||
    (saved.request !== undefined && !request) ||
    (saved.payment !== undefined && !payment) ||
    (saved.order !== undefined && !isOrder(saved.order)) ||
    (saved.queuedOrders !== undefined &&
      (!Array.isArray(saved.queuedOrders) || queued.length !== saved.queuedOrders.length)) ||
    !!invalidConnection ||
    (payment?.provider === KAKAO_TEST_PROVIDER && payment.connection?.mode !== KAKAO_TEST_PROVIDER) ||
    (payment?.connection?.mode === KAKAO_TEST_PROVIDER && payment.provider !== KAKAO_TEST_PROVIDER) ||
    !!(request?.connection && payment?.connection && (
      request.connection.mode !== payment.connection.mode ||
      ('serverUrl' in request.connection && (!('serverUrl' in payment.connection) ||
        request.connection.serverUrl !== payment.connection.serverUrl))
    )) ||
    !!(request && payment && (request.storeId !== payment.snapshot.storeId ||
      !matchesQuoteItems(request.items, payment.snapshot)));
  const storageNotice = saved.cart !== undefined &&
    (!Array.isArray(saved.cart) || cart.length !== saved.cart.length)
      ? '저장된 장바구니에서 읽을 수 없는 메뉴가 있었어요. 담은 메뉴를 다시 확인해 주세요.'
      : '';

  const snapshot: Snapshot = {
    onboarded: saved.onboarded === true,
    settings,
    storeId: isId(saved.storeId) ? saved.storeId : undefined,
    cart, history, request, payment, order,
    queuedOrders: queuedOrders.length ? queuedOrders : undefined,
  };
  return { snapshot, recoveryRequired, storageNotice };
}
