import { DESCRIPTION_USEFUL_CHARS } from '../config.ts';
import { htmlToText, isbn10to13 } from '../scan/formats/text.ts';
import type { EmbeddedMetadata } from '../scan/formats/types.ts';
import { SOURCE_LABELS, type SourceName, type SourceRecord } from '../sources/types.ts';

/** Display selection only. Never writes facts used to search or identify an item. */
export type Creator = { name: string; role?: string };
export type DetailSource = SourceName | 'owner' | 'file' | 'filename';
export interface DetailValue<T> {
  value: T;
  source: DetailSource;
  sourceId: string | null;
  label: string;
  reason: string;
}
export interface DetailMatch {
  record: SourceRecord;
  decision: 'confirmed' | 'accepted' | 'provisional' | 'tie' | 'rejected' | 'unidentified';
  strongIsbn: boolean;
  score: number;
}
export interface DetailFile {
  id: string;
  metadata: EmbeddedMetadata | null;
  /** Already corroborated by the normal file-title rules, including comic issue labels. */
  title: string | null;
  creators: Creator[];
  pages: number | null;
}
export interface DetailInput {
  fallbackTitle: string;
  ownerTitle: string | null;
  /** Primary file first, then other copies in stable order. */
  files: DetailFile[];
  /** Manually entered/imported creators when there is no file. */
  storedCreators: Creator[];
  issue: boolean;
  matches: DetailMatch[];
}
export interface ItemDetails {
  title: DetailValue<{ title: string; subtitle: string | null }>;
  creators: DetailValue<Creator[]> | null;
  firstPublishYear: DetailValue<number> | null;
  years: DetailValue<number>[];
  yearDisagreement: boolean;
  pages: (DetailValue<number> & { measured: boolean }) | null;
  description: DetailValue<string> | null;
  subjects: {
    value: string;
    sources: { source: DetailSource; sourceId: string | null; label: string }[];
  }[];
  /** Kept available for the book page; these never supply a selected fact. */
  suggestions: DetailMatch[];
}

const LABELS: Record<DetailSource, string> = {
  ...SOURCE_LABELS,
  owner: 'Your entry',
  file: 'File metadata',
  filename: 'Filename',
};
function value<T>(
  v: T,
  source: DetailSource,
  sourceId: string | null,
  reason: string,
): DetailValue<T> {
  return { value: v, source, sourceId, label: LABELS[source], reason };
}
const fromMatch = <T>(v: T, m: DetailMatch, reason: string) =>
  value(v, m.record.source, m.record.sourceId, reason);
const nonempty = (s: string | undefined | null) => !!s?.trim();
const positive = (n: number | undefined | null): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;
const isbn = (s: string) => {
  const n = s.replace(/[^0-9Xx]/g, '').toUpperCase();
  return n.length === 10 ? isbn10to13(n) : n;
};

/** Strongest trusted match, not a vote count or an item-level confirmation. */
function strongest(a: DetailMatch, b: DetailMatch): number {
  const preference: SourceName[] = [
    'hardcover',
    'openlibrary',
    'anilist',
    'metron',
    'comicvine',
    'calibre',
    'demo',
  ];
  return (
    Number(b.decision === 'confirmed') - Number(a.decision === 'confirmed') ||
    Number(b.strongIsbn) - Number(a.strongIsbn) ||
    b.score - a.score ||
    preference.indexOf(a.record.source) - preference.indexOf(b.record.source) ||
    a.record.sourceId.localeCompare(b.record.sourceId)
  );
}

export function displayDetailTitle(d: ItemDetails): string {
  const { title, subtitle } = d.title.value;
  return subtitle && !title.toLowerCase().endsWith(subtitle.toLowerCase())
    ? `${title}: ${subtitle}`
    : title;
}

/** Outside descriptions use HTML and simple Markdown; compare their visible text, not markup. */
export function descriptionText(raw: string): string {
  return htmlToText(
    raw
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)([\s\S]*?)\1/g, '$2')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, ''),
  );
}

