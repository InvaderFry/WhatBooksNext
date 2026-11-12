// whatBooksNext Google Play Books collector (console script). Paste it into the browser's console
// on https://play.google.com/books?source=purchases while signed in. It scrolls the page and reads
// the book cards; it makes no requests. See docs/plans/get-store-purchase-imports.md.
import { googlePlay, type PlayCard } from '../adapters/googlePlay.ts';
import { scanCards } from '../core/scan.ts';
import { runInPage } from './run.ts';

const text = (el: Element | null) => (el?.getAttribute('title') || el?.textContent || '').trim();

const readCards = (): PlayCard[] =>
  [...document.querySelectorAll('gpb-volume-card')].map((card) => {
    const link =
      card.querySelector<HTMLAnchorElement>('a.title[href]') ??
      card.querySelector<HTMLAnchorElement>('a.cover-link[href]') ??
      card.querySelector<HTMLAnchorElement>('a[href*="id="]');
    return {
      classes: [...(card.querySelector('div.card')?.classList ?? [])],
      href: link?.href ?? null,
      title: text(card.querySelector('a.title')),
      authors: [...card.querySelectorAll('a.author')].map(text).filter(Boolean),
    };
  });

/** The element that scrolls the library: the nearest scrolling parent of a card, else the page. */
function scroller(): Element {
  let el: Element | null = document.querySelector('gpb-volume-card');
  while (el && el !== document.body) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

void runInPage(googlePlay, (d) => {
  const box = scroller();
  return scanCards(googlePlay, {
    ...d,
    currentUrl: () => new URL(location.href),
    readCards,
    scroll: () => {
      box.scrollBy({ top: Math.max(200, box.clientHeight * 0.8) });
      return { atBottom: box.scrollTop + box.clientHeight >= box.scrollHeight - 4 };
    },
  });
});
