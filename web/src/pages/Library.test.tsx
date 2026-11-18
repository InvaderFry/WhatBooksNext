// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ItemSummary } from '../api.ts';
import { Library } from './Library.tsx';

/**
 * The Library page against a pretend server (review fixes 2026-11, Stage 4): paging past the
 * server's 1,000-book cap, errors that clear, and a shortlist star that fails. Titles are
 * invented.
 */

const STATE: AppState = {
  demo: false,
  platform: 'win32',
  folders: 1,
  items: 1150,
  scanRunning: false,
  reviewOpen: 0,
  healthProblems: 0,
  lookupsRunning: false,
};

const book = (n: number): ItemSummary =>
  ({
    id: `item-${n}`,
    title: `${n % 2 ? 'Ledger' : 'Harbor'} ${String(n).padStart(4, '0')}`,
    kind: 'fiction',
    creators: [],
    formats: ['epub'],
    fileCount: 1,
    coverFileId: null,
    coverItemId: null,
    community: null,
    user: { progress: 'not_started', rating: null, shortlistPosition: null, hidden: false },
    availability: { state: 'present', readyToRead: true, labels: [] },
  }) as unknown as ItemSummary;

/** The library in sorted order; a test may add or remove books while the page is open. */
let LIBRARY: ItemSummary[];

/** Answers like the real server, including its cap of 1,000 books per answer. */
let failItems: boolean;
let failShortlist: boolean;
/** While set, answers for "more" pages wait for it. */
let holdMore: Promise<void> | null;
/** While set, first pages for this search wait for it. */
let holdFirst: { q: string; until: Promise<void> } | null;
let requests: string[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  requests.push(url.pathname + url.search);
  if (url.pathname === '/api/folders') return json(200, []);
  if (url.pathname.startsWith('/api/shortlist'))
    return failShortlist ? json(500, { error: 'Test failure.' }) : json(200, { ok: true });
  if (url.pathname === '/api/items') {
    if (failItems) return json(500, { error: 'Test failure.' });
    const after = url.searchParams.get('after');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    if ((after || offset > 0) && holdMore) await holdMore;
    if (!after && offset === 0 && holdFirst && holdFirst.q === q) await holdFirst.until;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000);
    const list = LIBRARY.filter((b) => b.title.toLowerCase().includes(q));
    // Like queryLibrary: "after" continues from that book wherever it now sorts.
    let start = offset;
    if (after) {
      const at = list.findIndex((b) => b.id === after);
      if (at < 0)
        return json(200, {
          total: list.length,
          items: [],
          hasMore: false,
          anchorMissing: true,
          storeCounts: {},
        });
      start = at + 1;
    }
    const items = list.slice(start, start + limit);
    return json(200, {
      total: list.length,
      items,
      hasMore: start + items.length < list.length,
      storeCounts: {},
    });
  }
  return json(404, { error: 'No such route.' });
}

const rows = () => document.querySelectorAll('.item-row').length;
const showMore = () => screen.queryByRole('button', { name: /^Show (\d+ )?more$/ });
const titles = () => [...document.querySelectorAll('.item-title')].map((a) => a.textContent!);

/** Use the search field so its debounced value and the URL stay in sync on slower runners. */
async function searchFor(q: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('q')).toBe(q));
}

