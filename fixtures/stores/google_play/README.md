# Invented Google Play Books cards

What the Google Play Books console script reads from each `gpb-volume-card` on
`play.google.com/books?source=purchases`, as plain objects (see
`tools/store-collector/adapters/googlePlay.ts`). The structure copies the owner's look-around
report of 2026-11-11 (field names and card types only). Every title, author and volume ID is
invented, and the IDs start with `inv`, so none can point to a real book.
