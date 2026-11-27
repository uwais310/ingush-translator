# Beat PaydaDosh's translator on simple sentences (grammar, no AI)

Approved by Uwaus 2026-11-27 («да»).

## Why
PaydaDosh launched its own neural translator (paydadosh.ru/perevodchik, test mode). On three simple ru→inh
sentences it beats ours on grammar:

| Russian | PaydaDosh | ours (PR #56) |
|---|---|---|
| Ахмед купил хлеб в Назрани. | Ахьмада маькх ийцар Наьсаре. | Ахмед маькх Наьсаре эца. |
| Мой брат работает в школе. | Са воша ишколе балха ва. | Са воша ишколе болх бе. |
| Завтра мы поедем в горы. | Кхоана лоам гӀоргда вай. | Кхоана тхо лоамаш гӀоргда. |

Ours leaves the verb in the dictionary form when the dictionary line has no «прош.» form, keeps the doer in the
nominative, and keeps Russian spelling of names.

## Goals
1. **Past tense from the phrasebook.** A table «Russian verb lemma → Ingush past form», learned from PaydaDosh
   phrase pairs at the lemma level (купил / купила / купили all count for «купить»). Used only when the
   dictionary line has no past form. Only forms written by native speakers in those pairs.
2. **Ergative doer.** In a sentence with a transitive verb, a noun or name doer takes its ergative form when
   that form is attested in a phrasebook pair (e.g. «Магомед узнал друга — ДоттагӀа вайзар мохьмада»).
   Otherwise unchanged.
3. **Ingush spelling of names.** Russian name → Ingush name from phrasebook pairs (Ахмед → ахьмад,
   Магомед → мохьмад).
4. Measure with `scripts/score.js` before/after and on the three sentences above.

## Non-goals
- «вай / тхо» choice, interface features (Grok's area: tap-word dictionary, ✓/✎ per sentence).
- Open native-speaker questions (пришёл, мы идём) stay closed.

## Anti-goals
- Any Ingush form not written by a native speaker in a source. A rule stays silent when unsure.
- `eval-rules` going down.

## Approaches
- **A (picked): learn tables from phrasebook pairs** (lemma-level co-occurrence, strict thresholds, form must look
  like a past/ergative of the same word). Sourced, measurable, no new data format.
- B: hand-written morphology (ablaut rules эца → ийцар). Rejected: would invent forms.
- C: neural model like PaydaDosh. Rejected: Uwaus wants no AI.

## Left to the builder
Exact thresholds, which suffix shapes count as past (-ар/-ир/-ай/-ра…), where tables live (`lib/rules/`).
