import path from 'node:path';
import { countWords, htmlToText } from './text.ts';
import { thumbnailFromImage } from './thumbnail.ts';
import type { EmbeddedMetadata, MetaResult } from './types.ts';
import { attr, findAll, findFirst, parseXml, textOf, type XmlElement } from './xml.ts';
import { ZipReader } from './zip.ts';

/**
 * EPUB (PLAN.md §10): OPF metadata — title, creators, language, publisher, date, identifiers,
 * subjects, description, series (calibre:series / series_index, EPUB 3 belongs-to-collection) —
 * and a word count from the spine text, skipping navigation and repeated boilerplate.
 */

interface Opf {
  dir: string;
  doc: XmlElement;
  manifest: Map<string, { href: string; type: string; properties: string }>;
}

async function readOpf(zip: ZipReader): Promise<Opf> {
  const containerName = zip.find('META-INF/container.xml');
  let opfPath: string | undefined;
  if (containerName) {
    const c = parseXml(await zip.readText(containerName));
    opfPath = findFirst(c, 'rootfile')?.attrs['full-path'];
  }
  // A missing container is common in sloppy EPUBs; fall back to the first .opf in the archive.
  opfPath = (opfPath && zip.find(opfPath)) ?? zip.entries.find((e) => /\.opf$/i.test(e.name))?.name;
  if (!opfPath) throw new Error('No OPF package document: not a readable EPUB.');
  const doc = parseXml(await zip.readText(opfPath));
  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  for (const item of findAll(doc, 'item')) {
    const id = item.attrs.id;
    if (!id || !item.attrs.href) continue;
    manifest.set(id, {
      href: decodeHref(item.attrs.href),
      type: item.attrs['media-type'] ?? '',
      properties: item.attrs.properties ?? '',
    });
  }
  return { dir: path.posix.dirname(opfPath), doc, manifest };
}

function decodeHref(href: string): string {
  const noFragment = href.split('#')[0]!;
  try {
    return decodeURIComponent(noFragment);
  } catch {
    return noFragment;
  }
}

const resolve = (dir: string, href: string) =>
  path.posix.normalize(dir === '.' ? href : `${dir}/${href}`).replace(/^\/+/, '');

const clean = (s: string | undefined) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
};

/** Titles that mean "nobody set one". */
const PLACEHOLDER_TITLE = /^(unknown|untitled|none|title|book|ebook)$/i;

