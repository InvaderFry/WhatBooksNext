// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useParams } from '../url.ts';
import { AddAudiobookFolderForm } from './Settings.tsx';
import { AddStoreBook, PlacesSection } from './StoreBooks.tsx';
import { WhatNext } from './WhatNext.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the audiobook folder form in Settings', () => {
  it('submits the path, waits for the server, and explains that a scan is needed', async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const added = vi.fn();
    render(<AddAudiobookFolderForm onAdded={added} />);
    fireEvent.change(screen.getByLabelText('Add a folder of audiobooks'), {
      target: { value: 'E:\\Audiobooks' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add audiobook folder' }));
    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(added).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      '/api/audiobook-folders',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'E:\\Audiobooks' }),
      }),
    );
    answer(json({ folderId: 'folder', dir: '', newFolder: true }));
    await screen.findByText('Added. Press Scan now to list the audiobooks in it.');
    expect(added).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Add a folder of audiobooks') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('keeps the path after a failure and clears the error after a successful retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: 'That folder is already marked.' }, 409))
        .mockResolvedValueOnce(json({ folderId: 'folder' })),
    );
    const added = vi.fn();
    render(<AddAudiobookFolderForm onAdded={added} />);
    const input = screen.getByLabelText('Add a folder of audiobooks') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'E:\\Audiobooks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add audiobook folder' }));
    await screen.findByText('That folder is already marked.');
    expect(input.value).toBe('E:\\Audiobooks');
    expect(added).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add audiobook folder' }));
    await screen.findByText('Added. Press Scan now to list the audiobooks in it.');
    expect(screen.queryByText('That folder is already marked.')).toBeNull();
  });
});

describe('adding a new Audible title', () => {
  it('sends the typed title and playing time and opens the saved book', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ itemId: 'new-book', joined: false }),
    );
    vi.stubGlobal('fetch', fetch);
    render(<AddStoreBook onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Where'), { target: { value: 'audible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type it in' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The Glass Orchard' } });
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.search).toBe('?view=item&id=new-book'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/store/items',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      title: 'The Glass Orchard',
      store: 'audible',
      listenMinutes: 552,
    });
  });
});

describe('adding Audible to an existing book', () => {
  it('sends the optional hours and minutes as a listening length', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      json(init?.method === 'POST' ? { id: 'audible' } : []),
    );
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn();
    render(<PlacesSection itemId="book" hasFiles onChanged={changed} />);
    fireEvent.change(await screen.findByLabelText('Also in'), { target: { value: 'audible' } });
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      '/api/items/book/locations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ store: 'audible', listenMinutes: 552 }),
      }),
    );
  });

  it('leaves a blank Audible length unknown and omits the length after switching stores', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      json(init?.method === 'POST' ? { id: 'place' } : []),
    );
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn();
    render(<PlacesSection itemId="book" hasFiles onChanged={changed} />);
    const store = await screen.findByLabelText('Also in');
    fireEvent.change(store, { target: { value: 'audible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      '/api/items/book/locations',
      expect.objectContaining({ body: JSON.stringify({ store: 'audible' }) }),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '9' } });
    fireEvent.change(store, { target: { value: 'kobo' } });
    expect(screen.queryByLabelText('Hours')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledWith(
      '/api/items/book/locations',
      expect.objectContaining({ body: JSON.stringify({ store: 'kobo' }) }),
    );
  });
});

function NextPage() {
  const params = useParams();
  return <WhatNext params={params} onChanged={() => {}} />;
}

