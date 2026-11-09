import { splitWords } from './wordsplit.ts';

/**
 * Filename parser (PLAN.md §11.1, extended with the patterns found in the M0 probe).
 * Every part carries a confidence; the raw name is always kept. The output is a guess for
 * display and matching — embedded metadata and sources outrank it (§11.2).
 */

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
/** Size/source tags: recorded and ignored when comparing (M0 probe). */
const SIZE_TOKENS = new Set(['optimized', 'opt', 'downsampled', 'high', 'ebook', 'digital', 'lowres']);
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
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'at', 'by', 'with', 'vs']);
  if (!first && small.has(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Title case for display, used only when the name gave no casing of its own. */
export function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w, i) => cap(w, i === 0))
    .join(' ');
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
      return { rest: rest + marker.slice(0, marker.length - note.length), note: `${splitWords(note).join(' ')} edition` };
    }
  }
  return null;
}

function words(text: string): { value: string; split: boolean } {
  if (/\s/.test(text.trim()) || !/^[a-z0-9]+$/.test(text)) return { value: text.trim(), split: false };
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
    else if (t) tags.push(t);
    return ' ';
  });
  base = base.replace(/\s+/g, ' ').trim();

  // "-high" / "_hd" style suffix at the very end, in any naming style.
  const qs = /[-_ ](high|hd|hq|hi-?res|high-?res|lowres)$/i.exec(base);
  if (qs) {
    const t = qs[1]!.toLowerCase().replace('-', '');
    if (QUALITY_TOKENS.has(t)) result.quality = t.toUpperCase();
    else tags.push(t);
    base = base.slice(0, qs.index);
  }

  const spaced = /\s/.test(base) || /_-_/.test(base) || (/-/.test(base) && !/_/.test(base) && (base.match(/-/g)?.length ?? 0) >= 2);
  if (spaced) parseSpaced(base.replace(/_-_/g, ' - ').replace(/_/g, ' '), result, tags);
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

/** Humble-style slugs: "series_vol1_subtitle", "title_issue3", "runtogethertitle". */
function parseSlug(base: string, r: Partial<ParsedName>, tags: string[]) {
  const segs = base.split('_').filter(Boolean);
  const textSegs: string[] = [];
  let markerIndex = -1;

  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i]!;
    const lower = seg.toLowerCase();
    // "-high", "-hd" suffixes on the last segment
    const suffix = /^(.*?)-(high|hd|hq|hires|highres|lowres)$/.exec(lower);
    if (suffix) {
      if (QUALITY_TOKENS.has(suffix[2]!)) r.quality = suffix[2]!.toUpperCase();
      else tags.push(suffix[2]!);
      seg = seg.slice(0, suffix[1]!.length);
    }
    const s = seg.toLowerCase();
    if (QUALITY_TOKENS.has(s)) {
      r.quality = s.toUpperCase();
      continue;
    }
    if (SIZE_TOKENS.has(s)) {
      tags.push(s);
      continue;
    }
    if (/^\d{10}$/.test(s)) {
      tags.push(`humble-id ${s}`); // looks like a Unix timestamp; never used as a date
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
    if (markerIndex >= 0) textSegs.push(`\u0000${seg}`); // after a marker: subtitle text
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
function parseSpaced(base: string, r: Partial<ParsedName>, tags: string[]) {
  let s = base.replace(/-/g, (m, i: number, str: string) => (str[i - 1] === ' ' || str[i + 1] === ' ' ? m : ' '));
  s = s.replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;

  // Trailing quality / size words: "Saga 001 HD"
  s = s
    .split(' ')
    .filter((w) => {
      const lw = w.toLowerCase();
      if (QUALITY_TOKENS.has(lw)) {
        r.quality = w.toUpperCase();
        return false;
      }
      if (SIZE_TOKENS.has(lw) && lw !== 'high') {
        tags.push(lw);
        return false;
      }
      return true;
    })
    .join(' ');

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

  // Series volume + issue: "Series V1 17", "Series v2 09"
  if ((m = /^(.+?) [Vv](\d{1,2}) (\d{1,4})$/.exec(s))) {
    r.series = { value: m[1]!, confidence: 0.8 };
    r.seriesVolume = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.8 };
    r.issue = { value: m[3]!.replace(/^0+(?=\d)/, ''), confidence: 0.8 };
    r.title = { value: `${m[1]} v${r.seriesVolume.value} #${r.issue.value}`, confidence: 0.7 };
    r.rawTitle = m[1]!;
    return;
  }

  // Book volume: "Berserk v01", "Series Vol. 2 Subtitle"
  if ((m = /^(.+?) (?:[Vv](\d{1,3})|[Vv]ol(?:ume)?\.? ?(\d{1,3}))(?: (.+))?$/.exec(s))) {
    r.series = { value: m[1]!, confidence: 0.8 };
    r.volume = { value: (m[2] ?? m[3])!.replace(/^0+(?=\d)/, ''), confidence: 0.85 };
    if (m[4]) r.subtitle = { value: m[4], confidence: 0.6 };
    r.title = { value: m[1]!, confidence: 0.6 };
    r.rawTitle = m[1]!;
    return;
  }

  // Issue: "Series 001", "Series #4"
  // Two digits only when zero-padded ("05"), so "Catch 22" stays a title.
  if ((m = /^(.+?) #?(\d{1,4})$/.exec(s)) && (m[2]!.length >= 3 || /^0\d$/.test(m[2]!) || s.includes('#'))) {
    r.series = { value: m[1]!, confidence: 0.8 };
    r.issue = { value: m[2]!.replace(/^0+(?=\d)/, ''), confidence: 0.85 };
    r.title = { value: `${m[1]} #${r.issue.value}`, confidence: 0.7 };
    r.rawTitle = m[1]!;
    return;
  }

  // "Title - Author" or "Author - Title": keep both readings (§11.1).
  if ((m = /^(.+?) - (.+)$/.exec(s))) {
    const a = m[1]!.trim();
    const b = m[2]!.trim();
    const looksLikeName = (t: string) =>
      /^[A-Z][a-z]+(?: [A-Z]\.?)*(?: [A-Z][a-z'-]+){1,2}$/.test(t) || /^[A-Z][a-z]+, [A-Z]/.test(t);
    const first: TitleAuthor = { title: a, author: b };
    const second: TitleAuthor = { title: b, author: a };
    r.authorTitle = looksLikeName(a) && !looksLikeName(b) ? [second, first] : [first, second];
    r.title = { value: r.authorTitle[0]!.title, confidence: 0.5 };
    r.rawTitle = s;
    return;
  }

  r.title = { value: s, confidence: 0.5 };
  r.rawTitle = s;
}

/**
 * Comparison key for grouping files of one book in one folder (§11.3 rule 2): the base name
 * with quality and size tags, Humble ids and download-duplicate suffixes removed.
 */
export function compareKeyFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  let base = (dot > 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
  base = base.replace(/\s?\(\d{1,2}\)$/, '');
  base = base.replace(/(?<![\p{L}\p{N}])(?:hd|hq|hi-?res|high-?res|optimized|opt|downsampled|high|ebook|lowres|\d{10})(?![\p{L}\p{N}])/gu, ' ');
  const key = normalizeForCompare(base);
  return key || normalizeForCompare(fileName);
}
