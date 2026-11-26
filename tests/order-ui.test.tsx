import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER, type Product, type State } from '../src/core/types';
import { initial } from '../src/core/flow';
import { defaults, quote } from '../src/core/domain';
import catalog from '../src/data/catalog.json';
import App from '../App';
import { Icon, Photo } from '../src/ui/figma';

const mock = vi.hoisted(() => ({ state: null as State | null, listening: false, kakaoCheckStatus: 'idle' }));
vi.mock('../src/services/useApp', () => ({
  useApp: () => ({
    s: mock.state, dispatch: vi.fn(), busy: false, listening: mock.listening, speak: vi.fn(),
    discover: vi.fn(), voiceSearch: vi.fn(), cancelVoiceSearch: vi.fn(), complete: vi.fn(), finishPickup: vi.fn(),
    kakaoCheckStatus: mock.kakaoCheckStatus, checkKakaoPayment: vi.fn(), returnKakaoToCart: vi.fn(),
  }),
}));
vi.mock('../src/native/browserDevice', () => ({ canChooseBeacon: () => true }));

const products = catalog.menu as Product[];
const store = { stores: catalog.stores, storeId: catalog.stores[0].id, products };
const product = (name: string) => products.find(p => p.name === name)!;

function render(flow: State['flow'], extra: Partial<State> = {}, kakaoCheckStatus = 'idle') {
  mock.kakaoCheckStatus = kakaoCheckStatus;
  mock.state = { ...initial, ...store, flow, ...extra };
  return renderToStaticMarkup(<App />);
}

test('integrated KakaoPay uses the existing checkout screen and leaves START unchanged', () => {
  expect(render('START', { kakaoTest: true })).toEqual(render('START', { kakaoTest: false }));
  const line = { id: 'kakao-line', productId: products[0].id, options: defaults(products[0]), quantity: 2 };
  const receipt = quote(catalog.stores[0], products, [line]);
  const payment = {
    id: 'kakao-payment', provider: KAKAO_TEST_PROVIDER, state: 'ready' as const, snapshot: receipt,
    redirect: KAKAO_TEST_ORIGIN + '/checkout/kakao-payment',
  };
  const html = render('PAYMENT_EXTERNAL', {
    payment: { ...payment, connection: { mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN } },
  });
  expect(html).toContain('실제로 돈이 청구되지 않아요.');
  expect(html).toContain(receipt.total.toLocaleString('ko-KR') + '원');
  expect(html).toContain('카카오페이 결제하기');
  expect(html).toMatch(/role="status"[^>]*>[^>]*<div[^>]*>카카오페이 결제창에서 결제를 진행해 주세요/);
  expect(html).toContain('결제 결과 확인');
  expect(html).not.toMatch(/테스트 결제 완료|실패 상황 체험|시간 초과 체험/);
  expect(render('PAYMENT_EXTERNAL', { payment: { ...payment, provider: 'offline' } })).toContain('테스트 결제 완료');
});

