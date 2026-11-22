import type {
  State,
  Snapshot,
  Store,
  Product,
  Payment,
  Order,
  Quote,
  Settings,
  Flow,
} from './types';
import { defaults, initialOptions, quote, fromOrder, unit } from './domain';
export const settings: Settings = {
  dark: false,
  contrast: false,
  staffHelp: false,
  large: false,
  quickOptions: false,
  mode: 'local',
  serverUrl: '',
};
export const initial: State = {
  onboarded: false,
  settings,
  cart: [],
  history: {},
  flow: 'BOOT',
  backStack: [],
  stores: [],
  found: [],
  products: [],
  selected: {},
  quantity: 1,
  query: '',
  category: '',
  storeLimit: 3,
  menuLimit: 5,
  categoryLimit: 6,
  step: 0,
  returnReview: false,
  returnTo: 'START',
  discovery: 'ble',
  discoveryReady: false,
  error: '',
  message: '',
  notice: '',
  revision: 0,
};
export type Action =
  | {
      type: 'HYDRATE';
      snapshot?: Snapshot;
      stores: Store[];
      products: Product[];
    }
  | { type: 'STORES'; stores: Store[]; revision?: number }
  | { type: 'NAV'; flow: Flow }
  | { type: 'BACK' }
  | { type: 'ONBOARD_NEXT' }
  | { type: 'ONBOARD_SKIP' }
  | { type: 'REPLAY_TRAINING' }
  | { type: 'DISCOVER'; demo?: boolean }
  | { type: 'FOUND'; stores: Store[]; revision?: number }
  | { type: 'FAIL'; flow: Flow; message: string; revision?: number }
  | { type: 'SELECT_STORE'; id: string }
  | { type: 'CONFIRM_STORE'; clear?: boolean }
  | { type: 'MENU_LOADED'; products: Product[] }
  | { type: 'QUERY'; value: string }
  | { type: 'CATEGORY'; value: string }
  | { type: 'MORE_STORES' }
  | { type: 'MORE_MENU' }
  | { type: 'MORE_CATEGORIES' }
  | { type: 'SELECT_PRODUCT'; id: string; lineId?: string; recent?: boolean }
  | { type: 'OPTION'; id: string; value: string }
  | { type: 'QUANTITY'; value: number }
  | { type: 'EDIT_OPTIONS' }
  | { type: 'STEP_NEXT' }
  | { type: 'STEP_REST_DEFAULT' }
  | { type: 'EDIT_STEP'; index: number }
  | { type: 'ADD'; id: string }
  | { type: 'REMOVE'; id: string }
  | { type: 'CART_QUANTITY'; id: string; delta: number }
  | { type: 'CHECKOUT'; key: string; reorder?: boolean }
  | { type: 'PRICE_CHANGED'; quote: Quote; products: Product[] }
  | { type: 'ACCEPT_CHANGED' }
  | { type: 'PAYMENT_READY'; payment: Payment }
  | { type: 'PAYMENT_RESULT'; payment: Payment; order?: Order }
  | { type: 'RETRY_PAYMENT' }
  | { type: 'RETRY_CHECKOUT'; key: string }
  | { type: 'ORDER_UPDATED'; order: Order }
  | { type: 'OPEN_ORDER' }
  | { type: 'PICKUP_COMPLETE' }
  | { type: 'SETTINGS'; value: Partial<Settings> }
  | { type: 'CLEAR_ERROR' };
const entryMenu = (products: Product[]): Flow =>
  products.length > 20 ? 'V5-M1' : 'V5-05';
const selectionFlow = (s: State, p: Product, editing: boolean): Flow =>
  editing
    ? 'V5-08e'
    : p.options.length > 3 || p.options.some(g => g.choices.length > 4)
    ? 'V5-M3'
    : s.settings.quickOptions
    ? 'V5-06s'
    : 'V5-06';
// "2잔을" / "2개를": the unit plus the object particle that fits it.
const counted = (products: Product[], productId: string) =>
  unit(products, [productId]) === '잔' ? '잔을' : '개를';