describe('Read / Listen / Either on What next', () => {
  function server(audiobooks: boolean) {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/next')
        return json({
          view: 'read_next',
          cards: [],
          mightFit: [],
          total: 0,
          coverage: { eligible: 0, rated: 0, lengthKnown: 0 },
          modes: [],
          moods: [],
          topics: [],
          presets: [],
          taste: { on: false, outcomes: 0 },
          stillReading: 0,
          audiobooks,
        });
      if (url.pathname === '/api/triage') return json({ lastScan: null });
      if (url.pathname === '/api/lookups')
        return json({ pending: 0, pendingSeries: 0, status: null });
      if (url.pathname === '/api/saved-views') return json({ views: [], max: 10 });
      return json({ error: `Unexpected request: ${url.pathname}` }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('defaults to Either and sends each selected medium to the server', async () => {
    const fetch = server(true);
    render(<NextPage />);
    const either = await screen.findByRole('radio', { name: 'Either' });
    expect((either as HTMLInputElement).checked).toBe(true);
    for (const [name, medium] of [
      ['Listen', 'listen'],
      ['Read', 'read'],
      ['Either', ''],
    ] as const) {
      fireEvent.click(screen.getByRole('radio', { name }));
      await waitFor(() => {
        const calls = fetch.mock.calls
          .map(([input]) => new URL(String(input), 'http://localhost'))
          .filter((url) => url.pathname === '/api/next');
        expect(calls.at(-1)!.searchParams.get('medium')).toBe(medium);
      });
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).checked).toBe(true);
    }
  });

  it('keeps a bookmarked Listen selection usable even when no audiobooks remain', async () => {
    server(false);
    window.history.replaceState(null, '', '/?medium=listen');
    render(<NextPage />);
    expect(
      ((await screen.findByRole('radio', { name: 'Listen' })) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('hides the control when there are no audiobooks and Either is selected', async () => {
    server(false);
    render(<NextPage />);
    await screen.findByText(/Nothing to recommend yet/);
    expect(screen.queryByRole('group', { name: 'Read or listen?' })).toBeNull();
  });
});

describe('correcting an Audible length', () => {
  function server() {
    const place = {
      id: 'audible-copy',
      kind: 'store',
      store: 'audible',
      readable: true,
      note: null,
      url: null,
      urlKind: null,
      urlHost: null,
      urlByOwner: false,
      listenMinutes: 552 as number | null,
    };
    let fail = false;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        if (fail) return json({ error: 'Could not save the length.' }, 500);
        place.listenMinutes = JSON.parse(init.body as string).listenMinutes as number | null;
        return json({ ok: true });
      }
      return json([place]);
    });
    vi.stubGlobal('fetch', fetch);
    return {
      fetch,
      place,
      fail: (value: boolean) => {
        fail = value;
      },
    };
  }

  it('prefills the recorded length and saves a correction to the existing copy', async () => {
    const { fetch } = server();
    const changed = vi.fn();
    render(<PlacesSection itemId="book" hasFiles onChanged={changed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change length' }));
    expect((screen.getByLabelText('Hours') as HTMLInputElement).value).toBe('9');
    expect((screen.getByLabelText('Minutes') as HTMLInputElement).value).toBe('12');
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save length' }));
    await screen.findByText('Length in Audible: 10 h.');
    expect(changed).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/api/locations/audible-copy',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ listenMinutes: 600 }),
      }),
    );
  });

  it.each(['Remove length', 'blank fields'])(
    'sets the length back to unknown with %s',
    async (method) => {
      const { fetch } = server();
      render(<PlacesSection itemId="book" hasFiles onChanged={() => {}} />);
      await screen.findByRole('button', { name: 'Change length' });
      if (method === 'Remove length') {
        fireEvent.click(screen.getByRole('button', { name: 'Change length' }));
        fireEvent.click(screen.getByRole('button', { name: method }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Change length' }));
        fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save length' }));
      }
      await screen.findByText('Length in Audible: unknown.');
      expect(fetch).toHaveBeenCalledWith(
        '/api/locations/audible-copy',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ listenMinutes: null }),
        }),
      );
      expect(screen.getByRole('button', { name: 'Add length' })).toBeTruthy();
      await waitFor(() => expect(screen.queryByLabelText('Hours')).toBeNull());
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    },
  );

  it('keeps the edit after a failed save and allows a successful retry', async () => {
    const backend = server();
    backend.fail(true);
    const changed = vi.fn();
    render(<PlacesSection itemId="book" hasFiles onChanged={changed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change length' }));
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save length' }));
    await screen.findByText('Could not save the length.');
    expect((screen.getByLabelText('Hours') as HTMLInputElement).value).toBe('10');
    expect(changed).not.toHaveBeenCalled();
    backend.fail(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save length' }));
    await screen.findByText('Length in Audible: 10 h 12 min.');
    expect(screen.queryByText('Could not save the length.')).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  });
});
