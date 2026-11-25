import { randomUUID } from 'node:crypto';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKakaoPayTestServer } from '../scripts/kakaopay-test';

const HOST = '127.0.0.1:3000';
const ORIGIN = `http://${HOST}`;
const CHECKOUT = 'https://online-payment.kakaopay.com/mockup/bridge/pc/test';
const TID = 'T1234567890123456789';
const AID = 'A1234567890123456789';
const APPROVED_AT = '2026-11-25T12:00:00';
const PG_TOKEN = 'test-callback-token';
const APPROVED_TEXT = '테스트 결제 승인 및 거래 조회를 확인했어요.';
const UNKNOWN_TEXT = '거래 결과를 아직 확인하지 못했어요.';

type Fields = Record<string, unknown>;
type Operation = 'ready' | 'approve' | 'order';
type ProviderReply = (body: Fields, signal: AbortSignal) => Response | Promise<Response>;
type Replies = Partial<Record<Operation, ProviderReply>>;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(replies: Replies = {}, timeoutMs?: number) {
  const calls: { operation: Operation; body: Fields }[] = [];
  const syntheticCredential = randomUUID();
  let prepared: Fields = {};
  function approval() {
    return {
      cid: 'TC0ONETIME', tid: TID, aid: AID,
      partner_order_id: prepared.partner_order_id, partner_user_id: prepared.partner_user_id,
      item_name: prepared.item_name, quantity: prepared.quantity,
      amount: { total: 2200 }, approved_at: APPROVED_AT,
    };
  }
  function order(status = 'SUCCESS_PAYMENT') {
    return {
      ...approval(), status,
      payment_action_details: [{ payment_action_type: 'PAYMENT', amount: 2200, aid: AID, approved_at: APPROVED_AT }],
    };
  }

  const transport: typeof fetch = async (url, init) => {
    const operation = String(url).split('/').at(-1) as Operation;
    expect(url).toBe(`https://open-api.kakaopay.com/online/v1/payment/${operation}`);
    expect(['ready', 'approve', 'order']).toContain(operation);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`SECRET_KEY ${syntheticCredential}`);
    const body = JSON.parse(String(init?.body)) as Fields;
    calls.push({ operation, body });
    if (operation === 'ready') prepared = body;
    const override = replies[operation];
    if (override) return override(body, init!.signal!);
    if (operation === 'ready') return Response.json({ tid: TID, next_redirect_pc_url: CHECKOUT });
    return Response.json(operation === 'approve' ? approval() : order());
  };
  const server = createKakaoPayTestServer({ devKey: syntheticCredential, transport, timeoutMs });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  const port = address.port;

  function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path, method: options.method,
        headers: { Host: HOST, ...options.headers }, agent: false,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(options.body);
    });
  }

  async function browser() {
    const home = await send('/');
    const cookie = home.headers['set-cookie']![0].split(';')[0];
    function submit(path: '/ready' | '/check', page: string, overrides?: Record<string, string>) {
      const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(page)?.[1] ?? '';
      return send(path, {
        method: 'POST',
        headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...overrides },
        body: new URLSearchParams({ csrf, cid: 'ignored', total_amount: '999999' }).toString(),
      });
    }
    function callbackPath(kind: 'approval' | 'cancel' | 'fail' = 'approval') {
      const callback = new URL(String(prepared[`${kind}_url`]));
      if (kind === 'approval') callback.searchParams.set('pg_token', PG_TOKEN);
      return callback.pathname + callback.search;
    }
    function returnFromProvider(kind?: 'approval' | 'cancel' | 'fail') {
      return send(callbackPath(kind), { headers: { Cookie: cookie } });
    }
    const result = () => send('/result', { headers: { Cookie: cookie } });
    return { cookie, home, submit, result, returnFromProvider, callbackPath, start: () => submit('/ready', home.body) };
  }
  return { server, browser, send, approval, order, calls, syntheticCredential, operations: () => calls.map(call => call.operation) };
}

