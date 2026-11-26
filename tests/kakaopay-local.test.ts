import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { PaymentDatabase } from '../scripts/kakaopay-db';
import { createKakaoPayLocalServer } from '../scripts/kakaopay-local';
import type { KakaoDiagnostic } from '../scripts/kakaopay-provider';
import { defaults, quote } from '../src/core/domain';
import { catalogConnection, initial, lastOrderForStore, reduce, settings, snapshot } from '../src/core/flow';
import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER, type Order, type Payment, type State } from '../src/core/types';
import { products, stores } from '../src/services/api';
import { advancePayment, returnKakaoPaymentToCart } from '../src/services/checkout';
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

async function fixture(withFile = false, hosted = false, publicAccess = false) {
  const directory = withFile ? mkdtempSync(join(tmpdir(), 'link-kakao-sqlite-test-')) : undefined;
  const filename = directory ? join(directory, 'payments.sqlite') : ':memory:';
  const credential = randomUUID();
  const gateKey = randomUUID().replaceAll('-', '');
  const origin = hosted ? QA_ORIGIN : KAKAO_TEST_ORIGIN;
  const calls: { name: string; payload: GatewayRequest }[] = [];
  const diagnostics: KakaoDiagnostic[] = [];
  const gateway = new Map<string, GatewayPayment>();
  const scenario = { publicAccess, readyLost: false, approvalLost: false, approveBody: undefined as ((response: GatewayRequest) => Response) | undefined, orderOffline: false, wrongTotal: false,
    clock: Date.parse(STAMP), waitApprove: undefined as Promise<void> | undefined, waitReady: undefined as Promise<void> | undefined,
    readyResponse: undefined as ((tid: string) => Response) | undefined,
    waitOrder: undefined as Promise<void> | undefined,
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
      return scenario.readyResponse?.(tid) ??
        Response.json({ tid, next_redirect_pc_url: scenario.pc, next_redirect_mobile_url: scenario.mobile });
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
      if (scenario.waitApprove) await scenario.waitApprove;
      if (scenario.approvalLost) throw new Error('approval response lost');
      return scenario.approveBody?.(response) ?? Response.json(response);
    }
    if (scenario.waitOrder) await scenario.waitOrder;
    if (scenario.orderOffline) return new Response(credential, { status: 503 });
    return Response.json({ ...response, status: trade.status,
      aid: trade.status === 'SUCCESS_PAYMENT' ? aid : undefined,
      approved_at: trade.status === 'SUCCESS_PAYMENT' ? STAMP : undefined,
      payment_action_details: trade.status === 'SUCCESS_PAYMENT'
        ? [{ aid, amount: trade.ready.total_amount, payment_action_type: 'PAYMENT' }] : [],
    });
  };

  async function start() {
    database = new PaymentDatabase(filename);
    const qa = hosted ? {
      origin, upstream: QA_UPSTREAM, accessKey: gateKey, publicAccess: scenario.publicAccess,
      checkDisk: () => { if (!scenario.diskReady) throw new Error('disk unavailable'); },
    } : undefined;
    server = createKakaoPayLocalServer({ database, transport, devKey: credential, qa, now: () => scenario.clock,
      report: diagnostic => diagnostics.push(JSON.parse(JSON.stringify(diagnostic)) as KakaoDiagnostic) });
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
    if (hosted && !scenario.publicAccess && !cookie) cookie = (await login()).headers['set-cookie']![0].split(';')[0];
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
    send, browser, login, calls, diagnostics, filename, credential, scenario, returnPath,
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

test('public QA accepts the deployed frontend bootstrap without an access cookie', async () => {
  const fx = await fixture(false, true, true);
  const headers = { 'X-Link-Kakao-Test': '1', 'Sec-Fetch-Site': 'same-origin' };
  for (const host of [new URL(QA_ORIGIN).host, new URL(QA_UPSTREAM).host]) {
    const page = await fx.send('/qa-access', { headers: { Host: host } });
    expect(page).toMatchObject({ status: 303, body: '', headers: { location: QA_ORIGIN + '/' } });
    expect(page.headers['set-cookie']).toBeUndefined();
  }
  expect(await fx.login('old-form')).toMatchObject({ status: 303, headers: { location: QA_ORIGIN + '/' } });
  expect((await fx.send('/api/config')).status).toBe(403);
  expect((await fx.send('/api/config', { headers: { ...headers, Origin: QA_UPSTREAM } })).status).toBe(403);
  expect((await fx.send('/api/config', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);

  const owner = await fx.browser();
  expect(owner.config.status).toBe(200);
  expect(JSON.parse(owner.config.body)).toEqual({ kakaopayTest: true, csrf: owner.csrf });
  expect(owner.cookie).toMatch(/^__Host-link_kakaopay_session=[a-f0-9]{64}$/);
  expect(owner.config.headers['set-cookie']![0]).toContain('Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure');
  expect((await owner.api('/stores')).status).toBe(200);
  const outsider = await fx.browser();
  expect(outsider.cookie).not.toBe(owner.cookie);
  expect((await owner.api('/payments', checkout, { 'X-Link-CSRF': outsider.csrf })).status).toBe(403);
  expect((await owner.api('/payments', { ...checkout, expected: { ...expected, total: 1 } })).status).toBe(409);
  expect(fx.operations()).toEqual([]);
  const payment = await owner.prepare();
  const path = new URL(payment.redirect!).pathname;
  expect((await owner.navigate(path)).headers.location).toBe(PC);
  expect((await owner.navigate(path + '?channel=mobile')).headers.location).toBe(MOBILE);
  expect((await owner.navigate(path + '?channel=pc', { 'User-Agent': 'Android' })).headers.location).toBe(PC);
  expect((await owner.navigate(path, { 'User-Agent': 'iPhone' })).headers.location).toBe(MOBILE);
  expect((await outsider.navigate(path)).status).toBe(404);
  expect((await outsider.api('/payments/' + payment.id)).status).toBe(404);
  expect((await owner.navigate(fx.returnPath())).headers.location).toBe('/');
  const approved = await owner.payment(payment.id);
  expect(approved.state).toBe('approved');
  expect((await outsider.api('/orders/' + approved.orderId)).status).toBe(404);
  expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
});

test('a disk-backed order and pending payment survive both QA access mode changes', async () => {
  const fx = await fixture(true, true);
  const owner = await fx.browser();
  const completed = await owner.prepare();
  await owner.navigate(fx.returnPath());
  const approved = await owner.payment(completed.id);
  const order = await owner.order(approved.orderId!);
  const pendingRequest = { ...checkout, key: 'pending-mode-switch' };
  const pending = await owner.prepare(pendingRequest);
  const anonymousCookie = owner.cookie.split('; ').find(cookie => cookie.startsWith('__Host-link_kakaopay_session='))!;

  fx.scenario.publicAccess = true;
  await fx.restart();
  const publicOwner = await fx.browser(anonymousCookie);
  expect(publicOwner.config.status).toBe(200);
  expect(publicOwner.config.headers['set-cookie']).toBeUndefined();
  expect(publicOwner.csrf).toBe(owner.csrf);
  expect(await publicOwner.order(order.id)).toEqual(order);
  expect(await publicOwner.payment(pending.id)).toEqual(pending);
  const { cartReturnAvailable, ...savedPayment } = pending;
  expect(cartReturnAvailable).toBe(true);
  expect(await publicOwner.prepare(pendingRequest)).toEqual(savedPayment);

  fx.scenario.publicAccess = false;
  await fx.restart();
  expect((await publicOwner.api('/orders/' + order.id)).status).toBe(401);
  expect((await publicOwner.navigate(new URL(pending.redirect!).pathname)).headers.location).toBe('/qa-access');
  const gate = (await fx.login()).headers['set-cookie']![0].split(';')[0];
  const privateOwner = await fx.browser(gate + '; ' + anonymousCookie);
  expect(privateOwner.csrf).toBe(owner.csrf);
  expect(await privateOwner.order(order.id)).toEqual(order);
  expect(await privateOwner.prepare(pendingRequest)).toEqual(savedPayment);
  await privateOwner.navigate(fx.returnPath());
  const settled = await privateOwner.payment(pending.id);
  expect(settled.state).toBe('approved');
  expect((await privateOwner.order(settled.orderId!)).number).not.toBe(order.number);
  expect(fx.operations().filter(operation => operation === 'ready')).toHaveLength(2);
  expect(fx.operations().filter(operation => operation === 'approve')).toHaveLength(2);
});

test('caps new public sessions without spending the request budget of existing sessions', async () => {
  const fx = await fixture(true, true, true);
  const owner = await fx.browser();
  const headers = { 'X-Link-Kakao-Test': '1' };
  for (let i = 1; i < 30; i++) expect((await fx.send('/api/config', { headers })).status).toBe(200);
  const unknownCookie = '__Host-link_kakaopay_session=' + '0'.repeat(64);
  for (let i = 0; i < 601; i++) {
    const reply = await fx.send('/api/config', { headers: { ...headers, Cookie: unknownCookie } });
    expect(reply.status).toBe(429);
    expect(reply.headers['set-cookie']).toBeUndefined();
  }
  const db = new DatabaseSync(fx.filename, { readOnly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(30);
  } finally {
    db.close();
  }
  expect((await owner.api('/stores')).status).toBe(200);
  expect((await owner.api('/config')).headers['set-cookie']).toBeUndefined();
  fx.scenario.clock += 60_000;
  fx.scenario.diskReady = false;
  expect((await fx.send('/api/config', { headers })).status).toBe(503);
  expect((await owner.api('/config')).status).toBe(200);
  fx.scenario.diskReady = true;
  expect((await fx.send('/api/config', { headers })).status).toBe(200);
  expect(fx.operations()).toEqual([]);
}, 10_000);

test.each([false, true])('limits hosted gateway concurrency before a transaction reservation (public mode: %s)', async publicAccess => {
  const fx = await fixture(false, true, publicAccess);
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


const cartReturnPath = (id: string) => '/payments/' + id + '/return-to-cart';

test.each(['READY', 'OPEN_PAYMENT', 'FAIL_AUTH_PASSWORD'])(
  'returns %s to the cart once, including a channel that cannot reopen, and survives restart', async status => {
    const fx = await fixture(true);
    const owner = await fx.browser();
    fx.scenario.mobile = undefined;
    const payment = await owner.prepare();
    const callback = fx.returnPath();
    expect(payment).toMatchObject({ cartReturnAvailable: true, checkoutAvailable: { pc: true, mobile: false } });
    fx.gatewayTrade().status = status;
    expect(await owner.payment(payment.id)).toMatchObject({
      state: status === 'FAIL_AUTH_PASSWORD' ? 'review' : 'ready', cartReturnAvailable: true, snapshot: expected,
    });

    const returns = await Promise.all([owner.api(cartReturnPath(payment.id), {}), owner.api(cartReturnPath(payment.id), {})]);
    for (const response of returns) {
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ id: payment.id, state: 'cancelled', returnedToCart: true, snapshot: expected });
      expect(JSON.parse(response.body).redirect).toBeUndefined();
    }
    expect(fx.operations()).toEqual(['ready', 'order', 'order']);
    await fx.restart();
    const recovered = await owner.payment(payment.id);
    expect(recovered).toMatchObject({ state: 'cancelled', returnedToCart: true, id: payment.id });
    expect(await owner.prepare(checkout)).toEqual(recovered);
    expect((await owner.navigate(callback)).status).toBe(303);
    const next = await owner.prepare({ ...checkout, key: 'new-key-after-cart' });
    expect(next).toMatchObject({ state: 'ready', snapshot: expected });
    expect(next.id).not.toBe(payment.id);
    expect(fx.operations()).toEqual(['ready', 'order', 'order', 'ready']);
    const db = new DatabaseSync(fx.filename, { readOnly: true });
    try {
      expect(db.prepare('SELECT attempted, aid FROM payments WHERE id = ?').get(payment.id))
        .toMatchObject({ attempted: 0, aid: null });
      expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get()?.count).toBe(0);
    } finally {
      db.close();
    }
  },
);

test('verifies session ownership, Origin, CSRF and body before looking up the transaction for cart return', async () => {
  const fx = await fixture(true, true, true);
  const owner = await fx.browser();
  const other = await fx.browser();
  const payment = await owner.prepare();
  const path = cartReturnPath(payment.id);
  expect((await other.api(path, {})).status).toBe(404);
  expect((await owner.api(path, {}, { 'X-Link-CSRF': other.csrf })).status).toBe(403);
  expect((await owner.api(path, {}, { Origin: 'https://elsewhere.invalid' })).status).toBe(403);
  expect((await owner.api(path, { id: payment.id })).status).toBe(400);
  expect((await owner.api(path)).status).toBe(404);
  expect(fx.operations()).toEqual(['ready']);
});

test('keeps a live prepare reservation when a cart return targets it', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  let release!: () => void;
  fx.scenario.waitReady = new Promise<void>(resolve => { release = resolve; });
  const prepared = owner.prepare();
  try {
    await vi.waitFor(() => expect(fx.operations()).toEqual(['ready']));
    const id = String(fx.gatewayTrade().ready.partner_order_id);
    const result = await owner.api(cartReturnPath(id), {});
    expect(JSON.parse(result.body)).toMatchObject({ id, state: 'review' });
    expect(JSON.parse(result.body).returnedToCart).toBeUndefined();
    expect((await owner.api('/payments', { ...checkout, key: 'other-key' })).status).toBe(409);
  } finally {
    release();
    expect((await prepared).state).toBe('ready');
  }
});

test.each(['cart-first', 'approval-first'])(
  'cart return and approval are exclusive when %s', async first => {
    const fx = await fixture(true);
    const owner = await fx.browser();
    const payment = await owner.prepare();
    const callback = fx.returnPath();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    if (first === 'cart-first') fx.scenario.waitOrder = hold;
    else fx.scenario.waitApprove = hold;
    const leave = () => owner.api(cartReturnPath(payment.id), {});
    const approve = () => owner.navigate(callback);
    const earlier = first === 'cart-first' ? leave() : approve();
    try {
      await vi.waitFor(() => expect(fx.operations()).toEqual(['ready', first === 'cart-first' ? 'order' : 'approve']));
      const later = first === 'cart-first' ? approve() : leave();
      release();
      await Promise.all([earlier, later]);
      const recovered = await owner.payment(payment.id);
      if (first === 'cart-first') {
        expect(recovered).toMatchObject({ state: 'cancelled', returnedToCart: true });
        expect(fx.operations()).toEqual(['ready', 'order']);
      } else {
        expect(recovered.state).toBe('approved');
        expect((await owner.order(recovered.orderId!)).number).toBe('A-0001');
        expect(JSON.parse((await leave()).body)).toMatchObject({ state: 'approved', orderId: recovered.orderId });
        expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
      }
    } finally {
      release();
      await earlier;
    }
  },
);


test.each(['cart-first', 'approval-first'])('independent SQLite connections cannot undo the %s decision', async first => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  const session = owner.cookie.split('=')[1];
  const tid = fx.gatewayTrade().tid;
  const db1 = new PaymentDatabase(fx.filename);
  const db2 = new PaymentDatabase(fx.filename);
  const now = () => fx.scenario.clock;
  try {
    if (first === 'cart-first') {
      expect(db1.abandonUnapproved(session, payment.id, tid, now)).toBe(true);
      expect(db2.claimApproval(payment.id, now)).toBe(false);
      expect(db2.byId(session, payment.id)?.state).toBe('abandoned');
    } else {
      expect(db1.claimApproval(payment.id, now)).toBe(true);
      expect(db2.abandonUnapproved(session, payment.id, tid, now)).toBe(false);
      expect(db2.byId(session, payment.id)).toMatchObject({ state: 'approving', attempted: 1 });
    }
  } finally {
    db2.close();
    db1.close();
  }
});

test.each(['offline', 'wrong-total', 'approval-evidence', 'lost-approval', 'mismatch', 'past-deadline'])(
  'cart return does not release a transaction when evidence is %s', async condition => {
    const fx = await fixture(true);
    const owner = await fx.browser();
    const payment = await owner.prepare();
    if (condition === 'offline') fx.scenario.orderOffline = true;
    if (condition === 'wrong-total') fx.scenario.wrongTotal = true;
    if (condition === 'approval-evidence') fx.gatewayTrade().status = 'SUCCESS_PAYMENT';
    if (condition === 'past-deadline') fx.scenario.clock += 15 * 60_000;
    if (condition === 'lost-approval' || condition === 'mismatch') {
      fx.scenario.orderOffline = true;
      fx.scenario.approvalLost = condition === 'lost-approval';
      if (condition === 'mismatch') fx.scenario.approveBody = () => Response.json({ tid: 'other-tid' });
      await owner.navigate(fx.returnPath());
      fx.scenario.orderOffline = false;
      fx.gatewayTrade().status = 'AUTH_PASSWORD';
    }
    const reply = await owner.api(cartReturnPath(payment.id), {});
    expect(reply.status).toBe(200);
    const result = JSON.parse(reply.body);
    expect(result).toMatchObject({ id: payment.id, state: 'review' });
    expect(result.cartReturnAvailable).toBeUndefined();
    expect(result.returnedToCart).toBeUndefined();
    expect((await owner.api('/payments', { ...checkout, key: 'before-resolution' })).status).toBe(409);
  },
);

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
    expect(await owner.payment(duplicate.id)).toEqual(duplicate);
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

test.each([
  ['cancel', 'QUIT_PAYMENT', 'cancelled', false], ['fail', 'FAIL_PAYMENT', 'failed', false],
  ['cancel', 'QUIT_PAYMENT', 'cancelled', true], ['fail', 'FAIL_PAYMENT', 'failed', true],
])(
  'only recognizes %s after the gateway confirms %s as %s (public mode: %s)',
  async (path, remote, terminal, publicAccess) => {
    const fx = await fixture(false, publicAccess, publicAccess);
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

test.each([
  ['HTTP rejection', () => Response.json({ error_code: -400, error_message: 'private domain information' }, { status: 400 }),
    { reason: 'http', status: 400, errorCode: -400 }],
  ['unexpected error code', () => Response.json({ error_code: 'private-code', error_message: 'private domain information' }, { status: 400 }),
    { reason: 'http', status: 400 }],
  ['request timeout', () => { throw new DOMException('private timeout reason', 'TimeoutError'); },
    { reason: 'timeout' }],
  ['non-JSON response', () => new Response('private broken body'),
    { reason: 'response-format', status: 200 }],
  ['missing TID', () => Response.json({ next_redirect_pc_url: PC }),
    { reason: 'response-format', status: 200, invalidCheckoutUrl: false }],
] as const)('releases a checkout after %s and records only safe diagnostics', async (_name, respond, diagnostic) => {
  const fx = await fixture(false, true, true);
  const owner = await fx.browser();
  fx.scenario.readyResponse = respond;
  const first = await owner.prepare();
  expect(first).toMatchObject({ state: 'failed', failureReason: 'preparation', snapshot: expected });
  expect(first).not.toHaveProperty('redirect');
  const callback = fx.returnPath();
  expect(await owner.prepare()).toEqual(first);
  expect(await owner.payment(first.id)).toEqual(first);
  expect(fx.operations()).toEqual(['ready']);
  expect(fx.diagnostics).toEqual([{ operation: 'ready', ...diagnostic }]);
  expect(JSON.stringify(fx.diagnostics)).not.toMatch(/private|kakaopay.com/);

  fx.scenario.readyResponse = undefined;
  const next = await owner.prepare({ ...checkout, key: 'next-ready' });
  expect(next.state).toBe('ready');
  expect(next.id).not.toBe(first.id);
  expect((await owner.navigate(callback)).headers.location).toBe('/checkout-unavailable');
  expect(fx.operations()).toEqual(['ready', 'ready']);
  await owner.navigate(fx.returnPath());
  expect((await owner.order((await owner.payment(next.id)).orderId!)).number).toBe('A-0001');
  expect(await owner.payment(first.id)).toEqual(first);
});

test('recovers a lost ready response without reopening the failed request or accepting its callback', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  fx.scenario.readyLost = true;
  const payment = await owner.prepare();
  const callback = fx.returnPath();
  expect(payment).toMatchObject({ state: 'failed', failureReason: 'preparation' });
  expect(payment.redirect).toBeUndefined();
  expect(fx.diagnostics).toEqual([{ operation: 'ready', reason: 'network' }]);
  await fx.restart();
  const restarted = await fx.browser(owner.cookie);
  expect(await restarted.prepare()).toEqual(payment);
  expect(await restarted.payment(payment.id)).toEqual(payment);
  fx.scenario.readyLost = false;
  const next = await restarted.prepare({ ...checkout, key: 'different-key' });
  expect(next.state).toBe('ready');
  expect((await restarted.navigate(callback)).headers.location).toBe('/checkout-unavailable');
  expect(fx.operations()).toEqual(['ready', 'ready']);
});

test.each([undefined, 'https://unapproved.test/private-path'])(
  'preserves an unexposed TID but releases the order when both checkout channels are unusable (%s)',
  async candidate => {
    const fx = await fixture(true);
    fx.scenario.pc = candidate;
    fx.scenario.mobile = undefined;
    const owner = await fx.browser();
    const failed = await owner.prepare();
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'preparation', checkoutAvailable: { pc: false, mobile: false } });
    const db = new DatabaseSync(fx.filename, { readOnly: true });
    try {
      expect(db.prepare('SELECT tid, attempted FROM payments WHERE id = ?').get(failed.id))
        .toEqual({ tid: fx.gatewayTrade().tid, attempted: 0 });
    } finally {
      db.close();
    }
    const callback = fx.returnPath();
    expect((await owner.navigate('/checkout/' + failed.id)).headers.location).toBe('/');
    expect(fx.diagnostics).toEqual([{ operation: 'ready', reason: 'checkout-url', status: 200, invalidCheckoutUrl: !!candidate }]);
    fx.scenario.pc = PC;
    const next = await owner.prepare({ ...checkout, key: 'next-checkout' });
    expect(next.state).toBe('ready');
    await owner.navigate(callback);
    expect(fx.operations()).toEqual(['ready', 'ready']);
  },
);

