import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = '__Host-link_qa';
const SESSION_SECONDS = 12 * 60 * 60;

function same(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function qaAccess(key: string, now: () => number) {
  const signature = (value: string) => createHmac('sha256', key).update('link-qa:' + value).digest('hex');
  return {
    accepts(candidate: string) {
      return /^[a-zA-Z0-9_-]{32,128}$/.test(candidate) && same(candidate, key);
    },
    create() {
      const expires = Math.floor(now() / 1000) + SESSION_SECONDS;
      const value = expires + '.' + randomBytes(16).toString('hex');
      return COOKIE + '=' + value + '.' + signature(value) +
        '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_SECONDS;
    },
    allows(cookies: string) {
      const ticket = /(?:^|;\s*)__Host-link_qa=([0-9]{1,12}\.[a-f0-9]{32})\.([a-f0-9]{64})(?:;|$)/.exec(cookies);
      return !!ticket && Number(ticket[1].split('.')[0]) > Math.floor(now() / 1000) &&
        same(signature(ticket[1]), ticket[2]);
    },
  };
}