export function opfMetadata(doc: XmlElement): EmbeddedMetadata {
  const md = findFirst(doc, 'metadata') ?? doc;
  const m: EmbeddedMetadata = {};
  const title = clean(findAll(md, 'title').map(textOf)[0]);
  if (title && !PLACEHOLDER_TITLE.test(title)) m.title = title;
  const creators = findAll(md, 'creator')
    .map((c) => ({ name: clean(textOf(c)) ?? '', role: attr(c, 'role') }))
    .filter((c) => c.name && !/^unknown$/i.test(c.name));
  if (creators.length) m.creators = creators.map((c) => (c.role ? c : { name: c.name }));
  const lang = clean(findAll(md, 'language').map(textOf)[0]);
  if (lang && !/^(und|unknown)$/i.test(lang)) m.language = lang.toLowerCase();
  m.publisher = clean(findAll(md, 'publisher').map(textOf)[0]);
  m.date = clean(findAll(md, 'date').map(textOf)[0]);
  const ids = findAll(md, 'identifier')
    .map((i) => {
      const value = clean(textOf(i)) ?? '';
      const scheme =
        attr(i, 'scheme')?.toLowerCase() ??
        (/^urn:isbn:/i.test(value) ? 'isbn' : /^urn:uuid:/i.test(value) ? 'uuid' : '');
      const v = value.replace(/^urn:(isbn|uuid):/i, '');
      const digits = v.replace(/[-\s]/g, '');
      const isIsbn = scheme === 'isbn' || /^(97[89])?\d{9}[\dXx]$/.test(digits);
      return { scheme: isIsbn ? 'isbn' : scheme || 'other', value: isIsbn ? digits : v };
    })
    .filter((i) => i.value);
  if (ids.length) m.identifiers = ids;
  const subjects = findAll(md, 'subject')
    .map((s) => clean(textOf(s)))
    .filter((s): s is string => Boolean(s));
  if (subjects.length) m.subjects = subjects;
  // Kept as plain text: shown as text, never as HTML (§6.3).
  const desc = clean(findAll(md, 'description').map(textOf)[0]);
  if (desc) m.description = htmlToText(desc).slice(0, 5000);

  for (const meta of findAll(md, 'meta')) {
    const name = meta.attrs.name;
    if (name === 'calibre:series') m.series = clean(meta.attrs.content);
    if (name === 'calibre:series_index') m.seriesIndex = clean(meta.attrs.content);
  }
  if (!m.series) {
    const coll = findAll(md, 'meta').find((x) => x.attrs.property === 'belongs-to-collection');
    if (coll) {
      const id = coll.attrs.id;
      const refines = (prop: string) =>
        findAll(md, 'meta').find((x) => x.attrs.refines === `#${id}` && x.attrs.property === prop);
      const type = refines('collection-type');
      // A collection with no type is usually a series in practice; "set" is not.
      if (!type || textOf(type) === 'series') {
        m.series = clean(textOf(coll));
        const pos = refines('group-position');
        if (pos) m.seriesIndex = clean(textOf(pos));
      }
    }
  }
  for (const k of Object.keys(m) as (keyof EmbeddedMetadata)[]) if (m[k] === undefined) delete m[k];
  return m;
}

/** Files that are navigation rather than the book's text. */
const NAV_NAME = /(^|\/)(toc|nav|contents?|index)\.x?html?$/i;

export async function readEpub(file: string): Promise<MetaResult> {
  const zip = await ZipReader.open(file);
  try {
    const opf = await readOpf(zip);
    const metadata = opfMetadata(opf.doc);
    const seen = new Set<string>();
    let words = 0;
    for (const ref of findAll(opf.doc, 'itemref')) {
      const item = opf.manifest.get(ref.attrs.idref ?? '');
      if (!item || item.properties.includes('nav') || NAV_NAME.test(item.href)) continue;
      if (!/html|xml/.test(item.type)) continue;
      const name = zip.find(resolve(opf.dir, item.href));
      if (!name) continue;
      const text = htmlToText(await zip.readText(name));
      // Repeated boilerplate (the same notice page in every chapter file) is counted once.
      if (seen.has(text)) continue;
      seen.add(text);
      words += countWords(text);
    }
    return { metadata, wordCount: words > 0 ? words : null, pageCount: null };
  } finally {
    zip.close();
  }
}

/** The cover image, from the OPF's cover declaration or an image named like a cover. */
export async function epubThumbnail(file: string): Promise<Buffer | null> {
  const zip = await ZipReader.open(file);
  try {
    const opf = await readOpf(zip);
    let href: string | undefined;
    for (const it of opf.manifest.values())
      if (it.properties.split(/\s+/).includes('cover-image')) href = it.href;
    if (!href) {
      const coverId = findAll(opf.doc, 'meta').find((x) => x.attrs.name === 'cover')?.attrs.content;
      const it = coverId ? opf.manifest.get(coverId) : undefined;
      if (it?.type.startsWith('image/')) href = it.href;
    }
    if (!href) {
      href = [...opf.manifest.values()].find(
        (it) => it.type.startsWith('image/') && /cover/i.test(it.href),
      )?.href;
    }
    if (!href) return null;
    const name = zip.find(resolve(opf.dir, href));
    if (!name) return null;
    return thumbnailFromImage(await zip.read(name));
  } finally {
    zip.close();
  }
}
