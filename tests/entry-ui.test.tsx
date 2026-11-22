import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { Order, State } from '../src/core/types';
import { initial } from '../src/core/flow';
import catalog from '../src/data/catalog.json';
import App from '../App';

const mock = vi.hoisted(() => ({ state: null as State | null }));
vi.mock('../src/services/useApp', () => ({
  useApp: () => ({
    s: mock.state, dispatch: vi.fn(), busy: false, speak: vi.fn(),
    discover: vi.fn(), voiceSearch: vi.fn(), complete: vi.fn(),
  }),
}));
vi.mock('../src/native/browserDevice', () => ({ canChooseBeacon: () => true }));

function render(flow: State['flow'], extra: Partial<State> = {}) {
  mock.state = { ...initial, stores: catalog.stores, flow, ...extra };
  return renderToStaticMarkup(<App />);
}

function buttonTexts(html: string) {
  return Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g),
    ([, content]) => content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

test('entry screen offers real discovery and demo as separate actions', () => {
  const html = render('START', { discoveryReady: true });
  const heading = html.match(/<h1\b[^>]*>어떻게 시작할까요\?<\/h1>/)?.[0];
  expect(heading).toBeDefined();
  expect(heading).not.toMatch(/\s(?:role|tabindex)=/i);
  expect(buttonTexts(html)).toEqual(expect.arrayContaining(['실제 매장 찾기', '데모 매장으로 진행하기']));
});

test('Bluetooth guidance explains the browser window before offering to open it', () => {
  const html = render('BLE_GUIDE');
  expect(html).toContain('다음 창에서 매장 기기를 선택해 주세요. 웹 주소가 먼저 읽힐 수 있어요.');
  expect(buttonTexts(html)).toEqual(expect.arrayContaining(['기기 선택 창 열기', '매장 이름으로 찾기']));
  expect(html).not.toContain('주변 매장을 찾고 있어요');
});

test('only the demo scanner displays and announces its eight-second wait', () => {
  const notice = '데모에서는 8초 후 매장 검색 결과가 자동으로 표시돼요.';
  for (const discovery of ['ble', 'demo'] as const) {
    const html = render('V5-01', { discovery });
    expect(html).toContain('주변 매장을 찾고 있어요');
    expect(html).toContain('찾기 멈추기');
    if (discovery === 'demo') {
      expect(html).toContain(`role="status">${notice}</div>`);
      expect(html.slice(html.indexOf('class="screen-content"'))).toContain(notice);
    } else {
      expect(html).not.toContain(notice);
    }
    expect(html).not.toContain('블루투스로 매장 찾기');
    expect(html).not.toContain('15초');
  }
});

test('settings keeps user preferences and navigation without automatic speech or developer tools', () => {
  const html = render('SETTINGS');
  for (const label of ['큰 글씨', '고대비', '어두운 화면', '기본 옵션 빠르게 담기'])
    expect(html).toContain(`aria-label="${label}"`);
  expect(buttonTexts(html)).toEqual(expect.arrayContaining(['사용법 다시 듣기', '매장 찾기 방식 선택']));
  for (const label of ['화면 자동 음성 안내', 'BLE 기기 진단', '이름 필터 없이 BLE 기기 찾기', '개발·테스트 연결', '주문 서버 HTTPS 기본 주소', '이 서버에 연결'])
    expect(html).not.toContain(label);
});

test('1103: missing-store guidance contains the three ordered recovery actions, not a search form', () => {
  const html = render('V5-02e');
  expect(html).toContain('찾는 매장이 없나요?');
  const rows = buttonTexts(html).filter(text => /^(다시 찾기|매장 이름으로 찾기|주변 사람에게 도움 요청)/.test(text));
  expect(rows).toEqual([expect.stringMatching(/^다시 찾기/), expect.stringMatching(/^매장 이름으로 찾기/), expect.stringMatching(/^주변 사람에게 도움 요청/)]);
  expect(html).toContain('휴대폰 주문을 지원하는 매장만 목록에 나와요');
  expect(html).not.toContain('<input');
});

test('1103: name search has a search field and unsupported-ordering guidance without an extra primary CTA', () => {
  const html = render('V5-02s', { query: '없는 매장' });
  expect(html).toContain('어느 매장을 찾으세요?');
  expect(html).toContain('<input');
  expect(html).toContain('일치하는 매장이 없어요.');
  expect(html).toContain('휴대폰 주문 미지원');
  expect(html).not.toContain('data-testid="primary-action"');
});

