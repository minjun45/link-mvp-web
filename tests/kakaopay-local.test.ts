import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { PaymentDatabase } from '../scripts/kakaopay-db';
import { createKakaoPayLocalServer } from '../scripts/kakaopay-local';
import { defaults, quote } from '../src/core/domain';
import { catalogConnection, initial, lastOrderForStore, reduce, settings, snapshot } from '../src/core/flow';
import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER, type Order, type Payment, type State } from '../src/core/types';
import { products, stores } from '../src/services/api';
import { advancePayment } from '../src/services/checkout';
import { savePickup } from '../src/services/useApp';

const HOST = new URL(KAKAO_TEST_ORIGIN).host;
const QA_ORIGIN = 'https://link-preflight.vercel.app';
const QA_UPSTREAM = 'https://link-preflight.onrender.com';
const PC = 'https://online-payment.kakaopay.com/mockup/bridge/pc/test';
const MOBILE = 'https://online-payment.kakaopay.com/mockup/bridge/mobile/test';
const STAMP = '2026-11-25T10:00:00';
const store = stores.find(entry => entry.open)!;
const product = products.find(entry => !entry.soldOut)!;
const lines = [{ id: 'line-1', productId: product.id, options: defaults(product), quantity: 2 }];
const expected = quote(store, products, lines);
const checkout = { key: 'cart-request-1', storeId: store.id, items: lines, expected };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type GatewayRequest = Record<string, unknown>;
type GatewayPayment = { ready: GatewayRequest; tid: string; status: string };
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

