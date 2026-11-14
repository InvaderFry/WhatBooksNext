import { buildQuery } from '../identify/match.ts';
import { mergeItems, previewMerge } from './operations.ts';
import { createBackup, restoreBackup } from './backup.ts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DB } from '../db/database.ts';
import { memoryDb } from '../testing/helpers.ts';
import { createStoreItem } from './store.ts';
import {
  identificationContext,
  parseIsbnInput,
  saveIdentificationContext,
  validateIdentificationContext,
} from './identificationContext.ts';

let db: DB;
beforeEach(async () => {
  db = await memoryDb();
});
afterEach(() => db.close());
it('keeps bundle provenance and edition uncertainty without accepting a match', () => {
  const id = createStoreItem(db, { title: 'Ambiguous', store: 'other' });
  saveIdentificationContext(db, id, {
    bundle: 'Humble Comics',
    referenceUrl: 'https://example.com/bundle',
    title: 'Ambiguous Vol. 2',
    author: 'A. Writer',
    isbn: '0-306-40615-2',
    notes: 'Work identified; digital edition uncertain.',
  });
  expect(identificationContext(db, id).context).toMatchObject({
    bundle: 'Humble Comics',
    isbn: '9780306406157',
    notes: 'Work identified; digital edition uncertain.',
  });
  expect(
    db.prepare('SELECT match_override FROM user_item WHERE item_id = ?').pluck().get(id),
  ).toBeNull();
  saveIdentificationContext(db, id, {});
  expect(identificationContext(db, id).context.bundle).toBe('');
});
it('rejects malformed identifiers, unsafe links and unbounded content', () => {
  for (const bad of [
    { isbn: '9780306406158' },
    { referenceUrl: 'javascript:alert(1)' },
    { referenceUrl: 'https://user:password@example.com' },
    { notes: 'x'.repeat(4001) },
    { title: [] },
  ])
    expect(() => validateIdentificationContext(bad)).toThrow();
});

it('restores saved provenance from a backup', async () => {
  const id = createStoreItem(db, { title: 'Ambiguous', store: 'other' });
  saveIdentificationContext(db, id, { bundle: 'Humble Science', notes: 'Second edition' });
  const backup = createBackup(db);
  saveIdentificationContext(db, id, {});
  await restoreBackup(db, backup, null);
  expect(identificationContext(db, id).context).toMatchObject({
    bundle: 'Humble Science',
    notes: 'Second edition',
  });
});

it('carries evidence through merges and requires a choice for conflicting provenance', () => {
  const a = createStoreItem(db, { title: 'Ambiguous', store: 'other' });
  const b = createStoreItem(db, { title: 'Ambiguous', store: 'other' });
  saveIdentificationContext(db, b, { bundle: 'Humble Comics' });
  mergeItems(db, a, b, {});
  expect(identificationContext(db, a).context.bundle).toBe('Humble Comics');
  const c = createStoreItem(db, { title: 'Ambiguous', store: 'other' });
  saveIdentificationContext(db, c, { bundle: 'Different bundle' });
  expect(previewMerge(db, a, c).conflicts.some((x) => x.field === 'identification')).toBe(true);
});

it('invalidates prior lookups when a scan discovers printed ISBNs without promoting them', () => {
  const facts = {
    title: 'Ambiguous',
    titleSource: 'filename' as const,
    authors: [],
    isbns: [],
    isbnCandidates: [] as string[],
    kind: 'nonfiction',
  };
  const before = buildQuery(facts);
  const after = buildQuery({ ...facts, isbnCandidates: ['9780306406157'] });
  expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  expect(after.isbn).toBeUndefined();
});

it('reads an ISBN copied with its printed label, and nothing else around it', () => {
  expect(parseIsbnInput('ISBN-13: 978-0-306-40615-7')).toBe('9780306406157');
  expect(parseIsbnInput('isbn 0-306-40615-2')).toBe('9780306406157');
  expect(parseIsbnInput('  ')).toBeUndefined();
  for (const bad of ['Price 9780306406157', '9780306406158', 'x'.repeat(31)])
    expect(() => parseIsbnInput(bad)).toThrow();
});