function reserveLegacy(filename: string, cookie: string, state: 'review' | 'preparing') {
  const owner = cookie.split('; ').at(-1)!.split('=')[1];
  const db = new PaymentDatabase(filename);
  try {
    const reserved = db.reserve(owner, checkout.key, expected, expected.items[0].name, Date.parse(STAMP))!;
    if (state === 'review') db.setOutcome(reserved.id, 'review');
    return reserved;
  } finally {
    db.close();
  }
}

test('same-key replay closes a preparation interrupted by a restart before a TID was stored', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const abandoned = reserveLegacy(fx.filename, owner.cookie, 'preparing');
  await fx.restart();
  const after = await fx.browser(owner.cookie);
  expect(await after.prepare()).toMatchObject({ id: abandoned.id, state: 'failed', failureReason: 'preparation' });
  expect((await after.payment(abandoned.id)).state).toBe('failed');
  expect(fx.operations()).toEqual([]);
  const fresh = await after.prepare({ ...checkout, key: 'after-interrupted-prepare' });
  expect(fresh.state).toBe('ready');
  expect(fx.operations()).toEqual(['ready']);
});

test('a new request releases an unopened legacy review even without a saved payment ID in the browser', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const abandoned = reserveLegacy(fx.filename, owner.cookie, 'review');
  const db = new DatabaseSync(fx.filename);
  try {
    db.prepare('UPDATE payments SET tid = ? WHERE id = ?').run('unused-tid', abandoned.id);
  } finally {
    db.close();
  }
  const fresh = await owner.prepare({ ...checkout, key: 'fresh-cart-key' });
  expect(fresh.state).toBe('ready');
  expect(await owner.payment(abandoned.id)).toMatchObject({ state: 'failed', failureReason: 'preparation' });
  expect(fx.operations()).toEqual(['ready']);
});

