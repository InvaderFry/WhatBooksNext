import { READ_NEXT_PAGE, RECENT_DAYS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { todayLocal } from '../util.ts';
import { runMode } from './modes.ts';
import type { RankItem } from './recommend.ts';
import { loadStrength, loadTopics, loadWeights, tasteFrom } from './tune.ts';

/** Title-free counts. Picks use What next's default first page with the owner's Tune settings. */
export function ratingDiagnostics(db: DB, items: RankItem[]) {
  const tiers = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let unknown = 0;
  for (const i of items) {
    if (i.community) tiers[i.community.tier]++;
    else unknown++;
  }
  const picks = runMode(
    'read_next',
    items,
    {
      budget: null,
      mode: 'read_for',
      readyToRead: false,
      exclude: new Set(),
      today: todayLocal(),
      recentDays: RECENT_DAYS,
      weights: loadWeights(db),
      topics: loadTopics(db),
      taste: tasteFrom(items, loadStrength(db)),
    },
    { offset: 0, limit: READ_NEXT_PAGE },
  ).cards;
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    tiers,
    unknown,
    whatNext: {
      total: picks.length,
      provisional: picks.filter((c) => byId.get(c.id)?.community?.tier === 5).length,
    },
  };
}
