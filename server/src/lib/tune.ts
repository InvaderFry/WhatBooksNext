import { MAX_TOPIC_LENGTH, MAX_TOPICS, TASTE_STRENGTH, WEIGHTS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { HttpError, nowIso, parseJson } from '../util.ts';
import type { RankItem, Weights } from './recommend.ts';
import { cleanSavedViews, type SavedView } from './savedViews.ts';
import { learnTaste, type TasteModel, type TasteStrength } from './taste.ts';

/**
 * The owner's ranking settings (PLAN.md §13.7 Tune, §13.11, §15 Settings): weights, taste
 * strength and topic interests. Owner data, kept in `settings` (so backups carry them).
 */

export const WEIGHT_TEXT: Record<keyof typeof WEIGHTS, { label: string; explain: string }> = {
  rating: {
    label: 'Rating',
    explain: 'Your own rating if you gave one, otherwise what readers on Hardcover or others say.',
  },
  timeFit: {
    label: 'Time fit',
    explain:
      'How well it fits the time you picked. In “Read for”, shorter isn’t automatically better.',
  },
  taste: {
    label: 'Taste',
    explain:
      'Genres, authors, artists and publishers you rate highly or finish. Does nothing until there’s enough to learn from.',
  },
  momentum: {
    label: 'Momentum',
    explain: 'Books you’ve started, and the next book in a series you’re reading.',
  },
  triage: { label: 'Want', explain: 'Books you marked Want in triage. Maybe is neutral.' },
  recency: {
    label: 'Recently added',
    explain: 'A gentle nudge for books you got in the last 60 days. Never rewards buying.',
  },
};

function readSetting<T>(db: DB, key: string, fallback: T): T {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
    string | undefined;
  return parseJson<T>(v, fallback);
}

function writeSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

const KEYS = Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[];

/** The weights in use: the owner's from Tune, each falling back to its starting value (§20). */
export function loadWeights(db: DB): Weights {
  const saved = readSetting<Record<string, unknown>>(db, 'tuneWeights', {});
  const out = { ...WEIGHTS } as Weights;
  for (const k of KEYS) {
    const v = saved?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
  }
  return out;
}

export function saveWeights(db: DB, body: unknown): Weights {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'weights must be an object.');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!(KEYS as string[]).includes(k)) throw new HttpError(400, `Unknown weight "${k}".`);
  const next = loadWeights(db);
  for (const k of KEYS) {
    if (!(k in b)) continue;
    const v = b[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
      throw new HttpError(400, `${k} must be a number from 0 to 1.`);
    next[k] = Math.round(v * 100) / 100;
  }
  writeSetting(db, 'tuneWeights', next);
  return next;
}

export function resetWeights(db: DB): void {
  db.prepare("DELETE FROM settings WHERE key = 'tuneWeights'").run();
}

export function loadStrength(db: DB): TasteStrength {
  const v = readSetting<string>(db, 'tasteStrength', 'normal');
  return v in TASTE_STRENGTH ? (v as TasteStrength) : 'normal';
}

export function saveStrength(db: DB, v: unknown): TasteStrength {
  if (typeof v !== 'string' || !(v in TASTE_STRENGTH))
    throw new HttpError(400, `strength must be one of ${Object.keys(TASTE_STRENGTH).join(', ')}.`);
  writeSetting(db, 'tasteStrength', v);
  return v as TasteStrength;
}

export function loadTopics(db: DB): string[] {
  const v = readSetting<unknown>(db, 'topicInterests', []);
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

export function saveTopics(db: DB, v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'topics must be a list.');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of v) {
    if (typeof t !== 'string') throw new HttpError(400, 'Each topic must be text.');
    const clean = t.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    if (clean.length > MAX_TOPIC_LENGTH)
      throw new HttpError(400, `A topic can be at most ${MAX_TOPIC_LENGTH} characters.`);
    if (seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  if (out.length > MAX_TOPICS) throw new HttpError(400, `At most ${MAX_TOPICS} topics.`);
  writeSetting(db, 'topicInterests', out);
  return out;
}

/** Taste learned from every item, the owned and the read-elsewhere (§13.11). */
export function tasteFrom(items: RankItem[], strength: TasteStrength): TasteModel {
  return learnTaste(
    items.map((i) => ({
      id: i.id,
      kind: i.kind,
      creators: i.creators,
      subjects: i.subjects,
      publisher: i.publisher,
      seriesKey: i.series?.key ?? null,
      historyOnly: i.historyOnly,
      progress: i.user.progress,
      dnfReason: i.user.dnfReason,
      rating: i.user.rating,
    })),
    strength,
  );
}

/** Saved views on What next (`lib/savedViews.ts`). A damaged stored list reads as none. */
export function loadSavedViews(db: DB): SavedView[] {
  try {
    return cleanSavedViews(readSetting<unknown>(db, 'savedViews', []));
  } catch {
    return [];
  }
}

export function saveSavedViews(db: DB, v: unknown): SavedView[] {
  const views = cleanSavedViews(v);
  writeSetting(db, 'savedViews', views);
  return views;
}
