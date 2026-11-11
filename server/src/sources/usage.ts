import type { DB } from '../db/database.ts';
import { todayLocal } from '../util.ts';

/**
 * Requests made today against a source's daily allowance (Hardcover, Metron). Kept in the
 * database, so restarting the app doesn't forget them (it did at first: the owner saw 402 drop
 * back to 4). Without a database (tests), it's kept in memory.
 */
export class DailyUsage {
  private readonly db: DB | null;
  private readonly key: string;
  private memory = { day: '', count: 0 };

  constructor(db: DB | null, settingsKey: string) {
    this.db = db;
    this.key = settingsKey;
  }

  today(): number {
    const u = this.read();
    return u.day === todayLocal() ? u.count : 0;
  }

  count(n = 1): number {
    const today = todayLocal();
    const u = this.read();
    const next = { day: today, count: (u.day === today ? u.count : 0) + n };
    if (!this.db) this.memory = next;
    else
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(this.key, JSON.stringify(next), new Date().toISOString());
    return next.count;
  }

  private read(): { day: string; count: number } {
    if (!this.db) return this.memory;
    const v = this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(this.key) as
      string | undefined;
    let u: { day?: unknown; count?: unknown } = {};
    try {
      u = v ? (JSON.parse(v) as typeof u) : {};
    } catch {
      /* a damaged value counts as no use today */
    }
    return {
      day: typeof u.day === 'string' ? u.day : '',
      count: typeof u.count === 'number' ? u.count : 0,
    };
  }
}