test.each(['attempted', 'aid', 'mismatch', 'order'] as const)(
  'does not recover an otherwise unopened legacy record with evidence of %s',
  async evidence => {
    const fx = await fixture(true);
    const owner = await fx.browser();
    const row = reserveLegacy(fx.filename, owner.cookie, 'review');
    const db = new DatabaseSync(fx.filename);
    try {
      if (evidence === 'order') {
        db.prepare('INSERT INTO orders (id, paymentId, created) VALUES (?, ?, ?)').run(randomUUID(), row.id, row.created);
      } else {
        db.prepare('UPDATE payments SET ' + evidence + ' = ? WHERE id = ?').run(evidence === 'aid' ? 'known-aid' : 1, row.id);
      }
    } finally {
      db.close();
    }
    fx.scenario.clock += 30 * 60_000;
    expect((await owner.payment(row.id)).state).toBe('review');
    expect((await owner.api('/payments', { ...checkout, key: 'another-key' })).status).toBe(409);
    expect(fx.operations()).toEqual([]);
  },
);

test('recovers a lost approval response even after expiry and restart, without another approve', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  fx.scenario.approvalLost = fx.scenario.orderOffline = true;
  await owner.navigate(fx.returnPath());
  expect(fx.diagnostics).toEqual([
    { operation: 'approve', reason: 'network' },
    { operation: 'order', reason: 'http', status: 503 },
  ]);
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

test.each(['disk', 'sqlite'])('shows an interrupted return before approval claim (%s) and safely accepts a repeated callback', async failure => {
  const fx = await fixture(true, true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  const callback = fx.returnPath();
  const db = new DatabaseSync(fx.filename);
  try {
    if (failure === 'disk') fx.scenario.diskReady = false;
    else db.exec('BEGIN IMMEDIATE');
    const interrupted = await owner.navigate(callback);
    if (failure === 'sqlite') db.exec('ROLLBACK');
    fx.scenario.diskReady = true;
    expect(interrupted.headers.location).toBe('/checkout-unavailable?approval=interrupted');
    const page = await owner.navigate(interrupted.headers.location!);
    expect(page.status).toBe(503);
    expect(page.body).toContain('같은 결제의 결과를 다시 확인해 주세요');
    expect(page.body).not.toContain('mock-return-token');
    expect(page.body).toContain('href="/"');
    expect(db.prepare('SELECT attempted FROM payments WHERE id = ?').get(payment.id)?.attempted).toBe(0);
    expect(fx.operations()).toEqual(['ready']);
    expect((await owner.payment(payment.id)).state).toBe('ready');
    await Promise.all([owner.navigate(callback), owner.navigate(callback)]);
    const approved = await owner.payment(payment.id);
    expect((await owner.order(approved.orderId!)).number).toBe('A-0001');
    expect(fx.operations().filter(operation => operation === 'approve')).toHaveLength(1);
  } finally {
    db.close();
  }
}, 10_000);

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
  const path = 'link-web.state.v2';
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
  const save = (state: State) => data.set(path, JSON.stringify(snapshot(state)));
  save(begin);
  const reload = (active: boolean) => reduce(initial, {
    type: 'HYDRATE', snapshot: JSON.parse(data.get(path)!), stores, products, kakaoTest: active,
  });
  return { user, begin, fetcher, data, localOrder, reload, save, blockStorage: () => { writePayment = false; } };
}

test('rehydration automatically verifies an old unopenable checkout and keeps the cart and history for a new key', async () => {
  const fx = await fixture(true);
  const app = await frontend(fx);
  const payment = reserveLegacy(fx.filename, app.user.cookie, 'review');
  app.data.set('link-web.state.v2', JSON.stringify(snapshot({
    ...app.begin,
    settings: { ...settings, mode: 'server', serverUrl: 'https://legacy-server.test' },
    payment: { id: payment.id, provider: KAKAO_TEST_PROVIDER, state: 'review', snapshot: expected,
      connection: app.begin.request?.connection, checkoutAvailable: { pc: false, mobile: false } },
  })));
  await fx.restart();
  const rehydrated = app.reload(true);
  expect(rehydrated.flow).toBe('P02-V');
  const failed = reduce(rehydrated, (await advancePayment(rehydrated, () => true))!);
  expect(failed).toMatchObject({ flow: 'P02-F', payment: { id: payment.id, state: 'failed', failureReason: 'preparation' } });
  expect(app.fetcher.mock.calls.map(([url]) => url)).toEqual([KAKAO_TEST_ORIGIN + '/api/payments/' + payment.id]);
  expect(fx.operations()).toEqual([]);
  expect(reduce(failed, { type: 'RETRY_CHECKOUT', key: 'skip-cart' })).toBe(failed);
  const cart = reduce(failed, { type: 'RETRY_PAYMENT' });
  expect(cart).toMatchObject({ flow: 'V5-08', cart: lines, payment: undefined, request: undefined,
    history: { [store.id]: app.localOrder } });
  const retry = reduce(cart, { type: 'CHECKOUT', key: 'new-cart-key' });
  app.save(retry);
  const ready = reduce(retry, (await advancePayment(retry, () => true))!);
  expect(ready).toMatchObject({ flow: 'PAYMENT_EXTERNAL',
    request: { key: 'new-cart-key', connection: rehydrated.request?.connection } });
  expect(ready.payment?.id).not.toBe(payment.id);
});


test('recovers a lost cart-return response using the same ID and keeps cart, price, history and retry connection', async () => {
  const fx = await fixture(true);
  const app = await frontend(fx);
  const prepared = reduce(app.begin, (await advancePayment(app.begin, () => true))!);
  expect(prepared).toMatchObject({ flow: 'PAYMENT_EXTERNAL', payment: { cartReturnAvailable: true } });
  app.save(prepared);
  expect(app.reload(true).payment?.cartReturnAvailable).toBeUndefined();
  const transport = app.fetcher.getMockImplementation()!;
  app.fetcher.mockImplementation(async (url, init) => {
    const result = await transport(url, init);
    if (url.endsWith('/return-to-cart')) throw new Error('response lost after commit');
    return result;
  });
  app.fetcher.mockClear();
  const action = (await returnKakaoPaymentToCart(prepared, () => true))!;
  const cart = reduce(prepared, action);
  expect(cart).toMatchObject({ flow: 'V5-08', cart: lines, storeId: store.id,
    payment: undefined, request: undefined, history: { [store.id]: app.localOrder } });
  expect(catalogConnection(cart)).toEqual(prepared.payment!.connection);
  expect(app.fetcher.mock.calls.map(([url, init]) => [init.method, new URL(url).pathname])).toEqual([
    ['GET', '/api/config'],
    ['POST', '/api' + cartReturnPath(prepared.payment!.id)],
    ['GET', '/api/payments/' + prepared.payment!.id],
  ]);

  // A second tab or reload can recover even before the first tab persists its cart state.
  await fx.restart();
  const reload = app.reload(true);
  expect(reduce(reload, (await advancePayment(reload, () => true))!)).toMatchObject({
    flow: 'V5-08', cart: lines, payment: undefined, request: undefined, history: cart.history,
  });
  const retry = reduce(cart, { type: 'CHECKOUT', key: 'user-created-new-key' });
  expect(retry.request).toMatchObject({ key: 'user-created-new-key', expected, connection: prepared.payment?.connection });
  expect(reduce(retry, { ...action, revision: prepared.revision })).toBe(retry);
  await expect(returnKakaoPaymentToCart({ ...prepared, payment: undefined }, () => true)).resolves.toBeUndefined();
});

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
  app.save(ready);
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

test.each([{}, null, { approved_at: STAMP }])('recovers a verified order when the approval body is incomplete: %j', async body => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  fx.scenario.approveBody = () => Response.json(body);
  const payment = await owner.prepare();
  await owner.navigate(fx.returnPath());
  await fx.restart();
  const recovered = await owner.payment(payment.id);
  expect(recovered.state).toBe('approved');
  expect((await owner.order(recovered.orderId!)).number).toBe('A-0001');
  expect(fx.operations().filter(operation => operation === 'approve')).toHaveLength(1);
});

