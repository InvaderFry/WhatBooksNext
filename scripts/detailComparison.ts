import { loadLibrary } from '../server/src/lib/library.ts';
import { loadRankData } from '../server/src/lib/rankData.ts';
import { runMode } from '../server/src/lib/modes.ts';
import { topicsOf } from '../server/src/lib/recommend.ts';
import { tasteFrom } from '../server/src/lib/tune.ts';
import { matchFactsFor } from '../server/src/identify/lookups.ts';
import { memoryDb } from '../server/src/testing/helpers.ts';
import { buildDetailCases } from '../server/src/testing/detailCases.ts';
import { situation } from '../server/src/testing/rank.ts';
import type { DB } from '../server/src/db/database.ts';
import type { EmbeddedMetadata } from '../server/src/scan/formats/types.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Frozen Stage 1 display policy, compared on the same stored facts without changing them. */
export function compareDetails(db: DB) {
  const rows = db
    .prepare(
      'SELECT i.id, i.publication_year, COALESCE(u.kind_override,i.kind) AS kind FROM items i LEFT JOIN user_item u ON u.item_id = i.id ORDER BY i.id',
    )
    .all() as { id: string; publication_year: number | null; kind: string | null }[];
  const beforeFacts = rows.map((r) => matchFactsFor(db, r.id));
  const library = loadLibrary(db, new Map());
  const data = loadRankData(db, new Map());
  const changed = { title: 0, authors: 0, year: 0, pages: 0, description: 0 };
  let kindChanged = 0,
    tasteTopicsChanged = 0;
  const before = data.items.map((i) => {
    const old = library.rankingFacts.get(i.id)!;
    const input = library.detailInputs.get(i.id)!;
    const used = data.used.get(i.id) ?? [];
    const file = db
      .prepare(
        `SELECT f.page_count, f.metadata FROM files f JOIN item_files x ON x.file_id = f.id WHERE x.item_id = ? ORDER BY x.is_primary DESC, f.id`,
      )
      .all(i.id) as { page_count: number | null; metadata: string | null }[];
    const md = file[0]?.metadata ? (JSON.parse(file[0].metadata) as EmbeddedMetadata) : null;
    const oldPages =
      file[0]?.page_count ??
      (file.length ? Math.max(...file.map((f) => f.page_count ?? 0)) || null : null) ??
      used.find((m) => m.record.pages)?.record.pages ??
      null;
    const oldYear = rows.find((r) => r.id === i.id)!.publication_year;
    const oldDescription = used.find((m) => m.record.description)?.record.description ?? null;
    const d = data.details.get(i.id)!;
    if (!same(old.title, i.displayTitle)) changed.title++;
    if (!same(old.creators, d.creators?.value ?? [])) changed.authors++;
    if (!same(oldYear, d.firstPublishYear?.value ?? null)) changed.year++;
    if (!same(oldPages, d.pages?.value ?? null)) changed.pages++;
    if (!same(oldDescription, d.description?.value ?? null)) changed.description++;
    const oldSubjects = [
      ...new Set([
        ...used.flatMap((m) => m.record.subjects),
        ...(md?.subjects ?? []),
        ...(md?.comic?.genre ? [md.comic.genre] : []),
      ]),
    ];
    const original = {
      ...i,
      title: old.title,
      creators: old.creators,
      subjects: oldSubjects,
      firstPublishYear: oldYear,
      displayTitle: old.title,
      displayCreators: old.creators,
    };
    const topics = [
      ...new Set([
        ...oldSubjects,
        ...input.matches.flatMap((m) => m.record.subjects),
        'Copper',
        'Astronomy',
      ]),
    ];
    if (
      !same(topicsOf(original, topics), topicsOf(i, topics)) ||
      !same(oldSubjects, i.subjects) ||
      !same(old.creators, i.creators)
    )
      tasteTopicsChanged++;
    if (rows.find((r) => r.id === i.id)!.kind !== i.kind) kindChanged++;
    return original;
  });
  const opts = { offset: 0, limit: data.items.length };
  const classics = (items: typeof data.items) =>
    new Set(runMode('classics', items, situation(), opts).cards.map((c) => c.id));
  const a = classics(before),
    b = classics(data.items);
  const matchingInputsChanged = rows.filter(
    (r, n) => !same(beforeFacts[n], matchFactsFor(db, r.id)),
  ).length;
  const tasteChanged = !same(
    [...tasteFrom(before, 'normal').signals],
    [...tasteFrom(data.items, 'normal').signals],
  );
  return {
    items: data.items.length,
    changed,
    classics: {
      before: a.size,
      after: b.size,
      entering: [...b].filter((id) => !a.has(id)).length,
      leaving: [...a].filter((id) => !b.has(id)).length,
    },
    kindChanged,
    tasteTopicsChanged,
    tasteChanged,
    matchingInputsChanged,
  };
}

export async function reportDetailChanges() {
  const db = await memoryDb();
  try {
    buildDetailCases(db);
    const result = compareDetails(db);
    console.log(
      '\nStage 2 before/after — invented stored-detail fixtures only (title-free; not owner-library counts)',
    );
    console.log(JSON.stringify(result, null, 2));
    if (
      result.kindChanged ||
      result.tasteTopicsChanged ||
      result.tasteChanged ||
      result.matchingInputsChanged
    )
      throw new Error('Display selection changed kind, taste/topics or matching inputs.');
  } finally {
    db.close();
  }
}
