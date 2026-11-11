// whatBooksNext look-around script: paste it into the browser's console on a store's library
// page, scroll to the bottom, then click Finish. It reports only the page's structure (field
// names, counts and label words), never titles, IDs or account details. It sends nothing
// anywhere: the report stays on screen for you to copy. See
// docs/plans/get-store-purchase-imports.md, Stage 2.
import { maskUrl } from '../probe/mask.ts';
import { Probe, type DomSignature } from '../probe/report.ts';

void (() => {
  const host = location.hostname;
  const base = host.split('.').slice(-2).join('.');
  const own = [base, ...(base === 'google.com' ? ['googleapis.com'] : [])];
  const probe = new Probe(own);
  const earlier = performance
    .getEntriesByType('resource')
    .map((e) => e as PerformanceResourceTiming)
    .filter((e) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
    .map((e) => maskUrl(e.name, own));
  const isOwn = (u: string) => {
    try {
      const h = new URL(u, location.href).hostname;
      return own.some((o) => h === o || h.endsWith(`.${o}`));
    } catch {
      return false;
    }
  };
  const readable = (type: string) => /json|javascript|text\/plain|protobuf/i.test(type);

  // Watch the page's own requests as you scroll. Nothing is sent or changed.
  const origFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
      const method = (args[1]?.method ?? (req instanceof Request ? req.method : 'GET')) || 'GET';
      const type = res.headers.get('content-type') ?? '';
      const body =
        isOwn(url) && readable(type)
          ? await res
              .clone()
              .text()
              .catch(() => null)
          : null;
      probe.add({ method, url, status: res.status, contentType: type, body });
    } catch {
      /* never disturb the page */
    }
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    meta.set(this, { method: String(args[0]), url: String(args[1]) });
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    this.addEventListener('loadend', () => {
      try {
        const m = meta.get(this);
        if (!m) return;
        const type = this.getResponseHeader('content-type') ?? '';
        const text =
          this.responseType === '' || this.responseType === 'text'
            ? this.responseText
            : this.responseType === 'json'
              ? JSON.stringify(this.response)
              : null;
        probe.add({
          method: m.method,
          url: new URL(m.url, location.href).href,
          status: this.status,
          contentType: type,
          body: isOwn(m.url) && readable(type) ? text : null,
        });
      } catch {
        /* never disturb the page */
      }
    });
    return (origSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;

  // Data built into the page: Google's AF_initDataCallback blocks, JSON script tags, __NUXT__.
  const readEmbedded = () => {
    document.querySelectorAll('script').forEach((s, i) => {
      const t = s.textContent ?? '';
      if (
        s.type === 'application/json' ||
        s.type === 'application/ld+json' ||
        s.id === '__NEXT_DATA__'
      ) {
        try {
          probe.addEmbedded(`script ${s.id ? '#' + s.id : i} (${s.type || 'json'})`, JSON.parse(t));
        } catch {
          /* not JSON */
        }
      }
      for (const m of t.matchAll(
        /AF_initDataCallback\(\{key:\s*'([^']+)'[\s\S]*?data:([\s\S]*?), sideChannel/g,
      )) {
        try {
          probe.addEmbedded(`AF_initDataCallback ${m[1]}`, JSON.parse(m[2]!));
        } catch {
          /* not readable */
        }
      }
    });
    const w = window as unknown as Record<string, unknown>;
    for (const k of ['__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__', '__PRELOADED_STATE__'])
      if (w[k] && typeof w[k] === 'object') probe.addEmbedded(`window.${k}`, w[k]);
  };

  // Repeated elements: book cards usually repeat once per book.
  const domSignatures = (): DomSignature[] => {
    const counts = new Map<string, DomSignature & { el: Element }>();
    for (const el of document.body.querySelectorAll('*')) {
      const cls = [...el.classList]
        .map((c) => (/\d{3,}|^[a-z0-9_-]{1,3}$/i.test(c) ? null : c.replace(/\d+/g, '#')))
        .filter(Boolean)
        .slice(0, 4)
        .join('.');
      const sig = `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
      const got = counts.get(sig);
      if (got) got.count++;
      else {
        const a = el.querySelector('a[href]') ?? (el.matches('a[href]') ? el : null);
        counts.set(sig, {
          sig,
          count: 1,
          el,
          attrs: [...el.attributes]
            .map((x) => x.name)
            .filter((n) => n !== 'class' && n !== 'style' && /^[a-z-]{1,30}$/.test(n))
            .slice(0, 8),
          link: a ? maskUrl((a as HTMLAnchorElement).href, own) : null,
          hasImage: !!el.querySelector('img'),
        });
      }
    }
    return [...counts.values()]
      .filter((d) => d.count >= 5 && d.count <= 5000 && (d.link || d.hasImage))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map(({ el: _el, ...d }) => d);
  };

  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'whatBooksNext look-around');
  panel.style.cssText =
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(440px,calc(100vw - 32px));' +
    'background:#fff;color:#111;border:2px solid #2e6b57;border-radius:8px;padding:12px;' +
    'font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
  const status = document.createElement('p');
  status.style.margin = '0 0 8px';
  status.textContent =
    'Looking around. Now scroll your library slowly to the very bottom, until no more books load ' +
    '(click any “Show more” button the page has). Then click Finish.';
  const finish = document.createElement('button');
  finish.textContent = 'Finish';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.marginLeft = '8px';
  const restore = () => {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
  };
  cancel.onclick = () => {
    restore();
    panel.remove();
  };
  finish.onclick = () => {
    restore();
    readEmbedded();
    const text = probe.report({
      page: location.href,
      browser: navigator.userAgent,
      date: new Date().toISOString(),
      dom: domSignatures(),
      earlier,
    });
    console.log(text);
    finish.remove();
    cancel.remove();
    status.textContent = 'Done. Copy the report and paste it into chat. It has no titles or IDs.';
    const box = document.createElement('textarea');
    box.readOnly = true;
    box.value = text;
    box.rows = 12;
    box.setAttribute('aria-label', 'Look-around report');
    box.style.cssText = 'width:100%;box-sizing:border-box;font:11px monospace;margin:4px 0';
    const copy = document.createElement('button');
    copy.textContent = 'Copy report';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copied';
      } catch {
        box.select();
      }
    };
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.marginLeft = '8px';
    close.onclick = () => panel.remove();
    panel.append(box, copy, close);
  };
  panel.append(status, finish, cancel);
  document.body.append(panel);
})();