test('1103: no-store result includes retry and name search and no numbered checklist', () => {
  const html = render('V5-01e');
  expect(html).toContain('매장을 찾지 못했어요');
  expect(buttonTexts(html)).toEqual(expect.arrayContaining(['다시 찾기', '매장 이름으로 찾기']));
  expect(html).not.toContain('1. 매장 입구');
});

test('store confirmation renders the four detail headings in order, each followed by its value', () => {
  const store = catalog.stores[0];
  const html = render('V5-03', { selectedStoreId: store.id });
  const rows = Array.from(html.matchAll(/<h2\b[^>]*>([^<]*)<\/h2>\s*<[^>]+>([^<]*)</g),
    ([, label, value]) => [label, value]);
  expect(rows).toEqual([
    ['주소', store.address],
    ['영업', store.hours],
    ['주문', '지금 휴대폰 주문 가능'],
    ['대기', '매장에서 확인해 주세요'],
  ]);
});

test('1103: store confirmation displays wait data when provided and never invents a wait estimate', () => {
  const extra = { selectedStoreId: catalog.stores[0].id };
  expect(render('V5-03', extra)).toContain('매장에서 확인해 주세요');
  const html = render('V5-03', {
    ...extra,
    stores: [{ ...catalog.stores[0], wait: { ordersAhead: 2, minutes: 5 } }],
  });
  expect(html).toContain('앞 주문 2건 · 약 5분');
  expect(html).toContain('이 매장에서 주문');
  expect(html).toContain('다른 매장 찾기');
  // Read the store details in the same order as the visible confirmation screen.
  const action = html.indexOf('>이 매장에서 주문<');
  expect(html.indexOf(catalog.stores[0].name)).toBeLessThan(action);
  expect(action).toBeGreaterThan(html.indexOf(catalog.stores[0].address));
  expect(html.match(/data-testid="primary-action"/g)).toHaveLength(1);
});

test('footer has no shared replay button; order screens keep their own replay actions', () => {
  const extra = { storeId: catalog.stores[0].id };
  for (const flow of ['START', 'V5-O2', 'V5-05', 'V5-08', 'SETTINGS'] as const) {
    const html = render(flow, extra);
    const buttons = buttonTexts(html);
    expect(buttons).not.toContain('다시 듣기');
    expect(buttons).not.toContain('직원 도움');
    expect(buttonTexts(render(flow, { ...extra, settings: { ...initial.settings, staffHelp: true } })))
      .toContain('직원 도움');
  }
  expect(render('V5-O4')).not.toContain('맨 아래 왼쪽 다시 듣기');
  const order: Order = {
    id: 'o1',
    paymentId: 'p1',
    number: 'A-17',
    created: 0,
    snapshot: { storeId: catalog.stores[0].id, storeName: catalog.stores[0].name, items: [], total: 0, quantity: 0 },
    status: 'preparing',
    demo: true,
  };
  expect(render('V5-11', { order })).toContain('주문 상태 다시 듣기');
  expect(buttonTexts(render('V5-11', { order }))).not.toContain('픽업 정보 보기');
  const ready = render('V5-11', { order: { ...order, status: 'ready' } });
  expect(buttonTexts(ready)).toEqual(expect.arrayContaining(['픽업 정보 보기', '주문 상태 다시 듣기']));
  expect(ready).toMatch(/픽업 가능<span class="visually-hidden">, 지금<\/span>/);
  expect(render('V5-12', { order: { ...order, status: 'ready' } })).toContain('주문번호 다시 듣기');
});

test('store and menu search: the name says what the field is for, the native placeholder gives a hint', () => {
  for (const [flow, label, hint] of [
    ['V5-02s', '매장 이름으로 찾기', '매장 이름 입력'],
    ['V5-05', '메뉴 이름으로 찾기', '메뉴 이름 (예: 라떼)'],
  ] as const) {
    const html = render(flow, { storeId: catalog.stores[0].id });
    expect(html.match(/<input\b(?![^>]*type="radio")[^>]*>/g)).toHaveLength(1);
    const input = html.match(/<input\b(?![^>]*type="radio")[^>]*>/)![0];
    expect(input).toContain(`aria-label="${label}"`);
    expect(input).toContain(`placeholder="${hint}"`);
    // No second copy of the hint drawn over the field.
    expect(html.match(new RegExp(hint.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(buttonTexts(html)).toContain('말하기');
  }
});
