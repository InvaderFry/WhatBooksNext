import type { DB } from '../db/database.ts';
import { applyIdentity, storeCandidates } from '../identify/lookups.ts';
import { parseFilename } from '../identify/filename.ts';
import { refreshFactsOfItems } from '../identify/items.ts';
import { createStoreItem } from '../lib/store.ts';
import { ensureUserRow } from '../lib/progress.ts';
import type { DetailFile, DetailMatch } from '../lib/details.ts';
import { detailFile, detailMatch } from './details.ts';

/** A stored, invented corpus: selectors read it without file access, lookups or migrations. */
export function buildDetailCases(db: DB) {
  db.prepare(
    `INSERT INTO folders (id,display_path,relative_path,storage_kind,created_at,updated_at)
    VALUES ('detail-fixtures','/invented-library','','local','2026-11-10','2026-11-10')`,
  ).run();
  const ids: Record<string, string> = {};
  function add(
    name: string,
    matches: DetailMatch[],
    file?: DetailFile,
    ownerTitle?: string,
    issue = false,
  ) {
    const id = createStoreItem(db, {
      title: `Filename ${name}`,
      kind: issue ? 'comic' : 'fiction',
      store: 'kindle',
    });
    ids[name] = id;
    db.prepare("UPDATE items SET title_source = 'filename' WHERE id = ?").run(id);
    if (file) {
      const filename = `${name}.epub`;
      const fileId = `detail-file-${name}`;
      db.prepare(
        `INSERT INTO files (id,folder_id,rel_path,rel_dir,name,ext,format,size,availability,
        parsed,compare_key,first_seen_at,metadata,page_count)
        VALUES (?, 'detail-fixtures', ?, '', ?, 'epub', 'epub', 100, 'present', ?, ?, '2026-11-10', ?, ?)`,
      ).run(
        fileId,
        filename,
        filename,
        JSON.stringify(parseFilename(filename)),
        name,
        JSON.stringify(file.metadata),
        file.pages,
      );
      db.prepare('INSERT INTO item_files (item_id,file_id,is_primary) VALUES (?,?,1)').run(
        id,
        fileId,
      );
      refreshFactsOfItems(db, [id]);
    }
    if (issue) db.prepare("UPDATE items SET issue_label = '1' WHERE id = ?").run(id);
    for (const source of new Set(matches.map((m) => m.record.source))) {
      const ms = matches.filter((m) => m.record.source === source);
      storeCandidates(
        db,
        id,
        source,
        ms.map((m) => ({
          score: m.score,
          evidence: {
            title: 1,
            author: 'agrees',
            isbn: m.strongIsbn ? 'strong' : 'none',
            notes: [],
          },
          record: {
            ...m.record,
            sourceId: `${name}-${m.record.sourceId}`,
            rating: { value: 4.8, scale: 5, count: 100, scope: 'book' },
          },
        })),
      );
    }
    const confirmed = matches.find((m) => m.decision === 'confirmed');
    if (confirmed || ownerTitle) {
      ensureUserRow(db, id);
      if (confirmed)
        db.prepare('UPDATE user_item SET match_override = ? WHERE item_id = ?').run(
          `${confirmed.record.source}:${name}-${confirmed.record.sourceId}`,
          id,
        );
      if (ownerTitle)
        db.prepare('UPDATE user_item SET title_override = ? WHERE item_id = ?').run(ownerTitle, id);
    }
    applyIdentity(db, id);
    return id;
  }
  const hc = (
    record: Parameters<typeof detailMatch>[1] = {},
    over: Parameters<typeof detailMatch>[0] = {},
  ) => detailMatch(over, record);
  const ol = (
    record: Parameters<typeof detailMatch>[1] = {},
    over: Parameters<typeof detailMatch>[0] = {},
  ) => detailMatch(over, { source: 'openlibrary', sourceId: 'invented-ol', ...record });
  const calibre = hc({
    source: 'calibre',
    sourceId: 'invented-calibre',
    title: 'Calibre Copper Observatory',
    authors: ['Curated Writer'],
    description: '<p>A short curated description.</p>',
  });
  const file = detailFile({
    metadata: {
      title: 'Embedded Copper Observatory',
      creators: [{ name: 'Embedded Writer' }],
      subjects: ['File topic'],
      identifiers: [{ scheme: 'isbn', value: '9780000000002' }],
    },
  });
  add('owner', [hc(), calibre], file, 'Owner Copper Observatory');
  add('calibre', [hc(), calibre], file);
  add('embedded', [hc()], file);
  add('trusted', [
    ol({
      title: 'Open Copper Observatory',
      authors: ['Trusted Writer'],
      pages: 400,
      firstPublishYear: 1990,
    }),
  ]);
  add('provisional', [
    hc(
      {
        title: 'Unconfirmed Copper Observatory',
        authors: ['Unconfirmed Writer'],
        firstPublishYear: 1800,
        pages: 900,
        description: 'Unconfirmed prose',
        subjects: ['Provisional topic'],
      },
      { score: 0.75, decision: 'provisional' },
    ),
  ]);
  add('strongest', [
    hc(),
    ol(
      { title: 'Confirmed Copper Observatory', subtitle: 'From One Record' },
      { decision: 'confirmed' },
    ),
  ]);
  add('pages', [hc({ pages: 500 }), ol({ pages: 240, isbns: ['9780000000002'] })], {
    ...file,
    pages: null,
  });
  add('measured', [hc({ pages: 500 })], file);
  add('year', [
    hc({ firstPublishYear: 2005 }),
    ol({ firstPublishYear: 1990 }),
    detailMatch(
      { decision: 'provisional', score: 0.75 },
      { source: 'anilist', sourceId: 'invented-al', firstPublishYear: 1800 },
    ),
  ]);
  add(
    'issue',
    [
      detailMatch(
        {},
        {
          source: 'metron',
          sourceId: 'invented-issue',
          format: 'ISSUE',
          firstPublishYear: 2019,
          series: { name: 'Copper Observatory', startYear: 1980 },
        },
      ),
    ],
    detailFile({
      metadata: {
        comic: { series: 'Copper Observatory', number: '1', year: '2019', volume: '1980' },
      },
    }),
    undefined,
    true,
  );
  add('description', [
    hc({ description: 'Useful Hardcover description. '.repeat(10) }),
    ol({ description: 'A longer alternative. '.repeat(30) }),
    calibre,
  ]);
  add('markup', [
    hc({ description: '<p><b>Brief</b></p><script>bad()</script>' }),
    ol({ description: '**Longer**, plain text wins.' }),
    calibre,
  ]);
  add('tie', [
    hc({ title: 'Copper Observatory', authors: ['Cora Pell'] }),
    hc(
      { sourceId: 'invented-rival', title: 'Copper Observatory', authors: ['Nima Ocho'] },
      { score: 0.94 },
    ),
  ]);
  const rejected = add('rejected', [hc({ description: 'Rejected prose' })]);
  db.prepare(
    "INSERT INTO candidates_rejected (item_id,source,source_id,created_at) VALUES (?, 'hardcover', 'rejected-invented-hc','2026-11-10')",
  ).run(rejected);
  applyIdentity(db, rejected);
  return ids;
}
