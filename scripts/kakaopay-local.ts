import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quote, sameQuote, status } from '../src/core/domain.ts';
import { isLine, isRecord, isRequest } from '../src/core/savedData.ts';
import { KAKAO_TEST_ORIGIN, KAKAO_TEST_PROVIDER, type Order, type Payment, type Product, type Quote, type Store } from '../src/core/types.ts';
import { paymentChannel } from '../src/native/paymentChannel.ts';
import catalog from '../src/data/catalog.json' with { type: 'json' };
import { PaymentDatabase, type DatabasePayment } from './kakaopay-db.ts';
import { assertQaNode, qaSettings, verifyQaDisk } from './qa-config.ts';
import { qaAccess } from './qa-access.ts';
import { createKakaoPayClient, kakaoRedirect, kakaoReturn, loadDevKey, localAppData, outsideRepo, READY_EXPIRY_GRACE_MS, READY_WINDOW_MS, type KakaoOptions } from './kakaopay-provider.ts';

const COOKIE = 'link_kakaopay_session';
const ID = /^[a-f0-9]{64}$/;
const stores = catalog.stores as Store[];
const menu = catalog.menu as Product[];
const types: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function json(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

function error(res: ServerResponse, statusCode: number, message: string, code?: string) {
  json(res, statusCode, { error: message, code });
}

function html(res: ServerResponse, statusCode: number, page: string) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }).end(page);
}

function resultPage(res: ServerResponse, valid: boolean) {
  const title = valid ? '카카오페이 결제에서 돌아왔어요' : '카카오페이 결제창을 열 수 없어요';
  html(res, valid ? 200 : 404, `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><main><h1>${title}</h1>
<p>주문하던 브라우저 탭으로 돌아가 주세요. LINK가 그 탭에서 결제 결과를 확인해요.</p></main></html>`);
}

function accessPage(res: ServerResponse, status = 200) {
  // An ordinary same-origin form POST includes an Origin header with this policy.
  res.setHeader('Referrer-Policy', 'same-origin');
  return html(res, status, `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LINK QA 접속</title>
<style>body{font:1.125rem/1.6 system-ui,sans-serif;margin:1rem}main{max-width:34rem;margin:2rem auto}
label,input,button{display:block}input,button{font:inherit;min-height:2.75rem;margin-block:.5rem}
input{max-width:100%;box-sizing:border-box}:focus-visible{outline:3px solid currentColor;outline-offset:4px}</style>
<main><h1>LINK QA 접속</h1>
<p>테스트를 시작하려면 전달받은 QA 접속 키를 입력해 주세요.</p>
${status === 200 ? '' : '<p role="alert">접속 키를 확인한 뒤 다시 시도해 주세요.</p>'}
<form method="post" action="/qa-access">
<label for="key">QA 접속 키</label>
<input id="key" name="key" type="password" maxlength="128" required>
<button type="submit">QA 시작하기</button>
</form></main></html>`);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location }).end();
}

const interruptedApproval = '/checkout-unavailable?approval=interrupted';

class ApprovalStartUnavailable extends Error {}

function approvalRecoveryPage(res: ServerResponse) {
  const title = '결제 처리를 이어가지 못했어요';
  return html(res, 503, `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><main><h1>${title}</h1>
<p>주문하던 탭에서 같은 결제의 결과를 다시 확인해 주세요. ‘기존 결제 이어하기’가 보이면 같은 결제창을 다시 열 수 있어요.</p>
<a href="/">LINK 주문 화면 열기</a></main></html>`);
}

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage, type: string, max: number) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== type)
    throw new RequestError(415, '요청 형식을 확인해 주세요.');
  if (Number(req.headers['content-length']) > max)
    throw new RequestError(413, '요청 크기가 너무 커요.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > max) throw new RequestError(413, '요청 크기가 너무 커요.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readInput(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, 'application/json', 32 * 1024);
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestError(400, '요청 내용을 확인해 주세요.');
  }
}

