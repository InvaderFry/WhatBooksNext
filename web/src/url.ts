import { useEffect, useState } from 'react';

// URL state without a router (PLAN.md §5): the view and its filters live in the query string,
// so Back/Forward and bookmarks work.

const EVENT = 'wbn:navigate';

export type Params = Record<string, string>;

export function readParams(): Params {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

export function hrefFor(params: Params): string {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== '' && v !== undefined),
  );
  const qs = new URLSearchParams(clean).toString();
  return qs ? `/?${qs}` : '/';
}

export function navigate(params: Params, opts: { replace?: boolean } = {}): void {
  const url = hrefFor(params);
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(EVENT));
  if (!opts.replace) window.scrollTo({ top: 0 });
}

/** Merges into the current params (e.g. one filter changing). Filters replace history. */
export function updateParams(
  changes: Params,
  opts: { replace?: boolean } = { replace: true },
): void {
  navigate({ ...readParams(), ...changes }, opts);
}

export function useParams(): Params {
  const [params, setParams] = useState(readParams);
  useEffect(() => {
    const on = () => setParams(readParams());
    window.addEventListener('popstate', on);
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener(EVENT, on);
    };
  }, []);
  return params;
}

/** An in-app link: a real <a href> (middle-click works) that navigates without a reload. */
export function onLinkClick(params: Params) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(params);
  };
}
