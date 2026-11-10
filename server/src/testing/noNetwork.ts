// Tests never reach the internet (CLAUDE.md): online sources are tested against recorded
// responses in fixtures/sources, through a fake fetcher. Any real request fails loudly here.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`Network disabled in tests (tried ${String(input)}). Pass a fake fetcher.`);
}) as typeof fetch;
