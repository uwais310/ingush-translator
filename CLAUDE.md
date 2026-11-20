# Ingush Translator — notes for Claude Code

A free, open-source translator for the Ingush language (ГӀалгӀай мотт) ↔ Russian. Works without AI (dictionaries, rules, a word/phrase table learned from real pairs); AI only with `USE_AI=1`. Current state and next steps: HANDOFF.md. Live site on Netlify, code on GitHub: uwais310/ingush-translator.

The owner is Uwais. He writes in Russian or English, casually; answer in the language he uses. He is on a phone a lot: keep replies short and lead with the result.

## Run and test

No build step and no `npm install` needed (Node 18+).

```sh
node server.js                                   # http://localhost:3000 (database + rules work without keys)
for f in test/*.test.js; do node "$f"; done      # all tests must pass before any commit
node scripts/eval-rules.js                       # rules vs native speakers (PaydaDosh phrasebook)
node scripts/eval-chunks.js                      # word-by-word translator vs native speakers
node scripts/eval-retrieval.js                   # how many needed words reach the AI prompt
node scripts/eval-postcheck.js                   # Russian words left in Ingush AI output
```

AI keys live only in `.env` locally (see `.env.example`) and in Netlify environment variables. Never put a key in code or commits.

## How a translation is made (api/translate.js → resolveExact, then AI)

1. Native speakers' corrections (saved corrections, `/review` approvals) — always first.
2. Database `data/phrases.json`: project glossary/phrasebook → PaydaDosh → open dictionaries → base form (`lib/morph.js`).
3. Grammar rules `lib/rules/` (ru→inh `grammar.js`, inh→ru `reverse.js`, word library `lexicon.js`). A rule stays silent if any form isn't attested.
4. Longer text assembled sentence by sentence from known sentences.
5. Word-by-word / longest-chunk translation without AI (`lib/rules/chunks.js`). This is the last step unless `USE_AI=1` is set.
6. (Only with `USE_AI=1`) AI fallback with grammar guide (`lib/ingush-guide.js`), dictionary entries and example pairs (`lib/retrieval.js`). Output is checked: unknown words against ~155k Ingush word forms (`lib/ingush-words.js`), Russian words left in (`lib/postcheck.js`), Chechen forms swapped; a second "repair" pass fixes doubtful words.

Pages: `index.html` (translator), `review.html` (`/review`, native-speaker checks), `rules.html` (`/rules`). `sw.js` is the PWA cache — bump its version when pages change. `netlify.toml` hides `/data`, `/lib`, `/api` etc. from the site.

## Hard rules

- **Never invent Ingush.** Every Ingush word or form in code or data needs a source: the project glossary, PaydaDosh, or a native speaker. If unsure, leave it out and say so. Don't generate Ingush with AI for the database, lessons or tests.
- `verified: true` is set only by a person on `/review`, never in code or data.
- Don't edit `data/phrases.json` by hand. Change sources or `scripts/build-phrases.js` and rebuild; a rebuild must keep the same record count and ids.
- New grammar rules come with sourced examples, and `eval-rules` must not go down.
- Don't add dependencies, delete files or change data formats without asking Uwais first.

## Git and deploys

- Work on a new branch from fresh `main`, open a pull request, and let Uwais (or Grok) merge. Don't push to someone else's branch.
- Netlify free plan: every production deploy costs credits. Docs-only or non-site changes: put `[skip netlify]` in the merge commit message. Deploy Previews of PRs are free.
- End commit messages with a short "what and why"; keep commits focused.

## Team

Grok (another AI agent) also works in this repo. Agreed split:
- Grok: Netlify (deploys, env vars, credits), AI model list and prompts, data (`data/phrases.json`, `/review`), interface (`index.html`, `review.html`), the `/learn` section (PR #19 `learn-mvp`).
- Claude: `lib/rules/*` (incl. chunks, align, cases, verbs, sense, inh-verbs, ru-conj, ru-decl), `lib/morph.js`, `lib/retrieval.js`, `lib/postcheck.js`, `scripts/eval-*.js`, `scripts/check-everyday.js` and their tests.
- `api/translate.js` is shared: Grok owns prompts/models, Claude owns `resolveExact` and the rules/post-check hooks.

## Data and licenses

Code: MIT (`LICENSE`). Data keeps its own terms (`SOURCES.md`): open sources keep their licenses; PaydaDosh entries are published here with PaydaDosh's permission and are not an open license.

## Open questions waiting for native speakers

Forms of «пришёл» (вера / хьавенав), «мы идём» (долха / лелха) and some noun classes — don't guess them; add them to the rules only once Uwais's family confirms.