/** One pure result for Library, cards, details, CSV and Classics. */
export function chooseDetails(input: DetailInput): ItemDetails {
  const trusted = input.matches
    .filter((m) => m.decision === 'confirmed' || m.decision === 'accepted')
    .sort(strongest);
  const calibre = trusted.find((m) => m.record.source === 'calibre');
  const embedded = input.files.find((f) => nonempty(f.title));
  const onlineTitle = trusted.find((m) => nonempty(m.record.title));
  const titleMatch = calibre && nonempty(calibre.record.title) ? calibre : onlineTitle;
  let title: ItemDetails['title'];
  if (nonempty(input.ownerTitle))
    title = value({ title: input.ownerTitle!, subtitle: null }, 'owner', null, 'owner_title');
  else if (calibre && nonempty(calibre.record.title))
    title = fromMatch(
      { title: calibre.record.title, subtitle: calibre.record.subtitle ?? null },
      calibre,
      'calibre_title',
    );
  else if (embedded)
    title = value(
      { title: embedded.title!, subtitle: null },
      'file',
      embedded.id,
      'embedded_title',
    );
  else if (titleMatch)
    title = fromMatch(
      { title: titleMatch.record.title, subtitle: titleMatch.record.subtitle ?? null },
      titleMatch,
      'strongest_match',
    );
  else
    title = value(
      { title: input.fallbackTitle, subtitle: null },
      'filename',
      null,
      'filename_guess',
    );

  const fileCreators = input.files.find((f) => f.creators.length);
  const onlineCreators = trusted.find((m) => m.record.authors.length);
  const creators = calibre?.record.authors.length
    ? fromMatch(
        calibre.record.authors.map((name) => ({ name })),
        calibre,
        'calibre_creators',
      )
    : fileCreators
      ? value(fileCreators.creators, 'file', fileCreators.id, 'embedded_creators')
      : input.storedCreators.length
        ? value(input.storedCreators, 'owner', null, 'entered_creators')
        : onlineCreators
          ? fromMatch(
              onlineCreators.record.authors.map((name) => ({ name })),
              onlineCreators,
              'strongest_match',
            )
          : null;

  // firstPublishYear is an issue's cover/store year in comic adapters; series.startYear stays separate.
  const years = trusted
    .filter(
      (m) => positive(m.record.firstPublishYear) && (!input.issue || m.record.format === 'ISSUE'),
    )
    .map((m) => fromMatch(m.record.firstPublishYear!, m, 'earliest_trusted_year'));
  if (input.issue) {
    for (const f of input.files) {
      const year = Number(f.metadata?.comic?.year);
      if (positive(year)) years.push(value(year, 'file', f.id, 'issue_cover_year'));
    }
  }
  years.sort((a, b) => a.value - b.value);

  const measured = input.files.find((f) => positive(f.pages));
  const fileIsbns = new Set(
    input.files
      .flatMap((f) => f.metadata?.identifiers ?? [])
      .filter(
        (id) =>
          /isbn/i.test(id.scheme) || /^(97[89])?\d{9}[\dXx]$/.test(id.value.replace(/-/g, '')),
      )
      .map((id) => isbn(id.value)),
  );
  const pageMatches = trusted.filter((m) => positive(m.record.pages));
  const isbnPages = pageMatches.find((m) => m.record.isbns.some((id) => fileIsbns.has(isbn(id))));
  const pageMatch = isbnPages ?? pageMatches[0];
  const pages = measured
    ? { ...value(measured.pages!, 'file', measured.id, 'measured_pages'), measured: true }
    : pageMatch
      ? {
          ...fromMatch(
            pageMatch.record.pages!,
            pageMatch,
            isbnPages ? 'file_isbn' : 'strongest_match',
          ),
          measured: false,
        }
      : null;

  // Compare descriptions only after removing HTML, including Calibre's formatting padding.
  const descriptions = trusted
    .map((m) => ({ match: m, text: descriptionText(m.record.description ?? '') }))
    .filter((d) => d.text);
  const hardcover = descriptions.find(
    (d) => d.match.record.source === 'hardcover' && d.text.length >= DESCRIPTION_USEFUL_CHARS,
  );
  const longest = [...descriptions].sort(
    (a, b) => b.text.length - a.text.length || strongest(a.match, b.match),
  )[0];
  const description = hardcover ?? longest;

  const subjects = new Map<string, ItemDetails['subjects'][number]>();
  const addSubject = (raw: string, source: DetailSource, sourceId: string | null) => {
    const text = htmlToText(raw);
    if (!text) return;
    const key = text.toLocaleLowerCase();
    const entry = subjects.get(key) ?? { value: text, sources: [] };
    if (!entry.sources.some((s) => s.source === source && s.sourceId === sourceId))
      entry.sources.push({ source, sourceId, label: LABELS[source] });
    subjects.set(key, entry);
  };
  for (const f of input.files)
    for (const s of [
      ...(f.metadata?.subjects ?? []),
      ...(f.metadata?.comic?.genre ? [f.metadata.comic.genre] : []),
    ])
      addSubject(s, 'file', f.id);
  for (const m of trusted)
    for (const s of m.record.subjects) addSubject(s, m.record.source, m.record.sourceId);

  return {
    title,
    creators,
    firstPublishYear: years[0] ?? null,
    years,
    yearDisagreement: years.length > 1 && years.at(-1)!.value - years[0]!.value > 1,
    pages,
    description: description
      ? fromMatch(
          description.text,
          description.match,
          hardcover ? 'useful_hardcover' : 'longest_description',
        )
      : null,
    subjects: [...subjects.values()],
    suggestions: input.matches.filter((m) => m.decision === 'provisional'),
  };
}