const missing = (s: State) =>
  s.products
    .find(p => p.id === s.productId)
    ?.options.find(g => !g.choices.some(c => c.id === s.selected[g.id]));
const goto = (s: State, flow: Flow): State => ({
  ...s,
  flow,
  ...(['START', 'V5-01'].includes(flow) ? { discoveryReady: false } : {}),
  error: '',
  message: '',
  notice: '',
  signal: undefined,
  missingGroup: undefined,
  revision: s.revision + 1,
});
const shoppingScreens = new Set<Flow>([
  'V5-01',
  'V5-01e',
  'V5-02',
  'V5-02e',
  'V5-02s',
  'V5-03',
  'V5-R1',
  'V5-M1',
  'V5-05',
  'V5-05c',
  'V5-06',
  'V5-06s',
  'V5-M3',
  'V5-M4',
  'V5-08',
  'V5-08e',
]);

// Remember the visible screen, including its draft selection. Order, cart,
// and payment data stay current when the user goes back.
function visit(s: State, flow: Flow): State {
  if (s.flow === flow) return goto(s, flow);
  // A cancelled automatic loader must never become a Back destination.
  if (s.flow === 'V5-04') return goto(s, flow);
  const {
    flow: previous,
    selectedStoreId,
    productId,
    editId,
    selected,
    quantity,
    step,
    returnReview,
    query,
    category,
    storeLimit,
    menuLimit,
    categoryLimit,
    message,
  } = s;
  return {
    ...goto(s, flow),
    backStack: [
      ...s.backStack.slice(-23),
      {
        flow: previous,
        selectedStoreId,
        productId,
        editId,
        selected,
        quantity,
        step,
        returnReview,
        query,
        category,
        storeLimit,
        menuLimit,
        categoryLimit,
        message,
      },
    ],
  };
}

