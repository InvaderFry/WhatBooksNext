# Invented Kobo library cards

What the Kobo console script reads from each `li.item-wrapper` on a library page
(`kobo.com/us/en/library/books?pageNumber=N`), as plain objects (see
`tools/store-collector/adapters/kobo.ts`). The structure copies the owner's look-around report of
2026-11-11 (field names only). Every title, author and product ID is invented; the IDs start with
`inv`, so none can point to a real book. The preview and Kobo Plus cards show how such marks are
treated; how Kobo really marks them is still to be seen on the owner's account.
