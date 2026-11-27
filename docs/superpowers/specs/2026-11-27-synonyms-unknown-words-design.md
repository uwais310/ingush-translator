# Fewer unknown words: synonyms (ru→inh) and better word lookup (inh→ru)

## Why
Uwaus (Nov 27): many complaints, Ingush→Russian is only ~60% right; "if it can't find a word, let it use synonyms".
Live admin: 53% of answers come word-by-word, 16% not found. Measured on native-speaker phrases (eval-chunks, held-out):
ru→inh 812 of 7234 phrases (11%) contain a `[unknown]` word; inh→ru 2931 of 8120 (36%).

## Goals
- Fewer `[unknown]` words in both directions, without AI and without inventing Ingush.
- ru→inh: an unknown Russian word is replaced by a Russian synonym the dictionary knows. Synonyms come only from
  the project's own dictionary (Russian senses of the same Ingush entry: «большой, крупный»), never a new source.
- inh→ru: an unknown Ingush word is found through spelling variants, class-marker swaps, more endings, and
  dictionary/corpus entries that the word-by-word step ignores today (e.g. «аьнна» — «сказав» is in the corpus table).
- Uncertain matches are marked (how: "synonym" / "near") so the page and the log can tell them apart.

## Non-goals / anti-goals
- No admin panel changes. No AI. No new dependencies or data formats. No hand edits to data/phrases.json.
- Never output an Ingush form that is not attested (dictionary, PaydaDosh, glossary, corpus word list).
- A change that lowers any number in `node scripts/score.js` is a failure even if unknowns go down.

## Approach (picked)
Coder agent + harsh critic agent loop: coder implements and measures; critic reviews diff and sample outputs
like Uwaus would; repeat until the critic has no real complaints. Alternatives rejected: external Russian
thesaurus (new source, needs permission); AI fallback (goal is no AI).