function discover(s: State, demo = false): State {
  return {
    ...goto(s, 'V5-01'),
    backStack: [],
    discovery: demo ? 'demo' : 'ble',
    found: [],
    selectedStoreId: undefined,
    query: '',
    storeLimit: 3,
  };
}
function start(s: State): State {
  return {
    ...goto(s, 'START'),
    backStack: [],
    found: [],
    selectedStoreId: undefined,
    query: '',
    storeLimit: 3,
  };
}
const backRoutes: Partial<Record<Flow, Flow>> = {
  'V5-O2': 'V5-O1',
  'V5-O3': 'V5-O2',
  'V5-O4': 'V5-O3',
  'V5-01': 'START',
  'V5-02': 'START',
  'V5-01e': 'START',
  'V5-02e': 'V5-02',
  'V5-02s': 'V5-02e',
  'V5-04': 'V5-03',
  'V5-R1': 'V5-03',
  'V5-05': 'V5-03',
  'V5-05c': 'V5-03',
  'V5-M1': 'V5-03',
  'V5-06': 'V5-05',
  'V5-06s': 'V5-05',
  'V5-08e': 'V5-08',
  'V5-08': 'V5-05',
  'V5-09': 'P02-V',
  PAYMENT_EXTERNAL: 'P02-V',
  'P01-E1': 'V5-08',
  'P01-E2': 'V5-08',
  'P02-C': 'V5-08',
  'P02-F': 'V5-08',
  'P02-T': 'V5-08',
  'V5-10': 'V5-10',
  'V5-11': 'V5-10',
  'V5-12': 'V5-11',
};
export function reduce(s: State, a: Action): State {
  if ('revision' in a && a.revision !== undefined && a.revision !== s.revision) return s;
  try {
    switch (a.type) {
      case 'HYDRATE': {
        // Discard the retired automatic-speech preference from older snapshots.
        const { voice: _legacyVoice, ...savedSettings } =
          (a.snapshot?.settings ?? {}) as Partial<Settings> & { voice?: boolean };
        const next = {
          ...initial,
          ...a.snapshot,
          settings: { ...settings, ...savedSettings },
          stores: a.stores,
          products: a.products,
        };
        return {
          ...next,
          flow:
            next.request || next.payment
              ? 'P02-V'
              : 'START',
        };
      }
      case 'STORES':
        return { ...s, stores: a.stores, discoveryReady: true };
      case 'NAV':
        // Dismissing the added-item sheet should not reopen it on Back.
        if (s.flow === 'V5-05c' && ['V5-05', 'V5-M1', 'V5-08'].includes(a.flow)) {
          const menuIndex = s.backStack.map(entry => entry.flow).lastIndexOf('V5-05');
          const previous = s.backStack[menuIndex];
          const menu = previous
            ? { ...goto(s, previous.flow), ...previous, backStack: s.backStack.slice(0, menuIndex) }
            : { ...goto(s, entryMenu(s.products)), backStack: [] };
          return a.flow === 'V5-08' ? visit(menu, a.flow) : menu;
        }
        if (a.flow === 'START')
          return s.request || s.payment ? goto(s, 'P02-V') : start(s);
        if (a.flow === 'BLE_GUIDE')
          return s.request || s.payment
            ? goto(s, 'P02-V')
            : { ...goto(s, 'BLE_GUIDE'), discovery: 'ble', backStack: [] };
        return {
          ...(shoppingScreens.has(a.flow) &&
          (shoppingScreens.has(s.flow) || ['V5-02e', 'V5-02s'].includes(a.flow))
            ? visit(s, a.flow)
            : goto(s, a.flow)),
          ...(['V5-02e', 'V5-02s'].includes(a.flow) && a.flow !== s.flow
            ? { query: '', storeLimit: 3 }
            : {}),
          returnTo: a.flow === 'SETTINGS'
            ? s.flow === 'V5-01' ? 'START' : s.flow
            : s.returnTo,
        };
      case 'BACK':
        if (s.flow === 'SETTINGS') return s.returnTo === 'START' ? start(s) : goto(s, s.returnTo);
        if (['BLE_GUIDE', 'V5-01', 'V5-01e'].includes(s.flow)) return start(s);
        if (['P01-E2', 'P02-C', 'P02-F', 'P02-T'].includes(s.flow))
          return {
            ...goto(s, 'V5-08'),
            payment: undefined,
            request: undefined,
          };
        if (s.flow === 'V5-M3') {
          if (s.returnReview)
            return goto({ ...s, returnReview: false }, 'V5-M4');
          if (s.step > 0) return { ...goto(s, 'V5-M3'), step: s.step - 1 };
        }
        if (s.flow === 'V5-M4') return goto({ ...s, step: 0 }, 'V5-M3');
        // Discovery requires a new click. Return to the entry choices rather
        // than restoring a scanner with no active Bluetooth request.
        if (s.flow === 'V5-02' && s.discovery === 'demo')
          return {
            ...start(s),
            discovery: 'ble',
          };
        if (
          (shoppingScreens.has(s.flow) || s.flow === 'V5-04') &&
          s.backStack.length
        ) {
          const previous = s.backStack[s.backStack.length - 1];
          if (previous.flow === 'V5-01') return start(s);
          return {
            ...goto(s, previous.flow),
            ...previous,
            backStack: s.backStack.slice(0, -1),
          };
        }
        // A single discovery result skips the list. Without a visited screen
        // to restore, Back returns to entry choices instead of creating a list.
        if (s.flow === 'V5-03') return start(s);
        return goto(s, backRoutes[s.flow] || 'START');
      case 'ONBOARD_NEXT':
        return s.flow === 'V5-O1'
          ? goto(s, 'V5-O2')
          : s.flow === 'V5-O2'
          ? goto(s, 'V5-O3')
          : s.flow === 'V5-O3'
          ? goto(s, 'V5-O4')
          : { ...start(s), onboarded: true };
      case 'ONBOARD_SKIP':
        return { ...start(s), onboarded: true };
      case 'REPLAY_TRAINING':
        return { ...goto(s, 'V5-O1'), backStack: [] };
      case 'DISCOVER':
        if (s.request || s.payment) return goto(s, 'P02-V');
        return discover(
          a.demo && s.settings.mode !== 'local'
            ? reduce(s, { type: 'SETTINGS', value: { mode: 'local' } })
            : s,
          a.demo,
        );
      case 'FOUND':
        return {
          ...goto(
            s,
            a.stores.length === 1 ? 'V5-03' : a.stores.length ? 'V5-02' : 'V5-01e',
          ),
          found: a.stores,
          selectedStoreId: a.stores.length === 1 ? a.stores[0].id : undefined,
          signal: a.stores.length ? 'found' : undefined,
        };
      case 'FAIL':
        return {
          ...(s.flow === a.flow ? s : goto(s, a.flow)),
          error: a.message,
          signal: 'error',
        };
      case 'SELECT_STORE':
        return { ...visit(s, 'V5-03'), selectedStoreId: a.id };
      case 'CONFIRM_STORE': {
        const store = s.stores.find(x => x.id === s.selectedStoreId);
        if (!store?.open)
          return {
            ...goto(s, 'E05'),
            error: '지금은 이 매장에서 주문할 수 없어요.',
          };
        if (s.cart.length && s.storeId !== store.id && !a.clear)
          return { ...s, error: 'CHANGE_STORE' };
        return {
          ...visit(s, 'V5-04'),
          storeId: store.id,
          cart: s.storeId === store.id ? s.cart : [],
          query: '',
          category: '',
        };
      }
      case 'MENU_LOADED':
        return {
          ...goto(s, s.history[s.storeId!] ? 'V5-R1' : entryMenu(a.products)),
          products: a.products,
          category: a.products[0]?.category || '',
        };
      case 'QUERY':
        return {
          ...s,
          query: a.value,
          // A message about the previous list (e.g. a sold-out item) no
          // longer applies to the new results.
          error: '',
          storeLimit: 3,
          menuLimit: 5,
          flow: s.flow === 'V5-05c' ? 'V5-05' : s.flow,
        };
      case 'CATEGORY':
        return {
          ...(s.flow === 'V5-M1' ? visit(s, 'V5-05') : goto(s, 'V5-05')),
          // Inline filters update the list without starting a new screen visit.
          revision: s.flow === 'V5-M1' ? s.revision + 1 : s.revision,
          category: a.value,
          menuLimit: 5,
          query: '',
          // From the category screen this opens a new screen, whose title is
          // read on focus; a status message at the same time would cut it off.
          message:
            s.flow === 'V5-M1'
              ? ''
              : `${a.value} 메뉴 ${
                  s.products.filter(p => p.category === a.value).length
                }개`,
        };
      case 'MORE_STORES':
        return { ...s, storeLimit: s.storeLimit + 3 };
      case 'MORE_MENU':
        return { ...s, menuLimit: s.menuLimit + 5, error: '' };
      case 'MORE_CATEGORIES':
        return { ...s, categoryLimit: s.categoryLimit + 6 };
      case 'SELECT_PRODUCT': {
        const p = s.products.find(x => x.id === a.id);
        if (!p || p.soldOut)
          return { ...s, error: '품절된 메뉴는 선택할 수 없어요.' };
        const line = a.lineId
          ? s.cart.find(l => l.id === a.lineId)
          : a.recent
          ? s.history[s.storeId!]?.snapshot.items.find(
              l => l.productId === p.id,
            )
          : undefined;
        const flow =
          a.recent && !a.lineId ? 'V5-06' : selectionFlow(s, p, !!a.lineId);
        return {
          ...visit(s, flow),
          productId: p.id,
          editId: a.lineId,
          quantity: a.lineId ? line?.quantity || 1 : 1,
          selected: line
            ? {
                ...initialOptions(p),
                ...Object.fromEntries(
                  Object.entries(line.options).filter(([id, value]) =>
                    p.options.some(
                      g => g.id === id && g.choices.some(c => c.id === value),
                    ),
                  ),
                ),
              }
            : flow === 'V5-06s' || flow === 'V5-M3'
            ? defaults(p)
            : initialOptions(p),
          step: 0,
          returnReview: false,
        };
      }
      case 'OPTION':
        return {
          ...s,
          selected: { ...s.selected, [a.id]: a.value },
          error: '',
          missingGroup: undefined,
        };
      case 'QUANTITY': {
        const quantity = Math.min(20, Math.max(1, a.value));
        return {
          ...s,
          quantity,
          notice: `${quantity}${unit(s.products, s.productId ? [s.productId] : [])}`,
        };
      }
      case 'EDIT_OPTIONS':
        return visit(s, s.editId ? 'V5-08e' : 'V5-06');
      case 'STEP_NEXT': {
        const p = s.products.find(x => x.id === s.productId)!;
        if (missing(s)?.id === p.options[s.step]?.id)
          return {
            ...s,
            error: `${p.options[s.step].name} 옵션을 선택해 주세요.`,
          };
        return s.returnReview || s.step >= p.options.length - 1
          ? goto(s, 'V5-M4')
          : { ...goto(s, 'V5-M3'), step: s.step + 1 };
      }
      case 'STEP_REST_DEFAULT': {
        const p = s.products.find(x => x.id === s.productId)!;
        return {
          ...goto(s, 'V5-M4'),
          selected: { ...defaults(p), ...s.selected },
        };
      }
      case 'EDIT_STEP':
        return { ...goto(s, 'V5-M3'), step: a.index, returnReview: true };
      case 'ADD': {
        const m = missing(s);
        if (m)
          return {
            ...s,
            error: `${m.name} 옵션을 선택해 주세요.`,
            missingGroup: m.id,
          };
        const line = {
          id: s.editId || a.id,
          productId: s.productId!,
          quantity: s.quantity,
          options: { ...s.selected },
        };
        quote(
          s.stores.find(x => x.id === s.storeId),
          s.products,
          [line],
        );
        const cart = s.editId
          ? s.cart.map(x => (x.id === s.editId ? line : x))
          : [...s.cart, line];
        if (cart.length > 30)
          return { ...s, error: '한 번에 최대 30종류를 담을 수 있어요.' };
        return {
          ...(s.editId
            ? { ...goto(s, 'V5-08'), backStack: s.backStack.slice(0, -1) }
            : visit(s, 'V5-05c')),
          cart,
          message: `${s.products.find(p => p.id === line.productId)!.name} ${
            line.quantity
          }${counted(s.products, line.productId)} ${
            s.editId ? '변경했어요.' : '담았어요.'
          }`,
          signal: 'selected',
        };
      }
      case 'REMOVE':
        return {
          ...s,
          cart: s.cart.filter(x => x.id !== a.id),
          message: '메뉴를 삭제했어요.',
          notice: '',
        };
      case 'CART_QUANTITY': {
        const cart = s.cart.map(x =>
          x.id === a.id
            ? {
                ...x,
                quantity: Math.max(1, Math.min(20, x.quantity + a.delta)),
              }
            : x,
        );
        const line = cart.find(x => x.id === a.id);
        const product = s.products.find(p => p.id === line?.productId);
        return {
          ...s,
          cart,
          notice:
            line && product
              ? `${product.name} ${line.quantity}${unit(s.products, [product.id])}`
              : s.notice,
        };
      }
      case 'RETRY_CHECKOUT':
      case 'CHECKOUT': {
        if (a.type === 'RETRY_CHECKOUT') {
          const terminal = (s.flow === 'P02-C' && s.payment?.state === 'cancelled') ||
            (s.flow === 'P02-F' && s.payment?.state === 'failed');
          if (!terminal) return s;
        } else if (s.request || s.payment) {
          return goto(s, 'P02-V');
        }
        const cart = a.type === 'CHECKOUT' && a.reorder ? fromOrder(s.history[s.storeId!]) : s.cart;
        const expected = quote(
          s.stores.find(x => x.id === s.storeId),
          s.products,
          cart,
        );
        return {
          ...goto(s, 'V5-09'),
          payment: undefined,
          cart,
          request: {
            key: a.key,
            storeId: s.storeId!,
            items: cart.map(l => ({ ...l, options: { ...l.options } })),
            expected,
          },
        };
      }
      case 'PRICE_CHANGED':
        return {
          ...goto(s, 'P01-E1'),
          products: a.products,
          changed: a.quote,
          request: undefined,
          payment: undefined,
          error: '주문 내용이 바뀌었어요. 변경된 금액과 옵션을 확인해 주세요.',
        };
      case 'ACCEPT_CHANGED':
        return { ...goto(s, 'V5-08'), changed: undefined };
      case 'PAYMENT_READY':
        return {
          ...goto(
            s,
            a.payment.state === 'ready' ? 'PAYMENT_EXTERNAL' : 'P02-V',
          ),
          payment: a.payment,
        };
      case 'PAYMENT_RESULT': {
        const p = a.payment;
        if (p.state === 'approved' && a.order) {
          const unchanged =
            s.storeId === a.order.snapshot.storeId &&
            s.cart.length === a.order.snapshot.items.length &&
            s.cart.every((line, index) => {
              const paid = a.order!.snapshot.items[index];
              return (
                line.productId === paid.productId &&
                line.quantity === paid.quantity &&
                Object.keys(line.options).length ===
                  Object.keys(paid.options).length &&
                Object.entries(line.options).every(
                  ([id, value]) => paid.options[id] === value,
                )
              );
            });
          return {
            ...goto(s, 'V5-10'),
            payment: undefined,
            request: undefined,
            order: a.order,
            history: { ...s.history, [a.order.snapshot.storeId]: a.order },
            cart: unchanged ? [] : s.cart,
            signal: 'success',
          };
        }
        const flow =
          p.state === 'cancelled'
            ? 'P02-C'
            : p.state === 'failed'
            ? 'P02-F'
            : p.state === 'expired'
            ? 'P02-T'
            : 'P02-V';
        return {
          ...(s.flow === flow ? s : goto(s, flow)),
          payment: p,
          message:
            flow === 'P02-V'
              ? '결제 결과를 확인해 주세요. 결과가 확정되기 전에는 새 결제를 만들지 않아요.'
              : '',
        };
      }
      case 'RETRY_PAYMENT':
        return { ...goto(s, 'V5-08'), payment: undefined, request: undefined };
      case 'OPEN_ORDER':
        return goto(s, s.order?.status === 'ready' ? 'V5-12' : 'V5-11');
      case 'PICKUP_COMPLETE':
        if (s.flow !== 'V5-12') return s;
        return start({ ...s, order: undefined });
      case 'ORDER_UPDATED': {
        const changed = a.order.status !== s.order?.status;
        const pickup = s.flow === 'V5-11' && a.order.status === 'ready';
        return {
          ...s,
          order: a.order,
          flow: pickup ? 'V5-12' : s.flow,
          // Moving to V5-12 focuses its title "음료가 준비됐어요". A status
          // message at the same moment would say it twice or cut it off.
          message: pickup
            ? ''
            : changed
            ? a.order.status === 'ready'
              ? '음료가 준비됐어요.'
              : '주문을 준비하고 있어요.'
            : s.message,
          signal: changed ? 'found' : s.signal,
        };
      }
      case 'SETTINGS': {
        const connection =
          (a.value.mode && a.value.mode !== s.settings.mode) ||
          (a.value.serverUrl && a.value.serverUrl !== s.settings.serverUrl);
        if (connection && (s.request || s.payment))
          return { ...s, error: '진행 중인 결제 결과를 먼저 확인해 주세요.' };
        return {
          ...s,
          settings: { ...s.settings, ...a.value },
          ...(connection
            ? {
                cart: [],
                history: {},
                storeId: undefined,
                order: undefined,
                returnTo: 'START',
                backStack: [],
              }
            : {}),
          error: '',
        };
      }
      case 'CLEAR_ERROR':
        return { ...s, error: '' };
    }
  } catch (e) {
    return {
      ...s,
      error: e instanceof Error ? e.message : '다시 시도해 주세요.',
    };
  }
}
export function snapshot(s: State): Snapshot {
  return {
    onboarded: s.onboarded,
    settings: s.settings,
    storeId: s.storeId,
    cart: s.cart,
    history: s.history,
    request: s.request,
    payment: s.payment,
    order: s.order,
  };
}
