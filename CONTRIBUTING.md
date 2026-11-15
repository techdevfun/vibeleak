# Contributing to vibeleak

Thanks for helping prove what a stranger can read - before a stranger does.

## Ground rules

- **Consent first.** Never point vibeleak at an app you do not own or are
  not authorised to test in writing. Tests and demos use only the local
  synthetic fixtures in `examples/` - never a real Supabase project.
- **Read-only, always.** Only GET/HEAD, `limit=1`, at most one request per
  table and one per bucket. No POST/PUT/PATCH/DELETE, no RPC calls.
- **No row values, ever.** Reports and tests store column names and a 0/1
  rows-visible flag only. Fixture data must be synthetic and labelled so.
- **No invented numbers.** Figures cited in the README or docs must come
  from a named source with a date. Never write that a platform "was
  hacked" unless a named source establishes it.
- **English only, ASCII only.** All public-facing text is English with no
  non-ASCII characters (`node scripts/preflight.js` enforces this).

## Development

```sh
npm install
npm run build
npm test        # unit + e2e against the local fake PostgREST fixture
npm run lint    # eslint + prettier
node scripts/preflight.js
```

## Pull requests

- Keep the zero-dependency rule: no runtime dependencies.
- Add a test for every new verdict rule or probe behaviour.
- Update the README verdict table when a rule changes.
- Keep the demo honest: `scripts/capture-demo.sh` records real CLI
  output on the fixtures; never hand-edit `demo/transcript.txt`.
