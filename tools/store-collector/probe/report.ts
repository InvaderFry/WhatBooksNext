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
    this.embedded.push({ name, shape: shapeOf(data, this.own) });
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
      if (g.shape) out.push(render(g.shape, 1, 150));
    }
    if (groups.length > 15) out.push(`(${groups.length - 15} more kinds left out)`);
    out.push('', `== Requests made before the script started (${head.earlier.length}) ==`);
    for (const e of [...new Set(head.earlier)].slice(0, 40)) out.push(`- ${e}`);
    out.push('', `== Data built into the page (${this.embedded.length}) ==`);
    for (const e of this.embedded.slice(0, 12)) {
      out.push(`-- ${e.name}`);
      out.push(render(e.shape, 1, 150));
    }
    out.push('', '== Repeated page elements (likely book cards) ==');
    for (const d of head.dom)
      out.push(
        `- ${d.sig} ×${d.count}; attributes: ${d.attrs.join(', ') || 'none'}; link: ${d.link ?? 'none'}; image: ${d.hasImage ? 'yes' : 'no'}`,
      );
    return out.join('\n');
  }
}
