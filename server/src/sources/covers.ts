import type { SourceName } from './types.ts';

/** Public image hosts used by our sources. Never accept local addresses or arbitrary URLs. */
export const COVER_HOSTS: Partial<Record<SourceName, string[]>> = {
  hardcover: ['cdn.hardcover.app', 'assets.hardcover.app', 'images.hardcover.app'],
  metron: ['static.metron.cloud', 'metron.cloud'],
  comicvine: ['comicvine.gamespot.com', 'comicvine1.cbsistatic.com'],
  openlibrary: ['covers.openlibrary.org'],
  anilist: ['s4.anilist.co', 's.anilist.co'],
};
export const COVER_ORIGINS = [...new Set(Object.values(COVER_HOSTS).flat())].map(
  (h) => `https://${h}`,
);

export function sourceCoverUrl(source: SourceName, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      (u.port && u.port !== '443') ||
      !COVER_HOSTS[source]?.includes(u.hostname)
    )
      return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * Where a picture may be redirected: its source's image hosts and, for Open Library only, the
 * Internet Archive, which serves Open Library's older covers (archive.org, then a numbered
 * ia….us.archive.org server; owner decision 2026-11-15). Same rules otherwise: https, no
 * user name or password, the usual port. Undefined means refuse it.
 */
export function coverRedirectUrl(source: SourceName, value: string): string | undefined {
  const listed = sourceCoverUrl(source, value);
  if (listed || source !== 'openlibrary') return listed;
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      (u.port && u.port !== '443') ||
      !(u.hostname === 'archive.org' || /^ia\d+\.us\.archive\.org$/.test(u.hostname))
    )
      return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}