test.each(['READY', 'OPEN_PAYMENT', 'AUTH_PASSWORD', 'FAIL_AUTH_PASSWORD'])(
  'releases an unapproved expired checkout after the provider reports %s', async status => {
    const fx = await fixture(true);
    const owner = await fx.browser();
    const first = await owner.prepare();
    const callback = fx.returnPath();
    fx.gatewayTrade().status = status;
    fx.scenario.clock += 16 * 60_000;
    await fx.restart();
    expect((await owner.payment(first.id)).state).toBe('expired');
    const next = await owner.prepare({ ...checkout, key: 'after-expiry' });
    expect(next.state).toBe('ready');
    await owner.navigate(callback);
    expect(fx.operations().filter(operation => operation === 'approve')).toHaveLength(0);
  },
);

test.each([true, false])('pins a valid AID from an incomplete approval (matches order: %s)', async matches => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  fx.scenario.approveBody = body => Response.json({ aid: matches ? body.aid : 'AnotherAid' });
  const payment = await owner.prepare();
  await owner.navigate(fx.returnPath());
  await fx.restart();
  const checked = await owner.payment(payment.id);
  expect(checked.state).toBe(matches ? 'approved' : 'review');
  if (matches) expect((await owner.order(checked.orderId!)).number).toBe('A-0001');
  else expect((await owner.api('/payments', { ...checkout, key: 'new-key' })).status).toBe(409);
  expect(fx.operations().filter(entry => entry === 'approve')).toHaveLength(1);
});

