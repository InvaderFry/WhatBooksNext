-- Store links (docs/plans/get-store-purchase-imports.md, "Store links"). A store copy can carry a
-- link that opens the book in that store's web reader or on its store page. locations is backed
-- up as a whole table, so these columns travel with backups. Every column is nullable or has a
-- default, so older backups still restore.

-- The link, https only and on that store's own hosts (checked in server/src/lib/store.ts).
-- NULL: no link.
ALTER TABLE locations ADD COLUMN url TEXT;

-- What it opens: 'read' (the store's web reader) or 'page' (its store or library page).
ALTER TABLE locations ADD COLUMN url_kind TEXT CHECK (url_kind IN ('read', 'page'));

-- 1 when the owner typed, changed or removed the link. Imports never replace it then, and a
-- removed link (url NULL, url_by_owner 1) stays removed.
ALTER TABLE locations ADD COLUMN url_by_owner INTEGER NOT NULL DEFAULT 0 CHECK (url_by_owner IN (0, 1));
