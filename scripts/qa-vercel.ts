import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isQaOrigin } from '../src/core/types.ts';
import { renderOrigin } from './qa-config.ts';

export function qaRoutes(origin: string, upstream: string) {
  if (!isQaOrigin(origin) || !renderOrigin(upstream)) throw new Error('Invalid QA deployment origins');

  return {
    version: 3,
    routes: [
      {
        src: '^/(api/.*|checkout/.*|return/.*|payment-return|checkout-unavailable|qa-access)$',
        dest: upstream + '/$1',
        headers: { 'Cache-Control': 'no-store' },
      },
      {
        src: '^/(?:index\\.html)?$',
        dest: '/index.html',
        headers: {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
      },
      { handle: 'filesystem' },
    ],
  };
}

const origin = process.env.LINK_QA_ORIGIN ?? '';
const upstream = process.env.LINK_QA_RENDER_ORIGIN ?? '';
const routes = qaRoutes(origin, upstream);
// A Git Preview, another project, or missing Vercel system metadata must never emit the QA entry point.
if (process.env.VERCEL_ENV !== 'production' ||
    process.env.VERCEL_GIT_COMMIT_REF !== 'feature/kakaopay-test-payment' ||
    'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL !== origin)
  throw new Error('The QA build requires the dedicated Vercel Production branch and domain');

if (process.argv[2] !== '--check') {
  const directory = resolve(process.argv[2] ?? '.vercel/output');
  const filename = join(directory, 'static/index.html');
  const page = readFileSync(filename, 'utf8');
  if (!page.includes('<head>')) throw new Error('Missing frontend entry point');
  writeFileSync(filename, page.replace('<head>', '<head><meta name="link-kakaopay-qa" content="' + origin + '">'));
  writeFileSync(join(directory, 'config.json'), JSON.stringify(routes, null, 2) + '\n');
}
