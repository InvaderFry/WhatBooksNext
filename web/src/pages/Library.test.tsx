// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ItemSummary } from '../api.ts';
import { updateParams } from '../url.ts';
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

const LIBRARY = Array.from({ length: 1150 }, (_, i) => book(i + 1));

/** Answers like the real server, including its cap of 1,000 books per answer. */
let failItems: boolean;
let failShortlist: boolean;
/** While set, answers for "more" pages wait for it. */
let holdMore: Promise<void> | null;
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
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (offset > 0 && holdMore) await holdMore;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000);
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const list = LIBRARY.filter((b) => b.title.toLowerCase().includes(q));
    return json(200, {
      total: list.length,
      items: list.slice(offset, offset + limit),
      storeCounts: {},
    });
  }
  return json(404, { error: 'No such route.' });
}

const rows = () => document.querySelectorAll('.item-row').length;
const showMore = () => screen.queryByRole('button', { name: /^Show \d+ more$/ });

beforeEach(() => {
  failItems = false;
  failShortlist = false;
  holdMore = null;
  requests = [];
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
    act(() => updateParams({ q: 'harbor' }));
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
    act(() => updateParams({ q: 'harbor' }));
    await waitFor(() => expect(screen.getByText('575 items match')).toBeTruthy());
    await act(async () => {
      release();
      await holdMore;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toBe(100);
    expect(
      [...document.querySelectorAll('.item-title')].every((a) =>
        a.textContent!.startsWith('Harbor'),
      ),
    ).toBe(true);
  });

  it('clears an error once a later load works', async () => {
    failItems = true;
    render(<Library state={STATE} onScanStarted={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Test failure/));
    failItems = false;
    act(() => updateParams({ q: 'ledger' }));
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
