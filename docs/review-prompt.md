# Промпт для проверки проекта другим ИИ

Скопируйте текст ниже целиком в другого ИИ-агента (Claude, GPT, Grok, Gemini…), у которого есть доступ к репозиторию
`uwais310/ingush-translator` (клон на диске или GitHub). Он проверит проект и предложит улучшения отдельными PR.

---

You are reviewing and improving an open-source **Ingush ↔ Russian translator that works without AI**
(repository: uwais310/ingush-translator). Read `CLAUDE.md`, `HANDOFF.md`, `README.md` and `docs/translation-rules.md` first.

**Hard rules (do not break them):**
1. Never invent Ingush. Every Ingush word or form must come from `lib/ingush-guide.js`, `lib/rules/lexicon.js`,
   `data/phrases.json` (project glossary, PaydaDosh), the attested word list `lib/ingush-words.js`, or real sentence pairs.
   If a form is not attested, leave the word in [brackets] rather than guess. Do not use an AI model to generate Ingush.
2. Do not edit `data/phrases.json` by hand; `verified: true` is set only by a person on `/review`.
3. No new dependencies without asking the owner. Keep the site plain HTML/JS with no build step.
4. Open questions wait for native speakers: past of «прийти» (вера / хьавенав), «мы идём» (долха / лелха), «ӀӀ».
5. Work on a branch from fresh `main`, open a pull request, never merge it yourself. One PR per topic.
   Production deploys cost credits: docs-only changes get `[skip netlify]`.

**How to check quality (run before and after every change, report the numbers):**
```sh
for f in test/*.test.js; do node "$f" || exit 1; done   # all must pass
node scripts/eval-chunks.js          # Russian → Ingush vs native speakers (5-fold; the sentence never sees itself)
node scripts/eval-chunks.js --inh    # Ingush → Russian
node scripts/check-everyday.js --bad # 466 everyday sentences with automatic error flags
node scripts/eval-rules.js           # grammar rules vs phrasebook (must not go down)
```
No eval may drop. Never make the eval leak the test sentence, and never drop words just to raise precision.

**What to review:**
- Correctness bugs in `lib/rules/*.js` (chunks, align, cases, verbs, sense, sense-inh, inh-verbs, ru-conj, ru-decl, lm),
  `lib/morph.js`, `lib/retrieval.js`, `api/translate.js` (`resolveExact` and the no-AI branch).
- Translations that change the meaning: run `node scripts/check-everyday.js` and the round-trip check
  (Russian → Ingush → Russian), list the worst 20 with the responsible function and a sourced fix.
- Speed: first request after start and per-sentence time; memory under ~1 GB.
- UI (`index.html`): readability on a 375 px phone, accessibility, no layout shift; the page must stay simple.
- Reports from users: the «Неправильный перевод?» link saves entries under the store key `reports`
  (Supabase table `kv` or Netlify Blobs; locally `local-data/phrases-reports.json`). Use them to find real failures.

**Deliverables:** a short written review (what is good, the top problems ranked by impact, with file:line), then
focused PRs that fix the top problems, each with before/after eval numbers and tests that use only sourced examples.
