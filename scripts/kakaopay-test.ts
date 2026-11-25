import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKakaoPayClient, kakaoReturn, loadDevKey, READY_WINDOW_MS, token, type KakaoOptions } from './kakaopay-provider.ts';

const PORT = 3000;
const HOSTS = new Set(['127.0.0.1:3000', 'localhost:3000']);
const ITEM = 'LINK 카카오페이 테스트';
const TOTAL = 2200;
const QUANTITY = 1;

type Status = 'preparing' | 'ready' | 'checking' | 'unknown' | 'approved' | 'cancelled' | 'failed';

interface Transaction {
  owner: string;
  origin: string;
  orderId: string;
  userId: string;
  callbackId: string;
  expiresAt: number;
  status: Status;
  tid?: string;
  redirect?: string;
  approvalAttempted: boolean;
  pending?: Promise<void>;
  approvalMismatch?: boolean;
  aid?: string;
}

const STATUS_TEXT: Record<Status, string> = {
  preparing: '테스트 결제를 준비하고 있어요.',
  ready: '결제창에서 가상 결제수단을 선택해 주세요.',
  checking: '카카오페이에서 거래 결과를 확인하고 있어요.',
  unknown: '거래 결과를 아직 확인하지 못했어요. 같은 거래를 다시 조회해 주세요.',
  approved: '테스트 결제 승인 및 거래 조회를 확인했어요.',
  cancelled: '카카오페이에서 결제 취소를 확인했어요.',
  failed: '카카오페이에서 결제 실패를 확인했어요.',
};

function isTerminal(status: Status) {
  return status === 'approved' || status === 'cancelled' || status === 'failed';
}

function htmlAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function html(res: ServerResponse, status: number, title: string, content: string, scriptNonce: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', `default-src 'none'; connect-src 'self'; style-src 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  res.writeHead(status).end(`<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${scriptNonce}">
  body { font: 1.125rem/1.6 system-ui, sans-serif; margin: 1rem; }
  main { max-width: 38rem; margin: 2rem auto; }
  h1 { line-height: 1.25; }
  button, main > a { display: inline-block; font: inherit; padding: .55em .8em; }
  :focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
</style>
<main><h1>${title}</h1>${content}</main>
<script nonce="${scriptNonce}">
  const form = document.querySelector('form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    const body = new URLSearchParams(new FormData(form));
    button.disabled = true;
    document.querySelector('[role="status"]').textContent = '카카오페이 응답을 기다리고 있어요.';
    // Explicit CORS mode keeps the same-origin Origin header with no-referrer.
    await fetch(form.action, { method: 'POST', mode: 'cors', body, redirect: 'error' }).catch(() => {});
    location.assign('/result');
  });
</script></html>`);
}

function redirectToResult(res: ServerResponse, location = '/result') {
  res.writeHead(303, { Location: location }).end();
}

async function csrfFromBody(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return;
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > 1024) return;
    chunks.push(chunk);
  }
  const values = new URLSearchParams(Buffer.concat(chunks).toString()).getAll('csrf');
  if (values.length === 1) return values[0];
}

export function createKakaoPayTestServer(options: KakaoOptions) {
  const provider = createKakaoPayClient(options);
  // Keep a single transaction so lost preparation responses also block another browser tab.
  let current: Transaction | undefined;
  const sessionKey = randomBytes(32);

  function csrf(owner: string, origin: string, action: string) {
    const message = [owner, origin, action, current?.callbackId ?? ''].join('|');
    return createHmac('sha256', sessionKey).update(message).digest('hex');
  }

  async function prepare(owner: string, origin: string) {
    const tx: Transaction = {
      owner, origin, orderId: token(), userId: token(), callbackId: token(),
      expiresAt: Date.now() + READY_WINDOW_MS, status: 'preparing', approvalAttempted: false,
    };
    current = tx;
    const result = await provider.ready(trade(tx), origin, tx.callbackId);
    tx.tid = result.tid;
    tx.redirect = result.pc;
    tx.status = tx.tid && tx.redirect ? 'ready' : 'unknown';
  }

  function trade(tx: Transaction) {
    return { orderId: tx.orderId, userId: tx.userId, item: ITEM, total: TOTAL, quantity: QUANTITY };
  }

  async function confirm(tx: Transaction, pgToken?: string, fromCallback = false) {
    if (!tx.tid) return;
    const known = { ...trade(tx), tid: tx.tid };
    const wasReady = tx.status === 'ready';
    tx.status = 'checking';
    if (pgToken && !tx.approvalAttempted) {
      tx.approvalAttempted = true;
      const result = await provider.approve(known, pgToken);
      if (result.kind === 'verified') tx.aid = result.aid;
      if (result.kind === 'mismatch') tx.approvalMismatch = true;
    }
    const order = await provider.order(known, tx.aid);
    tx.status = 'unknown';
    if ((order === 'approved' && tx.approvalAttempted && !tx.approvalMismatch) ||
        order === 'cancelled' || order === 'failed' || (order === 'ready' && !fromCallback && wasReady))
      tx.status = order;
  }

  function refresh(tx: Transaction, pgToken?: string, fromCallback = false) {
    tx.pending ??= confirm(tx, pgToken, fromCallback).finally(() => {
      tx.pending = undefined;
    });
    return tx.pending;
  }

  function renderPage(res: ServerResponse, owner: string, origin: string) {
    const tx = current?.owner === owner && current.origin === origin ? current : undefined;
    const canStart = !current || isTerminal(current.status);
    const canCheck = tx?.tid && (tx.status === 'ready' || tx.status === 'unknown');
    const action = canStart ? '/ready' : canCheck ? '/check' : undefined;
    const form = action ? `<form action="${action}" method="post">
      <input type="hidden" name="csrf" value="${csrf(owner, origin, action)}">
      <button type="submit">${canStart ? '테스트 결제 준비' : '같은 거래 다시 조회'}</button>
    </form><p role="status"></p>` : '';
    const checkout = tx?.status === 'ready' && tx.redirect && Date.now() < tx.expiresAt
      ? `<a href="${htmlAttribute(tx.redirect)}" rel="noreferrer">카카오페이 테스트 결제창 열기</a>` : '';
    let status = tx ? STATUS_TEXT[tx.status] : '테스트 결제를 준비할 수 있어요.';
    if (tx?.status === 'unknown' && !tx.tid) {
      status = '결제 준비 결과와 거래번호를 확인하지 못했어요. 새 결제는 차단됐어요. 다시 시작하기 전에 카카오페이에서 이전 거래를 확인해 주세요.';
    } else if (tx?.status === 'ready' && !checkout) {
      status = '결제창이 만료됐어요. 같은 거래를 조회해 주세요.';
    } else if (!tx && !canStart) {
      status = '다른 브라우저에서 시작한 테스트 거래가 있어요. 처음 사용한 브라우저에서 결과를 확인해 주세요.';
    }
    html(res, 200, 'LINK 카카오페이 테스트 결제', `<p>테스트 상품 1개 · 2,200원</p>
