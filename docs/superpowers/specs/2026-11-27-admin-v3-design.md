# Admin panel v3 — design

Uwaus (2026-11-27): «админку тоже улучш, сделай больше features that u think will be cool and few that will be useful». Claude picks. List posted in the project thread; build all seven.

## Constraints
- Touch only `admin.html`, the `adminAction` part of `api/translate.js`, `lib/admin-insights.js`, `lib/activity-log.js` (read-only helpers ok), tests. Not the translation engine, not `sw.js` (admin.html is not cached by sw.js), not `index.html`.
- No new dependencies, no AI calls, no Ingush text invented anywhere (UI strings Russian only).
- Storage formats stay the same (keys `all`, `reports`, `log`, `log-stats`, `review`, `distilled`, `trash`). New fields only in API responses.
- Everything works on a phone (~375px), light and dark themes, existing visual style (cards, `.chart`, `.hbar`, `.rank`).
- All tests pass: `for f in test/*.test.js; do node "$f"; done`.

## Features
1. **Restore from backup** (useful). Overview → card «Копия»: button «Восстановить из файла». Reads an `ingush-translator-backup` JSON (from op `backup`). New op `restore` with `dry: true` returns counts of what would be added; without dry, merges: corrections (`all`) added by phraseId when not present (existing wins), reports added by reportId when missing, review entries added by key when missing, log entries merged by `at+text` (sorted, trimmed to MAX), log-stats days taken where missing. Never deletes or overwrites. Before applying, the page shows the counts and asks confirm. Validate `kind`, size limits (reject > ~5 MB body is handled by server; cap arrays).
2. **Quality by day** (useful). Chart 14 days: % of logged translations that were fully found = translation non-empty, how ≠ none, no `[...]` brackets. Computed from log (`INSIGHTS.quality(log, days)`), returns per-day {total, full}. Days with 0 shown empty.
3. **Dictionary conflicts** (useful). `INSIGHTS.conflicts(dict)`: site-dictionary entries with same direction + normalized text but different translations. Shown in Словарь tab top as a warning card listing groups, each entry with «Удалить» (uses existing `dict-delete`). Count also in the Словарь tab badge tooltip.
4. **Server health** (useful). `data` response gets `server: { uptimeSec, memMB, node, version, startedAt, logPending }`. `version`: `process.env.RAILWAY_GIT_COMMIT_SHA` or `COMMIT_REF` short, else read `.git/HEAD` best effort, else "—". Card at bottom of Обзор.
5. **Live feed «Сейчас на сайте»** (cool). Card at top of Обзор: last 8 translations, "за последний час: N", a pulsing dot when live. Toggle «Живой режим» polls op `live` every 20s (returns last 20 log entries + count last hour, cheap: LOG.read but no dict/insights), new rows animate in (respect prefers-reduced-motion). Pauses when tab hidden.
6. **Heatmap** (cool). 7×24 grid weekday × hour (local time of the viewer) from log entries, colour intensity by count, tooltip with count. Horizontal scroll avoided: cells shrink on phone (24 columns at ~12px).
7. **Records** (cool). Card with: best day (date + count, from log-stats), current streak of consecutive days with ≥1 translation (up to today or yesterday), longest streak, total all time, next milestone (100, 500, 1000, 2500, 5000, 10000…) with progress bar; when total crossed a milestone in the last 7 days show a small celebration line.

## Left to the builder
Exact layout, wording, colours within the existing style.
