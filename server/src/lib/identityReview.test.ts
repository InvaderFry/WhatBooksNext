import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../db/database.ts';
import { applyIdentity, matchFactsFor, storeCandidates } from '../identify/lookups.ts';
import { decide, MATCH_VERSION } from '../identify/match.ts';
import { parseMetronIssues } from '../sources/metron.ts';
import { memoryDb } from '../testing/helpers.ts';
import { applyMatchAction } from './identityReview.ts';
import { listReview, reviewEvidence } from './review.ts';
import { createStoreItem } from './store.ts';

let db: DB;
beforeEach(async () => {
  db = await memoryDb();
});
afterEach(() => db.close());

function tiedComic() {
  const id = createStoreItem(db, {
    title: 'Copperline #1',
    kind: 'comic',
    store: 'globalcomix',
    series: 'Copperline',
  });
  db.prepare('UPDATE items SET issue_label = ? WHERE id = ?').run('1', id);
  const records = parseMetronIssues(
    {
      results: [
        { id: 1, number: '1', cover_date: '1996-01-01', series: { id: 10, name: 'Copperline' } },
        { id: 2, number: '1', cover_date: '2016-01-01', series: { id: 20, name: 'Copperline' } },
      ],
    },
    new Map([
      [10, { publisher: { name: 'Four Color Press' } }],
      [20, { publisher: { name: 'Lantern House' } }],
    ]),
  );
  const result = decide(matchFactsFor(db, id)!, records);
  storeCandidates(db, id, 'metron', result.ranked);
  db.prepare(
    `INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome)
    VALUES (?, 'metron', ?, '{}', '2026-01-01', 'tie')`,
  ).run(id, MATCH_VERSION);
  applyIdentity(db, id);
  return { id, records };
}

describe('identity review evidence', () => {
  it('distinguishes tied runs with publisher labels without accepting either automatically', () => {
    const { id, records } = tiedComic();
    const row = listReview(db).rows.find((r) => r.items[0]?.id === id)!;
    expect(row.kind).toBe('tie');
    expect(row.why).toContain('this series name and issue number');
    expect(row.candidates?.map((c) => [c.year, c.publisher])).toEqual([
      [1996, 'Four Color Press'],
      [2016, 'Lantern House'],
    ]);
    expect(row.evidence).toMatchObject({
      filename: null,
      publisher: null,
      years: [],
      coverFileId: null,
    });
    applyMatchAction(db, id, { action: 'confirm', source: 'metron', sourceId: '2' });
    // A later lookup still honors the owner's choice, and the review stays resolved.
    storeCandidates(db, id, 'metron', decide(matchFactsFor(db, id)!, records).ranked);
    applyIdentity(db, id);
    expect(listReview(db).rows.some((r) => r.items[0]?.id === id)).toBe(false);
    expect(
      db.prepare('SELECT match_override FROM user_item WHERE item_id = ?').pluck().get(id),
    ).toBe('metron:2');
  });

  it('shows stored file facts and a cached cover even when the file is offline', () => {
    const { id } = tiedComic();
    db.prepare(
      `INSERT INTO folders (id, display_path, relative_path, storage_kind, created_at, updated_at)
      VALUES ('folder', '/unavailable', '', 'external', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO files (id, folder_id, rel_path, rel_dir, name, ext, format, size,
      availability, compare_key, first_seen_at, metadata, has_thumbnail, parsed)
      VALUES ('file', 'folder', 'Copperline (2016)/Copperline 001.cbz', 'Copperline (2016)',
      'Copperline 001.cbz', 'cbz', 'cbz', 100, 'missing', 'archangel1', '2026-01-01', ?, 1, '{}')`,
    ).run(
      JSON.stringify({
        title: 'Copperline #1',
        comic: { publisher: 'Lantern House', year: '2016' },
      }),
    );
    db.prepare('INSERT INTO item_files (item_id, file_id, is_primary) VALUES (?, ?, 1)').run(
      id,
      'file',
    );
    expect(reviewEvidence(db, id)).toMatchObject({
      filename: 'Copperline 001.cbz',
      embeddedTitle: 'Copperline #1',
      publisher: 'Lantern House',
      years: [2016],
      coverFileId: 'file',
    });
    db.prepare("UPDATE files SET metadata = NULL, has_thumbnail = 0 WHERE id = 'file'").run();
    expect(reviewEvidence(db, id)).toMatchObject({
      publisher: null,
      embeddedTitle: null,
      coverFileId: null,
    });
  });
});
