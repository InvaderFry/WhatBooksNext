import { splitWords, wordRank } from './wordsplit.ts';

/**
 * Filename parser (PLAN.md §11.1, extended with the patterns found in the M0 probe).
 * Every part carries a confidence; the raw name is always kept. The output is a guess for
 * display and matching — embedded metadata and sources outrank it (§11.2).
 */

/**
 * Version of the parser's rules. Raise it whenever the rules change: the next scan then reads
 * every file name again and refreshes titles taken from file names (owner corrections are kept).
 *   1 — M1.  2 — fixes from the owner's first real scan ("Series - 12", "Series - Subtitle",
 *   ranges, "Book 1 - Title", hyphens inside words, …).  3 — tags removed only where tags appear,
 *   never as title words ("The High Road" no longer matches "The Road").  4 — one shared
 *   trailing-tag rule for titles and grouping (end of name only: "road_to_low_orbit" is a title).
 *   5 — a stray single letter from the word splitter joins the word before it
 *   ("rickandmorty" was "Rick and Mort Y").
 */
export const PARSER_VERSION = 6;

export interface Part<T> {
  value: T;
  /** 0–1 heuristic: 0.9 explicit marker, 0.6 inferred, 0.3 word-split guess. */
  confidence: number;
}

export interface TitleAuthor {
  title: string;
  author: string;
}

export interface ParsedName {
  raw: string;
  ext: string;
  title: Part<string>;
  /** Raw (unsplit) title text, kept alongside the split guess. */
  rawTitle: string;
  series?: Part<string>;
  subtitle?: Part<string>;
  /** A book volume ("vol1", "v01", "Vol. 1", "book1"). */
  volume?: Part<string>;
  /** A comic's series volume, as in "Series V1 17" (volume 1 of the series, issue 17). */
  seriesVolume?: Part<string>;
  issue?: Part<string>;
  year?: Part<number>;
  /** Year joined to a series name ("series1992_issue5"): the series' start year (§8). */
  startYear?: Part<number>;
  /** "Author - Title" / "Title - Author" is ambiguous: both readings, likelier first. */
  authorTitle?: TitleAuthor[];
  /** Quality tag such as "HD" (recorded on the file, ignored when comparing names). */
  quality?: string;
  editionNumber?: number;
  editionNote?: string;
  /** An issue file naming the collected volume it belongs to ("012 Vol. 3 Low Tide"). */
  tradeHint?: { volume: string; title?: string };
  /** Tags that were stripped: release groups, "Digital", size tags, Humble ids, duplicates. */
  tags: string[];
  /** Key for comparing names within a folder (§11.3 rule 2): tags removed, letters+digits only. */
  compareKey: string;
}

const QUALITY_TOKENS = new Set(['hd', 'hq', 'hires', 'highres']);
/**
 * Smaller or lower-quality versions of the same file (Humble's "optimized" PDFs, "-low"
 * comics). Recorded as the file's quality, like HD, so they group with the full version and
 * are never chosen to open first.
 */
const REDUCED_QUALITY: Record<string, string> = {
  optimized: 'OPTIMIZED',
  opt: 'OPTIMIZED',
  downsampled: 'DOWNSAMPLED',
  lowres: 'LOW-RES',
  low: 'LOW',
};
/** A "-high" version is the better one, like HD. */
const HIGH_QUALITY: Record<string, string> = { high: 'HIGH' };

/**
 * How a quality tag ranks for opening: 1 for a better version (HD, HIGH…), -1 for a reduced
 * one (OPTIMIZED, LOW…), 0 for none or unknown.
 */
export function qualityRank(tag: string | null | undefined): number {
  if (!tag) return 0;
  const t = tag.toUpperCase();
  if (Object.values(REDUCED_QUALITY).includes(t)) return -1;
  return 1;
}

function qualityOf(token: string): string | undefined {
  const t = normalizeForCompare(token);
  if (QUALITY_TOKENS.has(t)) return t.toUpperCase();
  return REDUCED_QUALITY[t] ?? HIGH_QUALITY[t];
}
const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};
const NOTE_EDITIONS = [
  'updated',
  'deluxe',
  'completecolor',
  'complete',
  'omnibus',
  'special',
  'new',
  'revised',
  'expanded',
  'collectors',
  'definitive',
  'anniversary',
];
const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december';

