import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const CID = 'TC0ONETIME';
const REDIRECT_ORIGINS = new Set([
  'https://mockup-pg-web.kakao.com',
  'https://online-pay.kakao.com',
  'https://online-pay.kakaopay.com',
  'https://online-payment.kakaopay.com',
]);
export const READY_WINDOW_MS = 15 * 60_000;

type Fields = Record<string, unknown>;
type Operation = 'ready' | 'approve' | 'order';
export type KakaoDiagnostic = {
  operation: Operation;
  reason: 'http' | 'timeout' | 'network' | 'response-format' | 'response-mismatch' | 'checkout-url';
  status?: number;
  errorCode?: number;
  invalidCheckoutUrl?: boolean;
};
export type KakaoOptions = {
  devKey: string;
  transport?: typeof fetch;
  timeoutMs?: number;
  report?: (diagnostic: KakaoDiagnostic) => void;
};
export type KakaoTrade = { orderId: string; userId: string; item: string; total: number; quantity: number };
type KnownTrade = KakaoTrade & { tid: string };

export const token = () => randomBytes(32).toString('hex');

function fields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function isTimestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function kakaoRedirect(value: unknown) {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && REDIRECT_ORIGINS.has(url.origin) && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // An invalid provider redirect is never shown to the user.
  }
}

export function kakaoReturn(url: URL) {
  const match = /^\/return\/(success|cancel|fail)\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match) return;
  const tids = url.searchParams.getAll('tid');
  const tokens = url.searchParams.getAll('pg_token');
  const success = match[1] === 'success';
  if (tids.length > 1 || (success && (tokens.length !== 1 || !/^[\x21-\x7e]{1,512}$/.test(tokens[0])))) return;
  return { id: match[2], tid: tids[0] as string | undefined, pgToken: success ? tokens[0] : undefined };
}

function sameOrder(data: Fields, trade: KnownTrade) {
  return data.cid === CID && data.tid === trade.tid
    && data.partner_order_id === trade.orderId && data.partner_user_id === trade.userId;
}

function sameTotal(data: Fields, trade: KakaoTrade) {
  return fields(data.amount).total === trade.total && data.quantity === trade.quantity && data.item_name === trade.item;
}

export function createKakaoPayClient({ devKey, transport = fetch, timeoutMs = 8_000, report }: KakaoOptions) {
  async function call(operation: Operation, payload: Fields) {
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = (error: unknown) => signal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    let response: Response;
    try {
      response = await transport(`https://open-api.kakaopay.com/online/v1/payment/${operation}`, {
        method: 'POST',
        headers: { Authorization: `SECRET_KEY ${devKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, cid: CID }),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      report?.({ operation, reason: timedOut(error) ? 'timeout' : 'network' });
      return null;
    }
    if (!response.ok) {
      const code = fields(await response.json().catch(() => undefined)).error_code;
      const errorCode = typeof code === 'number' && Number.isInteger(code) && code < 0 && code > -10_000
        ? code : undefined;
      report?.({ operation, reason: 'http', status: response.status, errorCode });
      return null;
    }
    try {
      return { data: fields(await response.json()), status: response.status };
    } catch (error) {
      const reason = timedOut(error) ? 'timeout' : error instanceof SyntaxError ? 'response-format' : 'network';
      report?.({ operation, reason, status: response.status });
      return null;
    }
  }

  return {
    async ready(trade: KakaoTrade, origin: string, callbackId: string) {
      const response = await call('ready', {
        partner_order_id: trade.orderId, partner_user_id: trade.userId,
        item_name: trade.item, quantity: trade.quantity, total_amount: trade.total, tax_free_amount: 0,
        approval_url: `${origin}/return/success/${callbackId}`,
        cancel_url: `${origin}/return/cancel/${callbackId}`,
        fail_url: `${origin}/return/fail/${callbackId}`,
      });
      if (!response) return {};
      const { data, status } = response;
      const pc = kakaoRedirect(data.next_redirect_pc_url);
      const mobile = kakaoRedirect(data.next_redirect_mobile_url);
      const invalidCheckoutUrl = (data.next_redirect_pc_url != null && !pc) ||
        (data.next_redirect_mobile_url != null && !mobile);
      if (!isIdentifier(data.tid)) {
        report?.({ operation: 'ready', reason: 'response-format', status, invalidCheckoutUrl });
        return {};
      }
      if ((!pc && !mobile) || invalidCheckoutUrl)
        report?.({ operation: 'ready', reason: 'checkout-url', status, invalidCheckoutUrl });
      return { tid: data.tid, pc, mobile };
    },
    async approve(trade: KnownTrade, pgToken: string) {
      const response = await call('approve', {
        tid: trade.tid, pg_token: pgToken, partner_order_id: trade.orderId, partner_user_id: trade.userId,
      });
      if (!response) return { kind: 'unknown' } as const;
      const { data, status } = response;
      if (sameOrder(data, trade) && sameTotal(data, trade) && isIdentifier(data.aid) && isTimestamp(data.approved_at))
        return { kind: 'verified', aid: data.aid } as const;
      report?.({ operation: 'approve', reason: 'response-mismatch', status });
      return { kind: 'mismatch' } as const;
    },
    async order(trade: KnownTrade, aid?: string) {
      const response = await call('order', { tid: trade.tid });
      if (!response) return 'unknown';
      const { data, status } = response;
      if (!sameOrder(data, trade)) {
        report?.({ operation: 'order', reason: 'response-mismatch', status });
        return 'unknown';
      }
      switch (data.status) {
        case 'SUCCESS_PAYMENT': {
          const actions: unknown[] = Array.isArray(data.payment_action_details) ? data.payment_action_details : [];
          const payment = actions.map(fields).some(action =>
            action.payment_action_type === 'PAYMENT' && action.amount === trade.total &&
            isIdentifier(action.aid) && (!aid || action.aid === aid));
          if (sameTotal(data, trade) && isTimestamp(data.approved_at) && payment) return 'approved';
          report?.({ operation: 'order', reason: 'response-mismatch', status });
          return 'unknown';
        }
        case 'QUIT_PAYMENT':
        case 'CANCEL_PAYMENT': return 'cancelled';
        case 'FAIL_PAYMENT': return 'failed';
        case 'READY': return 'ready';
        case 'SEND_TMS':
        case 'OPEN_PAYMENT':
        case 'SELECT_METHOD':
        case 'ARS_WAITING':
        case 'AUTH_PASSWORD': return 'pending';
        default:
          report?.({ operation: 'order', reason: 'response-format', status });
          return 'unknown';
      }
    },
  };
}

export function outsideRepo(path: string) {
  const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const fromRepo = relative(repo, path);
  return isAbsolute(fromRepo) || fromRepo === '..' || fromRepo.startsWith(`..${sep}`);
}

export function localAppData() {
  const base = process.env.LOCALAPPDATA;
  if (!base || !isAbsolute(base)) throw new Error();
  return join(base, 'LINK');
}

export function isDevKey(key: unknown): key is string {
  return typeof key === 'string' && /^DEV[A-Za-z0-9_-]{16,125}$/i.test(key);
}

export function loadDevKey() {
  const keyFile = realpathSync(join(localAppData(), 'kakaopay-test.env'));
  if (!outsideRepo(keyFile)) throw new Error();
  const contents = readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '');
  const key = parseEnv(contents).KAKAOPAY_DEV_SECRET_KEY;
  if (!isDevKey(key)) throw new Error();
  return key;
}