test('mobile checkout describes the app switch, keeps one status message and omits the unavailable action', () => {
  const product = products[0];
  const receipt = quote(catalog.stores[0], products, [{ id: 'item', productId: product.id, options: defaults(product), quantity: 1 }]);
  const payment = {
    id: 'mobile-test', provider: KAKAO_TEST_PROVIDER, state: 'ready' as const, snapshot: receipt,
    connection: { mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN } as const,
    redirect: KAKAO_TEST_ORIGIN + '/checkout/mobile-test', checkoutAvailable: { pc: true, mobile: false },
  };
  vi.stubGlobal('navigator', { userAgent: 'iPhone' });
  try {
    const html = render('PAYMENT_EXTERNAL', { payment });
    expect(html).toContain('주문하던 브라우저로 돌아와 주세요.');
    expect(html.match(/이 기기에서 카카오페이 결제창을 열 수 없어요/g)).toHaveLength(1);
    expect(html).not.toContain('카카오페이 결제하기');
    expect(html).toContain('결제 결과 확인');
    expect(html).not.toContain('QR');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('announces distinct checking, unchanged and unavailable results without offering a new payment', () => {
  const line = { id: 'kakao-line', productId: products[0].id, options: defaults(products[0]), quantity: 1 };
  const receipt = quote(catalog.stores[0], products, [line]);
  const payment = {
    id: 'old-preparation', provider: KAKAO_TEST_PROVIDER, state: 'review' as const, snapshot: receipt,
    connection: { mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN } as const,
    checkoutAvailable: { pc: false, mobile: false },
  };
  const html = render('P02-V', { payment }, 'checking');
  expect(html).toMatch(/<h1[^>]*aria-live="polite">결제 결과를 확인하고 있어요<\/h1>/);
  expect(html).toContain('잠시만 기다려 주세요.');
  expect(html).not.toMatch(/결제 결과 다시 확인|다시 결제하기|장바구니로 돌아가기/);
  for (const mode of ['checked', 'unavailable']) {
    const uncertain = render('P02-V', { payment }, mode);
    expect(uncertain).toMatch(/<h1[^>]*>아직 결제 결과를 확인하지 못했어요<\/h1>/);
    expect(uncertain).toContain('중복 결제를 막기 위해 결제 결과를 먼저 확인해 주세요.');
    expect(uncertain).toMatch(/<button[^>]*>[\s\S]*?결제 결과 다시 확인[\s\S]*?<\/button>/);
    expect(uncertain).not.toMatch(/이 기기에서|아직 결제하지 않았어요|결제 계속하기|장바구니로 돌아가기/);
  }
  const oldReady = { ...payment, state: 'ready' as const, redirect: KAKAO_TEST_ORIGIN + '/checkout/old-preparation' };
  expect(render('P02-V', { payment: oldReady, error: '서버 연결을 확인해 주세요.' }, 'unavailable'))
    .not.toContain('아직 결제하지 않았어요');
});

test('confirmed unpaid checkout presents only actions supported by the verified transaction', () => {
  const payment = {
    id: 'ready-kakao', provider: KAKAO_TEST_PROVIDER, state: 'ready' as const,
    snapshot: quote(catalog.stores[0], products, [{ id: 'line', productId: products[0].id, options: defaults(products[0]), quantity: 2 }]),
    connection: { mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN } as const,
    redirect: KAKAO_TEST_ORIGIN + '/checkout/ready-kakao', cartReturnAvailable: true,
  };
  const external = render('PAYMENT_EXTERNAL', { payment });
  expect(external).toContain('카카오페이 결제하기');
  expect(external).toContain('장바구니로 돌아가기');
  expect(external).not.toContain('결제 결과 확인');
  const verified = render('P02-V', { payment }, 'checked');
  expect(verified).toMatch(/<h1[^>]*>아직 결제하지 않았어요<\/h1>/);
  expect(verified).toContain('결제 계속하기');
  expect(verified).toContain('장바구니로 돌아가기');
  expect(verified).not.toMatch(/결제 결과 다시 확인|기존 결제 이어하기|결제 중단하기/);
  const withoutLink = render('P02-V', { payment: { ...payment, state: 'review', redirect: null } }, 'checked');
  expect(withoutLink).toContain('아직 결제하지 않았어요');
  expect(withoutLink).toContain('장바구니로 돌아가기');
  expect(withoutLink).not.toContain('결제 계속하기');
  const olderServer = render('P02-V', { payment: { ...payment, cartReturnAvailable: undefined } }, 'checked');
  expect(olderServer).toContain('결제 계속하기');
  expect(olderServer).not.toContain('장바구니로 돌아가기');
  expect(render('P02-V', { payment }, 'idle')).not.toContain('장바구니로 돌아가기');
});

test('preparation failure explains what happened and offers the cart without a blind retry', () => {
  const line = { id: 'kakao-line', productId: products[0].id, options: defaults(products[0]), quantity: 1 };
  const receipt = quote(catalog.stores[0], products, [line]);
  const payment = {
    id: 'old-preparation', provider: KAKAO_TEST_PROVIDER, state: 'failed' as const, snapshot: receipt,
    connection: { mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN } as const,
    failureReason: 'preparation' as const,
  };
  const html = render('P02-F', { payment, cart: [line] });
  expect(html).toContain('카카오페이 결제창을 준비하지 못했어요.');
  expect(html).toContain('장바구니로 돌아가기');
  expect(html).not.toMatch(/이 기기에서|다시 결제하기/);
});

test('an incompletely pinned Kakao checkout cannot fall back to the legacy new-tab button', () => {
  const line = { id: 'kakao-line', productId: products[0].id, options: defaults(products[0]), quantity: 1 };
  const payment = {
    id: 'unbound-kakao-payment', provider: KAKAO_TEST_PROVIDER, state: 'ready' as const,
    snapshot: quote(catalog.stores[0], products, [line]), redirect: KAKAO_TEST_ORIGIN + '/checkout/unbound-kakao-payment',
  };
  const html = render('PAYMENT_EXTERNAL', { payment });
  expect(html).not.toMatch(/새 탭에서|결제 창 열기|카카오페이 결제하기|테스트 결제 완료/);
});

test('menu search field is named by its purpose and shows its example as a native placeholder', () => {
  const html = render('V5-05');
  expect(html).toMatch(/<input\b(?![^>]*type="radio")[^>]*aria-label="메뉴 이름으로 찾기"/);
  expect(html).toMatch(/<input\b[^>]*placeholder="메뉴 이름 \(예: 라떼\)"/);
  expect(html).not.toContain('aria-label="메뉴 이름 (예: 라떼)"');
});

test('sold-out menu reads its name and 품절 as one disabled button', () => {
  const html = render('V5-05', { category: product('디카페인 커피').category });
  const row = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes('디카페인 커피'));
  expect(row).toMatch(/\sdisabled(?:=|\s|>)/);
  expect(row).toMatch(/디카페인 커피[\s\S]*오늘 준비 수량 소진[\s\S]*품절/);
  expect(row).not.toContain('aria-label=');
});

test('native controls use their implicit tab order and buttons use their implicit role', () => {
  for (const flow of ['START', 'V5-02s', 'V5-05', 'V5-06', 'SETTINGS'] as const) {
    const html = render(flow, { productId: product('아메리카노').id });
    expect(html).not.toMatch(/\srole="button"/);
    expect(html).not.toMatch(/<(button|a|input)\b[^>]*\stabindex="0"/i);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toContain('type="button"');
  }
});

test('page heading identifies the store without a redundant step label', () => {
  const html = render('V5-05');
  expect(html).not.toContain('role="progressbar"');
  expect(html).not.toContain('주문 진행 단계');
  expect(html).not.toContain('1 / 3');
  expect(html).toContain(catalog.stores[0].name);
});

test('option groups say 필수 / 선택 instead of long phrases', () => {
  const html = render('V5-06', { productId: product('아메리카노').id });
  expect(html).toContain('온도 · 필수');
  expect(html).toContain('샷 추가 · 선택');
  expect(html).not.toContain('꼭 골라 주세요');
  expect(html).not.toContain('안 골라도 돼요');
});

test('category message is announced once, not repeated as text after the last menu', () => {
  const html = render('V5-05', { category: '음료', message: '음료 메뉴 2개' });
  expect(html).toContain('음료 · 2개');
  expect(html.match(/음료 메뉴 2개/g)).toHaveLength(1);
  expect(html).toMatch(/role="status">음료 메뉴 2개</);
  expect(render('V5-05', { query: '라' })).toContain('검색 결과');
});

test('desserts are counted in 개, drinks in 잔, and a mixed cart in 개', () => {
  const cookie = product('초콜릿 쿠키');
  const options = render('V5-06', { productId: cookie.id, quantity: 2 });
  expect(options).toContain('2개');
  expect(options).not.toContain('2잔');
  const cart = [{ id: 'c', productId: cookie.id, quantity: 2, options: {} }];
  expect(render('V5-05', { cart })).toContain('>장바구니 2개<');
  const mixed = [...cart, { id: 'a', productId: product('아메리카노').id, quantity: 1, options: { temperature: 'ice' } }];
  expect(render('V5-08', { cart: mixed })).toContain('2종류 · 총 3개');
  expect(render('V5-08', { cart: [{ ...mixed[1], quantity: 2 }] })).toContain('1종류 · 총 2잔');
});

test('final amount reads as one sentence: total, price per item, count', () => {
  const lemon = product('레몬에이드');
  const html = render('V5-06', { productId: lemon.id, quantity: 2, selected: { size: 'regular' } });
  expect(html).toMatch(/최종 금액\n<span[^>]*>8,000원<\/span>\n1잔당 4,000원 · 총 2잔/);
  expect(html).not.toContain('×');
});

test('screen title is a plain h1 without an extra role or a leftover tabindex', () => {
  const html = render('V5-06', { productId: product('레몬에이드').id });
  const title = html.match(/<h1[^>]*>/)?.[0];
  expect(title).toBeDefined();
  expect(title).not.toContain('role=');
  expect(title).not.toContain('tabindex');
  expect(html).toMatch(/<h1[^>]*>레몬에이드<\/h1>/);
});

test('waiting screens announce their title; quantity changes are announced without visible text', () => {
  expect(render('V5-04')).toMatch(/role="status">메뉴를 불러오고 있어요</);
  expect(render('V5-01', { discovery: 'demo' })).toMatch(/role="status">데모에서는 8초 후 매장 검색 결과가 자동으로 표시돼요\.</);
  // The browser's Bluetooth chooser is on top; the page stays quiet.
  expect(render('V5-01', { discovery: 'ble' })).toMatch(/role="status"><\/div>/);
  const html = render('V5-06', { productId: product('레몬에이드').id, quantity: 3, notice: '3잔' });
  expect(html).toMatch(/role="status">3잔</);
  expect(html.match(/>3잔</g)).toHaveLength(2); // the status region and the stepper only
});

test('cart button uses its visible quantity, amount and action even when a quote is unavailable', () => {
  const americano = product('아메리카노');
  const line = { id: 'l1', productId: americano.id, quantity: 2, options: defaults(americano) };
  for (const [cart, expected] of [
    [[], '장바구니 비어 있음 0원 보기'],
    [[line], '장바구니 2잔 5,000원 보기'],
    [[{ ...line, productId: 'missing' }], '장바구니 2개 금액 확인 필요 보기'],
  ] as const) {
    const html = render('V5-05', { cart: [...cart] });
    const button = html.match(/<button\b[^>]*class="app-button cart-button"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('aria-label=');
    expect(button?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).toBe(expected);
  }
});

test('menu search accepts both spellings of latte and spaces in a spoken menu name', () => {
  for (const query of ['라떼', '라테']) {
    const html = render('V5-05', { ...store, query });
    expect(html).toContain('검색 결과 · 2개');
    expect(html).toContain('카페라테');
    expect(html).toContain('바닐라라테');
  }
  const specific = render('V5-05', { ...store, query: '카페 라떼' });
  expect(specific).toContain('검색 결과 · 1개');
  expect(specific).not.toContain('바닐라라테');
});

test('info rows, order steps and the order number are real text, not an aria-label on a plain <div>', () => {
  const o = {
    id: 'o', paymentId: 'p', number: 'A-0001', created: Date.now(), demo: true, status: 'preparing' as const,
    snapshot: { storeId: catalog.stores[0].id, storeName: catalog.stores[0].name, items: [], total: 4000, quantity: 1 },
  };
  for (const html of [
    render('V5-03', { selectedStoreId: catalog.stores[0].id }),
    render('V5-11', { order: o }),
    render('V5-12', { order: { ...o, status: 'ready' as const } }),
  ]) {
    expect(html).not.toMatch(/<div(?![^>]*role=)[^>]*aria-label=/);
  }
  expect(render('V5-03', { selectedStoreId: catalog.stores[0].id })).toMatch(/<h2\b[^>]*>주소<\/h2><div\b[^>]*>[^<]+<\/div>/);
  expect(render('V5-11', { order: o })).toMatch(/주문 전달<span class="visually-hidden">, 완료<\/span>/);
  expect(render('V5-12', { order: { ...o, status: 'ready' as const } })).toMatch(/주문번호\n<span[^>]*>A-0001<\/span>/);
});

test('icons and the placeholder photo are hidden from screen readers', () => {
  expect(renderToStaticMarkup(<Icon name="mic" />)).toMatch(/^<div aria-hidden="true"/);
  const photo = renderToStaticMarkup(<Photo large />);
  expect(photo).toMatch(/^<div aria-hidden="true"/);
  expect(photo).toContain('메뉴 사진');
});

test('sections inside a screen are h2 headings; option groups are named by their heading', () => {
  const html = render('V5-06', { productId: product('아메리카노').id });
  expect(html).toMatch(/<h2 id="group-temperature"[^>]*>온도 · 필수<\/h2>/);
  expect(html).toMatch(/role="radiogroup"[^>]*aria-labelledby="group-temperature"|aria-labelledby="group-temperature"[^>]*role="radiogroup"/);
  expect(html).toMatch(/<h2[^>]*>수량<\/h2>/);
  expect(html).not.toContain('aria-label="온도 · 필수"');
});

test('one-option-at-a-time title uses the right particle', () => {
  const coffee = product('아메리카노');
  expect(render('V5-M3', { productId: coffee.id, step: 0 })).toContain('온도를 골라 주세요');
});

test('settings button is named by its visible text', () => {
  const settings = render('V5-05').match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find(button => button.includes('</span>접근성 설정<'));
  expect(settings).toBeDefined();
  expect(settings).not.toContain('aria-label=');
});

test('search results are told by the heading the 검색 key moves to, not by a status message', () => {
  const found = render('V5-05', { query: '라떼' });
  expect(found).toMatch(/<h2 id="search-results"[^>]*>검색 결과 · 2개<\/h2>/);
  expect(found).toMatch(/role="status"><\/div>/);
  expect(found).toMatch(/<input[^>]*enterkeyhint="search"/i); // the keyboard shows a 검색 key
  expect(render('V5-05', { query: '없는메뉴' })).toMatch(/id="search-results"[^>]*>일치하는 메뉴가 없어요/);
  expect(render('V5-02', { query: '링크', found: catalog.stores })).toMatch(/<h2 id="search-results"[^>]*>검색 결과 · \d+곳<\/h2>/);
});

test('voice results announce the transcript and matching count together', () => {
  const stores = render('V5-02', { query: '없는매장', spokenQuery: true, found: catalog.stores });
  expect(stores).toMatch(/id="search-results"[^>]*>‘없는매장’ 검색 결과 · 0곳</);
  expect(stores).toContain('role="status"></div>');
  expect(render('V5-05', { query: '라떼', spokenQuery: true })).toContain('‘라떼’ 검색 결과 · 2개');
  expect(render('V5-05', { query: '없는메뉴', spokenQuery: true })).toContain('‘없는메뉴’ 검색 결과 · 0개');
});
test('category bar of the grouped menu is a set of jump buttons, the group in view marked as current', () => {
  const html = render('V5-05');
  expect(html).toMatch(/role="navigation" aria-label="메뉴 분류"|aria-label="메뉴 분류"[^>]*role="navigation"/);
  expect(html).not.toContain('name="menu-category"');
  expect(html).toMatch(/<button type="button" class="choice-input" aria-label="커피" aria-current="location">/);
  expect(html).toMatch(/<button type="button" class="choice-input" aria-label="음료">/);
  expect(html).toMatch(/<section class="menu-group" data-group="1">/);
});

test('recent order menu row is one button that says how many and whether it is open', () => {
  const lemon = product('레몬에이드');
  const history = {
    [catalog.stores[0].id]: {
      id: 'o', paymentId: 'p', number: 'A-0001', created: Date.now(), demo: true, status: 'ready' as const,
      snapshot: { storeId: catalog.stores[0].id, storeName: catalog.stores[0].name, total: 4000, quantity: 1,
        items: [{ productId: lemon.id, name: lemon.name, quantity: 1, options: { size: 'regular' }, labels: ['기본'], unitPrice: 4000, total: 4000 }] },
    },
  };
  const html = render('V5-05', { history });
  expect(html).toMatch(/<button type="button" class="frequent-toggle" aria-expanded="false">최근 주문 메뉴 1개<span aria-hidden="true"><\/span><\/button>/);
  expect(html).not.toContain('<summary');
});

test.each(['V5-09', 'P02-V', 'V5-10'] as const)('screen %s omits the unusable in-app Back action', flow => {
  expect(render(flow)).not.toMatch(/>뒤로<\//);
});

test('pickup confirmation has a single heading and native action with large text and contrast', () => {
  const html = render('V5-13', { settings: { ...initial.settings, staffHelp: true, large: true, contrast: true } });
  expect(html).toMatch(/<h1[^>]*>픽업을 완료했어요<\/h1>/);
  expect(html.match(/픽업을 완료했어요/g)).toHaveLength(1);
  expect(html.match(/이용해 주셔서 감사합니다\./g)).toHaveLength(1);
  expect(html).toContain('role="status"></div>');
  expect(html).toMatch(/<button type="button"[^>]*data-testid="primary-action"[^>]*>[\s\S]*?새 주문 시작하기/);
  expect(html).not.toMatch(/>뒤로<\/|직원 도움|주문번호|다시 듣기/);
});

test('a locked payment keeps recovery instructions visible and cannot resume or retry', () => {
  const html = render('P02-V', { recoveryRequired: true });
  expect(html).toContain('기존 결제 내역을 확인');
  expect(html).not.toContain('결제 결과 다시 확인');
  expect(html).not.toContain('기존 결제 이어하기');
});

test('provides one main landmark containing the title on entry, payment and pickup screens', () => {
  for (const flow of ['START', 'P02-V', 'V5-13'] as const) {
    const html = render(flow);
    expect(html.match(/role="main"/g)).toHaveLength(1);
    expect(html).toMatch(/role="main"[^>]*>[\s\S]*?<h1[\s>]/);
  }
});

test('menu pagination names the actual remaining count', () => {
  const results = Array.from({ length: 7 }, (_, index) => ({
    ...products[0], id: `latte-${index}`, name: `카페라테 ${index}`,
  }));
  const html = render('V5-05', { products: results, query: '라떼', menuLimit: 5 });
  expect(html).toContain('메뉴 2개 더 보기');
  expect(html).not.toContain('더 듣기');
  expect(render('V5-05', { products: results, query: '라떼', menuLimit: 10 })).not.toContain('더 보기');
});

test('typed menu results restored by navigation do not repeat the spoken announcement', () => {
  const spoken = render('V5-05', { query: '라떼', spokenQuery: true });
  expect(spoken).toMatch(/<h2 id="search-results"[^>]*>‘라떼’ 검색 결과 · 2개<\/h2>/);
  expect(spoken).toContain('role="status"></div>');
  const restored = render('V5-05', { query: '라떼', spokenQuery: false });
  expect(restored).toMatch(/<h2 id="search-results"[^>]*>검색 결과 · 2개<\/h2>/);
  expect(restored).toContain('role="status"></div>');
  expect(restored).not.toContain('‘라떼’ 검색 결과');
});

test('listening offers an explicit voice cancellation and one status announcement', () => {
  mock.listening = true;
  try {
    const html = render('V5-05', { query: '라떼' });
    expect(html).toContain('음성 검색 취소');
    expect(html).toContain('role="status">듣고 있어요. 찾을 이름을 말해 주세요.</div>');
    expect(html.match(/듣고 있어요\. 찾을 이름을 말해 주세요\./g)).toHaveLength(1);
  } finally {
    mock.listening = false;
  }
});
