# Ingush Translator

A free, open-source translator for the Ingush language (ГӀалгӀай мотт). It looks things up in dictionaries and applies grammar rules first, and asks an AI model only when those don't have the answer.

**Try it:** https://stalwart-paletas-57ff72.netlify.app

<!-- Screenshot: save one as docs/screenshot.png and replace this comment with
![Ingush Translator on a phone](docs/screenshot.png) -->

> **По-русски.** Это бесплатный переводчик с ингушского на русский и обратно. Сначала он ищет ответ в словаре и разговорнике и собирает предложение по правилам грамматики, а ИИ подключается, только если база ответа не знает. Нашли ошибку или знаете слово, которого нет? Напишите в [Issues](https://github.com/uwais310/ingush-translator/issues/new/choose), можно по-русски: каждое исправление носителя языка делает перевод лучше для всех. Баркал!

## Why this exists

Roughly 330,000 to 350,000 people speak Ingush, and UNESCO's atlas of endangered languages lists it as vulnerable. Many Ingush families live outside Ingushetia, in Kazakhstan, other parts of Russia and Europe, and a lot of young people grow up understanding the language but hardly speaking it.

Most translation tools still don't offer Ingush. General AI models will write something that looks like Ingush, but it's often wrong: made-up words, Chechen forms in place of Ingush ones, the wrong noun class.

So this project goes the other way around. It trusts real sources first, says where every answer came from, and lets native speakers correct it. My family members who are native speakers check and fix the translations.

## What it does

- Translates between **Ingush and Russian** in both directions. English, Chechen, Kazakh, Turkish, Arabic, German and French are in the menu too, but those go through AI only.
- Answers from a database of 42,061 Russian–Ingush entries (32,183 words, 8,188 phrases, 1,690 names). If the exact form isn't there, it looks for the base form: «маму» finds «мама», «люблю» finds «любить».
- Builds simple sentences from grammar rules, without AI, both ways: «У меня есть…», «Где…?», «Мне нужен…», «Я тебя люблю», «Я (не) понимаю», «Это мой дом» and others. If the Russian doesn't show whether a man or a woman is speaking, it gives both versions.
- Labels every answer with where it came from: checked by a native speaker, from the database, built by the rules, or AI (with a warning that it may be wrong).
- Checks AI output against about 155,000 word forms from Ingush books and newspapers. Unknown words are underlined, known Chechen forms are swapped for Ingush ones, and the AI gets a second try at the doubtful words.
- Has a review page (`/review`) where native speakers mark translations as correct, fix them, or translate a list of 200 everyday sentences. Checked answers are always used first.
- Has a page that lists every grammar rule with its examples (`/rules`).
- Installs on a phone like an app. It also has a key for the letter Ӏ (palochka), voice input for languages the browser can recognize (not Ingush yet), history, copy and share, a "no AI" switch and a "compare AI models" button.

## How a translation is made

1. **Native speakers' corrections**, saved from the site or approved on `/review`.
2. **The database**: the project's own phrasebook and glossary, then PaydaDosh, then open dictionaries, then the base form of the word.
3. **Grammar rules** (`lib/rules/`). Every word a rule produces must exist in a dictionary or in the word list. If a form isn't attested, the rule stays silent rather than guess.
4. **Sentence by sentence**: a longer text where every sentence is already known is put together from those sentences.
5. **AI as the last step**, through whichever services have an API key: Claude Haiku via OpenRouter when that account has credit, then Google Gemini and xAI Grok, with free models on Groq and OpenRouter as backups. The prompt includes a short Ingush grammar guide (`lib/ingush-guide.js`), the dictionary entries for the words in the text and up to 16 similar example pairs (`lib/retrieval.js`). The answer is then checked as described above.

Steps 2–4 cover Russian ↔ Ingush only. The server side lives in `api/translate.js`. The pages are plain HTML (`index.html`, `review.html`, `rules.html`) with no build step.

## Using it

Open the site, pick the languages and type. To install it on a phone: Safari → Share → Add to Home Screen, or Chrome → ⋮ → Install app.

To run it on your own computer you need Node.js 18 or newer, and nothing else to install:

```sh
cp .env.example .env    # optional: add a free GEMINI_API_KEY for the AI step
node server.js          # then open http://localhost:3000
```

The database and grammar rules work without any key. Tests: `for f in test/*.test.js; do node "$f"; done`

## Contributing

You don't need to be a programmer. If you speak Ingush, the most useful thing you can do is tell us when a translation is wrong, or add a word that's missing. [CONTRIBUTING.md](CONTRIBUTING.md) explains how, step by step, in English and Russian.

## Data sources and thanks

- **[PaydaDosh](https://paydadosh.ru)**, the online Ingush dictionary created by Yunus Akhilgov: dictionary entries, phrasebook and proverbs, used **with the permission of the PaydaDosh team**. This data is not under an open license.
- Open dictionaries: Russian Wiktionary and Ingush Wikipedia (CC BY-SA 4.0), Wikidata and PanLex (CC0), translatewiki.net (CC BY 3.0).
- [ing_freq_dict](https://github.com/YandievRuslan/ing_freq_dict) by YandievRuslan (WTFPL): the list of Ingush word forms used to check the output.
- [GhalghayTools](https://github.com/Morgxth/GhalghayTools): parallel corpus. Only word statistics and fingerprints are kept here. The texts are downloaded at runtime and not redistributed.
- The grammar guide uses short word pairs and examples from the dictionaries of N. D. Kodzoev, A. S. Kurkiev and J. Nichols, via [polonkoevv/ingush_dictionary](https://github.com/polonkoevv/ingush_dictionary).

Every entry in `data/phrases.json` records its source, and open-source entries also record their license. [SOURCES.md](SOURCES.md) (in Russian) lists all sources, their licenses and which sources were left out on purpose, and why.

## Roadmap

- More grammar rules, including forms we're still checking with native speakers (for example «пришёл», «мы идём») and Ingush → Russian sentences with adverbs and names.
- Flag Russian words that the AI leaves untranslated in Ingush output (in review).
- More checked translations through `/review`, and a separate, openly licensed set of sentence pairs checked by native speakers.
- Database answers for English, not only Russian, and an interface in Ingush and English (it's Russian only for now).
- Long term: help get Ingush into the major translation services, by offering checked data wherever they accept contributions for new languages.

## License

The code is released under the [MIT License](LICENSE). The data keeps its own terms: open sources keep their original licenses (see the `license` field and SOURCES.md), and PaydaDosh entries are used with permission and are not covered by the MIT License.