test.each([
  { tid: 'unrelated-tid' },
  { amount: { total: 1 } },
  { quantity: '2' },
  { amount: [2_500] },
  { aid: 5 },
])('blocks a contradictory partial approval despite a matching lookup: %j', async partial => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  fx.scenario.approveBody = () => Response.json(partial);
  const payment = await owner.prepare();
  const callback = fx.returnPath();
  await owner.navigate(callback);
  await fx.restart();
  expect((await owner.payment(payment.id)).state).toBe('review');
  fx.gatewayTrade().status = 'FAIL_PAYMENT';
  expect((await owner.payment(payment.id)).state).toBe('review');
  expect((await owner.api('/payments', { ...checkout, key: 'after-mismatch' })).status).toBe(409);
  await owner.navigate(callback);
  expect(fx.operations().filter(entry => entry === 'approve')).toHaveLength(1);
  const db = new DatabaseSync(fx.filename, { readOnly: true });
  try {
    expect(db.prepare('SELECT mismatch FROM payments WHERE id = ?').get(payment.id)?.mismatch).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get()?.count).toBe(0);
  } finally {
    db.close();
  }
});

test('retains ambiguous legacy mismatch evidence even if the provider now reports success', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  fx.scenario.orderOffline = true;
  fx.scenario.approveBody = response => Response.json({ ...response, tid: 'unrelated-tid' });
  const payment = await owner.prepare();
  await owner.navigate(fx.returnPath());
  await fx.restart();
  fx.scenario.orderOffline = false;
  fx.scenario.clock += 24 * 60 * 60_000;
  expect((await owner.payment(payment.id)).state).toBe('review');
  expect((await owner.api('/payments', { ...checkout, key: 'new-key' })).status).toBe(409);
  const db = new DatabaseSync(fx.filename, { readOnly: true });
  try {
    expect(db.prepare('SELECT mismatch FROM payments WHERE id = ?').get(payment.id)?.mismatch).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get()?.count).toBe(0);
  } finally {
    db.close();
  }
});

