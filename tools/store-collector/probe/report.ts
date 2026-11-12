import { maskUrl } from './mask.ts';
import { merge, parseBody, render, shapeOf, type Shape } from './skeleton.ts';

/**
 * Collects what a store's library page loads, as shapes, and writes the look-around report
 * (store purchases plan, Stage 2): no titles, IDs, account names or values, only structure.
 */

export interface SeenRequest {
  method: string;
  url: string;
  status: number;
  contentType: string;
  body: string | null;
}

interface Group {
  key: string;
  count: number;
  statuses: Set<number>;
  types: Set<string>;
  shape: Shape | null;
  bytes: number;
}

export interface DomSignature {
  sig: string;
  count: number;
  attrs: string[];
  link: string | null;
  hasImage: boolean;
}

export class Probe {
  private groups = new Map<string, Group>();
  private embedded: { name: string; shape: Shape }[] = [];
  private sections: { title: string; text: string }[] = [];
  /** HTML pages the store's page fetched (Kobo loads library pages this way), for outlining. */
  html: { key: string; body: string }[] = [];
  private own: string[];
  constructor(own: string[]) {
    this.own = own;
  }

  add(r: SeenRequest): void {
    const key = `${r.method.toUpperCase()} ${maskUrl(r.url, this.own)}`;
    const g = this.groups.get(key) ?? {
      key,
      count: 0,
      statuses: new Set<number>(),
      types: new Set<string>(),
      shape: null,
      bytes: 0,
    };
    g.count++;
    if (r.body !== null && /html/i.test(r.contentType) && this.html.length < 3)
      this.html.push({ key, body: r.body });
    g.statuses.add(r.status);
    g.types.add((r.contentType.split(';')[0] ?? '').trim() || 'unknown');
    if (r.body !== null) {
      g.bytes += r.body.length;
      for (const data of parseBody(r.body)) {
        const s = shapeOf(data, this.own);
        g.shape = g.shape ? merge(g.shape, s) : s;
      }
    }
    this.groups.set(key, g);
  }

  addEmbedded(name: string, data: unknown): void {
    // react-query's saved state (GlobalComix's __INITIAL_STATE__): one entry per query, so a big
    // one (site settings) can't push the library list out of the report.
    const queries = (data as { queries?: unknown } | null)?.queries;
    if (
      Array.isArray(queries) &&
      queries.every((q) => q && typeof q === 'object' && 'state' in q)
    ) {
      queries.forEach((q, i) => {
        const x = q as { queryKey?: unknown; state?: { data?: unknown } };
        this.embedded.push({
          name: `${name}.queries[${i}] key ${queryKeyText(x.queryKey)}`,
          shape: shapeOf(x.state?.data, this.own),
        });
      });
      return;
    }
    this.embedded.push({ name, shape: shapeOf(data, this.own) });
  }

  /** Extra report sections (card outlines), already title-free. */
  addSection(title: string, text: string): void {
    this.sections.push({ title, text });
  }

  report(head: {
    page: string;
    browser: string;
    date: string;
    dom: DomSignature[];
    earlier: string[];
  }): string {
    const groups = [...this.groups.values()].sort(
      (a, b) => Number(!!b.shape) - Number(!!a.shape) || b.bytes - a.bytes,
    );
    const out = [
      'whatBooksNext look-around report (structure only, no titles or IDs)',
      `Page: ${maskUrl(head.page, this.own)}`,
      `Browser: ${head.browser}`,
      `Date: ${head.date}`,
      '',
      `== Requests the page made while you scrolled (${groups.length} kinds) ==`,
    ];
    for (const g of groups.slice(0, 15)) {
      out.push(
        `-- ${g.key}  ×${g.count}  status ${[...g.statuses].join('/')}  ${[...g.types].join('/')}  ${Math.round(g.bytes / 1024)} KB`,
      );
      if (g.shape) out.push(render(g.shape, 1, 250));
    }
    if (groups.length > 15) out.push(`(${groups.length - 15} more kinds left out)`);
    out.push('', `== Requests made before the script started (${head.earlier.length}) ==`);
    for (const e of [...new Set(head.earlier)].slice(0, 40)) out.push(`- ${e}`);
    out.push('', `== Data built into the page (${this.embedded.length}) ==`);
    for (const e of this.embedded.slice(0, 20)) {
      out.push(`-- ${e.name}`);
      out.push(render(e.shape, 1, 200));
    }
    out.push('', '== Repeated page elements (likely book cards) ==');
    for (const d of head.dom)
      out.push(
        `- ${d.sig} ×${d.count}; attributes: ${d.attrs.join(', ') || 'none'}; link: ${d.link ?? 'none'}; image: ${d.hasImage ? 'yes' : 'no'}`,
      );
    for (const s of this.sections) out.push('', `== ${s.title} ==`, s.text);
    return out.join('\n');
  }
}

/**
 * A react-query key, like ["account", "purchases", {"page": 1}]: plain words are shown (they name
 * what was asked for); anything with digits, spaces or hyphens (IDs, slugs, titles) is only
 * described, and objects show their keys.
 */
export function queryKeyText(key: unknown): string {
  if (!Array.isArray(key)) return '(none)';
  return `[${key
    .map((k) =>
      typeof k === 'string'
        ? /^[A-Za-z][A-Za-z_]{0,30}$/.test(k)
          ? JSON.stringify(k)
          : `text(${k.length})`
        : k && typeof k === 'object'
          ? `{${Object.keys(k)
              .filter((x) => /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(x))
              .join(', ')}}`
          : typeof k,
    )
    .join(', ')}]`;
}
