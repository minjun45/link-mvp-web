import type {
  State,
  Connection,
  Snapshot,
  Store,
  Product,
  Payment,
  Order,
  Quote,
  Settings,
  Flow,
} from './types';
import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER } from './types';
import { defaults, initialOptions, quote, fromOrder, unit, sameQuote, paymentMatchesRequest } from './domain';
import { matchesQuoteItems, orderHistoryKey, restoreSnapshot } from './savedData';
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
  kakaoTest: false,
  recoveryRequired: false,
  storageNotice: '',
  orderStatusChecked: true,
  retryVerification: false,
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
export function catalogConnection(state: State): Connection {
  const { mode, serverUrl } = state.settings;
  if (state.kakaoTest && (state.discovery === 'demo' || mode === 'local'))
    return { mode: KAKAO_TEST_PROVIDER, serverUrl: state.kakaoOrigin ?? KAKAO_TEST_ORIGIN };
  return mode === 'server' ? { mode, serverUrl } : { mode };
}

export function lastOrderForStore(state: State) {
  if (!state.storeId) return;
  return state.history[orderHistoryKey(state.storeId, catalogConnection(state))] ?? state.history[state.storeId];
}

export type Action =
  | {
      type: 'HYDRATE';
      snapshot?: unknown;
      kakaoTest?: boolean;
      kakaoOrigin?: string;
      resumed?: boolean;
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
  | { type: 'QUERY'; value: string; spoken?: boolean; revision?: number }
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
  | { type: 'CHECKOUT_REJECTED'; message: string; products?: Product[] }
  | { type: 'STORAGE_ERROR'; message: string }
  | { type: 'ACCEPT_CHANGED' }
  | { type: 'PAYMENT_READY'; payment: Payment }
  | { type: 'PAYMENT_RESULT'; payment: Payment; order?: Order; error?: string }
  | { type: 'RETRY_PAYMENT' }
  | { type: 'RETRY_CHECKOUT'; key: string }
  | { type: 'ORDER_UPDATED'; order: Order }
  | { type: 'ORDER_LOOKUP_FAILED'; orderId: string }
  | { type: 'OPEN_ORDER' }
  | { type: 'PICKUP_COMPLETE' }
  | { type: 'START_NEW_ORDER' }
  | { type: 'SETTINGS'; value: Partial<Settings> }
  | { type: 'START_VOICE_SEARCH' }
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
  spokenQuery: false,
  retryVerification: false,
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
  'P01-E1': 'V5-08',
  'P01-E2': 'V5-08',
  'P02-C': 'V5-08',
  'P02-F': 'V5-08',
  'P02-T': 'V5-08',
  'V5-11': 'V5-10',
  'V5-12': 'V5-11',
};
export function reduce(s: State, a: Action): State {
  if ('revision' in a && a.revision !== undefined && a.revision !== s.revision) return s;
  // Only the completion screen's button can leave it during the current visit.
  if (s.flow === 'V5-13' && a.type !== 'START_NEW_ORDER' && a.type !== 'HYDRATE') return s;
  try {
    switch (a.type) {
      case 'START_NEW_ORDER':
        return s.flow === 'V5-13' ? start(s) : s;
      case 'HYDRATE': {
        const { snapshot: saved, recoveryRequired, storageNotice } = restoreSnapshot(a.snapshot, settings);
        return {
          ...initial,
          ...saved,
          kakaoTest: a.kakaoTest === true,
          ...(a.kakaoOrigin ? { kakaoOrigin: a.kakaoOrigin } : {}),
          revision: a.resumed ? s.revision + 1 : 0,
          stores: a.stores,
          products: a.products,
          recoveryRequired,
          storageNotice,
          orderStatusChecked: !saved.order,
          flow: recoveryRequired || saved.request || saved.payment ? 'P02-V' : saved.order ? 'V5-11' : 'START',
        };
      }
      case 'STORES':
        return { ...s, stores: a.stores, discoveryReady: true };
      case 'NAV':
        if (s.flow === 'V5-09')
          return a.flow === 'START' || a.flow === 'BLE_GUIDE' ? goto(s, 'P02-V') : s;
        if (s.flow === 'PAYMENT_EXTERNAL' || s.flow === 'P02-V') {
          if (a.flow === 'P02-V' && !s.recoveryRequired)
            return { ...goto(s, 'P02-V'), retryVerification: s.flow === 'P02-V' };
          if (a.flow === 'PAYMENT_EXTERNAL' && s.flow === 'P02-V' &&
              !s.recoveryRequired && !s.error && s.payment?.state === 'ready' &&
              paymentMatchesRequest(s.payment, s.request))
            return goto(s, 'PAYMENT_EXTERNAL');
          if (a.flow === 'V5-11' && s.recoveryRequired && s.order)
            return goto(s, 'V5-11');
          if (a.flow === 'START' || a.flow === 'BLE_GUIDE') return goto(s, 'P02-V');
          return s;
        }
        if (s.order && ['START', 'BLE_GUIDE'].includes(a.flow)) return reduce(s, { type: 'OPEN_ORDER' });
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
        if (['V5-09', 'P02-V', 'V5-10'].includes(s.flow)) return s;
        if (s.flow === 'PAYMENT_EXTERNAL') return goto(s, 'P02-V');
        if (s.recoveryRequired && s.flow === 'V5-11') return goto(s, 'P02-V');
        if (s.flow === 'SETTINGS') return s.returnTo === 'START' ? start(s) : goto(s, s.returnTo);
        if (['BLE_GUIDE', 'V5-01', 'V5-01e'].includes(s.flow)) return start(s);
        if (['P01-E2', 'P02-C', 'P02-F', 'P02-T'].includes(s.flow))
          return reduce(s, { type: 'RETRY_PAYMENT' });
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
        if (s.request || s.payment || s.order || s.recoveryRequired) return s;
        return { ...goto(s, 'V5-O1'), backStack: [] };
      case 'DISCOVER':
        if (s.request || s.payment || s.recoveryRequired) return goto(s, 'P02-V');
        if (s.order) return reduce(s, { type: 'OPEN_ORDER' });
        return discover(
          a.demo && !s.kakaoTest && s.settings.mode !== 'local'
            ? reduce(s, { type: 'SETTINGS', value: { mode: 'local' } })
            : s,
          a.demo,
        );
      case 'FOUND': {
        const kind = s.discovery === 'demo' ? '데모 매장' : '매장';
        let result = `${kind}을 찾지 못했어요.`;
        if (a.stores.length === 1)
          result = `${kind} 1곳을 찾았어요. ${a.stores[0].name}의 정보를 확인해 주세요.`;
        else if (a.stores.length > 1)
          result = `${kind} ${a.stores.length}곳을 찾았어요. 매장을 선택해 주세요.`;
        return {
          ...goto(
            s,
            a.stores.length === 1 ? 'V5-03' : a.stores.length ? 'V5-02' : 'V5-01e',
          ),
          found: a.stores,
          message: result,
          selectedStoreId: a.stores.length === 1 ? a.stores[0].id : undefined,
          signal: a.stores.length ? 'found' : undefined,
        };
      }
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
          ...goto(s, lastOrderForStore(s) ? 'V5-R1' : entryMenu(a.products)),
          products: a.products,
          category: a.products[0]?.category || '',
        };
      case 'START_VOICE_SEARCH':
        return { ...s, spokenQuery: false, error: '', message: '', notice: '' };
      case 'QUERY':
        return {
          ...s,
          query: a.value,
          spokenQuery: !!a.spoken,
          // A message about the previous list (e.g. a sold-out item) no
          // longer applies to the new results.
          error: '',
          message: '',
          notice: '',
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
        return { ...s, menuLimit: s.menuLimit + 5, error: '', notice: '' };
      case 'MORE_CATEGORIES':
        return { ...s, categoryLimit: s.categoryLimit + 6 };
      case 'SELECT_PRODUCT': {
        const p = s.products.find(x => x.id === a.id);
        if (!p || p.soldOut)
          return { ...s, error: '품절된 메뉴는 선택할 수 없어요.' };
        const line = a.lineId
          ? s.cart.find(l => l.id === a.lineId)
          : a.recent
          ? lastOrderForStore(s)?.snapshot.items.find(
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
        if (s.recoveryRequired) return goto(s, 'P02-V');
        if (s.order && !s.request && !s.payment) return reduce(s, { type: 'OPEN_ORDER' });
        if (a.type === 'RETRY_CHECKOUT') {
          const terminal = (s.flow === 'P02-C' && s.payment?.state === 'cancelled') ||
            (s.flow === 'P02-F' && s.payment?.state === 'failed');
          if (!terminal || s.order) return s;
        } else if (s.request || s.payment) {
          return ['V5-09', 'PAYMENT_EXTERNAL', 'P02-V'].includes(s.flow) ? s : goto(s, 'P02-V');
        }
        const cart = a.type === 'CHECKOUT' && a.reorder ? fromOrder(lastOrderForStore(s)!) : s.cart;
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
            connection: catalogConnection(s),
            key: a.key,
            storeId: s.storeId!,
            items: cart.map(l => ({ ...l, options: { ...l.options } })),
            expected,
          },
        };
      }
      case 'STORAGE_ERROR':
        return { ...s, storageNotice: a.message };
      case 'CHECKOUT_REJECTED':
        return {
          ...goto(s, 'P01-E2'),
          request: undefined,
          payment: undefined,
          products: a.products ?? s.products,
          error: a.message,
        };
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
        if (s.flow !== 'V5-09') return s;
        return {
          ...goto(
            s,
            a.payment.state === 'ready' ? 'PAYMENT_EXTERNAL' : 'P02-V',
          ),
          payment: a.payment,
        };
      case 'PAYMENT_RESULT': {
        const p = a.payment;
        if ((!s.payment && !s.request) || (s.payment && s.payment.id !== p.id) ||
            (s.payment?.state === 'approved' && p.state !== 'approved'))
          return s;
        if (p.state === 'approved' && a.order && a.order.paymentId === p.id &&
            (!p.orderId || p.orderId === a.order.id) && sameQuote(p.snapshot, a.order.snapshot)) {
          const unchanged = s.storeId === a.order.snapshot.storeId &&
            matchesQuoteItems(s.cart, a.order.snapshot);
          const queued = (s.queuedOrders ?? []).filter(order => order.id !== a.order?.id && order.id !== s.order?.id);
          if (s.order && s.order.id !== a.order.id) queued.unshift(s.order);
          return {
            ...goto(s, 'V5-10'),
            payment: undefined,
            request: undefined,
            order: a.order,
            queuedOrders: queued.length ? queued : undefined,
            orderStatusChecked: true,
            history: { ...s.history, [orderHistoryKey(a.order.snapshot.storeId, a.order.connection)]: a.order },
            cart: unchanged ? [] : s.cart,
            signal: 'success',
          };
        }
        const kakao = p.connection?.mode === KAKAO_TEST_PROVIDER;
        const flow =
          p.state === 'cancelled'
            ? 'P02-C'
            : p.state === 'failed'
            ? 'P02-F'
            : p.state === 'expired'
            ? 'P02-T'
            : kakao && s.flow === 'PAYMENT_EXTERNAL' ? 'PAYMENT_EXTERNAL' : 'P02-V';
        if (kakao && s.flow === flow && s.payment?.state === p.state && s.payment.redirect === p.redirect &&
            s.payment.orderId === p.orderId && s.payment.checkoutAvailable?.pc === p.checkoutAvailable?.pc &&
            s.payment.checkoutAvailable?.mobile === p.checkoutAvailable?.mobile && s.error === (a.error ?? ''))
          return s;
        return {
          ...(s.flow === flow ? s : goto(s, flow)),
          payment: p,
          retryVerification: false,
          error: a.error ?? '',
          message:
            flow === 'P02-V'
              ? '결제 결과를 확인해 주세요. 결과가 확정되기 전에는 새 결제를 만들지 않아요.'
              : '',
        };
      }
      case 'RETRY_PAYMENT': {
        if (!['P01-E2', 'P02-C', 'P02-F', 'P02-T'].includes(s.flow) || s.recoveryRequired) return s;
        const cleared = { ...s, payment: undefined, request: undefined };
        return s.order ? reduce(cleared, { type: 'OPEN_ORDER' }) : goto(cleared, 'V5-08');
      }
      case 'OPEN_ORDER':
        if (!s.order || s.request || s.payment || s.recoveryRequired) return s;
        return goto(s, s.orderStatusChecked && s.order.status === 'ready' ? 'V5-12' : 'V5-11');
      case 'PICKUP_COMPLETE': {
        if (s.flow !== 'V5-12' || !s.orderStatusChecked || s.order?.status !== 'ready' || s.recoveryRequired) return s;
        const [order, ...queued] = s.queuedOrders ?? [];
        const pickedUp = { ...s, order, orderStatusChecked: !order, storageNotice: '',
          queuedOrders: queued.length ? queued : undefined };
        return { ...goto(pickedUp, 'V5-13'), backStack: [] };
      }
      case 'ORDER_LOOKUP_FAILED':
        if (s.flow !== 'V5-11' || s.order?.id !== a.orderId) return s;
        return { ...s, message: '주문 상태를 확인하지 못했어요. 주문번호는 그대로이며 다시 확인하고 있어요.' };
      case 'ORDER_UPDATED': {
        if (!s.order || s.order.id !== a.order.id || s.order.paymentId !== a.order.paymentId) return s;
        const changed = a.order.status !== s.order.status;
        const order = changed ? { ...s.order, status: a.order.status } : s.order;
        if (s.flow === 'V5-11' && order.status === 'ready' && (changed || !s.orderStatusChecked)) {
          // The pickup heading announces readiness. Keep the live region quiet.
          return { ...goto(s, 'V5-12'), order, orderStatusChecked: true, signal: 'found' };
        }
        return {
          ...s,
          order,
          orderStatusChecked: true,
          message: changed ? (order.status === 'ready' ? '음료가 준비됐어요.' : '주문을 준비하고 있어요.') : '',
          signal: changed ? 'found' : s.signal,
        };
      }
      case 'SETTINGS': {
        const connection =
          (a.value.mode && a.value.mode !== s.settings.mode) ||
          (a.value.serverUrl && a.value.serverUrl !== s.settings.serverUrl);
        if (connection && (s.request || s.payment || s.order || s.recoveryRequired))
          return { ...s, error: '진행 중인 결제와 주문을 먼저 확인해 주세요.' };
        return {
          ...s,
          settings: { ...s.settings, ...a.value },
          ...(connection
            ? {
                cart: [],
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
    queuedOrders: s.queuedOrders,
  };
}