test('an approval claimed just before the deadline cannot expire when concurrent returns cross it', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  const callback = fx.returnPath();
  fx.scenario.clock += 15 * 60_000 - 1;
  let release!: () => void;
  fx.scenario.waitApprove = new Promise<void>(resolve => { release = resolve; });
  const first = owner.navigate(callback);
  try {
    await vi.waitFor(() => expect(fx.operations()).toEqual(['ready', 'approve']));
    fx.scenario.clock += 11_000;
    const late = owner.navigate(callback);
    expect((await owner.api('/payments', { ...checkout, key: 'competing' })).status).toBe(409);
    release();
    await Promise.all([first, late]);
  } finally {
    release();
    await first;
  }
  await fx.restart();
  const approved = await owner.payment(payment.id);
  expect(approved.state).toBe('approved');
  expect((await owner.order(approved.orderId!)).number).toBe('A-0001');
  expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
});

test('simultaneous callbacks after 15 minutes cannot claim approval or reopen an expired payment', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  const callback = fx.returnPath();
  fx.gatewayTrade().status = 'AUTH_PASSWORD';
  fx.scenario.clock += 15 * 60_000 + 1;
  await Promise.all([owner.navigate(callback), owner.navigate(callback)]);
  expect((await owner.payment(payment.id)).state).toBe('review');
  fx.scenario.clock += 10_000;
  // The new-key route can reconcile a legacy pending row without a saved payment ID.
  const next = await owner.prepare({ ...checkout, key: 'new-after-window' });
  expect(next.state).toBe('ready');
  expect((await owner.payment(payment.id)).state).toBe('expired');
  await owner.navigate(callback);
  expect(fx.operations()).not.toContain('approve');
});

