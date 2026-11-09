/**
 * A small, tolerant XML reader for the few documents the deep pass reads: EPUB's container.xml
 * and OPF, and ComicInfo.xml. These are simple, so a 100-line reader beats a dependency.
 *
 * Input is untrusted (§6.3): no external entities, no DTDs, no recursion (an explicit stack),
 * and malformed markup never throws — it yields whatever was well-formed enough to read.
 * Namespace prefixes are kept on `name`; `local` is the name without its prefix.
 */

export interface XmlElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED[e.toLowerCase()] ?? HTML_NAMED[e.toLowerCase()] ?? m;
  });
}

/** A few HTML entities common in EPUB text, so they don't count as words or garbage. */
const HTML_NAMED: Record<string, string> = {
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
};

const localName = (n: string) => n.slice(n.indexOf(':') + 1);

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      // Processing instruction or DOCTYPE: skipped. A DOCTYPE's internal subset is never read,
      // so entity-expansion attacks have nothing to expand.
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim();
      // Pop to the matching open element; a stray close tag is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
    } else {
      const end = findTagEnd(src, lt + 1);
      const raw = src.slice(lt + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const m = /^\s*([^\s/>]+)/.exec(body);
      if (!m) continue;
      const el: XmlElement = {
        name: m[1]!,
        local: localName(m[1]!),
        attrs: parseAttrs(body.slice(m[0].length)),
        children: [],
        text: '',
      };
      top.children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  return root;
}

/** The end of a start tag, skipping '>' inside quoted attribute values. */
function findTagEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** All descendants with this local name, in document order (iterative). */
export function findAll(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack = [...el.children].reverse();
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let k = e.children.length - 1; k >= 0; k--) stack.push(e.children[k]!);
  }
  return out;
}

export function findFirst(el: XmlElement, local: string): XmlElement | undefined {
  return findAll(el, local)[0];
}

/** All text inside an element, including its descendants'. */
export function textOf(el: XmlElement): string {
  // Iterative, so a maliciously deep document can't overflow the stack.
  let s = '';
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    s += e.text;
    for (let k = e.children.length - 1; k >= 0; k--) stack.push(e.children[k]!);
  }
  return s.trim();
}

/** An attribute by local name (ignoring its namespace prefix). */
export function attr(el: XmlElement, local: string): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
  return undefined;
}
