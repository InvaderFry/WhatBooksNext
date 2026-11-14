import type { DB } from '../db/database.ts';
import type { ParsedName } from '../identify/filename.ts';
import { matchesOf, runKeyOf, runVolumeOf } from '../identify/lookups.ts';
import type { SourceName } from '../sources/types.ts';
import { HttpError, parseJson } from '../util.ts';
import { applyMatchAction } from './identityReview.ts';

/**
 * "Which run?" (§11.4, confirm all like this): comic issues of one series in one folder, still
 * tied or unconfirmed, answered together. Many runs share a name and numbers ("Series #1" from
 * 1984, 1993 and 2011), so each issue asks the same question; the owner answers it once.
 *
 * A group is the issues that share a folder, a series name and what their filenames say about
 * the run (series volume "v4", start year "series1992"): the same rule as the run hints that
 * settle an issue's neighbours (`runHintsFor`). Choosing a run confirms, for each issue, that
 * run's candidate for the same number. Issues whose candidates don't include the run are left
 * for the run hint, which settles them once the source answers with it.
 */

const COMIC_SOURCES = new Set<string>(['metron', 'comicvine']);

export interface RunOption {
  source: SourceName;
  seriesId: string;
  name: string;
  startYear?: number;
  volume?: number;
  publisher?: string;
  /** How many of the group's issues have a candidate from this run. */
  issues: number;
}

export interface RunGroup {
  key: string;
  /** The series as the files name it, with their run details ("Series v4"). */
  series: string;
  folder: string;
  itemIds: string[];
  runs: RunOption[];
}

interface IssueRow {
  id: string;
  issue_label: string;
  series_hint: string;
  folder_id: string;
  rel_dir: string;
  parsed: string | null;
}

/** For each run: the candidate to confirm, per item. */
type Choices = Map<string, { option: RunOption; picks: Map<string, string> }>;

function collect(db: DB): { group: RunGroup; choices: Choices }[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.issue_label, i.series_hint, f.folder_id, f.rel_dir, f.parsed
       FROM items i
       JOIN item_files x ON x.item_id = i.id AND x.is_primary = 1
       JOIN files f ON f.id = x.file_id
       LEFT JOIN user_item u ON u.item_id = i.id
       WHERE i.issue_label IS NOT NULL AND i.series_hint IS NOT NULL
         AND i.identity IN ('tie', 'provisional') AND u.match_override IS NULL
       ORDER BY f.rel_dir, i.series_hint, CAST(i.issue_label AS REAL), i.issue_label`,
    )
    .all() as IssueRow[];
  const rejected = new Set(
    (
      db.prepare('SELECT item_id, source, source_id FROM candidates_rejected').all() as {
        item_id: string;
        source: string;
        source_id: string;
      }[]
    ).map((r) => `${r.item_id}:${r.source}:${r.source_id}`),
  );
  const byKey = new Map<string, { rows: IssueRow[]; parsed: ParsedName | null }>();
  for (const r of rows) {
    const key = [r.folder_id, r.rel_dir, r.series_hint.toLowerCase(), runKeyOf(r.parsed)].join('|');
    if (!byKey.has(key))
      byKey.set(key, { rows: [], parsed: parseJson<ParsedName | null>(r.parsed, null) });
    byKey.get(key)!.rows.push(r);
  }
  const out: { group: RunGroup; choices: Choices }[] = [];
  for (const [key, { rows: issues, parsed }] of byKey) {
    if (issues.length < 2) continue;
    const choices: Choices = new Map();
    for (const it of issues) {
      const number = /^\d+(\.\d+)?$/.test(it.issue_label) ? parseFloat(it.issue_label) : null;
      for (const m of matchesOf(db, it.id)) {
        const s = m.record.series;
        if (!COMIC_SOURCES.has(m.source) || !s?.id) continue;
        if (rejected.has(`${it.id}:${m.source}:${m.sourceId}`)) continue;
        // Another number in the same run is another issue, never this one's answer.
        if (number !== null && s.position !== undefined && s.position !== number) continue;
        const runKey = `${m.source}:${s.id}`;
        if (!choices.has(runKey))
          choices.set(runKey, {
            option: {
              source: m.source,
              seriesId: s.id,
              name: s.name,
              ...(s.startYear !== undefined ? { startYear: s.startYear } : {}),
              ...(s.volume !== undefined ? { volume: s.volume } : {}),
              ...(m.record.publisher ? { publisher: m.record.publisher } : {}),
              issues: 0,
            },
            picks: new Map(),
          });
        const c = choices.get(runKey)!;
        // Matches come best first, so the first candidate per item is the one to keep.
        if (!c.picks.has(it.id)) c.picks.set(it.id, m.sourceId);
      }
    }
    if (choices.size === 0) continue;
    for (const c of choices.values()) c.option.issues = c.picks.size;
    const volume = runVolumeOf(parsed);
    const start = parsed?.startYear?.value;
    out.push({
      group: {
        key,
        series: `${issues[0]!.series_hint}${volume ? ` v${volume}` : ''}${start ? ` (${start})` : ''}`,
        folder: issues[0]!.rel_dir,
        itemIds: issues.map((i) => i.id),
        runs: [...choices.values()]
          .map((c) => c.option)
          .sort(
            (a, b) =>
              b.issues - a.issues ||
              (a.startYear ?? 9999) - (b.startYear ?? 9999) ||
              a.name.localeCompare(b.name),
          ),
      },
      choices,
    });
  }
  return out;
}

/** Series in a folder whose issues all ask "which run?", with the runs their candidates offer. */
export function runGroups(db: DB): RunGroup[] {
  return collect(db).map((c) => c.group);
}

/**
 * The owner's answer for a whole group: each issue with a candidate from that run is confirmed
 * as it, exactly like "This is it" on the issue. The others are returned for the run hint.
 */
export function chooseRun(
  db: DB,
  key: string,
  source: string,
  seriesId: string,
): { confirmed: number; leftIds: string[] } {
  const found = collect(db).find((c) => c.group.key === key);
  if (!found) throw new HttpError(404, 'These issues are already settled. Reload the page.');
  const choice = found.choices.get(`${source}:${seriesId}`);
  if (!choice) throw new HttpError(400, 'Choose one of the runs listed.');
  db.transaction(() => {
    for (const [itemId, sourceId] of choice.picks)
      applyMatchAction(db, itemId, {
        action: 'confirm',
        source: choice.option.source,
        sourceId,
      });
  })();
  return {
    confirmed: choice.picks.size,
    leftIds: found.group.itemIds.filter((id) => !choice.picks.has(id)),
  };
}