beforeEach(() => {
  failItems = false;
  failShortlist = false;
  holdMore = null;
  holdFirst = null;
  requests = [];
  LIBRARY = Array.from({ length: 1150 }, (_, i) => book(i + 1));
  window.history.replaceState(null, '', '/?view=library');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Library page', () => {
  it('pages past 1,000 books 100 at a time, and starts again when the search changes', async () => {
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(rows()).toBe(100));
    for (let i = 0; i < 15 && showMore(); i++) {
      const before = rows();
      fireEvent.click(showMore()!);
      await waitFor(() => expect(rows()).toBeGreaterThan(before));
    }
    expect(rows()).toBe(1150);
    expect(showMore()).toBeNull();
    await searchFor('harbor');
    await waitFor(() => expect(screen.getByText('575 items match')).toBeTruthy());
    expect(rows()).toBe(100);
    expect(document.querySelector('.item-title')!.textContent).toBe('Harbor 0002');
  });

  it('never adds a slow answer for the old search to the new list', async () => {
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(rows()).toBe(100));
    let release!: () => void;
    holdMore = new Promise<void>((r) => (release = r));
    fireEvent.click(showMore()!);
    await searchFor('harbor');
    await waitFor(() => expect(screen.getByText('575 items match')).toBeTruthy());
    await act(async () => {
      release();
      await holdMore;
    });
    await waitFor(() => {
      expect(rows()).toBe(100);
      expect(titles()).toEqual(
        LIBRARY.filter((b) => b.title.startsWith('Harbor'))
          .slice(0, 100)
          .map((b) => b.title),
      );
    });
  });

  it('keeps paging when a book is added above the loaded ones, and offers to reload', async () => {
    LIBRARY = LIBRARY.slice(0, 300);
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(rows()).toBe(100));
    // A scan finds a new book that sorts first.
    LIBRARY.unshift({ ...book(9999), id: 'new-arrival', title: 'Aardvark Atlas' });
    for (let i = 0; i < 6 && showMore(); i++) {
      fireEvent.click(showMore()!);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Loading…' })).toBeNull());
    }
    expect(showMore()).toBeNull();
    // Every book that was there is listed once, in order: nothing skipped or repeated.
    expect(titles()).toEqual(LIBRARY.slice(1).map((b) => b.title));
    fireEvent.click(screen.getByRole('button', { name: 'Reload the list' }));
    await waitFor(() => expect(titles()[0]).toBe('Aardvark Atlas'));
    expect(rows()).toBe(100);
  });

  it('starts again from the top when the last book shown has gone', async () => {
    LIBRARY = LIBRARY.slice(0, 300);
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(rows()).toBe(100));
    LIBRARY.splice(99, 1);
    fireEvent.click(showMore()!);
    await waitFor(() => expect(screen.getByText(/starts again from the top/)).toBeTruthy());
    expect(titles()).toEqual(LIBRARY.slice(0, 100).map((b) => b.title));
  });

  it('doesn’t page the new search with the old list while its first page loads', async () => {
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(rows()).toBe(100));
    fireEvent.click(showMore()!);
    await waitFor(() => expect(rows()).toBe(200));
    fireEvent.click(showMore()!);
    await waitFor(() => expect(rows()).toBe(300));
    let releaseFirst!: () => void;
    let releaseMore!: () => void;
    holdFirst = { q: 'harbor', until: new Promise<void>((r) => (releaseFirst = r)) };
    holdMore = new Promise<void>((r) => (releaseMore = r));
    await searchFor('harbor');
    // The old list is still showing; paging it now would mix the two lists.
    if (showMore()) fireEvent.click(showMore()!);
    // The new first page answers first, then the stray "more" answer.
    await act(async () => {
      releaseFirst();
      await holdFirst!.until;
    });
    await waitFor(() => expect(screen.getByText('575 items match')).toBeTruthy());
    await act(async () => {
      releaseMore();
      await holdMore;
    });
    const harbor = LIBRARY.filter((b) => b.title.startsWith('Harbor'));
    await waitFor(() => {
      expect(titles()).toEqual(harbor.slice(0, 100).map((b) => b.title));
      expect(rows()).toBe(100);
    });
  });

  it('clears an error once a later load works', async () => {
    failItems = true;
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Test failure/));
    failItems = false;
    await searchFor('ledger');
    await waitFor(() => expect(rows()).toBe(100));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the shortlist star fails, and leaves the star as it was', async () => {
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(rows()).toBe(100));
    failShortlist = true;
    const star = screen.getByRole('button', { name: 'Shortlist Ledger 0001' });
    fireEvent.click(star);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /Couldn’t change the shortlist for Ledger 0001/,
      ),
    );
    expect(star.getAttribute('aria-pressed')).toBe('false');
    failShortlist = false;
    fireEvent.click(star);
    await waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
