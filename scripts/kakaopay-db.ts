import { DatabaseSync } from 'node:sqlite';
import type { Payment, Quote } from '../src/core/types.ts';
import { token } from './kakaopay-provider.ts';

type DatabasePayment = {
  id: string;
  owner: string;
  requestKey: string;
  callbackId: string;
  userId: string;
  item: string;
  created: number;
  state: Payment['state'];
  snapshot: string;
  tid: string | null;
  pc: string | null;
  mobile: string | null;
  attempted: number;
  aid: string | null;
  mismatch: number;
  orderId: string | null;
};
type Session = { id: string; csrf: string };
const waiting = "'preparing', 'ready', 'approving', 'review'";

export class PaymentDatabase {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported payment database schema');
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id), requestKey TEXT NOT NULL,
        callbackId TEXT NOT NULL UNIQUE, userId TEXT NOT NULL, item TEXT NOT NULL,
        created INTEGER NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL,
        tid TEXT UNIQUE, pc TEXT, mobile TEXT,
        attempted INTEGER NOT NULL DEFAULT 0, aid TEXT, mismatch INTEGER NOT NULL DEFAULT 0,
        UNIQUE(owner, requestKey)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment ON payments(owner) WHERE state IN (${waiting});
      CREATE TABLE IF NOT EXISTS orders (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        paymentId TEXT NOT NULL UNIQUE REFERENCES payments(id), created INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
    } catch (failure) {
      this.db.close();
      throw failure;
    }
  }

  check() {
    this.db.prepare('SELECT id FROM sessions LIMIT 1').get();
  }

  close() {
    this.db.close();
  }

  session(id: string) {
    return this.db.prepare('SELECT id, csrf FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  newSession() {
    const session = { id: token(), csrf: token() };
    this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(session.id, session.csrf);
    return session;
  }

  private payment(where: string, ...values: string[]) {
    return this.db.prepare(`
      SELECT payments.*, orders.id AS orderId FROM payments LEFT JOIN orders ON orders.paymentId = payments.id
      WHERE ${where}
    `).get(...values) as unknown as DatabasePayment | undefined;
  }

  byId(owner: string, id: string) {
    return this.payment('payments.owner = ? AND payments.id = ?', owner, id);
  }

  byKey(owner: string, key: string) {
    return this.payment('payments.owner = ? AND payments.requestKey = ?', owner, key);
  }

  byReturn(id: string) {
    return this.payment('payments.callbackId = ?', id);
  }

  pending(owner: string) {
    return this.payment(`payments.owner = ? AND payments.state IN (${waiting})`, owner);
  }

  failUnopened(owner: string, id: string) {
    return this.db.prepare(`
      UPDATE payments SET state = 'failed'
      WHERE owner = ? AND id = ? AND state IN ('preparing', 'review')
        AND attempted = 0 AND aid IS NULL AND mismatch = 0
        AND (tid IS NULL OR (pc IS NULL AND mobile IS NULL))
        AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.paymentId = payments.id)
    `).run(owner, id).changes === 1;
  }

  reserve(owner: string, key: string, snapshot: Quote, item: string, created: number) {
    const id = token();
    // The unique request key and partial index protect both retries and new keys from other tabs.
    const insert = this.db.prepare(`
      INSERT INTO payments (id, owner, requestKey, callbackId, userId, item, created, state, snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?) ON CONFLICT DO NOTHING
    `).run(id, owner, key, token(), token(), item, created, JSON.stringify(snapshot));
    return insert.changes ? this.byId(owner, id) : undefined;
  }

  storeReady(id: string, response: { tid?: string; pc?: string; mobile?: string }) {
    const tid = response.tid ?? null;
    const state = tid && (response.pc || response.mobile) ? 'ready' : 'failed';
    this.db.prepare(`
      UPDATE payments SET tid = ?, pc = ?, mobile = ?, state = ?
      WHERE id = ? AND state = 'preparing' AND tid IS NULL AND pc IS NULL AND mobile IS NULL
        AND attempted = 0 AND aid IS NULL AND mismatch = 0
        AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.paymentId = payments.id)
    `).run(tid, response.pc ?? null, response.mobile ?? null, state, id);
  }

  claimApproval(id: string) {
    return this.db.prepare(`
      UPDATE payments SET attempted = 1, state = 'approving'
      WHERE id = ? AND attempted = 0 AND tid IS NOT NULL AND (pc IS NOT NULL OR mobile IS NOT NULL) AND state IN (${waiting})
    `).run(id).changes === 1;
  }

  storeApproval(id: string, aid: string | null, mismatch: boolean) {
    this.db.prepare('UPDATE payments SET aid = ?, mismatch = ? WHERE id = ?').run(aid, Number(mismatch), id);
  }

  setOutcome(id: string, state: 'ready' | 'review' | 'cancelled' | 'failed') {
    this.db.prepare(`UPDATE payments SET state = ? WHERE id = ? AND state IN (${waiting})`).run(state, id);
  }

  finish(owner: string, id: string, created: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const payment = this.byId(owner, id);
      if (payment?.attempted && !payment.mismatch && ['ready', 'approving', 'review'].includes(payment.state)) {
        this.db.prepare(`
          INSERT INTO orders (id, paymentId, created) VALUES (?, ?, ?) ON CONFLICT(paymentId) DO NOTHING
        `).run(token(), id, created);
        this.db.prepare("UPDATE payments SET state = 'approved' WHERE id = ?").run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  order(owner: string, id: string) {
    return this.db.prepare(`
      SELECT orders.*, payments.snapshot FROM orders JOIN payments ON payments.id = orders.paymentId
      WHERE payments.owner = ? AND orders.id = ?
    `).get(owner, id) as { id: string; paymentId: string; sequence: number; created: number; snapshot: string } | undefined;
  }
}

export type { DatabasePayment };