<p>가상 결제수단을 사용하며 실제 금액은 청구되지 않아요.</p>
<p>결제창과 결과 화면은 같은 PC 브라우저에서 열어 주세요.</p>
<h2>거래 상태</h2><p>${status}</p>${checkout}${form}`, token());
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = req.headers.host;
    if (!host || !HOSTS.has(host) || req.headersDistinct.host?.length !== 1) {
      res.writeHead(403).end();
      return;
    }
    const origin = `http://${host}`;
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, origin);
    const owner = /(?:^|;\s*)link_kakaopay=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];

    if (req.method === 'GET' && url.pathname.startsWith('/return/')) {
      const callback = kakaoReturn(url);
      const tx = current;
      if (!tx?.tid || !callback || callback.id !== tx.callbackId || tx.owner !== owner || tx.origin !== origin
        || (callback.tid !== undefined && callback.tid !== tx.tid)) {
        redirectToResult(res, '/invalid-return');
        return;
      }
      if (tx.pending) await tx.pending;
      if (!isTerminal(tx.status) && !(callback.pgToken && tx.approvalAttempted)) {
        const canApprove = callback.pgToken && tx.redirect && Date.now() < tx.expiresAt;
        await refresh(tx, canApprove ? callback.pgToken : undefined, true);
      }
      redirectToResult(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/invalid-return') {
      html(res, 400, '결제 복귀를 확인할 수 없어요', '<a href="/result">거래 상태 보기</a>', token());
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/result')) {
      const session = owner ?? token();
      if (!owner) res.setHeader('Set-Cookie', `link_kakaopay=${session}; Path=/; HttpOnly; SameSite=Lax`);
      renderPage(res, session, origin);
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/ready' || url.pathname === '/check')) {
      if (req.headers.origin !== origin || !owner || await csrfFromBody(req) !== csrf(owner, origin, url.pathname)) {
        res.writeHead(403).end();
        return;
      }
      if (url.pathname === '/ready' && (!current || isTerminal(current.status))) {
        await prepare(owner, origin);
      } else if (url.pathname === '/check' && current?.owner === owner && current.origin === origin && current.tid
        && (current.status === 'ready' || current.status === 'unknown')) {
        await refresh(current);
      }
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  }

  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = createKakaoPayTestServer({ devKey: loadDevKey() });
    server.once('error', () => {
      console.error('로컬 테스트 서버를 시작하지 못했어요. 포트 3000이 비어 있는지 확인해 주세요.');
      process.exitCode = 1;
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log('LINK 카카오페이 테스트 서버: http://127.0.0.1:3000');
    });
  } catch {
    console.error('%LOCALAPPDATA%\\LINK\\kakaopay-test.env에 KAKAOPAY_DEV_SECRET_KEY 설정을 확인해 주세요.');
    process.exitCode = 1;
  }
}