async function fixture(withFile = false, hosted = false) {
  const directory = withFile ? mkdtempSync(join(tmpdir(), 'link-kakao-sqlite-test-')) : undefined;
  const filename = directory ? join(directory, 'payments.sqlite') : ':memory:';
  const credential = randomUUID();
  const gateKey = randomUUID().replaceAll('-', '');
  const origin = hosted ? QA_ORIGIN : KAKAO_TEST_ORIGIN;
  const calls: { name: string; payload: GatewayRequest }[] = [];
  const gateway = new Map<string, GatewayPayment>();
  const scenario = { readyLost: false, approvalLost: false, orderOffline: false, wrongTotal: false,
    clock: Date.parse(STAMP), waitReady: undefined as Promise<void> | undefined,
    pc: PC as string | undefined, mobile: MOBILE as string | undefined, diskReady: true };
  let latest: GatewayPayment | undefined;
  let database: PaymentDatabase;
  let server: Server;
  let port: number;

  const transport: typeof fetch = async (input, init) => {
    const name = String(input).split('/').at(-1)!;
    const payload = JSON.parse(String(init?.body)) as GatewayRequest;
    expect(input).toBe(`https://open-api.kakaopay.com/online/v1/payment/${name}`);
    expect(payload.cid).toBe('TC0ONETIME');
    expect(init?.redirect).toBe('error');
    calls.push({ name, payload });
    if (name === 'ready') {
      const tid = `T${String(payload.partner_order_id).slice(0, 19)}`;
      latest = { ready: payload, tid, status: 'READY' };
      gateway.set(tid, latest);
      if (scenario.waitReady) await scenario.waitReady;
      if (scenario.readyLost) throw new Error('lost response');
      return Response.json({ tid, next_redirect_pc_url: scenario.pc, next_redirect_mobile_url: scenario.mobile });
    }

    const trade = gateway.get(String(payload.tid));
    if (!trade) throw new Error('unknown gateway trade');
    const aid = `A${trade.tid.slice(1)}`;
    const response = {
      tid: trade.tid, aid, cid: payload.cid, approved_at: STAMP,
      partner_order_id: trade.ready.partner_order_id, partner_user_id: trade.ready.partner_user_id,
      quantity: trade.ready.quantity, item_name: trade.ready.item_name,
      amount: { total: scenario.wrongTotal ? 1 : trade.ready.total_amount },
    };
    if (name === 'approve') {
      trade.status = 'SUCCESS_PAYMENT';
      if (scenario.approvalLost) throw new Error('approval response lost');
      return Response.json(response);
    }
    if (scenario.orderOffline) return new Response(credential, { status: 503 });
    return Response.json({ ...response, status: trade.status,
      payment_action_details: [{ aid, amount: trade.ready.total_amount, payment_action_type: 'PAYMENT' }],
    });
  };

  async function start() {
    database = new PaymentDatabase(filename);
    const qa = hosted ? {
      origin, upstream: QA_UPSTREAM, accessKey: gateKey,
      checkDisk: () => { if (!scenario.diskReady) throw new Error('disk unavailable'); },
    } : undefined;
    server = createKakaoPayLocalServer({ database, transport, devKey: credential, qa, now: () => scenario.clock });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    port = address.port;
  }
  async function stop() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close();
  }
  await start();
  cleanups.push(async () => {
    await stop();
    if (directory) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
      rmdirSync(directory);
    }
  });

  function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<Reply>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, path, method: options.method,
        headers: { Host: hosted ? new URL(QA_UPSTREAM).host : HOST, ...options.headers }, agent: false,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(options.body);
    });
  }

  function login(key = gateKey, requestOrigin = origin) {
    return send('/qa-access', {
      method: 'POST',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key }).toString(),
    });
  }

  async function browser(initialCookie = '') {
    let cookie = initialCookie;
    if (hosted && !cookie) cookie = (await login()).headers['set-cookie']![0].split(';')[0];
    const config = await send('/api/config', { headers: { 'X-Link-Kakao-Test': '1', Cookie: cookie } });
    if (config.headers['set-cookie']) cookie = [cookie, config.headers['set-cookie'][0].split(';')[0]].filter(Boolean).join('; ');
    const { csrf } = JSON.parse(config.body);
    function navigate(path: string, headers?: Record<string, string>) {
      return send(path, { headers: { Cookie: cookie, ...headers } });
    }
    function api(path: string, data?: unknown, headers?: Record<string, string>) {
      return send('/api' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie, 'X-Link-Kakao-Test': '1',
          ...(data === undefined ? {} : { Origin: origin, 'X-Link-CSRF': csrf, 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    }
    const prepare = async (body = checkout) => JSON.parse((await api('/payments', body)).body) as Payment;
    const payment = async (id: string) => JSON.parse((await api('/payments/' + id)).body) as Payment;
    const order = async (id: string) => JSON.parse((await api('/orders/' + id)).body) as Order;
    return { cookie, csrf, config, navigate, api, prepare, payment, order };
  }

  function returnPath(kind = 'approval') {
    const url = new URL(String(latest?.ready[`${kind}_url`]));
    if (kind === 'approval') url.searchParams.set('pg_token', 'mock-return-token');
    return url.pathname + url.search;
  }

  return {
    send, browser, login, calls, filename, credential, scenario, returnPath,
    operations: () => calls.map(call => call.name),
    gatewayTrade: () => latest!,
    restart: async () => { await stop(); await start(); },
  };
}

test('hosted QA requires the access cookie even at the Render origin and keeps readiness public', async () => {
  const fx = await fixture(true, true);
  const headers = { 'X-Link-Kakao-Test': '1' };
  expect((await fx.send('/healthz')).status).toBe(200);
  expect((await fx.send('/api/config', { headers })).status).toBe(401);
  expect((await fx.send('/api/config', { headers: { ...headers, Host: 'unapproved.example.test' } })).status).toBe(403);
  expect((await fx.login('incorrect')).status).toBe(401);
  expect((await fx.login(undefined, QA_UPSTREAM)).status).toBe(403);

  const gate = await fx.login();
  expect(gate.headers.location).toBe('/');
  expect(gate.headers['set-cookie']![0]).toMatch(/^__Host-link_qa=.*Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const owner = await fx.browser();
  const forged = owner.cookie.replace(/(__Host-link_qa=\d+\.[a-f0-9]+\.)[a-f0-9]{64}/, '$1' + '0'.repeat(64));
  expect((await fx.send('/api/config', { headers: { ...headers, Cookie: forged } })).status).toBe(401);
  expect(owner.config.headers['set-cookie']![0]).toMatch(/^__Host-link_kakaopay_session=.*HttpOnly; SameSite=Lax.*Secure/);
  expect((await owner.api('/stores', undefined, { Cookie: owner.cookie.replace(/__Host-link_qa=[^;]+; /, '') })).status).toBe(401);
  expect((await owner.api('/payments', checkout, { Origin: QA_UPSTREAM })).status).toBe(403);
  expect((await owner.api('/payments', checkout, { 'X-Forwarded-Host': 'untrusted.example.test' })).status).toBe(200);
  expect(new URL(String(fx.calls[0].payload.approval_url)).origin).toBe(QA_ORIGIN);
  expect(String(fx.calls[0].payload.approval_url).length).toBeLessThanOrEqual(255);
  const prepared = await owner.prepare();
  expect(prepared.redirect).toBe(QA_ORIGIN + '/checkout/' + prepared.id);
  expect((await owner.navigate(fx.returnPath())).headers.location).toBe('/');
  const paid = await owner.payment(prepared.id);
  expect(paid.state).toBe('approved');
  const secondTester = await fx.browser();
  expect((await secondTester.api('/orders/' + paid.orderId)).status).toBe(404);
  await fx.restart();
  expect((await owner.order(paid.orderId!)).snapshot).toEqual(expected);
  expect((await fx.send('/healthz')).body).toBe('ok');
  fx.scenario.diskReady = false;
  expect((await fx.send('/healthz')).status).toBe(503);
  expect((await owner.api('/payments', { ...checkout, key: 'disk-down' })).status).toBe(503);
  expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
});

test('limits hosted gateway concurrency before a transaction reservation', async () => {
  const fx = await fixture(false, true);
  const first = await fx.browser();
  const second = await fx.browser();
  const third = await fx.browser();
  let release!: () => void;
  fx.scenario.waitReady = new Promise(resolve => { release = resolve; });
  const active = [first.prepare(), second.prepare()];
  try {
    await vi.waitFor(() => expect(fx.operations()).toEqual(['ready', 'ready']));
    expect((await third.api('/payments', checkout)).status).toBe(429);
    expect((await fx.send('/healthz')).status).toBe(200);
  } finally {
    release();
    await Promise.all(active);
  }
  expect((await third.prepare()).state).toBe('ready');
  expect(fx.operations()).toEqual(['ready', 'ready', 'ready']);
});

test('rejects wrong methods, data types, body size, fractional quantities and excessive totals', async () => {
  const fx = await fixture(false, true);
  const user = await fx.browser();
  const headers = { Cookie: user.cookie, 'X-Link-Kakao-Test': '1', Origin: QA_ORIGIN, 'X-Link-CSRF': user.csrf };
  expect((await fx.send('/api/quote', { headers })).status).toBe(404);
  expect((await fx.send('/api/quote', { method: 'POST', headers, body: '{}' })).status).toBe(415);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  expect((await fx.send('/api/quote', { method: 'POST', headers: jsonHeaders, body: '{' })).status).toBe(400);
  expect((await fx.send('/api/quote', { method: 'POST', headers: { ...jsonHeaders, 'Content-Length': '33000' } })).status).toBe(413);
  expect((await user.api('/quote', { ...checkout, items: [{ ...lines[0], quantity: 1.5 }] })).status).toBe(409);
  expect((await user.api('/quote', { ...checkout, items: [{ ...lines[0], quantity: -1 }] })).status).toBe(409);
  const excessive = Array.from({ length: 30 }, (_, index) => ({ ...lines[0], id: 'line-' + index, quantity: 20 }));
  expect((await user.api('/quote', { ...checkout, items: excessive })).status).toBe(409);
  expect(fx.operations()).toEqual([]);
});

test('quotes from the catalog, stores the TID before redirect and verifies the approved test order', async () => {
  const fx = await fixture();
  const user = await fx.browser();
  expect(user.config.headers['set-cookie']![0]).toContain('HttpOnly; SameSite=Lax');
  expect(JSON.parse((await user.api('/stores')).body).stores).toEqual(stores);
  expect(JSON.parse((await user.api(`/stores/${store.id}/menu`)).body).menu).toEqual(products);
  expect(JSON.parse((await user.api('/quote', { ...checkout, total: 1 })).body)).toEqual(expected);

  const payment = await user.prepare();
  expect(payment).toMatchObject({ state: 'ready', provider: KAKAO_TEST_PROVIDER, snapshot: expected });
  expect(fx.calls[0].payload).toMatchObject({ total_amount: expected.total, quantity: expected.quantity });
  expect(String(fx.calls[0].payload.approval_url)).toHaveLength(`${KAKAO_TEST_ORIGIN}/return/success/${'0'.repeat(64)}`.length);
  expect(payment.redirect).toBe(`${KAKAO_TEST_ORIGIN}/checkout/${payment.id}`);
  const checkoutPath = new URL(payment.redirect!).pathname;
  expect((await user.navigate(checkoutPath)).headers.location).toBe(PC);
  expect((await user.navigate(checkoutPath, { 'User-Agent': 'Android Mobile' })).headers.location).toBe(MOBILE);
  expect((await user.navigate(checkoutPath, { 'User-Agent': 'iPhone Safari' })).headers.location).toBe(MOBILE);
  expect((await user.navigate(checkoutPath + '?channel=mobile', { 'User-Agent': 'Macintosh Safari' })).headers.location).toBe(MOBILE);
  expect((await user.api(`/payments/${payment.id}/complete`, { result: 'success' })).status).toBe(404);

  const returned = await user.navigate(fx.returnPath());
  expect(returned.headers).toMatchObject({ location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  const landing = await user.navigate('/payment-return');
  expect(landing.body).toContain('주문하던 브라우저 탭');
  expect(landing.body).not.toContain('<script');
  expect(landing.body).not.toContain('mock-return-token');
  expect(landing.body).not.toContain(fx.credential);
  const approved = await user.payment(payment.id);
  expect(approved.state).toBe('approved');
  expect(await user.order(approved.orderId!)).toMatchObject({
    demo: true, paymentId: payment.id, number: 'A-0001', snapshot: expected, status: 'received',
  });
  fx.scenario.clock += 25_000;
  expect((await user.order(approved.orderId!)).status).toBe('ready');
  expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
});

test.each([undefined, 'http://online-payment.kakaopay.com/pay', 'https://user@online-payment.kakaopay.com/pay',
  'https://online-payment.kakaopay.com.attacker.test/pay'])('keeps mobile checkout unavailable for %s without falling back to PC', async candidate => {
  const fx = await fixture(true);
  fx.scenario.mobile = candidate;
  const owner = await fx.browser();
  const payment = await owner.prepare();
  expect(payment.checkoutAvailable).toEqual({ pc: true, mobile: false });
  await fx.restart();
  const path = new URL(payment.redirect!).pathname;
  const mobile = await owner.navigate(path + '?channel=mobile');
  expect(mobile.status).toBe(409);
  expect(mobile.headers.location).toBeUndefined();
  expect(mobile.body).toContain('이 기기에서 결제창을 열 수 없어요');
  expect(mobile.body).toContain('LINK 주문 화면으로 돌아가기');
  expect((await owner.navigate(path)).headers.location).toBe(PC);
  expect(fx.operations()).toEqual(['ready']);
});

test('supports a mobile-only link and processes a valid approval callback without a session cookie', async () => {
  const fx = await fixture(true);
  fx.scenario.pc = undefined;
  const owner = await fx.browser();
  const payment = await owner.prepare();
  expect(payment.checkoutAvailable).toEqual({ pc: false, mobile: true });
  expect((await owner.navigate(new URL(payment.redirect!).pathname + '?channel=mobile')).headers.location).toBe(MOBILE);
  await fx.restart();
  const anonymous = await fx.send(fx.returnPath());
  expect(anonymous.headers.location).toBe('/payment-return');
  expect(anonymous.headers['set-cookie']).toBeUndefined();
  const safePage = await fx.send('/payment-return');
  expect(safePage.body).not.toContain('<script');
  expect(safePage.body).not.toContain(payment.id);
  const recovered = await owner.payment(payment.id);
  expect(recovered.state).toBe('approved');
  expect((await owner.order(recovered.orderId!)).snapshot).toEqual(expected);
  expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
});

test('does not infer approval from an inquiry or a success path without a pg_token', async () => {
  const fx = await fixture();
  const owner = await fx.browser();
  const payment = await owner.prepare();
  fx.gatewayTrade().status = 'SUCCESS_PAYMENT';
  expect((await owner.navigate(fx.returnPath().split('?')[0])).headers.location).toBe('/checkout-unavailable');
  const result = await owner.payment(payment.id);
  expect(result.state).toBe('review');
  expect(result.orderId).toBeUndefined();
  expect(fx.operations()).toEqual(['ready', 'order']);
});

test('rejects altered prices, invalid stores, quantities and options without preparing a payment', async () => {
  const fx = await fixture();
  const user = await fx.browser();
  const manipulated = { ...expected, total: 1, items: [{ ...expected.items[0], total: 1, unitPrice: 1 }] };
  expect(JSON.parse((await user.api('/payments', { ...checkout, expected: manipulated })).body).code).toBe('PRICE_CHANGED');
  for (const body of [
    { ...checkout, storeId: 'bad-store' },
    { ...checkout, items: [{ ...lines[0], quantity: 21 }] },
    { ...checkout, items: [{ ...lines[0], options: { size: 'not-a-size' } }] },
    { ...checkout, items: [lines[0], lines[0]] },
  ]) {
    expect((await user.api('/quote', body)).status).toBe(409);
  }
  expect(fx.operations()).toEqual([]);
});

test('validates Host, Origin, CSRF and session ownership for checkout, callbacks, payments and orders', async () => {
  const fx = await fixture();
  expect((await fx.send('/api/config', { headers: { Host: 'other.test', 'X-Link-Kakao-Test': '1' } })).status).toBe(403);
  const owner = await fx.browser();
  const outsider = await fx.browser();
  expect((await owner.api('/payments', checkout, { Origin: 'http://localhost:3000' })).status).toBe(403);
  expect((await owner.api('/payments', checkout, { 'X-Link-CSRF': outsider.csrf })).status).toBe(403);
  expect((await owner.api('/stores', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  expect(fx.operations()).toEqual([]);

  const payment = await owner.prepare();
  const callback = fx.returnPath();
  const forged = callback.replace(/success\/[a-f0-9]{64}/, `success/${'0'.repeat(64)}`);
  expect((await owner.navigate(forged)).headers.location).toBe('/checkout-unavailable');
  expect((await owner.navigate(`${callback}&tid=wrong`)).headers.location).toBe('/checkout-unavailable');
  expect((await outsider.navigate(callback.split('?')[0])).headers.location).toBe('/checkout-unavailable');
  expect((await outsider.navigate(new URL(payment.redirect!).pathname)).status).toBe(404);
  expect((await outsider.api('/payments/' + payment.id)).status).toBe(404);
  expect(fx.operations()).toEqual(['ready']);

  const foreignReturn = await outsider.navigate(callback);
  expect(foreignReturn.headers.location).toBe('/payment-return');
  expect(foreignReturn.headers['set-cookie']).toBeUndefined();
  expect((await outsider.navigate('/payment-return')).body).not.toContain('<script');
  expect((await outsider.api('/payments/' + payment.id)).status).toBe(404);
  const approved = await owner.payment(payment.id);
  expect(approved.state).toBe('approved');
  expect((await outsider.api('/orders/' + approved.orderId)).status).toBe(404);
});

test('bounds local API requests without exposing a gateway response', async () => {
  const fx = await fixture();
  const user = await fx.browser();
  for (let i = 0; i < 179; i++) expect((await user.api('/stores')).status).toBe(200);
  expect((await user.api('/stores')).status).toBe(429);
  expect(fx.calls).toHaveLength(0);
  fx.scenario.clock += 60_000;
  expect((await user.api('/stores')).status).toBe(200);
});

test('serializes duplicate preparations and approvals with one durable order', async () => {
  const fx = await fixture();
  const owner = await fx.browser();
  let release!: () => void;
  fx.scenario.waitReady = new Promise(resolve => { release = resolve; });
  const first = owner.prepare();
  let duplicate: Payment;
  try {
    await vi.waitFor(() => expect(fx.operations()).toEqual(['ready']));
    duplicate = await owner.prepare();
    expect(duplicate.state).toBe('review');
    expect(duplicate).not.toHaveProperty('redirect');
    expect((await owner.api('/payments', { ...checkout, key: 'another-key' })).status).toBe(409);
  } finally {
    release();
  }
  const payment = await first;
  expect(duplicate!.id).toBe(payment.id);
  const pending = (await owner.payment(payment.id)).state;
  expect(pending).toBe('ready');
  await Promise.all([owner.navigate(fx.returnPath()), owner.navigate(fx.returnPath())]);
  const result = await owner.payment(payment.id);
  expect((await owner.prepare()).orderId).toBe(result.orderId);
  expect(fx.operations().filter(operation => operation === 'approve')).toHaveLength(1);
  expect(fx.operations().filter(operation => operation === 'ready')).toHaveLength(1);
  expect((await owner.order(result.orderId!)).number).toBe('A-0001');
});

test.each([['cancel', 'QUIT_PAYMENT', 'cancelled'], ['fail', 'FAIL_PAYMENT', 'failed']])(
  'only recognizes %s after the gateway confirms it',
  async (path, remote, terminal) => {
    const fx = await fixture();
    const owner = await fx.browser();
    const payment = await owner.prepare();
    await owner.navigate(fx.returnPath(path));
    expect((await owner.payment(payment.id)).state).toBe('ready');
    fx.gatewayTrade().status = remote;
    expect((await owner.payment(payment.id)).state).toBe(terminal);
    expect(fx.operations()).not.toContain('approve');
  },
);

test('only verifies a late success callback and refuses an uninitiated approval', async () => {
  const fx = await fixture();
  const owner = await fx.browser();
  const payment = await owner.prepare();
  fx.gatewayTrade().status = 'SUCCESS_PAYMENT';
  fx.scenario.clock += 16 * 60_000;
  await owner.navigate(fx.returnPath());
  const unresolved = await owner.payment(payment.id);
  expect(unresolved.state).toBe('review');
  expect(unresolved.orderId).toBeUndefined();
  expect(fx.operations()).toEqual(['ready', 'order', 'order']);
});

test('leaves an unverifiable amount pending and keeps gateway error data private', async () => {
  const fx = await fixture();
  const owner = await fx.browser();
  const payment = await owner.prepare();
  fx.scenario.wrongTotal = true;
  await owner.navigate(fx.returnPath());
  fx.scenario.orderOffline = true;
  const result = await owner.api('/payments/' + payment.id);
  expect(JSON.parse(result.body)).toMatchObject({ state: 'review', snapshot: expected });
  expect(result.body).not.toContain(fx.credential);
  expect(result.body).not.toContain('orderId');
  expect((await owner.api('/payments', { ...checkout, key: 'different-key' })).status).toBe(409);
});

test('keeps an unknown preparation locked across restart without fetching or resubmitting a missing TID', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  fx.scenario.readyLost = true;
  const payment = await owner.prepare();
  expect(payment.state).toBe('review');
  expect(payment.redirect).toBeUndefined();
  await fx.restart();
  const restarted = await fx.browser(owner.cookie);
  expect(await restarted.prepare()).toEqual(payment);
  expect((await restarted.payment(payment.id)).state).toBe('review');
  expect((await restarted.api('/payments', { ...checkout, key: 'different-key' })).status).toBe(409);
  expect((await restarted.navigate(fx.returnPath())).headers.location).toBe('/checkout-unavailable');
  expect(fx.operations()).toEqual(['ready']);
});

test('recovers a lost approval response even after expiry and restart, without another approve', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  fx.scenario.approvalLost = fx.scenario.orderOffline = true;
  await owner.navigate(fx.returnPath());
  await fx.restart();
  fx.scenario.clock += 16 * 60_000;
  fx.scenario.orderOffline = false;
  const after = await fx.browser(owner.cookie);
  expect((await after.navigate(new URL(payment.redirect!).pathname)).headers.location).toBe('/');
  const recovered = await after.payment(payment.id);
  expect(recovered.state).toBe('approved');
  expect(fx.calls.filter(call => call.name === 'order').every(call => call.payload.tid === fx.gatewayTrade().tid)).toBe(true);
  await after.navigate(fx.returnPath());
  await fx.restart();
  expect((await after.order(recovered.orderId!)).paymentId).toBe(payment.id);
  expect(fx.operations()).toEqual(['ready', 'approve', 'order', 'order']);
});

test('rolls back a failed order commit and creates the order exactly once on a later verified lookup', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  const db = new DatabaseSync(fx.filename);
  try {
    db.exec(`CREATE TRIGGER fail_approval BEFORE UPDATE OF state ON payments WHEN NEW.state = 'approved'
      BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END`);
    expect((await owner.navigate(fx.returnPath())).headers.location).toBe('/');
    expect(db.prepare('SELECT count(*) AS count FROM orders').get()?.count).toBe(0);
    expect(db.prepare('SELECT state FROM payments').get()?.state).toBe('approving');
    expect((await owner.api('/payments/' + payment.id)).status).toBe(503);
    db.exec('DROP TRIGGER fail_approval');
    const recovered = await owner.payment(payment.id);
    expect(recovered.state).toBe('approved');
    await owner.navigate(fx.returnPath());
    expect(db.prepare('SELECT count(*) AS count FROM orders').get()?.count).toBe(1);
    expect(fx.operations().filter(operation => operation === 'approve')).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('keeps server commerce separate from the demo discovery preference and preserves old history', () => {
  const alternate = { mode: 'server' as const, serverUrl: 'https://example.test' };
  const base = { ...initial, flow: 'START' as const, kakaoTest: true, settings: { ...settings, ...alternate } };
  expect(catalogConnection(reduce(base, { type: 'DISCOVER' }))).toEqual(alternate);
  const demo = reduce(base, { type: 'DISCOVER', demo: true });
  expect(demo.settings).toEqual(base.settings);
  expect(catalogConnection(demo)).toEqual({ mode: KAKAO_TEST_PROVIDER, serverUrl: KAKAO_TEST_ORIGIN });
  expect(catalogConnection({ ...base, kakaoTest: false })).toEqual(alternate);
});

async function frontend(fx: Awaited<ReturnType<typeof fixture>>) {
  const user = await fx.browser();
  const data = new Map<string, string>();
  let writePayment = true;
  const path = 'link-web.state.v1';
  vi.stubGlobal('location', { origin: KAKAO_TEST_ORIGIN });
  vi.stubGlobal('localStorage', {
    setItem(key: string, value: string) {
      if (!writePayment && JSON.parse(value).payment) throw new Error('storage full');
      data.set(key, value);
    },
    getItem: (key: string) => data.get(key) ?? null,
  });
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe(KAKAO_TEST_ORIGIN);
    const response = await fx.send(url.pathname, {
      method: init.method, body: init.body as string | undefined,
      headers: { Cookie: user.cookie, ...init.headers as Record<string, string>,
        ...(init.method === 'POST' ? { Origin: KAKAO_TEST_ORIGIN } : {}) },
    });
    return new Response(response.body, { status: response.status });
  });
  vi.stubGlobal('fetch', fetcher);
  const localOrder: Order = {
    id: 'old-order', paymentId: 'old-payment', created: 0, number: 'A-0088',
    snapshot: expected, status: 'ready', demo: true,
  };
  const cart: State = { ...initial, kakaoTest: true, flow: 'V5-08', discovery: 'demo',
    stores, products, storeId: store.id, cart: lines, history: { [store.id]: localOrder } };
  const begin = reduce(cart, { type: 'CHECKOUT', key: checkout.key });
  const reload = (active: boolean) => reduce(initial, {
    type: 'HYDRATE', snapshot: JSON.parse(data.get(path)!), stores, products, kakaoTest: active,
  });
  return { user, begin, fetcher, data, localOrder, reload, blockStorage: () => { writePayment = false; } };
}

test('integrated app persists the payment before opening it, reloads the pinned trade and finishes pickup', async () => {
  const fx = await fixture(true);
  const app = await frontend(fx);
  const prepared = reduce(app.begin, (await advancePayment(app.begin, () => true))!);
  expect(prepared.flow).toBe('PAYMENT_EXTERNAL');
  expect(prepared.payment?.snapshot).toEqual(expected);
  await fx.restart();
  const restored = app.reload(false);
  expect(restored.flow).toBe('P02-V');
  expect(restored.payment?.connection?.mode).toBe(KAKAO_TEST_PROVIDER);
  await app.user.navigate(fx.returnPath());
  const approved = reduce(restored, (await advancePayment(restored, () => true))!);
  expect(approved.flow).toBe('V5-10');
  expect(approved.history[store.id]).toEqual(app.localOrder);
  expect(lastOrderForStore({ ...approved, kakaoTest: true, storeId: store.id })?.id).toBe(approved.order?.id);
  expect(lastOrderForStore({ ...approved, kakaoTest: false, storeId: store.id })?.id).toBe(app.localOrder.id);

  fx.scenario.clock += 25_000;
  const order = await app.user.order(approved.order!.id);
  const ready = reduce(reduce(approved, { type: 'OPEN_ORDER' }), { type: 'ORDER_UPDATED', order });
  expect(ready.flow).toBe('V5-12');
  let finished = ready;
  await savePickup(ready, { current: false }, () => {}, action => { finished = reduce(finished, action); });
  expect(finished.flow).toBe('V5-13');
  expect(reduce(finished, { type: 'START_NEW_ORDER' }).flow).toBe('START');
  expect(app.reload(true)).toMatchObject({ flow: 'START', order: undefined, history: finished.history });
});

test('leaves an active transaction in verification on storage or network failure without a mock payment', async () => {
  const fx = await fixture();
  const app = await frontend(fx);
  app.blockStorage();
  const waiting = reduce(app.begin, (await advancePayment(app.begin, () => true))!);
  expect(waiting).toMatchObject({ flow: 'P02-V', request: app.begin.request, payment: { provider: KAKAO_TEST_PROVIDER } });
  expect(reduce(waiting, { type: 'NAV', flow: 'PAYMENT_EXTERNAL' })).toBe(waiting);
  app.fetcher.mockRejectedValueOnce(new Error('server disconnected'));
  const restored = app.reload(false);
  const retry = reduce(restored, { type: 'NAV', flow: 'P02-V' });
  const disconnected = reduce(retry, (await advancePayment(retry, () => true))!);
  expect(disconnected).toMatchObject({ flow: 'P02-V', request: app.begin.request });
  expect(disconnected.error).toBeTruthy();
  expect(app.data.has('link-web.ledger.v1')).toBe(false);
  expect(fx.operations()).toEqual(['ready']);
});
