# Review guide for the Ingush translator

Write review comments in Russian, short and simple.

Project rules (full version in CLAUDE.md):

- **Never invent Ingush.** Every Ingush word or form added in code, data or tests needs a source:
  the project glossary, PaydaDosh, or a native speaker. Flag new Ingush text that has no source.
- `verified: true` is set only by a person on `/review`, never in code or data.
- `data/phrases.json` is not edited by hand; it is rebuilt by `scripts/build-phrases.js`.
- Grammar rules in `lib/rules/` stay silent when a form isn't attested, and come with sourced examples and tests.
- No new dependencies, deleted files or changed data formats without the owner's OK.
- No API keys or secrets in code.
- If pages change, the cache version in `sw.js` must be bumped.
- Plain Node 18+, no build step: don't suggest TypeScript, bundlers or frameworks.
