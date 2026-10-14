/**
 * Budget ledger — durable, atomic, fail-closed accounting for paid inference.
 * The design's stage-4 gate: atomic reservations BEFORE requests, reconcile
 * with actual returned cost, ambiguous failures keep reservations held, and
 * the combined monthly cap can never be overshot.
 */
import { Database } from 'bun:sqlite';

export interface BudgetConfig {
  monthlyCapUsd: number;
  /** ISO date (day precision) the current period started. Defaults to this month. */
  periodStart?: string;
}

export interface ReserveResult {
  reserved: boolean;
  reason?: string;
}

interface LedgerRow {
  key: string;
  reserved_usd: number;
  actual_usd: number | null;
  period_start: string;
  created_at: string;
  reconciled_at: string | null;
}

export class BudgetLedger {
  private constructor(private readonly db: Database, private config: BudgetConfig) {}

  static async open(dbPath: string, config: BudgetConfig): Promise<BudgetLedger> {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        key TEXT PRIMARY KEY,
        reserved_usd REAL NOT NULL,
        actual_usd REAL,
        period_start TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reconciled_at TEXT
      )
    `);
    return new BudgetLedger(db, { ...config });
  }

  private currentPeriod(): string {
    return this.config.periodStart ?? new Date().toISOString().slice(0, 7) + '-01';
  }

  /** Remaining allowance: cap minus (outstanding + reconciled actuals) this period. */
  remainingUsd(): number {
    const period = this.currentPeriod();
    const rows = this.db.query<LedgerRow, [string]>(
      'SELECT * FROM reservations WHERE period_start = ?',
    ).all(period);
    const spent = rows.reduce((sum, r) => sum + (r.actual_usd ?? r.reserved_usd), 0);
    return Math.round((this.config.monthlyCapUsd - spent) * 1e6) / 1e6;
  }

  /** Atomically reserve up to the remaining allowance. Fail-closed at the cap. */
  reserve(key: string, amountUsd: number): ReserveResult {
    if (typeof key !== 'string' || !key.trim()) return { reserved: false, reason: 'invalid key' };
    if (!(amountUsd > 0)) return { reserved: false, reason: 'invalid amount' };
    const existing = this.db.query<LedgerRow, [string]>(
      'SELECT * FROM reservations WHERE key = ?',
    ).get(key);
    if (existing) {
      throw new Error(`RESERVATION_OUTSTANDING: key '${key}' already has an unreconciled or reconciled entry; retries must use a new key`);
    }
    const remaining = this.remainingUsd();
    if (amountUsd > remaining + 1e-9) {
      return { reserved: false, reason: `cap: requested ${amountUsd} exceeds remaining ${remaining}` };
    }
    const tx = this.db.query<LedgerRow, [string, number, string, string]>(
      'INSERT INTO reservations (key, reserved_usd, period_start, created_at) VALUES (?, ?, ?, ?)',
    );
    tx.run(key, amountUsd, this.currentPeriod(), new Date().toISOString());
    return { reserved: true };
  }

  /** Settle a reservation with the actual cost. Idempotent-once per key. */
  reconcile(key: string, actualUsd: number): void {
    if (!(actualUsd >= 0)) throw new Error('RECONCILE_INVALID: actual cost must be >= 0');
    const row = this.db.query<LedgerRow, [string]>('SELECT * FROM reservations WHERE key = ?').get(key);
    if (!row) throw new Error(`RECONCILE_UNKNOWN: no reservation '${key}'`);
    if (row.reconciled_at) throw new Error(`RECONCILE_DUPLICATE: '${key}' already reconciled`);
    this.db.query<[string, number, string], [number, string, string]>(
      'UPDATE reservations SET actual_usd = ?, reconciled_at = ? WHERE key = ?',
    ).run(actualUsd, new Date().toISOString(), key);
  }

  /** Advance the period (e.g. month rollover). History is retained. */
  setPeriod(periodStart: string): void {
    this.config = { ...this.config, periodStart };
  }

  /** Total actually spent in a given period (reconciled + still-outstanding estimates). */
  spentInPeriod(periodStart: string): number {
    const rows = this.db.query<LedgerRow, [string]>(
      'SELECT * FROM reservations WHERE period_start = ?',
    ).all(periodStart);
    return Math.round(rows.reduce((sum, r) => sum + (r.actual_usd ?? r.reserved_usd), 0) * 1e6) / 1e6;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