test('cannot release an expired checkout from an unavailable gateway lookup', async () => {
  const fx = await fixture(true);
  const owner = await fx.browser();
  const payment = await owner.prepare();
  fx.scenario.clock += 16 * 60_000;
  fx.scenario.orderOffline = true;
  expect((await owner.payment(payment.id)).state).toBe('review');
  expect((await owner.api('/payments', { ...checkout, key: 'keep-locked' })).status).toBe(409);
  fx.scenario.orderOffline = false;
  expect((await owner.payment(payment.id)).state).toBe('expired');
});

test.each(['cancelled', 'failed', 'expired'] as const)(
  'restored Kakao %s uses the original QA connection when retrying with legacy settings', async status => {
    const fx = await fixture();
    const app = await frontend(fx);
    const prepared = reduce(app.begin, (await advancePayment(app.begin, () => true))!);
    app.save({ ...prepared, settings: { ...settings, mode: 'server', serverUrl: 'https://legacy-server.test' } });
    const restored = app.reload(true);
    const ended = reduce(restored, { type: 'PAYMENT_RESULT', payment: { ...restored.payment!, state: status } });
    const connection = app.begin.request!.connection;
    if (status !== 'expired')
      expect(reduce(ended, { type: 'RETRY_CHECKOUT', key: 'direct-retry' }).request?.connection).toEqual(connection);
    const cart = reduce(ended, { type: 'RETRY_PAYMENT' });
    expect(reduce(cart, { type: 'CHECKOUT', key: 'cart-retry' }).request?.connection).toEqual(connection);
  },
);
