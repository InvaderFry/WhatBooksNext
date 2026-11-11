// whatBooksNext Kobo collector (console script). Paste it into the browser's console on
// https://www.kobo.com/us/en/library/books while signed in. It fetches the same library pages that
// page fetches as you scroll, and reads them; it never presses a button on a book. See
// docs/plans/get-store-purchase-imports.md.
import { kobo, type KoboCard } from '../adapters/kobo.ts';
import { scan } from '../core/scan.ts';
import { runInPage } from './run.ts';

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function cardsOf(html: string, url: string): { page: number; cards: KoboCard[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const page = Number(new URL(url).searchParams.get('pageNumber') ?? '1');
  const cards = [...doc.querySelectorAll('li.item-wrapper')].map((li): KoboCard => {
    const titleLink = li.querySelector<HTMLAnchorElement>('h2.title a');
    const titleText = text(titleLink);
    return {
      classes: [...li.classList],
      trackInfo: li.getAttribute('data-track-info'),
      title: titleText,
      // Links are read from their attributes and made absolute against the page.
      pageHref: titleLink?.getAttribute('href')
        ? new URL(titleLink.getAttribute('href')!, url).href
        : null,
      authors: [...li.querySelectorAll('a.contributor-name')].map(text).filter(Boolean),
      readHref: (() => {
        const a = li.querySelector('a.button.readnow');
        return a?.getAttribute('href') ? new URL(a.getAttribute('href')!, url).href : null;
      })(),
      status: text(li.querySelector('span.item-status')),
      marks: [
        ...li.querySelectorAll(
          '[class*="badge"], [class*="ribbon"], [class*="preview"], [class*="plus"], [class*="subscription"], .product-type-icon',
        ),
      ]
        .flatMap((el) => [text(el), ...[...el.classList]])
        .map((t) => t.toLowerCase())
        .filter((t) => t && t.length < 40 && t !== titleText.toLowerCase()),
    };
  });
  return { page, cards };
}

void runInPage(kobo, (d) => scan(kobo, { ...d, fetch: (u, i) => fetch(u, i), fromHtml: cardsOf }));
