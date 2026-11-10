import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { Product, State } from '../src/core/types';
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
  const row = html.match(/<[^>]*aria-label="디카페인 커피, 품절"[^>]*>/)?.[0];
  expect(row).toBeDefined();
  expect(row).toContain('role="button"');
  expect(row).toContain('aria-disabled="true"');
});

test('step progress bar is decorative; the step label carries the information', () => {
  const html = render('V5-05');
  expect(html).not.toContain('role="progressbar"');
  expect(html).not.toContain('주문 진행 단계');
  expect(html).toContain('1 / 3');
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

test('empty cart button reads like its visible text', () => {
  expect(render('V5-05')).toContain('aria-label="장바구니 비어 있음"');
  const cart = [{ id: 'l1', productId: product('아메리카노').id, quantity: 1, options: { temperature: 'ice' } }];
  const html = render('V5-05', { cart });
  expect(html).not.toContain('aria-label="장바구니 비어 있음"');
  expect(html).toMatch(/aria-label="장바구니 보기 · 1개 · /);
});