function catalogQuote(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > 30 ||
      !body.items.every(isLine) || new Set(body.items.map(line => line.id)).size !== body.items.length)
    throw new Error('담은 메뉴와 수량을 확인해 주세요.');
  const priced = quote(stores.find(store => store.id === body.storeId), menu, body.items);
  if (!Number.isSafeInteger(priced.total) || priced.total < 1 || priced.total > 1_000_000 ||
      priced.items.some(item => !Number.isSafeInteger(item.unitPrice) || item.unitPrice < 1))
    throw new Error('주문 금액 범위를 확인해 주세요.');
  return priced;
}

export function createKakaoPayLocalServer({
  database, distDir, qa, now = Date.now, ...options
}: KakaoOptions & {
  database: PaymentDatabase; distDir?: string; now?: () => number;
  qa?: { origin: string; upstream: string; accessKey: string; publicAccess: boolean; checkDisk: () => void };
}) {
  const origin = qa?.origin ?? KAKAO_TEST_ORIGIN;
  const hosts = new Set([new URL(origin).host, ...(qa ? [new URL(qa.upstream).host] : [])]);
  const publicAccess = qa?.publicAccess === true;
  const gate = qa && !publicAccess ? qaAccess(qa.accessKey, now) : undefined;
  const sessionCookie = qa ? '__Host-link_kakaopay_session' : COOKIE;
  const provider = createKakaoPayClient(options);
  const checks = new Map<string, Promise<void>>();
  const preparing = new Set<string>();
  const appPage = distDir
    ? readFileSync(join(distDir, 'index.html'), 'utf8').replace('<head>', '<head><meta name="link-kakaopay-test" content="enabled">')
    : undefined;
  let windowStart = now();
  const counts = new Map<string, number>();
  const gatewayActive = { ready: 0, approve: 0, inquiry: 0 };
  function limited(bucket = 'request', max = qa ? 600 : 180) {
    if (now() - windowStart >= 60_000) {
      windowStart = now();
      counts.clear();
    }
    const count = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, count);
    return count > max;
  }

  function gatewaySlot(lane: keyof typeof gatewayActive, owner: string) {
    if (!qa) return () => {};
    const max = lane === 'ready' ? 2 : 4;
    if (gatewayActive[lane] >= max || limited(lane, lane === 'inquiry' ? 180 : 45) ||
        limited(lane + ':' + owner, lane === 'inquiry' ? 30 : 8))
      throw new RequestError(429, '결제 확인 요청이 많아요. 잠시 뒤 같은 거래를 확인해 주세요.');
    gatewayActive[lane]++;
    return () => { gatewayActive[lane]--; };
  }

  function recoverUnopened(tx: DatabasePayment): DatabasePayment {
    // The ready reservation and this process's in-flight marker are installed before any await.
    if (!preparing.has(tx.id) && ['preparing', 'review'].includes(tx.state) && database.failUnopened(tx.owner, tx.id))
      return { ...tx, state: 'failed' };
    return tx;
  }

  function view(tx: DatabasePayment): Payment {
    const state = tx.state === 'preparing' || (tx.state === 'ready' && now() - tx.created >= READY_WINDOW_MS)
      ? 'review' : tx.state;
    const preparationFailed = state === 'failed' && tx.attempted === 0 && tx.aid === null &&
      tx.mismatch === 0 && !tx.orderId && (tx.tid === null || (tx.pc === null && tx.mobile === null));
    return {
      id: tx.id, state, provider: KAKAO_TEST_PROVIDER, snapshot: JSON.parse(tx.snapshot) as Quote,
      ...(preparationFailed ? { failureReason: 'preparation' as const } : {}),
      created: tx.created, orderId: tx.orderId ?? undefined,
      redirect: state === 'ready' ? `${origin}/checkout/${tx.id}` : undefined,
      checkoutAvailable: { pc: !!kakaoRedirect(tx.pc), mobile: !!kakaoRedirect(tx.mobile) },
    };
  }

  function trade(tx: DatabasePayment) {
    const snapshot = JSON.parse(tx.snapshot) as Quote;
    return { orderId: tx.id, userId: tx.userId, item: tx.item, total: snapshot.total, quantity: snapshot.quantity };
  }

  async function verify(tx: DatabasePayment, pgToken?: string) {
    if (!tx.tid || !['ready', 'approving', 'review'].includes(tx.state)) return;
    const known = { ...trade(tx), tid: tx.tid };
    if (pgToken && !tx.attempted && now() - tx.created < READY_WINDOW_MS) {
      let release: (() => void) | undefined;
      let claimed: boolean;
      try {
        qa?.checkDisk();
        release = gatewaySlot('approve', tx.owner);
        claimed = database.claimApproval(tx.id, now);
      } catch {
        release?.();
        throw new ApprovalStartUnavailable();
      }
      try {
        if (claimed) {
          const result = await provider.approve(known, pgToken);
          database.storeApproval(tx.id, ('aid' in result ? result.aid : undefined) ?? null, result.kind === 'mismatch');
        }
      } finally {
        release();
      }
    }
    const saved = database.byId(tx.owner, tx.id);
    if (!saved || !['ready', 'approving', 'review'].includes(saved.state)) return;
    const release = gatewaySlot('inquiry', tx.owner);
    const outcome = await provider.order(known, saved.aid ?? undefined).finally(release);
    if (outcome === 'approved' && saved.attempted && !saved.mismatch) {
      // If the write fails, the original TID and approval claim remain available for the next lookup.
      database.finish(tx.owner, tx.id, now());
    } else if (outcome === 'cancelled' || outcome === 'failed') {
      database.setOutcome(tx.id, outcome);
    } else {
      const unapproved = outcome === 'ready' || outcome === 'pending' || outcome === 'auth-failed';
      const checkedAt = now();
      if (unapproved && checkedAt - saved.created >= READY_WINDOW_MS + READY_EXPIRY_GRACE_MS &&
          database.expireUnapproved(saved.id, known.tid, checkedAt)) return;
      const canResume = (outcome === 'ready' || outcome === 'pending') && !!(saved.pc || saved.mobile) &&
        !saved.attempted && now() - saved.created < READY_WINDOW_MS && !pgToken;
      database.setOutcome(tx.id, canResume ? 'ready' : 'review');
    }
  }

  async function refresh(tx: DatabasePayment, pgToken?: string): Promise<void> {
    const pending = checks.get(tx.id);
    if (pending) {
      if (!pgToken) return pending;
      // A failed inquiry must not discard a concurrently arriving approval token.
      await pending.catch(() => {});
      const saved = database.byId(tx.owner, tx.id);
      if (saved && !saved.attempted) await refresh(saved, pgToken);
      return;
    }
    const next = verify(tx, pgToken);
    checks.set(tx.id, next);
    try {
      await next;
    } finally {
      checks.delete(tx.id);
    }
  }

  async function prepare(res: ServerResponse, owner: string, body: unknown) {
    if (!isRequest(body) || !/^[A-Za-z0-9_-]{1,100}$/.test(body.key)) {
      error(res, 400, '주문 내용과 결제 요청을 확인해 주세요.');
      return;
    }
    const previous = database.byKey(owner, body.key);
    if (previous) {
      const receipt = view(previous);
      if (!sameQuote(receipt.snapshot, body.expected)) {
        error(res, 409, '기존 결제 금액과 주문 내용을 확인해 주세요.');
        return;
      }
      json(res, 200, view(recoverUnopened(previous)));
      return;
    }

    let priced: Quote;
    try {
      priced = catalogQuote(body);
    } catch (e) {
      error(res, 409, e instanceof Error ? e.message : '메뉴를 다시 확인해 주세요.', 'PRICE_CHANGED');
      return;
    }
    if (priced.total <= 0 || !sameQuote(priced, body.expected)) {
      error(res, 409, '주문 내용과 금액이 바뀌었어요.', 'PRICE_CHANGED');
      return;
    }
    const item = priced.items[0].name + (priced.items.length > 1 ? ` 외 ${priced.items.length - 1}종` : '');
    qa?.checkDisk();
    const pending = database.pending(owner);
    if (pending && recoverUnopened(pending).state !== 'failed' &&
        now() - pending.created >= READY_WINDOW_MS + READY_EXPIRY_GRACE_MS && !pending.attempted)
      await refresh(pending);
    if (database.pending(owner)) {
      error(res, 409, '이전에 시작한 결제 결과를 먼저 확인해 주세요.');
      return;
    }
    const release = gatewaySlot('ready', owner);
    try {
      const tx = database.reserve(owner, body.key, priced, item, now());
      if (!tx) {
        const repeated = database.byKey(owner, body.key);
        if (repeated && sameQuote(view(repeated).snapshot, priced)) json(res, 200, view(repeated));
        else error(res, 409, '이전에 시작한 결제 결과를 먼저 확인해 주세요.');
        return;
      }
      preparing.add(tx.id);
      try {
        // The TID and usable URL reach durable storage before the checkout link is exposed.
        const result = await provider.ready(trade(tx), origin, tx.callbackId);
        database.storeReady(tx.id, result, now());
        json(res, 200, view(database.byId(owner, tx.id)!));
      } finally {
        preparing.delete(tx.id);
      }
    } finally {
      release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headersDistinct.host?.length !== 1 || !hosts.has(req.headers.host ?? '')) return res.writeHead(403).end();
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return res.writeHead(400).end();
    const url = new URL(req.url, origin);
    const path = url.pathname;
    const cookies = req.headers.cookie ?? '';
    const sessionId = new RegExp(`(?:^|;\\s*)${sessionCookie}=([a-f0-9]{64})(?:;|$)`).exec(cookies)?.[1];
    const allowed = !gate || gate.allows(cookies);

    if (req.method === 'GET' && path === '/healthz') {
      try {
        qa?.checkDisk();
        database.check();
        return res.writeHead(200).end('ok');
      } catch {
        return res.writeHead(503).end('unavailable');
      }
    }

    if (publicAccess && path === '/qa-access') {
      if (req.method === 'GET' || req.method === 'POST') return redirect(res, origin + '/');
      return res.writeHead(405, { Allow: 'GET, POST' }).end();
    }

    if (gate && path === '/qa-access') {
      if (req.method === 'GET') {
        if (allowed) return redirect(res, '/');
        return accessPage(res);
      }
      if (req.method !== 'POST') return res.writeHead(405, { Allow: 'GET, POST' }).end();
      if (req.headers.origin !== origin ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
        return res.writeHead(403).end();
      const form = new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded', 1024));
      const keys = form.getAll('key');
      if (keys.length !== 1 || !gate.accepts(keys[0])) {
        return accessPage(res, limited('invalid-access', 30) ? 429 : 401);
      }
      res.setHeader('Set-Cookie', gate.create());
      return redirect(res, '/');
    }

    if (req.method === 'GET' && path.startsWith('/return/')) {
      // Coarse cap also bounds invalid lookups. Reserve settlement capacity for verified returns.
      if (limited('callback-entry', qa ? 3000 : 180)) return redirect(res, '/checkout-unavailable');
      const callback = kakaoReturn(url);
      // The random callback ID authenticates the provider return. Only the session unlocks the LINK app.
      const tx = callback ? database.byReturn(callback.id) : undefined;
      if (!tx?.tid || !callback || (callback.tid !== undefined && callback.tid !== tx.tid))
        return redirect(res, '/checkout-unavailable');
      try {
        await refresh(tx, callback.pgToken);
      } catch (failure) {
        if (failure instanceof ApprovalStartUnavailable) return redirect(res, interruptedApproval);
        // The claim may already be durable. The original tab can check the same transaction.
      }
      return redirect(res, sessionId === tx.owner ? '/' : '/payment-return');
    }

    if (req.method === 'GET' && (path === '/payment-return' || path === '/checkout-unavailable')) {
      if (path === '/checkout-unavailable' && url.searchParams.get('approval') === 'interrupted')
        return approvalRecoveryPage(res);
      return resultPage(res, path === '/payment-return');
    }

    if (req.method === 'GET' && path.startsWith('/checkout/')) {
      if (!allowed) return redirect(res, '/qa-access');
      if (!publicAccess && limited()) return resultPage(res, false);
      const id = path.slice('/checkout/'.length);
      const tx = sessionId && ID.test(id) ? database.byId(sessionId, id) : undefined;
      if (!tx || (publicAccess && (limited('session:' + tx.owner, 120) || limited())))
        return resultPage(res, false);
      if (tx.state !== 'ready' || now() - tx.created >= READY_WINDOW_MS) return redirect(res, '/');
      if (!tx.tid) return resultPage(res, false);
      const detected = paymentChannel({
        userAgent: req.headers['user-agent'],
        userAgentData: { mobile: req.headers['sec-ch-ua-mobile'] === '?1' },
      });
      const specified = url.searchParams.get('channel');
      const channel = specified === 'pc' || specified === 'mobile' ? specified : detected;
      const link = kakaoRedirect(tx[channel]);
      if (link) return redirect(res, link);
      return html(res, 409, `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>결제창을 열 수 없어요</title><main><h1>이 기기에서 결제창을 열 수 없어요</h1>
<p>카카오페이 결제 결과를 확인할 수 있도록 주문 화면으로 돌아가 주세요.</p>
<a href="/">LINK 주문 화면으로 돌아가기</a></main></html>`);
    }

    if (path.startsWith('/api/')) {
      // Reject cross-origin fetches as well as form submissions. Writes require a per-session token.
      if (req.headers['x-link-kakao-test'] !== '1' ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
          (req.headers.origin !== undefined && req.headers.origin !== origin))
        return error(res, 403, 'LINK 테스트 화면에서 다시 시도해 주세요.');
      if (!allowed) return error(res, 401, 'QA 접속 키를 확인해 주세요.');
      const config = req.method === 'GET' && path === '/api/config';
      if (!publicAccess && limited()) return error(res, 429, '요청이 많아요. 잠시 뒤 다시 확인해 주세요.');
      const session = sessionId ? database.session(sessionId) : undefined;
      if (qa && session && limited('session:' + session.id, 120))
        return error(res, 429, '요청이 많아요. 잠시 뒤 다시 확인해 주세요.');
      // Rejected public bootstraps and unknown sessions must not spend the existing session request budget.
      if (publicAccess && (session || config) && ((!session && limited('public-session', 30)) || limited()))
        return error(res, 429, '요청이 많아요. 잠시 뒤 다시 확인해 주세요.');
      if (config) {
        if (publicAccess && !session) qa?.checkDisk();
        const owner = session ?? database.newSession();
        if (!session)
          res.setHeader('Set-Cookie', `${sessionCookie}=${owner.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${qa ? '; Secure' : ''}`);
        return json(res, 200, { kakaopayTest: true, csrf: owner.csrf });
      }
      if (!session) return error(res, 404, '이 브라우저의 거래 정보를 확인할 수 없어요.');
      if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-link-csrf'] !== session.csrf))
        return error(res, 403, 'LINK 테스트 화면에서 다시 시도해 주세요.');
      if (req.method === 'GET' && path === '/api/stores') return json(res, 200, { stores });
      const menuPath = /^\/api\/stores\/([^/]+)\/menu$/.exec(path);
      if (req.method === 'GET' && menuPath) {
        if (!stores.find(store => encodeURIComponent(store.id) === menuPath[1])?.open)
          return error(res, 409, '지금은 이 매장에서 주문할 수 없어요.');
        return json(res, 200, { menu });
      }
      if (req.method === 'POST' && path === '/api/quote') {
        const body = await readInput(req);
        try {
          return json(res, 200, catalogQuote(body));
        } catch (e) {
          return error(res, 409, e instanceof Error ? e.message : '메뉴를 확인해 주세요.');
        }
      }
      if (req.method === 'POST' && path === '/api/payments') return prepare(res, session.id, await readInput(req));
      const paymentPath = /^\/api\/payments\/([a-f0-9]{64})$/.exec(path);
      if (req.method === 'GET' && paymentPath) {
        const tx = database.byId(session.id, paymentPath[1]);
        if (!tx) return error(res, 404, '결제 정보를 찾을 수 없어요.');
        const recovered = recoverUnopened(tx);
        if (recovered.state === 'failed') return json(res, 200, view(recovered));
        await refresh(recovered);
        return json(res, 200, view(database.byId(session.id, tx.id)!));
      }
      const orderPath = /^\/api\/orders\/([a-f0-9]{64})$/.exec(path);
      if (req.method === 'GET' && orderPath) {
        const row = database.order(session.id, orderPath[1]);
        if (!row) return error(res, 404, '주문 정보를 찾을 수 없어요.');
        const order: Order = {
          id: row.id, paymentId: row.paymentId, number: `A-${String(row.sequence).padStart(4, '0')}`,
          created: row.created, snapshot: JSON.parse(row.snapshot) as Quote, status: status(row.created, now()), demo: true,
        };
        return json(res, 200, order);
      }
      return error(res, 404, '요청한 기능을 찾을 수 없어요.');
    }

    if (req.method === 'GET' && appPage && (path === '/' || path === '/index.html')) return html(res, 200, appPage);
    if (req.method === 'GET' && distDir && /^\/(?:assets\/)?[\w.-]+$/.test(path) && Object.hasOwn(types, extname(path))) {
      const asset = await readFile(join(distDir, path.slice(1))).catch(() => undefined);
      if (asset) return res.writeHead(200, { 'Content-Type': types[extname(path)] }).end(asset);
    }
    return res.writeHead(404).end();
  }

  return createServer({ requestTimeout: 25_000 }, (req, res) => {
    void handle(req, res).catch(failure => {
      if (!res.headersSent) {
        if (req.url?.startsWith('/return/')) redirect(res, '/checkout-unavailable');
        else if (failure instanceof RequestError) error(res, failure.status, failure.message);
        else error(res, 503, '거래 결과를 확인할 수 없어요. 같은 결제의 결과를 다시 확인해 주세요.');
      } else if (!res.writableEnded) res.end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let database: PaymentDatabase | undefined;
  const closeDatabase = () => {
    const connection = database;
    database = undefined;
    connection?.close();
  };
  const hosted = process.argv[2] === '--qa';
  const report: KakaoOptions['report'] = diagnostic => console.warn('[KakaoPay] ' + JSON.stringify(diagnostic));
  try {
    let server;
    let port = 3000;
    let bind = '127.0.0.1';
    if (hosted) {
      assertQaNode();
      const { databasePath, devKey, ...settings } = qaSettings(process.env);
      const checkDisk = () => verifyQaDisk(databasePath);
      checkDisk();
      database = new PaymentDatabase(databasePath);
      database.check();
      server = createKakaoPayLocalServer({ database, devKey, report, qa: { ...settings, checkDisk } });
      port = settings.port;
      bind = '0.0.0.0';
    } else {
      const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
      if (!existsSync(join(distDir, 'index.html'))) throw new Error();
      const devKey = loadDevKey();
      const directory = realpathSync(localAppData());
      const path = join(directory, 'kakaopay-local.sqlite');
      if (!outsideRepo(directory) || (existsSync(path) && !outsideRepo(realpathSync(path)))) throw new Error();
      database = new PaymentDatabase(path);
      server = createKakaoPayLocalServer({ database, distDir, devKey, report });
    }
    server.once('close', closeDatabase);
    server.once('error', () => {
      closeDatabase();
      console.error('LINK 결제 서버가 지정된 포트를 열지 못했어요.');
      process.exitCode = 1;
    });
    const shutdown = () => server.close();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.listen(port, bind, () => console.log(hosted ? 'LINK QA backend ready' : 'LINK 카카오페이 테스트: ' + KAKAO_TEST_ORIGIN));
  } catch {
    closeDatabase();
    console.error(hosted ? 'QA 설정, Node.js와 영속 디스크 상태를 확인해 주세요.'
      : '빌드 결과, 로컬 SQLite 지원, 카카오페이 개발용 환경 파일을 확인해 주세요.');
    process.exitCode = 1;
  }
}
