# Beat PaydaDosh: past tense, ergative names, Ingush name spelling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** «Ахмед купил хлеб в Назрани» → «Ахьмада маькх ийцар Наьсаре» without AI and without invented forms.

**Architecture:** Past forms by the vowel-change patterns of the glossary («хатта → хаьттар», «деша → дийшар»), accepted
only when the exact form is attested in Ingush texts or the PaydaDosh phrasebook. Name spelling and the name's
-а form from Wikidata person labels («Матиев Ахмет Хасанович | Матенаькъан Хьасана Ахьмад») and phrasebook pairs.

**Tech Stack:** Node 18, no dependencies. Tests are plain `node test/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-11-27-beat-paydadosh-grammar-design.md`

## Global Constraints
- Never invent Ingush: every output form must be attested (word list, phrasebook, Wikidata).
- No new data formats, no edits to `data/phrases.json`, no dependencies.
- `node scripts/score.js` numbers (eval-rules) must not go down.

## Review Focus
- Homonym infinitives («дала» give/die): two attested candidates → silent.
- d-initial intransitive verbs need class: only emit class forms that are attested.
- Name in an oblique case («у Ахмеда») keeps the existing [bracket] behaviour.
- Name as object («вижу Ахмеда») must not get the ergative.
- Intransitive past («Ахмед пришёл») must not get the ergative.

---

### Task 1: Past tense by attested vowel change (`lib/rules/verbs.js`)
**Files:** Modify `lib/rules/verbs.js`, `lib/rules/chunks.js` (ruWord past branch); Test `test/past-tense.test.js`
**Produces:** `V.pastOf(inf: string) → string | null` (one attested form or null).
- [ ] Test: pastOf("эца")="ийцар", ("деша")="дийшар", ("хатта")="хаьттар", ("лаха")="лехар", ("дала")=null; translate «Я купил хлеб.» contains «ийцар»; «Брат купил хлеб.» contains «ийцар».
- [ ] Run: fails.
- [ ] Implement: stem vowel map а→аь/е/и, е,э,у→ий, о→уо, и→и; suffix -ар/-ир; keep candidates attested (word list or phrasebook tokens); if several, prefer phrasebook-attested; exactly one or null. Use in chunks past branch after dictionary «прош.» and ALIGN.
- [ ] Run tests + score.js; commit.

### Task 2: Ingush spelling of names and their -а form (`lib/rules/names-inh.js`)
**Files:** Create `lib/rules/names-inh.js`; Modify `lib/rules/chunks.js` (name hit + ergative step); Test `test/names-inh.test.js`
**Produces:** `makeNamesInh(pairs) → { nom(ruName) → string|null, erg(ruName) → string|null }`.
- [ ] Test: nom("Ахмед")="Ахьмад", nom("Хасан")="Хьасан", erg("Ахмед")="Ахьмада"; «Ахмед купил хлеб в Назрани.» → «Ахьмада маькх ийцар Наьсаре.» (word order may differ); «Ахмед пришёл.» has no «Ахьмада»; «Я вижу Ахмеда» has no «Ахьмада».
- [ ] Implement: from Wikidata person pairs align given name (ru first-name ↔ inh last token) and patronymic (-ович/-овна ↔ inh genitive -а); from phrasebook speaker names. Need ≥1 Wikidata pair or phrasebook pair; conflicts → null. Ergative = the -а form, used only for the doer of a transitive verb (same condition as existing noun ergative).
- [ ] Run tests + score.js; commit.

### Task 3: Measure, PR
- [ ] score.js before/after; the 3 PaydaDosh sentences; full test suite; push; PR on top of PR #56 branch; list for native-speaker check.