/** Lowercase, letters and digits only. Used for every name comparison. */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Title comparison key: normalised, with a leading article stripped — and a trailing one,
 * the library-sort form (§11.1). Otherwise "boatofamillionyears" never matches
 * "The Boat of a Million Years".
 */
export function titleCompareKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length > 1 && ['the', 'a', 'an'].includes(words[0]!)) words.shift();
  if (words.length > 1 && ['the', 'a', 'an'].includes(words.at(-1)!)) words.pop();
  let key = words.join('');
  // Run-together text keeps its article glued on: "theboatof..." / "...breakthroughsthe".
  if (words.length === 1) {
    const m = /^(the|an|a)(.{4,})$/.exec(key);
    if (m && !/^(an|a)$/.test(m[1]!)) key = m[2]!;
  }
  return key;
}

function cap(word: string, first: boolean): string {
  const small = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'of',
    'in',
    'on',
    'to',
    'for',
    'at',
    'by',
    'with',
    'vs',
  ]);
  if (!first && small.has(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Title case for display, used only when the name gave no casing of its own. */
export function titleCase(s: string): string {
  const words = s.split(' ');
  return words.map((w, i) => cap(w, i === 0 || words[i - 1]!.endsWith(':'))).join(' ');
}

function splitOrdinal(t: string): number | null {
  const m = /^(\d+)(st|nd|rd|th)$/.exec(t);
  if (m) return Number(m[1]);
  return ORDINAL_WORDS[t] ?? null;
}

/** Pulls an edition marker off the end of a run-together segment, e.g. "javafordummies2ndedition". */
function extractEdition(seg: string): { rest: string; number?: number; note?: string } | null {
  const m = /^(.*?)(\d+(?:st|nd|rd|th)|[a-z]+?)(anniversary)?edition(\d*)$/.exec(seg);
  if (!m) return null;
  const [, rest = '', marker = '', anniversary] = m;
  if (anniversary) {
    return { rest, note: `${marker} anniversary edition` };
  }
  const n = splitOrdinal(marker);
  if (n !== null) return { rest, number: n };
  // "completecoloredition" -> "complete color edition"; marker may have swallowed title text.
  for (const note of NOTE_EDITIONS) {
    if (marker.endsWith(note)) {
      return {
        rest: rest + marker.slice(0, marker.length - note.length),
        note: `${splitWords(note).join(' ')} edition`,
      };
    }
  }
  return null;
}

function words(text: string): { value: string; split: boolean } {
  if (/\s/.test(text.trim()) || !/^[a-z0-9]+$/.test(text))
    return { value: text.trim(), split: false };
  if (text.length <= 6 || /^\d+$/.test(text)) return { value: text, split: false };
  return { value: splitWords(text).join(' '), split: true };
}

/** Moves a trailing article to the front: "art of change ... the" -> "the art of change ...". */
function fixTrailingArticle(s: string): string {
  const m = /^(.*\S)\s+(the)$/.exec(s);
  return m ? `${m[2]} ${m[1]}` : s;
}

export function parseFilename(fileName: string): ParsedName {
  const raw = fileName;
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  let base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const tags: string[] = [];
  const result: Partial<ParsedName> = {};

  // Download duplicate: "name(1)" / "name (1)" — a browser's "file exists" suffix.
  const dup = /\s?\((\d{1,2})\)$/.exec(base);
  if (dup) {
    tags.push(`duplicate(${dup[1]})`);
    base = base.slice(0, dup.index);
  }

  // Bracketed tags: years, (Digital), quality, release groups.
  base = base.replace(/[([]([^)\]]*)[)\]]/g, (_m, inner: string) => {
    const t = inner.trim();
    const y = /^(19|20)\d\d$/.exec(t);
    if (y && !result.year) result.year = { value: Number(t), confidence: 0.8 };
    else if (QUALITY_TOKENS.has(normalizeForCompare(t))) result.quality = t.toUpperCase();
    else if (qualityOf(t)) {
      result.quality ??= qualityOf(t);
      tags.push(t);
    } else if (t) tags.push(t);
    return ' ';
  });
  base = base.replace(/\s+/g, ' ').trim();

  // Quality/size tags and Humble ids at the end of the name (shared with compareKeyFor).
  const trailing = stripTrailingTags(base);
  base = trailing.base;
  if (trailing.quality) result.quality = trailing.quality;
  tags.push(...trailing.tags);

  const spaced =
    /\s/.test(base) ||
    /_-_/.test(base) ||
    (/-/.test(base) && !/_/.test(base) && (base.match(/-/g)?.length ?? 0) >= 2);
  if (spaced) parseSpaced(base.replace(/_-_/g, ' - ').replace(/_/g, ' '), ext, result, tags);
  else parseSlug(base, result, tags);

  const parsed = result as ParsedName;
  parsed.raw = raw;
  parsed.ext = ext;
  parsed.tags = tags;
  parsed.rawTitle = parsed.rawTitle ?? base;
  parsed.title = parsed.title ?? { value: base, confidence: 0.3 };
  parsed.compareKey = compareKeyFor(fileName);
  return parsed;
}

