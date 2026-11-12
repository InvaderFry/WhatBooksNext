// whatBooksNext GlobalComix collector (console script). Paste it into the browser's console on
// https://globalcomix.com (the home page) while signed in, then go to My Shelf → Purchases with the
// site's own menu. It makes no requests: it reads the purchases list the page itself receives, and
// changes nothing. See docs/plans/get-store-purchase-imports.md.
import { globalcomix } from '../adapters/globalcomix.ts';
import { collectAnswers } from '../core/scan.ts';
import { runInPage } from './run.ts';

void runInPage(
  globalcomix,
  (d) =>
    new Promise((resolve) => {
      const answers: unknown[] = [];
      const pagesSeen = new Set<number>();
      let lastPage: number | null = null;
      const origFetch = window.fetch;
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const meta = new WeakMap<XMLHttpRequest, string>();

      const end = (ended: 'owner' | 'cancelled' | 'whole_list') => {
        window.fetch = origFetch;
        XMLHttpRequest.prototype.open = origOpen;
        XMLHttpRequest.prototype.send = origSend;
        resolve(
          collectAnswers(globalcomix, answers, { ended, region: 'globalcomix.com' }, d.now()),
        );
      };
      // One answer the page received: keep it, and finish once the whole list has been seen.
      const take = (url: string, text: string) => {
        let u: URL;
        try {
          u = new URL(url, location.href);
        } catch {
          return;
        }
        if (!globalcomix.matches(u)) return;
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return;
        }
        answers.push(body);
        try {
          const p = globalcomix.parse(body);
          if (p.page !== undefined) pagesSeen.add(p.page);
          if (p.next === null && p.page !== undefined) lastPage = p.page;
          const count = answers.length;
          d.say(
            `Read ${count} page${count === 1 ? '' : 's'} of your purchases. Keep scrolling to the bottom; it finishes by itself once it has the whole list.`,
          );
          if (
            lastPage !== null &&
            Array.from({ length: lastPage }, (_, i) => i + 1).every((n) => pagesSeen.has(n))
          )
            end('whole_list');
        } catch {
          end('owner'); // the layout check fails: stop now, the result says why
        }
      };

      window.fetch = async function (...args: Parameters<typeof fetch>) {
        const res = await origFetch.apply(this, args);
        try {
          const req = args[0];
          const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
          if (globalcomix.matches(new URL(url, location.href)))
            void res
              .clone()
              .text()
              .then((t) => take(url, t))
              .catch(() => {});
        } catch {
          /* never disturb the page */
        }
        return res;
      };
      XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
        meta.set(this, String(args[1]));
        return (origOpen as (...a: unknown[]) => void).apply(this, args);
      } as typeof XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
        this.addEventListener('loadend', () => {
          try {
            const url = meta.get(this);
            if (!url) return;
            const text =
              this.responseType === '' || this.responseType === 'text'
                ? this.responseText
                : this.responseType === 'json'
                  ? JSON.stringify(this.response)
                  : null;
            if (text !== null) take(url, text);
          } catch {
            /* never disturb the page */
          }
        });
        return (origSend as (...a: unknown[]) => void).apply(this, args);
      } as typeof XMLHttpRequest.prototype.send;

      d.signal.addEventListener('abort', () => end('cancelled'));
      d.finished.addEventListener('abort', () => end('owner'));
    }),
  {
    finish: true,
    first:
      'Watching. Now use GlobalComix’s menu to go to My Shelf → Purchases, then scroll to the bottom of your purchases. It finishes by itself once it has the whole list (or click Finish).',
  },
);
