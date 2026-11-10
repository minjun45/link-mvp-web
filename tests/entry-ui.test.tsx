import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { State } from '../src/core/types';
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

test('entry screen offers real discovery and demo as separate actions', () => {
  const html = render('START', { discoveryReady: true });
  expect(html).toContain('어떻게 시작할까요?');
  expect(html).toContain('aria-label="실제 매장 찾기"');
  expect(html).toContain('aria-label="데모 매장으로 진행하기"');
});

test('both discovery modes show the scanner without a second Bluetooth search button', () => {
  for (const discovery of ['ble', 'demo'] as const) {
    const html = render('V5-01', { discovery });
    expect(html).toContain('주변 매장을 찾고 있어요');
    expect(html).toContain('찾기 멈추기');
    expect(html).not.toContain('블루투스로 매장 찾기');
  }
});

test('settings exposes unfiltered diagnostics separately from normal store discovery', () => {
  const html = render('SETTINGS');
  expect(html).toContain('BLE 기기 진단');
  expect(html).toContain('aria-label="이름 필터 없이 BLE 기기 찾기"');
  expect(html).toContain('LINK-KAIST, LINK-IEUM, LINK-BAKERY');
});

test('1103: missing-store guidance contains the three ordered recovery actions, not a search form', () => {
  const html = render('V5-02e');
  expect(html).toContain('찾는 매장이 없나요?');
  expect(html.indexOf('aria-label="다시 찾기,')).toBeLessThan(html.indexOf('aria-label="매장 이름으로 찾기,'));
  expect(html.indexOf('aria-label="매장 이름으로 찾기,')).toBeLessThan(html.indexOf('aria-label="주변 사람에게 도움 요청,'));
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
  expect(html).toContain('aria-label="다시 찾기"');
  expect(html).toContain('aria-label="매장 이름으로 찾기"');
  expect(html).not.toContain('1. 매장 입구');
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
  // Keep the PR's short screen-reader route without losing local wait data.
  const action = html.indexOf('aria-label="이 매장에서 주문"');
  expect(html.indexOf(catalog.stores[0].name)).toBeLessThan(action);
  expect(action).toBeLessThan(html.indexOf(catalog.stores[0].address));
  expect(html.match(/data-testid="primary-action"/g)).toHaveLength(1);
});

test('store and menu search each expose one field label without a duplicate native placeholder', () => {
  for (const [flow, label] of [
    ['V5-02s', '매장 이름으로 찾기'],
    ['V5-05', '메뉴 이름 (예: 라떼)'],
  ] as const) {
    const html = render(flow, { storeId: catalog.stores[0].id });
    expect(html.match(/<input\b[^>]*>/g)).toHaveLength(1);
    const input = html.match(/<input\b[^>]*>/)![0];
    expect(input).toContain(`aria-label="${label}"`);
    expect(input).not.toContain('placeholder=');
    expect(html).toContain('aria-hidden="true"');
  }
});