/** "one".."twelve" as written in names like "march_book_two" or "marchbooktwo". */
const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * A marker and its number in separate underscored segments ("March_Book_2", "saga_vol_2",
 * "march_book_two") become one segment ("book2", "vol2") for the rules below. A number word
 * joined to "book" ("booktwo") is read the same way. Only "book", "vol" and "volume": a bare
 * number after other words is too often part of a title.
 */
function joinMarkers(segs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!.toLowerCase();
    const next = segs[i + 1]?.toLowerCase();
    const n = next === undefined ? null : /^\d{1,3}$/.test(next) ? next : COUNT_WORDS[next];
    if ((s === 'book' || s === 'vol' || s === 'volume') && n !== null && n !== undefined && i > 0) {
      out.push(`${s}${n}`);
      i++;
      continue;
    }
    const w = /^book([a-z]+)$/.exec(s);
    if (w && COUNT_WORDS[w[1]!] !== undefined && i > 0) {
      out.push(`book${COUNT_WORDS[w[1]!]}`);
      continue;
    }
    out.push(segs[i]!);
  }
  return out;
}

/** Humble-style slugs: "series_vol1_subtitle", "title_issue3", "runtogethertitle". */
function parseSlug(base: string, r: Partial<ParsedName>, tags: string[]) {
  const segs = joinMarkers(base.split('_').filter(Boolean));
  const textSegs: string[] = [];
  let markerIndex = -1;

  for (let i = 0; i < segs.length; i++) {
    // Trailing tags were already removed (stripTrailingTags); a tag word in the middle of a
    // name is a title word ("road_to_low_orbit").
    const seg = segs[i]!;
    const s = seg.toLowerCase();
    // A trailing "_new" (Humble's marker for a newer edition) is an edition note, not a subtitle.
    if (s === 'new' && i === segs.length - 1 && i > 0) {
      r.editionNote = 'new edition';
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^s(\d+)vol(\d+)$/.exec(s.replace(/^.*-/, '')))) {
      const prefix = s.includes('-') ? s.slice(0, s.lastIndexOf('-')) : '';
      if (prefix) textSegs.push(prefix);
      r.seriesVolume = { value: `season ${m[1]}`, confidence: 0.6 };
      r.volume = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.8 };
      markerIndex = markerIndex < 0 ? i : markerIndex;
      continue;
    }
    if ((m = /^(.*?)vol(?:ume)?(\d+)(.*)$/.exec(s))) {
      if (m[1]) textSegs.push(m[1].replace(/[-.]+$/, ''));
      let vol = m[2]!.replace(/^0+(?=\d)/, '');
      const next = segs[i + 1];
      if (next && /^\d{1,2}$/.test(next) && !m[3]) {
        vol = `${vol}.${next}`; // "vol1_5" -> 1.5
        i++;
      }
      r.volume = { value: vol, confidence: 0.9 };
      // Leftovers such as "part2", "tp", "tpdigital" are kept as tags, not title text.
      if (m[3]) tags.push(m[3]);
      markerIndex = markerIndex < 0 ? i : markerIndex;
      continue;
    }
    if ((m = /^(.*?)(?:free)?issue(\d*)$/.exec(s))) {
      if (m[1]) textSegs.push(m[1].replace(/[-.]+$/, ''));
      let num = m[2] ?? '';
      if (!num && segs[i + 1] && /^\d+$/.test(segs[i + 1]!)) num = segs[++i]!;
      if (num) {
        r.issue = { value: num.replace(/^0+(?=\d)/, ''), confidence: 0.9 };
        markerIndex = markerIndex < 0 ? i : markerIndex;
        continue;
      }
    }
    if (s === 'special' && segs[i + 1] && /^\d+$/.test(segs[i + 1]!)) {
      r.issue = { value: `Special ${segs[++i]}`, confidence: 0.7 };
      markerIndex = markerIndex < 0 ? i : markerIndex;
      continue;
    }
    if ((m = /^book(\d+)$/.exec(s))) {
      r.volume = { value: m[1]!.replace(/^0+(?=\d)/, ''), confidence: 0.7 };
      markerIndex = markerIndex < 0 ? i : markerIndex;
      continue;
    }
    const ed = extractEdition(s);
    if (ed) {
      if (ed.number) r.editionNumber = ed.number;
      if (ed.note) r.editionNote = ed.note;
      if (ed.rest) textSegs.push(ed.rest);
      continue;
    }
    if (/^v\d{1,3}$/.test(s)) {
      // "_V2" after a title: a volume/version marker
      r.volume = { value: s.slice(1).replace(/^0+(?=\d)/, ''), confidence: 0.5 };
      markerIndex = markerIndex < 0 ? i : markerIndex;
      continue;
    }
    if (markerIndex >= 0)
      textSegs.push(`\u0000${seg}`); // after a marker: subtitle text
    else textSegs.push(seg);
  }

  const before = textSegs.filter((t) => !t.startsWith('\u0000'));
  const after = textSegs.filter((t) => t.startsWith('\u0000')).map((t) => t.slice(1));
  const hasMarker = Boolean(r.volume || r.issue);

  // Series name with a joined start year: "harbinger1992" + issue
  let head = before[0] ?? '';
  if (hasMarker && before.length === 1) {
    const y = /^(.*[a-z])((?:19|20)\d\d)$/.exec(head.toLowerCase());
    if (y) {
      r.startYear = { value: Number(y[2]), confidence: 0.6 };
      head = y[1]!;
    }
  }
  const headParts = [head, ...before.slice(1)].filter(Boolean);
  const split = headParts.map((p) => words(p.toLowerCase()));
  const headText = split.map((w) => w.value).join(' ');
  const wasSplit = split.some((w) => w.split);
  const restText = after.map((p) => words(p.toLowerCase()).value).join(' ');

  r.rawTitle = headParts.join(' ');
  if (hasMarker) {
    r.series = { value: headText, confidence: wasSplit ? 0.4 : 0.6 };
    if (restText) r.subtitle = { value: restText, confidence: 0.5 };
    r.title = { value: headText, confidence: wasSplit ? 0.3 : 0.5 };
  } else {
    let title = headText;
    let subtitle = '';
    if (split.length > 1) {
      title = split[0]!.value;
      subtitle = split
        .slice(1)
        .map((w) => w.value)
        .join(' ');
    }
    // "artofchange_transformingparadoxes...the": the trailing article belongs to the whole title.
    if (/\sthe$/.test(subtitle)) {
      subtitle = subtitle.replace(/\s+the$/, '');
      title = `the ${title}`;
    } else title = fixTrailingArticle(title);
    r.title = { value: title, confidence: wasSplit ? 0.3 : 0.5 };
    if (subtitle) r.subtitle = { value: subtitle, confidence: 0.4 };
  }
}

