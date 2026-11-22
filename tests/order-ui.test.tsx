import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { Product, State } from '../src/core/types';
import { initial } from '../src/core/flow';
import { defaults } from '../src/core/domain';
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

const products = catalog.menu as Product[];
const store = { stores: catalog.stores, storeId: catalog.stores[0].id, products };
const product = (name: string) => products.find(p => p.name === name)!;

function render(flow: State['flow'], extra: Partial<State> = {}) {
  mock.state = { ...initial, ...store, flow, ...extra };
  return renderToStaticMarkup(<App />);
}

test('menu search field is named by its purpose; the example stays visible but hidden from screen readers', () => {
  const html = render('V5-05');
  expect(html).toMatch(/<input\b(?![^>]*type="radio")[^>]*aria-label="메뉴 이름으로 찾기"/);
  expect(html).toContain('메뉴 이름 (예: 라떼)');
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

test('cart button uses its visible quantity, amount and action even when a quote is unavailable', () => {
  const americano = product('아메리카노');
  const line = { id: 'l1', productId: americano.id, quantity: 2, options: defaults(americano) };
  for (const [cart, expected] of [
    [[], '장바구니 비어 있음 0원 보기'],
    [[line], '장바구니 2개 5,000원 보기'],
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
    expect(html).toContain('메뉴 검색 결과 2개');
    expect(html).toContain('카페라테');
    expect(html).toContain('바닐라라테');
  }
  const specific = render('V5-05', { ...store, query: '카페 라떼' });
  expect(specific).toContain('메뉴 검색 결과 1개');
  expect(specific).not.toContain('바닐라라테');
});
