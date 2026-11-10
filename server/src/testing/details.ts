import type { DetailFile, DetailInput, DetailMatch } from '../lib/details.ts';

/** All names, source ids and claims are invented. */
export const detailMatch = (
  over: Partial<DetailMatch> = {},
  record: Partial<DetailMatch['record']> = {},
): DetailMatch => ({
  decision: 'accepted',
  strongIsbn: false,
  score: 0.95,
  ...over,
  record: {
    source: 'hardcover',
    sourceId: 'invented-hc',
    title: 'The Copper Observatory',
    authors: ['Ari Quill'],
    subjects: ['Astronomy'],
    isbns: [],
    ...record,
  },
});
export const detailFile = (over: Partial<DetailFile> = {}): DetailFile => ({
  id: 'invented-file',
  metadata: null,
  title: 'The File Observatory',
  creators: [{ name: 'The File Writer', role: 'writer' }],
  pages: 120,
  ...over,
});
export const detailInput = (over: Partial<DetailInput> = {}): DetailInput => ({
  fallbackTitle: 'copperobservatory',
  ownerTitle: null,
  files: [],
  storedCreators: [],
  issue: false,
  matches: [],
  ...over,
});