/** Spaced names: "Series 001 (2012)", "Series V1 17", "Title - Author", "Series #4". */
function parseSpaced(base: string, ext: string, r: Partial<ParsedName>, tags: string[]) {
  // Hyphens are word separators only in an all-hyphen name ("The-Tin-Orchard-124"). In names
  // with spaces or underscores they belong to words ("4-Hour", "Comic-Con") or ranges ("1-25").
  const hyphenSlug = !/[\s_]/.test(base);
  let s = hyphenSlug
    ? base.replace(/-/g, (m, i: number, str: string) =>
        str[i - 1] === ' ' || str[i + 1] === ' ' ? m : ' ',
      )
    : base;
  s = s.replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;

  // A range of volumes in one archive: "Series 1-25"
  if ((m = /^(.+?) (\d{1,3})-(\d{1,3})$/.exec(s)) && Number(m[2]) < Number(m[3])) {
    r.series = { value: cleanSeries(m[1]!), confidence: 0.7 };
    r.volume = { value: `${Number(m[2])}–${Number(m[3])}`, confidence: 0.6 };
    r.title = { value: r.series.value, confidence: 0.6 };
    r.rawTitle = m[1]!;
    return;
  }

  // A release date at the end: ", November 24, 2004"
  if ((m = new RegExp(`,? ((?:${MONTHS}) \\d{1,2}, ((?:19|20)\\d\\d))$`, 'i').exec(s))) {
    tags.push(m[1]!);
    if (!r.year) r.year = { value: Number(m[2]), confidence: 0.6 };
    s = s.slice(0, m.index).trim();
  }

  // Issue file naming its trade: "Series 012 Vol. 3 Arc Name"
  if ((m = /^(.+?) (\d{2,4}(?:-\d+)?) Vol\.? ?(\d+) ?(.*)$/i.exec(s))) {
    r.series = { value: m[1]!, confidence: 0.8 };
    r.issue = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.85 };
    r.tradeHint = { volume: m[3]!, ...(m[4] ? { title: m[4].replace(/,$/, '').trim() } : {}) };
    r.title = { value: `${m[1]} #${r.issue.value}`, confidence: 0.7 };
    r.rawTitle = m[1]!;
    return;
  }

  // Series volume + issue: "Series V1 17", "Series v2 09", "Series v1 04b - Subtitle"
  if ((m = /^(.+?) [Vv](\d{1,2}) (\d{1,4}[a-z]?)(?: - (.+))?$/.exec(s))) {
    r.series = { value: m[1]!, confidence: 0.8 };
    r.seriesVolume = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.8 };
    r.issue = { value: m[3]!.replace(/^0+(?=\d)/, ''), confidence: 0.8 };
    if (m[4]) r.subtitle = { value: m[4], confidence: 0.6 };
    r.title = { value: `${m[1]} v${r.seriesVolume.value} #${r.issue.value}`, confidence: 0.7 };
    r.rawTitle = m[1]!;
    return;
  }

  // "Book" with a number, spelled or not: "March Book Two", "March - Book 2", "Saga, Book One -
  // Arc". The series name comes first; "Book Two" alone (no name before it) isn't a series.
  if (
    (m = new RegExp(
      `^(.+?)[ ,:-]+Book (\\d{1,3}|${BOOK_NUMBER_WORDS.join('|')})(?:[ :-]+(.+))?$`,
      'i',
    ).exec(s)) &&
    !/^(the|a|an)$/i.test(m[1]!.trim())
  ) {
    const n = /^\d+$/.test(m[2]!)
      ? m[2]!.replace(/^0+(?=\d)/, '')
      : String(BOOK_NUMBER_WORDS.indexOf(m[2]!.toLowerCase()) + 1);
    r.series = { value: cleanSeries(m[1]!), confidence: 0.7 };
    r.volume = { value: n, confidence: 0.7 };
    if (m[3]) r.subtitle = { value: m[3].replace(/^- /, ''), confidence: 0.6 };
    r.title = { value: r.series.value, confidence: 0.6 };
    r.rawTitle = m[1]!;
    return;
  }

  // Book volume: "Berserk v01", "Series Vol. 2 Subtitle"
  if ((m = /^(.+?) (?:[Vv](\d{1,3})|[Vv]ol(?:ume)?\.? ?(\d{1,3}))(?: (.+))?$/.exec(s))) {
    r.series = { value: cleanSeries(m[1]!), confidence: 0.8 };
    r.volume = { value: (m[2] ?? m[3])!.replace(/^0+(?=\d)/, ''), confidence: 0.85 };
    if (m[4]) r.subtitle = { value: m[4].replace(/^- /, ''), confidence: 0.6 };
    r.title = { value: r.series.value, confidence: 0.6 };
    r.rawTitle = m[1]!;
    return;
  }

  // Numbered installment with a dash: "Series - 12", "Series 01 - Subtitle". Collected volumes
  // in practice (manga, trades); an issue run would use 3-digit numbers or "#".
  if ((m = /^([^-]+?) - (\d{1,3})$/.exec(s)) || (m = /^([^-]+?) (\d{1,3}) - (.+)$/.exec(s))) {
    // "Book 1 - Real Title": the word is a generic marker, so the subtitle *is* the title.
    if (/^(book|volume|vol\.?|part|tome)$/i.test(m[1]!.trim()) && m[3]) {
      r.volume = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.6 };
      r.title = { value: m[3], confidence: 0.6 };
      r.rawTitle = m[3];
      return;
    }
    r.series = { value: cleanSeries(m[1]!), confidence: 0.7 };
    r.volume = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.5 };
    if (m[3]) r.subtitle = { value: m[3], confidence: 0.6 };
    r.title = { value: r.series.value, confidence: 0.6 };
    r.rawTitle = m[1]!;
    return;
  }

  // Issue: "Series 001", "Series #4". Two digits only when zero-padded ("05") or the file is a
  // comic archive ("Series 10.cbr"), so "Catch 22.epub" stays a title. A bare 19xx/20xx is a
  // year, not an issue, unless written "#1991".
  if ((m = /^(.+?) (#?)(\d{1,4})$/.exec(s))) {
    const num = m[3]!;
    const isYear = /^(19|20)\d\d$/.test(num) && !m[2];
    const looksLikeIssue =
      Boolean(m[2]) ||
      num.length === 3 ||
      /^0\d$/.test(num) ||
      (COMIC_EXTS.has(ext) && num.length <= 3);
    if (isYear) {
      if (!r.year) r.year = { value: Number(num), confidence: 0.6 };
      s = m[1]!;
    } else if (looksLikeIssue) {
      r.series = { value: cleanSeries(m[1]!), confidence: 0.8 };
      r.issue = { value: num.replace(/^0+(?=\d)/, ''), confidence: 0.85 };
      r.title = { value: `${r.series.value} #${r.issue.value}`, confidence: 0.7 };
      r.rawTitle = m[1]!;
      return;
    }
  }

  // "Title - Author", "Author - Title" or "Series - Subtitle": ambiguous, so keep both readings
  // (§11.1). The display title drops the right-hand side only when it clearly is a person's name;
  // otherwise it shows both parts ("Batman: The Killing Joke") rather than lose a subtitle.
  if ((m = /^(.+?) - (.+)$/.exec(s))) {
    const a = m[1]!.trim();
    const b = m[2]!.trim();
    const first: TitleAuthor = { title: a, author: b };
    const second: TitleAuthor = { title: b, author: a };
    // In a comic archive, "Series - Subtitle" is the convention; authors aren't in these names.
    const comic = COMIC_EXTS.has(ext);
    // When both sides could be names, a middle initial decides which one is the author.
    const initial = (t: string) => / [A-Z]\. /.test(` ${t} `);
    const bIsAuthor =
      looksLikePersonName(b) && (!looksLikePersonName(a) || (initial(b) && !initial(a)));
    // The usual order is "Title - Author", so the left side counts as the author only on a strong
    // sign: an initial ("Robert C. Martin"), "Martin, Robert", or "SURNAME First".
    const strongName = (t: string) =>
      initial(t) || /^[A-Z][a-z]+, [A-Z]/.test(t) || /^[A-Z]{2,} [A-Z][a-z]+$/.test(t);
    const aIsAuthor = strongName(a) && !strongName(b);
    if (!comic && bIsAuthor) {
      r.authorTitle = [first, second];
      r.title = { value: a, confidence: 0.6 };
    } else if (!comic && aIsAuthor) {
      r.authorTitle = [second, first];
      r.title = { value: b, confidence: 0.6 };
    } else {
      r.authorTitle = [first, second];
      r.title = { value: `${a}: ${b.replace(/ - /g, ': ')}`, confidence: 0.4 };
    }
    r.rawTitle = s;
    return;
  }

  r.title = { value: s, confidence: 0.5 };
  r.rawTitle = s;
}

const COMIC_EXTS = new Set(['cbz', 'cbr', 'cb7', 'zip', 'rar']);
const NAME_STOPWORDS = new Set(
  'the a an of and or to in on for with at by from vs my your our his her their this that is are be how what why when who where into over under after before about all no not new'.split(
    ' ',
  ),
);

/** Spelled-out installment numbers seen in names ("Book Two"). */
const BOOK_NUMBER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

function cleanSeries(s: string): string {
  return s.replace(/[\s-]+$/, '').trim();
}

/**
 * Is this text plausibly a person's name? "Robert C. Martin", "Martin, Robert", or — for
 * lowercase slugs — 2–4 plain words with no small connecting words and at least one word that
 * is rare in English ("john scalzi"). Numbers are never names. A guess, used only to decide what
 * to show; both readings are kept for matching.
 */
export function looksLikePersonName(t: string): boolean {
  if (/\d/.test(t)) return false;
  // Title case: a middle initial ("Robert C. Martin") is a strong sign; otherwise it needs a
  // rare word, like the lowercase case below.
  if (/^[A-Z][a-z]+ (?:[A-Z]\. )+[A-Z][a-z'-]+$/.test(t)) return true;
  if (/^[A-Z][a-z]+, [A-Z]/.test(t)) return true;
  const words = t.toLowerCase().split(/\s+/);
  if (words.length < 2 || words.length > 4 || !words.every((w) => /^[a-z'.-]+$/.test(w)))
    return false;
  if (hasStopword(t)) return false;
  return words.some((w) => (wordRank(w) ?? Infinity) > RARE_WORD_RANK);
}

function hasStopword(t: string): boolean {
  return t
    .toLowerCase()
    .split(/\s+/)
    .some((w) => NAME_STOPWORDS.has(w));
}

/** Words ranked below this in English frequency count as rare (surnames mostly are). */
const RARE_WORD_RANK = 20_000;

/**
 * Comparison key for grouping files of one book in one folder (§11.3 rule 2): the base name
 * with quality and size tags, Humble ids and download-duplicate suffixes removed.
 */
export function compareKeyFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  let base = (dot > 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
  base = base.replace(/\s?\(\d{1,2}\)$/, '');
  // A bracket holding only a tag, "(HQ)" / "[Digital]".
  base = base.replace(new RegExp(`[([]\\s*(?:${JOINED_TAGS})\\s*[)\\]]`, 'g'), ' ').trim();
  // Then the same trailing-tag rule the parser uses, so titles and grouping always agree.
  const key = normalizeForCompare(stripTrailingTags(base).base);
  return key || normalizeForCompare(fileName);
}

/**
 * Tags are recognised only at the END of a name, repeatedly ("unity_vol1_hd_1410891143" ->
 * "unity_vol1"), never in the middle, where the same words are title words: "The High Road",
 * "road_to_low_orbit", "Going Digital". Joined by "-" or "_" any known tag counts; after a space
 * only words that are never ordinary title endings do ("Map Making optimized", "Saga 001 HD").
 * Used by both the parser and compareKeyFor, so displayed titles and grouping can't disagree.
 */
const JOINED_TAGS =
  'high[-_ ]?definition|hi-?res|high-?res|lowres|downsampled|optimized|ebook|digital|high|low|hd|hq|opt|\\d{10}';
const SPACED_TAGS = 'hi-?res|high-?res|lowres|downsampled|optimized|hd|hq|opt';

export function stripTrailingTags(input: string): {
  base: string;
  quality?: string;
  tags: string[];
} {
  let base = input.trim();
  let quality: string | undefined;
  const tags: string[] = [];
  const joined = new RegExp(`[-_](${JOINED_TAGS})$`, 'i');
  const spaced = new RegExp(` (${SPACED_TAGS})$`, 'i');
  for (;;) {
    const m = joined.exec(base) ?? spaced.exec(base);
    if (!m || m.index === 0) break; // never strip the whole name
    const t = m[1]!.toLowerCase().replace(/[-_ ]/g, '');
    if (/^\d{10}$/.test(t)) {
      tags.push(`humble-id ${t}`); // looks like a Unix timestamp; never used as a date
      base = base.slice(0, m.index);
      const d = /-d\d{1,2}$/.exec(base); // a short "-d9"-style marker that sometimes precedes it
      if (d && d.index > 0) base = base.slice(0, d.index);
    } else {
      const q = t === 'highdefinition' ? 'hd' : t;
      if (QUALITY_TOKENS.has(q)) quality ??= q.toUpperCase();
      else {
        // A size version ("optimized", "-low") is a quality too, and stays listed as a tag.
        const sized = REDUCED_QUALITY[q] ?? HIGH_QUALITY[q];
        if (sized) quality ??= sized;
        tags.push(q);
      }
      base = base.slice(0, m.index);
    }
    base = base.trim();
  }
  return { base, quality, tags };
}