describe('local KakaoPay test payment', () => {
  it('uses a fixed test CID and amount, follows the PC link, then approves and verifies the same trade', async () => {
    const fx = await fixture();
    const client = await fx.browser();
    expect(client.home.headers['set-cookie']![0]).toContain('HttpOnly; SameSite=Lax');
    expect(client.home.body).toContain('실제 금액은 청구되지 않아요');
    expect((await client.start()).status).toBe(204);
    const ready = fx.calls[0].body;
    expect(ready).toMatchObject({
      cid: 'TC0ONETIME', quantity: 1, total_amount: 2200, tax_free_amount: 0,
      item_name: 'LINK 카카오페이 테스트',
    });
    expect(ready.approval_url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/return\/success\/[a-f0-9]{64}$/);
    expect((await client.result()).body).toContain(`href="${CHECKOUT}" rel="noreferrer"`);
    const returned = await client.returnFromProvider();
    expect(returned.status).toBe(303);
    expect(returned.headers.location).toBe('/result');
    expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
    expect(fx.calls[1].body).toEqual({
      cid: 'TC0ONETIME', tid: TID, partner_order_id: ready.partner_order_id,
      partner_user_id: ready.partner_user_id, pg_token: PG_TOKEN,
    });
    expect(fx.calls[2].body).toEqual({ cid: 'TC0ONETIME', tid: TID });
    expect((await client.result()).body).toContain(APPROVED_TEXT);
    expect((await client.returnFromProvider()).headers.location).toBe('/result');
    expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
  });

  it.each([
    ['cancel', 'QUIT_PAYMENT', '결제 취소를 확인했어요.'],
    ['fail', 'FAIL_PAYMENT', '결제 실패를 확인했어요.'],
  ] as const)('only marks a %s callback terminal after a verified order lookup', async (kind, status, message) => {
    let remoteStatus = 'READY';
    const fx = await fixture({ order: () => Response.json(fx.order(remoteStatus)) });
    const client = await fx.browser();
    await client.start();
    expect((await client.returnFromProvider(kind)).headers.location).toBe('/result');
    const pending = await client.result();
    expect(pending.body).toContain(UNKNOWN_TEXT);
    expect(pending.body).not.toContain(message);
    remoteStatus = status;
    await client.submit('/check', pending.body);
    expect((await client.result()).body).toContain(message);
    expect(fx.operations()).toEqual(['ready', 'order', 'order']);
  });

  it('rejects forged, ownerless, pre-restart and mismatched-TID callbacks before contacting the provider', async () => {
    const fx = await fixture();
    const client = await fx.browser();
    await client.start();
    const path = client.callbackPath();
    const forged = path.replace(/success\/[a-f0-9]{64}/, `success/${'0'.repeat(64)}`);
    for (const invalid of [forged, `${path}&tid=other-tid`, `${path}&pg_token=duplicate`, path.split('?')[0]]) {
      const response = await fx.send(invalid, { headers: { Cookie: client.cookie } });
      expect(response.status).toBe(303);
      expect(response.headers.location).toBe('/invalid-return');
    }
    expect((await fx.send(path)).headers.location).toBe('/invalid-return');
    const restarted = await fixture();
    expect((await restarted.send(path, { headers: { Cookie: client.cookie } })).headers.location).toBe('/invalid-return');
    expect(restarted.calls).toHaveLength(0);
    expect(fx.operations()).toEqual(['ready']);
    expect((await client.result()).body).toContain(CHECKOUT);
  });

  it.each([
    ['wrong provider CID', { cid: 'other-cid' }],
    ['wrong provider TID', { tid: 'other-tid' }],
    ['wrong merchant order', { partner_order_id: 'other-order' }],
    ['wrong merchant user', { partner_user_id: 'other-user' }],
    ['wrong total', { amount: { total: 1100 } }],
    ['missing completed payment action', { payment_action_details: [] }],
    ['different approval ID', { payment_action_details: [{ payment_action_type: 'PAYMENT', amount: 2200, aid: 'other-aid' }] }],
  ])('does not certify a payment when the order lookup returns %s', async (_label, fields) => {
    const fx = await fixture({ order: () => Response.json({ ...fx.order(), ...fields }) });
    const client = await fx.browser();
    await client.start();
    await client.returnFromProvider();
    expect((await client.result()).body).toContain(UNKNOWN_TEXT);
    expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
  });

  it('blocks a mismatched approval amount even when the search response looks successful', async () => {
    const fx = await fixture({
      approve: () => Response.json({ ...fx.approval(), amount: { total: 3300 } }),
    });
    const client = await fx.browser();
    await client.start();
    await client.returnFromProvider();
    expect((await client.result()).body).toContain(UNKNOWN_TEXT);
  });

  it('does not treat an authenticated but unapproved trade as a success', async () => {
    const fx = await fixture({ order: () => Response.json(fx.order('AUTH_PASSWORD')) });
    const client = await fx.browser();
    await client.start();
    await client.returnFromProvider();
    expect((await client.result()).body).toContain(UNKNOWN_TEXT);
    expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
  });

  it('does not approve an order that reports success before a valid approval attempt', async () => {
    const fx = await fixture();
    const client = await fx.browser();
    await client.start();
    await client.returnFromProvider('cancel');
    const page = await client.result();
    expect(page.body).toContain(UNKNOWN_TEXT);
    expect(fx.operations()).toEqual(['ready', 'order']);
  });

  it('locks concurrent preparation across browsers and approves concurrent returns once', async () => {
    const preparing = deferred();
    const prepareResponse = deferred();
    const approving = deferred();
    const approveResponse = deferred();
    const fx = await fixture({
      ready: async () => {
        preparing.resolve();
        await prepareResponse.promise;
        return Response.json({ tid: TID, next_redirect_pc_url: CHECKOUT });
      },
      approve: async () => {
        approving.resolve();
        await approveResponse.promise;
        return Response.json(fx.approval());
      },
    });
    const client = await fx.browser();
    const other = await fx.browser();
    const first = client.start();
    await preparing.promise;
    try {
      expect((await client.start()).status).toBe(403);
      expect((await other.start()).status).toBe(403);
      expect((await other.result()).body).toContain('다른 브라우저');
    } finally {
      prepareResponse.resolve();
    }
    await first;
    const firstReturn = client.returnFromProvider();
    await approving.promise;
    const secondReturn = client.returnFromProvider();
    approveResponse.resolve();
    await Promise.all([firstReturn, secondReturn]);
    expect(fx.operations()).toEqual(['ready', 'approve', 'order']);
    expect((await client.result()).body).toContain(APPROVED_TEXT);
    expect((await client.start()).status).toBe(403);
  });

  it('allows an explicit new test only after a verified outcome and invalidates old return URLs', async () => {
    const fx = await fixture();
    const client = await fx.browser();
    await client.start();
    const oldPath = client.callbackPath();
    const firstOrder = fx.calls[0].body.partner_order_id;
    await client.returnFromProvider();
    const finished = await client.result();
    expect(finished.body).toContain(APPROVED_TEXT);

    expect((await client.submit('/ready', finished.body)).status).toBe(204);
    expect(fx.calls[3].body.partner_order_id).not.toBe(firstOrder);
    expect(client.callbackPath()).not.toBe(oldPath);
    expect((await fx.send(oldPath, { headers: { Cookie: client.cookie } })).headers.location).toBe('/invalid-return');
    expect(fx.operations()).toEqual(['ready', 'approve', 'order', 'ready']);
  });

  it('does not lose a valid success callback during a manual order lookup', async () => {
    const checking = deferred();
    const orderResponse = deferred();
    const fx = await fixture({
      order: async () => {
        if (!fx.operations().includes('approve')) {
          checking.resolve();
          await orderResponse.promise;
          return Response.json(fx.order('AUTH_PASSWORD'));
        }
        return Response.json(fx.order());
      },
    });
    const client = await fx.browser();
    await client.start();
    const lookup = client.submit('/check', (await client.result()).body);
    await checking.promise;
    const callback = client.returnFromProvider();
    orderResponse.resolve();
    await Promise.all([lookup, callback]);
    expect(fx.operations()).toEqual(['ready', 'order', 'approve', 'order']);
    expect((await client.result()).body).toContain(APPROVED_TEXT);
  });

  it('refuses to approve through an expired return URL', async () => {
    const fx = await fixture({ order: () => Response.json(fx.order('READY')) });
    const client = await fx.browser();
    await client.start();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect((await client.result()).body).not.toContain(CHECKOUT);
    await client.returnFromProvider();
    expect(fx.operations()).toEqual(['ready', 'order']);
    expect((await client.result()).body).toContain(UNKNOWN_TEXT);
  });

  it('blocks a new payment when the ready response is lost or times out without a TID', async () => {
    const ready = vi.fn((_body: Fields, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const fx = await fixture({ ready }, 10);
    const client = await fx.browser();
    await client.start();
    const unknown = await client.result();
    expect(unknown.body).toContain('새 결제는 차단됐어요.');
    expect(unknown.body).not.toContain('/check');
    expect((await client.start()).status).toBe(403);
    const other = await fx.browser();
    expect((await other.start()).status).toBe(403);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][1].aborted).toBe(true);
  });

  it('checks the original TID after an approval response is lost and offers only a safe inquiry', async () => {
    let inquiryAvailable = false;
    const fx = await fixture({
      approve: () => { throw new TypeError('connection lost after approval'); },
      order: () => inquiryAvailable ? Response.json(fx.order()) : Response.error(),
    });
    const client = await fx.browser();
    await client.start();
    await client.returnFromProvider();
    const unknown = await client.result();
    expect(unknown.body).toContain(UNKNOWN_TEXT);
    expect(unknown.body).not.toContain('테스트 결제 준비');
    inquiryAvailable = true;
    await client.submit('/check', unknown.body);
    expect((await client.result()).body).toContain(APPROVED_TEXT);
    expect(fx.operations()).toEqual(['ready', 'approve', 'order', 'order']);
    expect(fx.calls.slice(1).every(call => call.body.tid === TID)).toBe(true);
  });

  it.each([
    'http://online-payment.kakaopay.com/mockup',
    'https://online-payment.kakaopay.com.attacker.invalid/test',
    'https://user@online-payment.kakaopay.com/mockup',
    'https://online-payment.kakaopay.com:8443/mockup',
  ])('refuses an untrusted PC checkout URL before any browser redirect', async untrusted => {
    const fx = await fixture({ ready: () => Response.json({ tid: TID, next_redirect_pc_url: untrusted }) });
    const client = await fx.browser();
    await client.start();
    const page = await client.result();
    expect(page.body).toContain('같은 거래 다시 조회');
    expect(page.body).not.toContain(untrusted);
    await client.returnFromProvider();
    expect(fx.operations()).toEqual(['ready', 'order']);
  });

  it('rejects invalid Host, Origin and CSRF without a provider request', async () => {
    const fx = await fixture();
    const client = await fx.browser();
    expect((await fx.send('/', { headers: { Host: 'attacker.invalid:3000' } })).status).toBe(403);
    for (const origin of ['', 'null', 'https://attacker.invalid', 'http://localhost:3000']) {
      expect((await client.submit('/ready', client.home.body, { Origin: origin })).status).toBe(403);
    }
    expect((await client.submit('/ready', 'wrong csrf')).status).toBe(403);
    expect((await client.submit('/ready', client.home.body, { Cookie: '' })).status).toBe(403);
    expect(fx.calls).toHaveLength(0);
    expect((await client.start()).status).toBe(204);
  });

  it('uses clean redirects and never reflects provider errors, authorization, or callback parameters', async () => {
    const rawProviderError = 'sensitive-provider-error';
    const fx = await fixture({
      approve: () => new Response(rawProviderError, { status: 500 }),
      order: () => new Response(rawProviderError, { status: 500 }),
    });
    const client = await fx.browser();
    await client.start();
    const callback = await client.returnFromProvider();
    expect(callback.headers.location).toBe('/result');
    const page = await client.result();
    expect(page.body).toContain(UNKNOWN_TEXT);
    for (const response of [callback, page]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      const output = JSON.stringify(response);
      for (const secret of [fx.syntheticCredential, 'SECRET_KEY', rawProviderError, PG_TOKEN, client.callbackPath()]) {
        expect(output).not.toContain(secret);
      }
    }
  });
});
