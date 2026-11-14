import { MAX_SAVED_VIEW_NAME, MAX_SAVED_VIEWS, MAX_TOPIC_LENGTH } from '../config.ts';
import { HttpError, newId } from '../util.ts';
import { MODE_IDS } from './modes.ts';
import { TIME_PRESETS } from './recommend.ts';

/**
 * Saved views on What next: a named set of the page's choices ("30-minute comics, ready now"),
 * applied with one tap. Owner data, kept in `settings` (so backups carry them). Pure validation:
 * only the What next choices are stored, each limited to the values the page itself offers.
 */

export interface SavedViewParams {
  m?: string;
  time?: string;
  mode?: string;
  show?: string;
  ready?: string;
  complete?: string;
  mood?: string;
  topic?: string;
}

export interface SavedView {
  id: string;
  name: string;
  params: SavedViewParams;
}

/** What each choice may be. '' (or leaving it out) means the page's default. */
const ALLOWED: Record<Exclude<keyof SavedViewParams, 'topic'>, readonly string[]> = {
  m: MODE_IDS,
  time: TIME_PRESETS.map((p) => p.id),
  mode: ['read_for', 'finish_within'],
  show: ['books', 'tech', 'comics', 'all'],
  ready: ['1'],
  complete: ['1'],
  mood: ['escape', 'learn', 'skim'],
};

function cleanParams(v: unknown): SavedViewParams {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new HttpError(400, 'A saved view needs its choices.');
  const out: SavedViewParams = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === '' || raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') throw new HttpError(400, `${k} must be text.`);
    if (k === 'topic') {
      const t = raw.trim();
      if (t.length > MAX_TOPIC_LENGTH) throw new HttpError(400, 'That topic is too long.');
      if (t) out.topic = t;
      continue;
    }
    const allowed = ALLOWED[k as keyof typeof ALLOWED];
    if (!allowed) throw new HttpError(400, `Unknown choice "${k}".`);
    if (!allowed.includes(raw)) throw new HttpError(400, `"${raw}" isn't a choice for ${k}.`);
    out[k as keyof typeof ALLOWED] = raw;
  }
  return out;
}

/**
 * The whole list, tidied: names trimmed and required, no two names alike (ignoring case), at
 * most MAX_SAVED_VIEWS. Existing ids are kept so the page can tell views apart; new ones get one.
 */
export function cleanSavedViews(v: unknown): SavedView[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'views must be a list.');
  if (v.length > MAX_SAVED_VIEWS)
    throw new HttpError(400, `At most ${MAX_SAVED_VIEWS} saved views. Remove one first.`);
  const out: SavedView[] = [];
  const names = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x))
      throw new HttpError(400, 'Each saved view must be an object.');
    const r = x as Record<string, unknown>;
    if (typeof r.name !== 'string') throw new HttpError(400, 'A saved view needs a name.');
    const name = r.name.trim().replace(/\s+/g, ' ');
    if (!name) throw new HttpError(400, 'A saved view needs a name.');
    if (name.length > MAX_SAVED_VIEW_NAME)
      throw new HttpError(400, `A name can be at most ${MAX_SAVED_VIEW_NAME} characters.`);
    if (names.has(name.toLowerCase()))
      throw new HttpError(400, `There's already a saved view called "${name}".`);
    names.add(name.toLowerCase());
    const id = typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : newId();
    out.push({ id, name, params: cleanParams(r.params) });
  }
  return out;
}
