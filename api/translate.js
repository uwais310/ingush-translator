// Серверная функция перевода (Vercel: api/translate.js, Netlify: netlify/functions/translate.js).
//
// 1. Фразы, исправленные носителями языка (кнопка «Исправить» на сайте), хранятся в Netlify Blobs.
//    Если фраза уже есть в этом разговорнике — отдаём сохранённый перевод.
//    Похожие исправленные фразы добавляются в промпт как примеры, поэтому ИИ учится на них.
// 2. Потом — база без ИИ (lib/base.js): проверенные фразы, словарь, слова и целые предложения
//    из настоящих текстов. Такой ответ помечается «Из базы». С noAi: true ИИ не вызывается совсем.
// 3. Иначе промпт уходит по цепочке ИИ: сначала сильные модели, потом запасные.
//    Если в ответе ИИ есть слова, которых нет в ингушских текстах, страница просит второй проход
//    (action: "repair"): ИИ заменяет эти слова, и остаётся вариант, где таких слов меньше.
//    В промпте — справочник по ингушскому (lib/ingush-guide.js): правила, отличия от чеченского,
//    словарик частых слов и проверенные фразы. Gemini и Grok получают его целиком,
//    Groq и OpenRouter — коротко и только нужные слова (у них маленький лимит токенов).
//
// Ключи (переменные окружения хостинга), хватит одного:
//   GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY (платный)
// Если на счёте OpenRouter есть деньги, первым переводит Claude Haiku 5.5 (anthropic/claude-haiku-5.5):
// это платно, примерно 0,2 цента за перевод. Без денег на счёте всё работает бесплатно, как раньше.
// Кнопка «Сравнить ИИ» при деньгах на счёте показывает ещё и другие платные модели (COMPARE_PAID),
// чтобы носитель языка выбрал лучшую; выбранную ставят первой в DEFAULT_SEQUENCE.
// Необязательно: EDITOR_CODE — если задан, сохранять исправления можно только с этим кодом.
//   TIME_LIMIT_SECONDS — сколько секунд хостинг даёт функции (обычно определяется само).
//   OPENROUTER_MODEL — платная модель OpenRouter, которая переводит первой (по умолчанию anthropic/claude-haiku-5.5;
//                      например anthropic/claude-sonnet-5.5; off — без платной модели).
//   PROVIDER_ORDER   — порядок сервисов, например gemini,openrouter,groq.
//   AI_TEMPERATURE   — 0–0.2 для перевода (по умолчанию 0). Gemini 4 и 3.6+ её не принимают, им не передаётся.
//   GEMINI_THINKING  — low | medium | high: сколько думает Gemini, когда времени много (на Netlify всегда low).
//   DISTILL_MODELS   — модели, чьи уверенные переводы сохраняются как примеры для других (см. «дистилляция»).
// Подсказки под текст подбирает lib/retrieval.js; ИИ отвечает JSON {translation, confidence, unknown_words}.

const WORDS_RAW = require("../lib/ingush-words.js");
const KB = require("../lib/ingush-guide.js");
const CORPUS = require("../lib/corpus.js");
const LEX = require("../lib/corpus-lexicon.js");
const BASE = require("../lib/base.js")(KB, LEX);
const SEED = require("../data/phrases.json"); // база пар; verified ставит только человек на /review
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX }); // подбор слов и примеров под текст
// перевод по правилам грамматики без ИИ: библиотека слов lib/rules/lexicon.js + библиотека правил lib/rules/grammar.js
const RULES = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS: WORDS_RAW });
// русские слова, оставленные ИИ в ингушском переводе (список словоформ их не ловит: тексты двуязычные)
// перевод «по кускам» без ИИ: самые длинные известные фразы + слова из словаря (lib/rules/chunks.js)
// таблица слов из пар фраз (lib/rules/align.js) строится один раз при первом переводе по кускам
let CHUNKS_ = null;
const chunksEngine = () => {
  if (CHUNKS_) return CHUNKS_;
  const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "") && !p.rare; // rare — форм нет в текстах: в таблицу слов не берём
  const phrases = SEED.filter((p) => p.kind === "phrase" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES.map(([ru, inh]) => [ru, inh]));
  const words = SEED.filter((p) => p.kind === "word" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.GLOSSARY.map(([ru, inh]) => [ru, inh]));
  const ALIGN = require("../lib/rules/align.js")([...phrases, ...words]);
  return (CHUNKS_ = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN, EXAMPLES: phrases }));
};
const CHUNKS = { translate: (...a) => chunksEngine().translate(...a), inhLexicon: (...a) => chunksEngine().inhLexicon(...a) };
// ИИ выключен, пока в настройках не задано USE_AI=1: тогда вместо ИИ переводит CHUNKS (код ИИ остаётся)
const aiEnabled = () => process.env.USE_AI === "1";
const POST = require("../lib/postcheck.js")({ SEED, KB, L: require("../lib/rules/lexicon.js") });

const LANGS = {
  inh: "Ingush (ГӀалгӀай мотт)",
  ru: "Russian",
  en: "English",
  ce: "Chechen (Нохчийн мотт)",
  kk: "Kazakh",
  tr: "Turkish",
  ar: "Arabic",
  de: "German",
  fr: "French",
};
const MAX_CHARS = 3000;
const DEADLINE_MS = 9000; // если хостинг не сказал, сколько у нас времени: обычно обрывают через 10 секунд
const LONG_BUDGET_MS = 20000; // если времени столько или больше — модели могут думать дольше

// ---------------- промпты (одни и те же для всех ИИ) ----------------
// Каждый промпт состоит из двух частей:
//   system — постоянная часть: роль, правила и справочник по ингушскому (lib/ingush-guide.js).
//            Она одинаковая для всех текстов, поэтому Claude через OpenRouter и Gemini её кэшируют:
//            повторные переводы дешевле и быстрее.
//   user   — то, что подобрано под этот текст (lib/retrieval.js): нужные слова словаря, статистика
//            корпуса, похожие проверенные фразы, слова без перевода в базе и сам текст.
// Раньше Gemini получал весь словарик (559 слов) и все 132 фразы — длинный промпт, где нужные
// слова терялись. Теперь в промпт идут только 40 подходящих слов и до 16 похожих фраз.

const INGUSH_RULES = `Ingush rules:
- Ingush (ГӀалгӀай мотт) is the Nakh language of the Ingush people. It is close to Chechen but different: use Ingush words, grammar and spelling, never Chechen forms.
- Prefer the most common everyday Ingush words, as used in modern Ingush books and the newspaper «Сердало».
- Write Ingush in Cyrillic. Always write the palochka as the letter Ӏ (U+04C0), as in гӀ, кӀ, пӀ, тӀ, хӀ, цӀ, чӀ and standalone Ӏ. Never write it as 1, I, l or |.
- In Ingush input, 1, I, l or | next to letters stand for Ӏ.`;

const hasIngush = (src, tgt) => src === "inh" || tgt === "inh";

// Как не выдумывать слова (главная беда бесплатных моделей).
const honestyInh = (S) => `How to stay correct:
- Build the Ingush text from words you can see in the dictionary entries, the corpus word statistics and the example translations of this request. Change endings and class marks as the grammar needs.
- If you are not sure a word exists in Ingush, do not invent one and do not use a Chechen word instead. Use a simpler Ingush word you are sure about, or say the same thing in other words. If there is no way around it, write the ${S} word in square brackets, for example [компьютер], and add it to unknown_words.
- Never use the Chechen forms listed in the reference. Make every class mark agree (в for a man, й for a woman, б for many people, д for тхо, вай, шо); use the ergative for the doer of a transitive verb and the dative with хов, хац, лов, деза, хет, гу.
- Do not leave Russian words inside Ingush sentences (names of people, places and organisations stay as they are).
- Before answering, check your draft word by word against the reference, the dictionary entries and the examples: replace Chechen forms, fix class marks and case endings. Output only the corrected final version.
`;
const HONESTY_FROM_INH = `How to stay correct:
- The Ingush text may use dialect forms, typos or Latin/Chechen spellings: use the reference, the dictionary entries and the examples to understand it, and translate the meaning.
- If you cannot understand an Ingush word, keep it in square brackets, for example [кхоачам], and add it to unknown_words. Do not guess wildly.
`;

const textOutput = (T) => `Output rules:
- Keep the line breaks, punctuation, numbers and proper names. Keep the meaning and tone; use natural everyday ${T}.
- If the text is already in ${T}, return it unchanged.
- Reply with JSON only, exactly in this shape (no markdown, no notes outside the JSON):
{"translation": "the full ${T} translation", "confidence": "high | medium | low", "unknown_words": ["source words you were not sure how to translate"]}
- confidence: high — every word is taken from the dictionary or the examples; medium — some words are your own; low — you are guessing.`;

const wordOutput = (S, T) => `Reply with JSON only, in exactly this shape:
{"translation": "best ${T} translation",
 "alternatives": [{"text": "another ${T} translation", "meaning": "short gloss in Russian of how it differs"}],
 "part_of_speech": "noun | verb | adjective | adverb | phrase | other",
 "example": {"source": "a short everyday sentence in ${S} using it", "target": "that sentence in ${T}"},
 "note": "one short usage note in Russian, or an empty string",
 "confidence": "high | medium | low"}
Give 0 to 3 alternatives. Set confidence to low if you are not sure the ${T} words are correct.`;

const repairOutput = `Correct the draft:
- Replace each listed word with a real Ingush word or phrase of the same meaning. Take it from the dictionary entries, the corpus word statistics or the examples. If nothing there fits, say that part in other words that you are sure exist in Ingush; if even that is impossible, leave the source word in [square brackets].
- Keep every other word of the draft, changing it only where the grammar requires it (class marks, case endings).
- Names of people and places stay as they are.
- Output only the corrected translation, with no notes or explanations. Keep the line breaks.`;

// Постоянная часть промпта. kind: "text" | "word" | "repair"; tier: "full" (весь справочник) или "compact".
const SYSTEM_MEMO = {};
function systemPrompt(kind, src, tgt, tier) {
  const key = [kind, src, tgt, tier].join("|");
  if (SYSTEM_MEMO[key]) return SYSTEM_MEMO[key];
  const S = LANGS[src], T = LANGS[tgt], ing = hasIngush(src, tgt);
  const role =
    kind === "repair" ? `You are an editor and a native speaker of Ingush. You correct translations from ${S} into ${T}.`
    : kind === "word" ? `You are a bilingual dictionary${ing ? " made by native speakers of Ingush" : ""}. You translate single words and short phrases from ${S} into ${T}.`
    : `You are a professional translator${ing ? " and a native speaker of Ingush" : ""}. You translate texts from ${S} into ${T}.`;
  const ref = !ing ? "" :
    `\n\n${INGUSH_RULES}\n\n<ingush_reference>\n${tier === "full" ? KB.GUIDE : KB.GUIDE_SHORT}\n</ingush_reference>`;
  const honesty = tgt === "inh" ? honestyInh(S) : src === "inh" ? HONESTY_FROM_INH : "";
  const out = kind === "text" ? textOutput(T) : kind === "word" ? wordOutput(S, T) : repairOutput;
  return (SYSTEM_MEMO[key] = `${role}${ref}\n\n${honesty}${honesty ? "\n" : ""}${out}`);
}

// Подсказки под этот текст: словарь (только нужные слова) и слова, которых нет в базе.
function dictionaryBlock(text, src, tgt, tier, shots) {
  if (!hasIngush(src, tgt)) return "";
  if (src !== "ru" && src !== "inh") {
    // английский, казахский и т.п. → ингушский: по словам текста словарь не найти, даём весь словарик (как раньше)
    return tier === "full"
      ? `<dictionary>\nRussian — Ingush dictionary of common words (class of the singular / of the plural; мн. = plural form):\n${KB.GLOSSARY.map(([ru, inh]) => `${ru} — ${inh}`).join("\n")}\n</dictionary>\n\n`
      : "";
  }
  const order = RET.wordsOf(text);
  const at = (h) => { const i = order.indexOf((h.hits || [])[0]); return i < 0 ? 999 : i; };
  // записи идут в порядке слов текста (внутри слова — от надёжных к менее надёжным)
  const hits = RET.pickDictionary(text, src, tier === "full" ? 40 : 25).map((h, n) => ({ h, n })).sort((a, b) => at(a.h) - at(b.h) || a.n - b.n).map((x) => x.h);
  const missing = RET.missingWords(text, src, hits, shots);
  let out = "";
  if (hits.length) {
    // «слово текста: запись словаря» — чтобы ИИ видел, к какому слову относится запись («люблю: любить — деза»)
    const line = (h) => {
      const head = RET.normalize(h.ru), hit = (h.hits || []).filter((w) => w !== head).map((w) => w.replace(/ӏ/g, "Ӏ"));
      const tag = h.from === "open" ? " [open dictionary, not checked]" : h.from === "corpus" ? " [from texts, may be an inflected form]" : "";
      return `${hit.length && src === "ru" ? hit.join(", ") + ": " : ""}${h.ru} — ${h.inh}${tag}`;
    };
    out += `<dictionary_entries>\nRussian — Ingush dictionary entries for the words of this text. Before the colon is the word as it stands in the text; the entry itself is the dictionary (base) form, so put the Ingush word into the case, class and tense your sentence needs. Entries without a tag come from the project's dictionary and the PaydaDosh dictionary and are the most reliable. One word can have several entries: choose the one that fits the meaning here (class of the singular / of the plural; мн. = plural):\n${hits.map(line).join("\n")}\n</dictionary_entries>\n\n`;
  }
  if (missing.length) {
    out += `<not_in_dictionary>\nThese words of the text have no entry in the project's dictionary: ${missing.join(", ")}.\nTranslate them only if you are sure of the Ingush word; otherwise follow the rule about [square brackets].\n</not_in_dictionary>\n\n`;
  }
  return out;
}

// Примеры перевода (few-shot): исправления носителей, фразы справочника, переводы сильной модели.
// Самые похожие стоят последними — ближе к тексту.
function examplesBlock(shots, src, tgt) {
  if (!shots.length) return "";
  const S = LANGS[src], T = LANGS[tgt];
  const LABEL = { native: " (checked by a native speaker)", guide: "", paydadosh: "", open: " (open dictionary, not checked)", wiki: " (website interface text, not checked)", distilled: " (by a stronger AI model, not checked)" };
  const line = (e) => {
    if (e.source) return `${LANGS[e.source]}: ${e.text}\n${LANGS[e.target]}: ${e.translation}`; // другие языки
    const from = src === "inh" ? e.inh : e.ru, to = src === "inh" ? e.ru : e.inh;
    return `${S}: ${from}\n${T}: ${to}${LABEL[e.from] || ""}`;
  };
  return `<example_translations>\nCorrect translations of similar phrases. Reuse their words, spelling and grammar. Translations checked by a native speaker win over everything else.\n\n${shots.slice().reverse().map(line).join("\n\n")}\n</example_translations>\n\n`;
}

// Как слова текста переводятся в настоящих текстах (статистика по корпусу, без предложений).
function lexiconBlock(text, src, tgt, tier) {
  if (!hasIngush(src, tgt) || !(src === "ru" || src === "inh")) return "";
  const lines = LEX.lookup(text, src, tier === "full" ? 30 : 12);
  if (!lines.length) return "";
  return `<corpus_word_stats>\nHow the words of this text are translated in 35,000 real Ingush–Russian sentence pairs (books, «Сердало», Wikipedia); the number is how many times. Use these words, with the case and class your sentence needs.\n${lines.join("\n")}\n</corpus_word_stats>\n\n`;
}

// Настоящие пары предложений из корпуса (книги, «Сердало», Википедия) с теми же словами, что в тексте.
function corpusBlock(pairs, src, tier) {
  if (!pairs || !pairs.length) return "";
  const list = tier === "full" ? pairs.slice(0, 10) : pairs.slice(0, 8).sort((a, b) => a[0].length - b[0].length).slice(0, 4);
  const lines = list.map(([inh, ru]) => (src === "inh" ? `Ingush: ${inh}\nRussian: ${ru}` : `Russian: ${ru}\nIngush: ${inh}`));
  return `<corpus_examples>\nReal sentence pairs from Ingush books, the Ingush newspaper «Сердало» and Wikipedia that share words with the text. They show how these words are really used in Ingush (the translations can be loose; do not copy names or facts from them).\n\n${lines.join("\n\n")}\n</corpus_examples>\n\n`;
}

// Всё, что подобрано под текст. shots — примеры (см. pickShots в обработчике).
function contextFor(text, src, tgt, shots, tier, corpus) {
  const few = tier === "full" ? shots : shots.slice(0, 8);
  return dictionaryBlock(text, src, tgt, tier, few) + lexiconBlock(text, src, tgt, tier) + corpusBlock(corpus, src, tier) + examplesBlock(few, src, tgt);
}

function textPrompt(text, src, tgt, shots = [], tier = "full", corpus = []) {
  return {
    system: systemPrompt("text", src, tgt, tier),
    user: `${contextFor(text, src, tgt, shots, tier, corpus)}Translate the text inside <text> from ${LANGS[src]} into ${LANGS[tgt]}. Reply with the JSON only.\n\n<text>\n${text}\n</text>`,
  };
}

// Второй проход: ИИ получает свой черновик и список слов, которых нет в ингушских текстах.
function repairPrompt(text, src, tgt, draft, bad, shots = [], tier = "full", corpus = []) {
  return {
    system: systemPrompt("repair", src, tgt, tier),
    user: `${contextFor(text, src, tgt, shots, tier, corpus)}<source>\n${text}\n</source>\n\n<draft>\n${draft}\n</draft>\n\nThese words of the draft were not found in a list of 155,000 word forms from Ingush books and newspapers, so they are probably invented, misspelled, Chechen or left in Russian:\n${bad.join(", ")}`,
  };
}

function wordPrompt(text, src, tgt, shots = [], tier = "full", corpus = []) {
  return {
    system: systemPrompt("word", src, tgt, tier),
    user: `${contextFor(text, src, tgt, shots, tier, corpus)}Translate the word or short phrase inside <text> from ${LANGS[src]} into ${LANGS[tgt]}.\n\n<text>\n${text}\n</text>`,
  };
}

// Схема ответа для Gemini (structured output): модель обязана вернуть именно такой JSON.
const TEXT_SCHEMA = {
  type: "OBJECT",
  properties: {
    translation: { type: "STRING" },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    unknown_words: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["translation", "confidence", "unknown_words"],
};

// Ответ ИИ на textPrompt → { translation, confidence, unknown_words }. Если пришёл не JSON — берём текст как есть.
function readTranslation(raw) {
  const v = parseJson(raw);
  if (v && typeof v.translation === "string" && v.translation.trim()) {
    const conf = ["high", "medium", "low"].includes(String(v.confidence).toLowerCase()) ? String(v.confidence).toLowerCase() : "";
    const unknown = Array.isArray(v.unknown_words) ? v.unknown_words.map(String).filter(Boolean).slice(0, 20) : [];
    return { translation: v.translation.trim(), confidence: conf, unknown_words: unknown };
  }
  const t = cleanOutput(raw);
  if (/^\s*[{[]/.test(t)) return { translation: "", confidence: "", unknown_words: [] }; // сломанный JSON
  return { translation: t, confidence: "", unknown_words: [] };
}

// ---------------- текст ----------------

const LOOK = "1Il|ІіΙⅠǀ";
const PAL_RE = new RegExp(`([\\u0400-\\u04FF])([${LOOK}])|([${LOOK}])(?=[\\u0400-\\u04FF])`, "g");
const fixPalochka = (s) =>
  String(s || "").replace(/ӏ/g, "Ӏ").replace(PAL_RE, (m, a) => (a ? a + "Ӏ" : "Ӏ"));

// Здесь только чистка разметки. Русские слова в ингушском ответе ловит lib/postcheck.js (checkIngush).
const cleanOutput = (t) =>
  String(t || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*<text>\s*/i, "")
    .replace(/\s*<\/text>\s*$/i, "")
    .trim();

function parseJson(raw) {
  const m = cleanOutput(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Ключ для сравнения фраз: без регистра, знаков препинания и лишних пробелов.
const normKey = (s) =>
  fixPalochka(String(s || "")).toLowerCase().replace(/Ӏ/g, "ӏ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokens = (s) => normKey(s).split(" ").filter((w) => w.length >= 2);

// ---------------- проверка по словарю ----------------

// тот же Set словоформ, что у правил (lib/rules/verbs.js): строится один раз на процесс
const words = () => require("../lib/rules/verbs.js").wordSet();
const wordKey = (w) =>
  fixPalochka(w.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC")).toLowerCase().replace(/Ӏ/g, "ӏ");

// Слова в [квадратных скобках] ИИ сам пометил как неизвестные — их не проверяем.
const noBrackets = (t) => String(t || "").replace(/\[[^\]\n]{0,80}\]/g, " ");

// source — исходный текст: слово, перенесённое из него как есть, точно русское (lib/postcheck.js).
// russian — такие слова отдельно; они же входят в unknown (страница их подчёркивает, второй проход заменяет).
function checkIngush(text, source = "") {
  const found = noBrackets(text).match(/[Ѐ-ӿ]+(?:-[Ѐ-ӿ]+)*/g) || [];
  const set = words();
  const russian = POST.russian(text, source);
  const ru = new Set(russian.map(wordKey));
  const unknown = new Set();
  let checked = 0, known = 0;
  for (const t of found) {
    const k = wordKey(t);
    if (k.length < 2) continue;
    checked++;
    const ok = !ru.has(k) && (set.has(k) || (k.includes("-") && k.split("-").every((p) => p.length < 2 || set.has(p))));
    if (ok) known++; else unknown.add(t);
  }
  const out = { unknown: [...unknown], coverage: checked ? Math.round((known / checked) * 100) / 100 : 1 };
  if (russian.length) out.russian = russian;
  return out;
}

// Слова с заглавной буквы не в начале предложения — имена и названия (в нижнем регистре).
function namesIn(text) {
  const out = new Set();
  const re = /[\u0400-\u04FF]+(?:-[\u0400-\u04FF]+)*/g;
  const s = String(text);
  let m;
  while ((m = re.exec(s))) {
    const w = m[0];
    const first = w[0] === "Ӏ" ? w[1] || "" : w[0]; // палочка всегда выглядит заглавной
    if (!first || first === first.toLowerCase()) continue;
    const before = s.slice(0, m.index).replace(/[\s"«»(\[—–-]+$/, "");
    if (before && !/[.!?…:;]$/.test(before)) out.add(w.toLowerCase());
  }
  return out;
}

// Подозрительные слова перевода: их нет в ингушских текстах, и это не имена.
function suspects(translation, sourceText) {
  const { unknown } = checkIngush(translation, sourceText); // слова в [скобках] сюда не попадают
  if (!unknown.length) return [];
  const names = namesIn(translation);
  const srcNames = new Set([...namesIn(sourceText)].map((w) => w.slice(0, 4)));
  return unknown.filter((w) => {
    const k = w.toLowerCase();
    return !names.has(k) && !(k.length >= 4 && srcNames.has(k.slice(0, 4)));
  });
}

// ---------------- разговорник (исправления носителей) ----------------

let storeOverride = null; // для тестов
function phraseStore() {
  if (storeOverride) return storeOverride;
  // Если на хостинге заданы ключи Supabase, исправления хранятся там; иначе в Netlify Blobs.
  const sb = require("../lib/supabase-store.js").supabaseStore();
  if (sb) return sb;
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore("phrases");
  } catch {
    return null;
  }
}

let PHRASES = null, PHRASES_AT = 0;
async function loadPhrases(force = false) {
  if (!force && PHRASES && Date.now() - PHRASES_AT < 60_000) return PHRASES;
  const store = phraseStore();
  if (!store) return (PHRASES = PHRASES || []);
  try {
    const list = await store.get("all", { type: "json" });
    PHRASES = Array.isArray(list) ? list : [];
  } catch (e) {
    console.error("phrases load:", e.message);
    PHRASES = PHRASES || [];
  }
  PHRASES_AT = Date.now();
  return PHRASES;
}

// Готовый перевод из разговорника (в обе стороны).
function exactMatch(phrases, text, source, target) {
  const k = normKey(text);
  for (let i = phrases.length - 1; i >= 0; i--) {
    const p = phrases[i];
    if (p.source === source && p.target === target && normKey(p.text) === k) return p.translation;
    if (p.source === target && p.target === source && normKey(p.translation) === k) return p.text;
  }
  return null;
}

// Самые похожие исправленные фразы — примеры для ИИ.
function pickExamples(phrases, text, source, target, max = 8) {
  const want = new Set(tokens(text));
  const langs = new Set([source, target]);
  const scored = [];
  phrases.forEach((p, i) => {
    if (!langs.has(p.source) || !langs.has(p.target)) return;
    let score = 0;
    for (const w of tokens(`${p.text} ${p.translation}`)) if (want.has(w)) score++;
    scored.push({ p, score, i });
  });
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  const out = scored.filter((s) => s.score > 0).slice(0, max);
  for (const s of scored) { // если похожих мало — добавим свежие, чтобы ИИ видел стиль
    if (out.length >= Math.min(4, max)) break;
    if (!out.includes(s)) out.push(s);
  }
  return out.map((s) => s.p);
}

async function savePhrase(entry) {
  const store = phraseStore();
  if (!store) throw httpError(501, "Сохранение недоступно на этом хостинге (нужен Netlify).");
  const list = await loadPhrases(true);
  const k = normKey(entry.text);
  const kept = list.filter((p) => !(p.source === entry.source && p.target === entry.target && normKey(p.text) === k));
  kept.push(entry);
  while (kept.length > 3000) kept.shift();
  await store.setJSON("all", kept);
  PHRASES = kept; PHRASES_AT = Date.now();
  CACHE.clear();
  return kept.length;
}

// ---------------- ИИ-провайдеры ----------------

const envList = (name) =>
  process.env[name] ? process.env[name].split(",").map((s) => s.trim()).filter(Boolean) : null;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && (data.error.message || data.error)) || data.message || `HTTP ${r.status}`;
      throw httpError(r.status, typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw httpError(504, "Timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Промпт может быть строкой (как раньше) или { system, user } — постоянная часть отдельно.
const asParts = (prompt) => (typeof prompt === "string" ? { system: "", user: prompt } : prompt);

// Насколько «творчески» отвечает ИИ. Для перевода нужно 0–0.2: меньше выдумок, один и тот же ответ.
function temperature() {
  const t = Number(process.env.AI_TEMPERATURE);
  return Number.isFinite(t) && t >= 0 && t <= 1 ? t : 0;
}

// Сколько Gemini думает. В быстром режиме (Netlify, около 10 секунд) — мало, иначе — GEMINI_THINKING или по умолчанию.
// У моделей 2.5 это задаётся числом токенов, у 3.x и 4 — уровнем (low, medium, high).
function geminiThinking(model, fast) {
  if (/lite/i.test(model)) return null;
  const level = String(process.env.GEMINI_THINKING || "").toLowerCase();
  if (/gemini-2\.5/i.test(model)) {
    if (fast) return { thinkingBudget: 512 };
    return level ? { thinkingBudget: { low: 512, medium: 2048, high: 8192 }[level] || 2048 } : null;
  }
  if (fast) return { thinkingLevel: "low" };
  return level ? { thinkingLevel: level } : { thinkingLevel: "medium" };
}
// Gemini 4 и Gemini 3.6+ не принимают temperature (Google просит её не передавать), старым — передаём.
const geminiTakesTemperature = (model) => !/gemini-(4|3\.[6-9])/i.test(model) && !/latest/i.test(model);

// Бесплатная модель Gemini. json: true — ответ JSON, объект — ещё и схема ответа (structured output).
async function callGemini(model, prompt, json, timeoutMs, opts = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const started = Date.now();
  const { system, user } = asParts(prompt);
  const gen = {};
  if (json) gen.responseMimeType = "application/json";
  if (json && typeof json === "object") gen.responseSchema = json;
  if (geminiTakesTemperature(model)) gen.temperature = temperature();
  const thinking = geminiThinking(model, opts.fast);
  if (thinking) gen.thinkingConfig = thinking;
  const send = (g, ms) => postJson(
    url, { "x-goog-api-key": process.env.GEMINI_API_KEY },
    {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: user }] }],
      ...(Object.keys(g).length ? { generationConfig: g } : {}),
    },
    ms
  );
  let data;
  try {
    data = await send(gen, timeoutMs);
  } catch (e) {
    // модель не приняла какую-то настройку (думание, схема, temperature) — повторяем без них
    if (e.status !== 400 || !Object.keys(gen).length) throw e;
    const left = timeoutMs - (Date.now() - started);
    if (left < 1500) throw e;
    data = await send(json ? { responseMimeType: "application/json" } : {}, left);
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

// OpenRouter, Groq, Grok (формат OpenAI). Постоянная часть промпта идёт отдельным сообщением system.
// Для Claude (через OpenRouter) она помечается для кэша — в серии переводов она стоит в 10 раз дешевле
// и обрабатывается быстрее (если она достаточно длинная: у Anthropic есть минимальный размер кэша).
const openAiCompatible = (url, keyEnv, extraHeaders = {}) => async (model, prompt, json, timeoutMs, opts = {}) => {
  const started = Date.now();
  const send = (body, ms) => postJson(url, { Authorization: `Bearer ${process.env[keyEnv]}`, ...extraHeaders }, { model, ...body }, ms);
  const extra = opts.extra || {}; // особые настройки модели (например, «думай мало»); при ошибке 400 повтор без них
  const { system, user } = asParts(prompt);
  const sys = !system ? null
    : opts.cache && system.length >= 4000 ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;
  const messages = (s) => (s ? [{ role: "system", content: s }, { role: "user", content: user }] : [{ role: "user", content: user }]);
  let data;
  try {
    data = await send({ ...extra, messages: messages(sys), temperature: temperature() }, timeoutMs);
  } catch (e) {
    // модель не приняла настройки запроса — повторяем самым простым способом (всё одним сообщением)
    const left = timeoutMs - (Date.now() - started);
    if (e.status !== 400 || left < 1500) throw e;
    data = await send({ messages: [{ role: "user", content: system ? `${system}\n\n${user}` : user }] }, left);
  }
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  let content = msg && msg.content;
  if (Array.isArray(content)) content = content.filter((c) => !c.type || c.type === "text").map((c) => c.text || "").join("");
  return content || "";
};

// tier: "full" — справочник целиком (у этих моделей большой лимит), "compact" — короткий.
const PROVIDERS = {
  gemini: { label: "Gemini", keyEnv: "GEMINI_API_KEY", tier: "full", call: callGemini },
  groq: {
    label: "Groq", keyEnv: "GROQ_API_KEY", tier: "compact",
    call: openAiCompatible("https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY"),
  },
  openrouter: {
    label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", tier: "compact",
    call: openAiCompatible("https://openrouter.ai/api/v1/chat/completions", "OPENROUTER_API_KEY", { "X-Title": "Ingush Translator" }),
  },
  grok: { label: "Grok", keyEnv: "XAI_API_KEY", tier: "full", call: openAiCompatible("https://api.x.ai/v1/chat/completions", "XAI_API_KEY") },
};

// Платные модели (OpenRouter, всё, что не «:free»): им идёт полный справочник, как Gemini.
const isPaid = (p, model) => p === "openrouter" && model !== "openrouter/free" && !model.endsWith(":free");
const tierFor = (p, model) => (isPaid(p, model) ? "full" : PROVIDERS[p].tier);
// GPT-OSS на Groq — модель «с размышлением»: просим думать мало, иначе на Netlify (10 с) не успевает.
const callOpts = (p, model, fast) => ({
  fast,
  cache: p === "openrouter" && model.startsWith("anthropic/"),
  ...(p === "groq" && /gpt-oss/.test(model) ? { extra: { reasoning_effort: "low" } } : {}),
});
// Сколько ждать одну модель, когда времени мало (Netlify, ~10 с на всё). Groq отвечает за 1–3 с, если дольше —
// значит, занят; бесплатные модели OpenRouter — до 6 с; Gemini и платные — всё оставшееся время.
// Так зависшая быстрая модель не съедает время, которое нужно запасным.
function capFor(p, model, fast, left) {
  if (!fast) return left;
  const cap = p === "groq" ? 5000 : p === "openrouter" && !isPaid(p, model) ? 6000 : left;
  return Math.max(1200, Math.min(left, cap));
}
// Платные модели для кнопки «Сравнить ИИ»: [модель, оценка цены одного перевода с полным справочником].
// Цены за миллион входных токенов на OpenRouter (ноябрь 2026): Opus 5.5 — $4, Sonnet 5.5 — $2,
// Haiku 5.5 и GPT-6 Luna — $0.10, DeepSeek V4.1 Flash — $0.30, GLM 5.3 Flash — около $0.10.
const COMPARE_PAID = [
  ["anthropic/claude-opus-5.5", "≈ 6–8 ¢ за перевод"],
  ["anthropic/claude-sonnet-5.5", "≈ 3–4 ¢ за перевод"],
  ["anthropic/claude-haiku-5.5", "≈ 0,2 ¢ за перевод"],
  ["openai/gpt-6-luna", "≈ 0,2 ¢ за перевод"],
  ["deepseek/deepseek-v4.1-flash", "≈ 0,5 ¢ за перевод"],
  ["z-ai/glm-5.3-flash", "≈ 0,2 ¢ за перевод"],
];
const NAMES = { "openai/gpt-6-luna": "GPT-6 Luna", "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash", "z-ai/glm-5.3-flash": "GLM 5.3 Flash" };
// «anthropic/claude-haiku-5.5» → «Claude Haiku 5.5 (OpenRouter)»
function modelLabel(p, model) {
  const m = /^anthropic\/claude-([a-z]+)-([\d.]+)$/.exec(model);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]} (${PROVIDERS[p].label})`;
  if (NAMES[model]) return `${NAMES[model]} (${PROVIDERS[p].label})`;
  return `${PROVIDERS[p].label} · ${model}`;
}
// Коротко, почему модель не ответила (для строки под ошибкой).
function whyFailed(e) {
  if (e.status === 402) return "нет средств на счёте";
  if (e.status === 429) return "лимит";
  if (e.status === 504) return "не успел ответить";
  if (e.status === 404) return "нет такой модели";
  if (e.status === 413) return "слишком большой запрос";
  if (e.status === 503 || e.status === 529) return "перегружен";
  if (isBadKey(e)) return "ключ не работает";
  return `ошибка ${e.status || "связи"}`;
}

// Сколько ждать сильную модель, если у быстрой ответ уже готов (на хостинге, где времени мало).
const FAST_GRACE_MS = Number(process.env.FAST_GRACE_SECONDS) * 1000 || 4000;

// Сколько миллисекунд у нас есть на ответ.
function timeBudget(req) {
  const env = Number(process.env.TIME_LIMIT_SECONDS) * 1000;
  if (env > 0) return Math.max(4000, env - 1000);
  const left = Number(req && req.deadlineMs);
  if (left > 0) return Math.max(4000, Math.min(left - 2000, 55000)); // берём всё время, которое даёт хостинг
  return DEADLINE_MS;
}

// Промпт под нужный размер, каждый собирается один раз.
function prompts(build) {
  const memo = {};
  return (tier) => memo[tier] || (memo[tier] = build(tier));
}

// Порядок по умолчанию: сначала сильные модели, слабые — в самом конце.
// Первая — платная модель через OpenRouter (OPENROUTER_MODEL, по умолчанию Claude Haiku 5.5):
// работает, когда на счёте OpenRouter есть деньги, иначе пропускается, и перевод идёт бесплатными моделями.
// OPENROUTER_MODEL=off — платную модель не использовать совсем.
// Бесплатные модели Gemini (ноябрь 2026, ai.google.dev/gemini-api/docs/pricing): Gemini 4 Hydrogen —
// самая сильная из бесплатных (у неё маленький дневной лимит); 3.8 Flash и 3.6 Flash — запасные;
// 3.5 Flash-Lite — самая быстрая. Модель, которая ответила «лимит», какое-то время пропускается (COOL).
// Остальные бесплатные (проверено 17.11.2026 по openrouter.ai/api/v1/models и console.groq.com/docs/models;
// Kimi K2 и qwen3-32b с Groq и kimi-k2:free с OpenRouter убраны — «нет такой модели»):
//   Groq: GPT-OSS 120B (основная, хорошо знает русский), Qwen 3.8 27B (preview), GPT-OSS 20B — самая быстрая;
//   OpenRouter: Gemma 4 31B (Google, многоязычная), Nemotron 3 Ultra (NVIDIA), openrouter/free — что свободно.
//   Grok (платно, xAI): grok-4.20-non-reasoning — без размышлений, успевает за 10 с.
// Модель, которой больше нет (404), на полчаса убирается из очереди (DEAD), чтобы не терять на ней время.
const PAID_DEFAULT = "anthropic/claude-haiku-5.5";
function defaultSequence() {
  const paid = String(process.env.OPENROUTER_MODEL || PAID_DEFAULT).trim();
  return [
    ...(paid && paid.toLowerCase() !== "off" ? [["openrouter", paid]] : []),
    ["gemini", "gemini-4-hydrogen"],
    ["gemini", "gemini-3.8-flash"],
    ["gemini", "gemini-3.6-flash"],
    ["grok", "grok-4.20-non-reasoning"],
    ["groq", "openai/gpt-oss-120b"],
    ["groq", "qwen/qwen3.8-27b"],
    ["openrouter", "google/gemma-4-31b-it:free"],
    ["openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    ["openrouter", "openrouter/free"],
    ["gemini", "gemini-3.5-flash-lite"],
    ["groq", "openai/gpt-oss-20b"],
  ];
}
const MODEL_ENV = { gemini: "GEMINI_MODELS", groq: "GROQ_MODELS", openrouter: "OPENROUTER_MODELS", grok: "XAI_MODELS" };

const hasKey = (p) => PROVIDERS[p] && process.env[PROVIDERS[p].keyEnv];

function attempts() {
  const order = envList("PROVIDER_ORDER");
  let seq = defaultSequence();
  // свои списки моделей через переменные GEMINI_MODELS и т.п.
  for (const [p, env] of Object.entries(MODEL_ENV)) {
    const custom = envList(env);
    if (custom) {
      const at = seq.findIndex(([q]) => q === p);
      seq = seq.filter(([q]) => q !== p);
      seq.splice(at < 0 ? seq.length : at, 0, ...custom.map((m) => [p, m]));
    }
  }
  if (order) seq = order.flatMap((p) => seq.filter(([q]) => q === p));
  return seq.filter(([p]) => hasKey(p));
}

function isBadKey(e) {
  return e.status === 401 || /api key|unauthori[sz]ed|invalid.*key/i.test(e.message);
}

// На счёте сервиса нет денег: его платные модели 10 минут не трогаем, чтобы не терять время на каждом переводе.
const BROKE_AT = {};
const isBroke = (p) => BROKE_AT[p] && Date.now() - BROKE_AT[p] < 10 * 60_000;
// Когда времени мало, бесплатным моделям Groq и OpenRouter идёт короткий справочник: длинный они не успевают прочитать.
// Gemini теперь получает полный справочник всегда: словарь и примеры подбираются под текст, и промпт
// стал в несколько раз короче, чем раньше (около 10 тыс. знаков вместо 60 тыс.).
const tierNow = (p, model, fast) => (fast && !isPaid(p, model) && p !== "gemini" ? "compact" : tierFor(p, model));

// Модель ответила «лимит» (429): какое-то время её не спрашиваем первой, чтобы перевод не терял на неё время.
// Первый раз — минута (или столько, сколько просит сам сервис: «retry in 35s»), второй подряд — 5 минут,
// дальше — по полчаса: так ведёт себя дневной лимит. Если остальные модели тоже не ответят, её спросят в конце.
const COOL = new Map(), COOL_HITS = new Map();
const coolKey = (p, model) => `${p}|${model}`;
const isCooling = (p, model) => (COOL.get(coolKey(p, model)) || 0) > Date.now();
function coolDown(p, model, e) {
  const k = coolKey(p, model);
  const hits = (COOL_HITS.get(k) || 0) + 1;
  COOL_HITS.set(k, hits);
  const hint = /retry in ([\d.]+)\s*s/i.exec(String(e && e.message));
  const asked = hint ? Math.ceil(Number(hint[1])) * 1000 : 0;
  const step = hits === 1 ? 60_000 : hits === 2 ? 5 * 60_000 : 30 * 60_000;
  COOL.set(k, Date.now() + Math.min(30 * 60_000, Math.max(step, asked)));
}
// Модели нет (404 / «model not found») или бесплатная модель сказала «нет денег» (402): не спрашиваем её
// какое-то время совсем — на каждом переводе это стоило бы полсекунды-секунду.
const DEAD = new Map();
const isDead = (p, model) => (DEAD.get(coolKey(p, model)) || 0) > Date.now();
const noSuchModel = (e) => e.status === 404 || (e.status === 400 && /model.*(not found|does not exist|not a valid|decommissioned|not supported)|no endpoints/i.test(String(e.message)));
const coolClear = (p, model) => { COOL.delete(coolKey(p, model)); COOL_HITS.delete(coolKey(p, model)); };

// Пробует модели, пока одна не ответит. Возвращает { text, by }.
// prompt(tier) возвращает промпт нужного размера.
async function ask(prompt, json = false, budget = DEADLINE_MS) {
  const started = Date.now();
  const fast = budget < LONG_BUDGET_MS;
  // одной модели — не всё время, чтобы успели запасные; на своём компьютере времени много, ждём дольше
  const cap = fast ? 6500 : Math.max(16000, Math.min(45000, Math.round(budget * 0.5)));
  const deadKeys = new Set();
  const slow = new Set(); // сервис не успел ответить — сначала пробуем другие сервисы
  const trail = []; // кто и почему не ответил
  let last = null, sawLimit = false, gone = 0; // gone — сколько моделей «нет / нет денег»

  const attempt = async (p, model, ms) => {
    const text = cleanOutput(await PROVIDERS[p].call(model, prompt(tierNow(p, model, fast)), json, ms, callOpts(p, model, fast)));
    if (!text) throw httpError(503, "Empty answer");
    coolClear(p, model);
    return { text, by: modelLabel(p, model), p, model };
  };
  const failed = (p, model, e) => {
    last = e;
    trail.push(`${modelLabel(p, model)}: ${whyFailed(e)}`);
    console.error(`${p} ${model}:`, e.status, e.message);
    if (noSuchModel(e)) { gone++; DEAD.set(coolKey(p, model), Date.now() + 30 * 60_000); return; }
    if (e.status === 402) { gone++; BROKE_AT[p] = Date.now(); if (!isPaid(p, model)) DEAD.set(coolKey(p, model), Date.now() + 10 * 60_000); return; }
    if (e.status === 429) { sawLimit = true; coolDown(p, model, e); }
    if (e.status === 504) slow.add(p);
    if (isBadKey(e)) { deadKeys.add(p); e.badKey = PROVIDERS[p].keyEnv; }
  };
  const usable = ([p, model]) => !deadKeys.has(p) && !(isBroke(p) && isPaid(p, model)) && !isDead(p, model);

  let queue = attempts().filter(usable);
  // модели на «паузе после лимита» — в конец очереди
  queue = [...queue.filter(([p, m]) => !isCooling(p, m)), ...queue.filter(([p, m]) => isCooling(p, m))];

  if (fast) {
    // Времени мало: первая модель каждого сервиса стартует сразу.
    // Ждём по порядку силы: если сильная не ответила, ответ следующей уже готов.
    const seen = new Set(), firsts = [], rest = [];
    for (const a of queue) (seen.has(a[0]) ? rest : (seen.add(a[0]), firsts)).push(a);
    // У Gemini сильная модель (Hydrogen) думает долго, и у неё маленький дневной лимит. Вместе с ней сразу
    // запускаем следующую, быструю (Flash): если сильная не успеет за несколько секунд или ответит «лимит»,
    // ответ Flash уже готов, и ждать не нужно.
    const gi = firsts.findIndex(([p]) => p === "gemini");
    const partner = rest.findIndex(([p]) => p === "gemini");
    if (gi >= 0 && partner >= 0) firsts.splice(gi + 1, 0, rest.splice(partner, 1)[0]);
    const ms = Math.max(1500, budget - 900);
    const runs = firsts.map(([p, model]) => attempt(p, model, capFor(p, model, fast, ms)).then((r) => ({ r }), (e) => ({ e })));
    // сильную модель ждём не до конца: если она думает дольше FAST_GRACE_MS, а у следующей ответ готов — берём его
    const graceEnd = started + Math.min(FAST_GRACE_MS, Math.max(2500, Math.round(budget * 0.65)));
    const wait = (i) => Promise.race([runs[i], new Promise((res) => setTimeout(() => res(null), Math.max(0, graceEnd - Date.now())))]);
    const pending = [];
    for (let i = 0; i < firsts.length; i++) {
      const out = await wait(i);
      if (!out) { pending.push(i); continue; }
      if (out.r) return out.r;
      failed(firsts[i][0], firsts[i][1], out.e);
    }
    // готовых ответов нет — берём первый, который придёт (а не ждём сильную модель до конца)
    while (pending.length) {
      const { i, out } = await Promise.race(pending.map((j) => runs[j].then((o) => ({ i: j, out: o }))));
      pending.splice(pending.indexOf(i), 1);
      if (out.r) return out.r;
      failed(firsts[i][0], firsts[i][1], out.e);
    }
    queue = rest;
  }

  const later = [];
  while (queue.length || later.length) {
    const [p, model] = queue.length ? queue.shift() : later.shift();
    if (!usable([p, model])) continue;
    if (slow.has(p) && queue.some(([q]) => !slow.has(q) && !deadKeys.has(q))) { later.push([p, model]); continue; }
    const left = budget - (Date.now() - started);
    if (left < 1200) break;
    try {
      return await attempt(p, model, capFor(p, model, fast, Math.min(left - 200, cap)));
    } catch (e) {
      failed(p, model, e);
    }
  }
  if (last && last.badKey && attempts().every(([p]) => deadKeys.has(p))) throw httpError(401, `Check ${last.badKey}. ${last.message}`);
  // Понятное сообщение: почему ИИ не ответил. Слова и фразы из базы при этом работают (их ищут до ИИ).
  const msg = sawLimit
    ? "Бесплатные ИИ-переводчики исчерпали лимит. Попробуйте через минуту или переведите короче."
    : gone && gone >= trail.length
      ? "ИИ-переводчики сейчас недоступны (нет средств на счёте или модель отключена). Слова и фразы из базы работают."
      : "Все переводчики сейчас заняты. Попробуйте через минуту.";
  const err = httpError(sawLimit ? 429 : 503, msg);
  err.detail = trail.slice(0, 8).join("; ");
  throw err;
}

// Для кнопки «Сравнить»: по одной бесплатной модели от каждого сервиса и, если на счёте OpenRouter
// есть деньги, платные модели из COMPARE_PAID — все параллельно.
// all — все модели, а не по одной от сервиса (для замера scripts/check-ai.js). У каждого ответа — время, ms.
async function askAll(prompt, budget = DEADLINE_MS, all = false) {
  const seen = new Set();
  const free = attempts().filter(([p, model]) => !isPaid(p, model)).filter(([p]) => (all || seen.has(p) ? all : seen.add(p)));
  const paid = hasKey("openrouter") && !isBroke("openrouter") ? COMPARE_PAID.map(([model, price]) => ["openrouter", model, price]) : [];
  const fast = budget < LONG_BUDGET_MS;
  const results = await Promise.all([...paid, ...free].map(async ([p, model, price]) => {
    const by = modelLabel(p, model) + (price ? ` · ${price}` : "");
    const t0 = Date.now();
    try {
      const text = cleanOutput(await PROVIDERS[p].call(model, prompt(tierNow(p, model, fast)), false, budget - 500, callOpts(p, model, fast)));
      return text ? { by, text, ms: Date.now() - t0 } : { by, error: "Пустой ответ", ms: Date.now() - t0 };
    } catch (e) {
      if (e.status === 402) { BROKE_AT[p] = Date.now(); return { by, noMoney: true }; }
      return { by, ms: Date.now() - t0, error: e.status === 429 ? "Лимит исчерпан" : e.status === 504 ? "Не успел ответить" : e.status === 404 ? "Нет такой модели" : isBadKey(e) ? "Ключ не работает" : "Занят или недоступен" };
    }
  }));
  return results.filter((r) => !r.noMoney); // денег на счёте нет — платные модели просто не показываем
}

// ---------------- кэш ----------------
const CACHE = new Map();
function cacheSet(k, v) {
  if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, v);
}

// ---------------- «дистилляция»: переводы сильной модели как примеры для слабой ----------------
// Необязательно, по умолчанию выключено. Если задать DISTILL_MODELS (например anthropic/claude-opus-5.5),
// то уверенные переводы этой модели (confidence high, без [неизвестных] слов, не длиннее 300 знаков)
// сохраняются в хранилище Netlify Blobs под ключом "distilled". Потом они идут в промпт как примеры
// с пометкой «сильная модель, не проверено» — так дешёвая модель (Haiku, Gemini) учится на них.
// Проверенные носителем фразы всегда важнее. Ошибки сильной модели тоже копируются — поэтому
// такие переводы лучше просматривать (их видно в хранилище) и исправлять кнопкой «Исправить».
let DISTILLED = null, DISTILLED_AT = 0;
const distillModels = () => envList("DISTILL_MODELS") || [];
async function loadDistilled() {
  if (!distillModels().length) return [];
  if (DISTILLED && Date.now() - DISTILLED_AT < 60_000) return DISTILLED;
  const store = phraseStore();
  let list = [];
  if (store) {
    try { const got = await store.get("distilled", { type: "json" }); if (Array.isArray(got)) list = got; } catch (e) { console.error("distilled load:", e.message); }
  }
  DISTILLED = list; DISTILLED_AT = Date.now();
  return DISTILLED;
}
async function maybeDistill(input, source, result, info) {
  if (!info.model || !distillModels().includes(info.model)) return;
  if (info.confidence !== "high" || info.unknown.length || /\[/.test(result.translation)) return;
  if (input.length > 300 || (result.unknown && result.unknown.length)) return;
  const store = phraseStore();
  if (!store) return;
  try {
    const list = (await loadDistilled()).slice();
    const entry = source === "ru"
      ? { ru: input, inh: result.translation, from: "distilled", model: info.model, at: new Date().toISOString() }
      : { ru: result.translation, inh: input, from: "distilled", model: info.model, at: new Date().toISOString() };
    const k = normKey(entry.ru);
    const kept = list.filter((e) => normKey(e.ru) !== k);
    kept.push(entry);
    while (kept.length > 2000) kept.shift();
    await store.setJSON("distilled", kept);
    DISTILLED = kept; DISTILLED_AT = Date.now();
  } catch (e) {
    console.error("distilled save:", e.message); // не сохранилось — перевод всё равно отдаём
  }
}

// ---------------- обработчик ----------------

// ---------------- база пар (data/phrases.json) и проверка носителем (/review) ----------------
// Решения носителя лежат в том же хранилище под отдельным ключом "review":
//   { "<id пары>": { s: "ok" | "fix", inh?: "исправленный перевод", at } }
// Сам файл data/phrases.json при этом не меняется, а список исправлений с сайта ("all") не трогается.

let REVIEW = null, REVIEW_AT = 0, VERIFIED = [];
async function loadReview(force = false) {
  if (!force && REVIEW && Date.now() - REVIEW_AT < 60_000) return REVIEW;
  const store = phraseStore();
  let data = REVIEW || {};
  if (store) {
    try {
      const got = await store.get("review", { type: "json" });
      data = got && typeof got === "object" && !Array.isArray(got) ? got : {};
    } catch (e) {
      console.error("review load:", e.message);
    }
  }
  setReview(data);
  return REVIEW;
}
const noParens = (t) => String(t).replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
function setReview(data) {
  REVIEW = data; REVIEW_AT = Date.now();
  // проверенные пары работают как исправления с сайта: точный ответ и примеры для ИИ.
  // Идём с конца, чтобы при одинаковом русском тексте («мужчине» / «женщине») первой была первая пара.
  VERIFIED = [];
  for (let i = SEED.length - 1; i >= 0; i--) {
    const r = data[SEED[i].id];
    if (r) VERIFIED.push({ source: "ru", target: "inh", text: noParens(SEED[i].ru), translation: r.inh || SEED[i].inh, at: r.at });
  }
}
async function saveReview(id, decision, inh) {
  const store = phraseStore();
  if (!store) throw httpError(501, "Сохранение недоступно на этом хостинге (нужен Netlify).");
  const data = { ...(await loadReview(true)) };
  data[id] = decision === "fix" ? { s: "fix", inh, at: new Date().toISOString() } : { s: "ok", at: new Date().toISOString() };
  await store.setJSON("review", data);
  setReview(data);
  CACHE.clear();
  return Object.keys(data).length;
}

// Короткие вопросы разговорника по набору слов (без порядка): в русском порядок слов в вопросе свободный,
// «как зовут тебя» = «тебя как зовут» = «Как тебя зовут?». Только вопросы (в базе со знаком «?»)
// из 2–4 слов с вопросительным словом, только надёжные источники — так смысл не меняется.
let REORDER_IDX = null;
const bagKey = (ws) => ws.slice().sort().join(" ");
function reorderedQuestion(text) {
  const L = require("../lib/rules/lexicon.js");
  const ws = RET.wordsOf(String(text).toLowerCase().replace(/ё/g, "е"));
  if (ws.length < 2 || ws.length > 4 || !ws.some((w) => L.QUESTION_WORDS[w])) return null;
  if (!REORDER_IDX) {
    REORDER_IDX = new Map();
    for (const p of SEED) {
      if (p.kind !== "phrase" || p.rare || !/\?\s*$/.test(p.ru || "") || !/^(PaydaDosh|Справочник)/.test(p.source || "")) continue;
      const pw = RET.wordsOf(String(p.ru).toLowerCase().replace(/ё/g, "е"));
      if (pw.length < 2 || pw.length > 4) continue;
      const k = bagKey(pw);
      if (!REORDER_IDX.has(k)) REORDER_IDX.set(k, []);
      REORDER_IDX.get(k).push(p);
    }
  }
  const list = REORDER_IDX.get(bagKey(ws));
  if (!list) return null;
  const best = seedBest(list[0].ru, "ru") || list[0];
  const r = seedResult(best, "ru");
  const alts = list.filter((p) => p !== best).map((p) => ({ text: noStress(splitAlt(splitNote(p.inh).text)[0] || p.inh), meaning: "" }))
    .filter((x, i, all) => x.text !== r.translation && all.findIndex((y) => y.text === x.text) === i);
  if (alts.length) r.alternatives = (r.alternatives || []).concat(alts);
  r.kind = "reorder";
  r.label += ", тот же вопрос";
  r.note = joinNotes(`В разговорнике: «${noParens(best.ru)}» — те же слова в другом порядке.`, r.note);
  return r;
}

// Обратный поиск для «ингушский → русский» по парам «русский → ингушский»: ингушская фраза из тех же слов
// (порядок в ингушском свободный, падежи показывают, кто что делает). 2–5 слов, только разговорник,
// справочник и исправления носителей. Палочка (1, l, I) и знаки препинания не важны.
let REV_IDX = null;
const inhWords = (t) => RET.wordsOf(fixPalochka(String(t)).toLowerCase().replace(/ё/g, "е"));
function reverseFromRuInh(text, pool) {
  const ws = inhWords(text);
  if (ws.length < 2 || ws.length > 5) return null;
  const k = bagKey(ws);
  // исправления носителей (рус → инг) — первыми
  for (let i = (pool || []).length - 1; i >= 0; i--) {
    const p = pool[i];
    if (p.source === "ru" && p.target === "inh" && bagKey(inhWords(p.translation)) === k) {
      return { translation: noParens(p.text), verified: true, label: "Проверено носителем языка (те же слова в другом порядке)" };
    }
  }
  if (!REV_IDX) {
    REV_IDX = new Map();
    for (const p of SEED) {
      if (p.kind !== "phrase" || p.rare || !/^(PaydaDosh|Справочник)/.test(p.source || "")) continue;
      for (const v of splitAlt(splitNote(p.inh).text)) {
        const pw = inhWords(v);
        if (pw.length < 2 || pw.length > 5) continue;
        const kk = bagKey(pw);
        if (!REV_IDX.has(kk)) REV_IDX.set(kk, p);
      }
    }
  }
  const p = REV_IDX.get(k);
  if (!p) return null;
  const r = seedResult(p, "inh");
  r.kind = "reorder";
  r.label += ", те же слова";
  r.note = joinNotes(`В разговорнике: «${splitNote(p.inh).text}» — те же ингушские слова в другом порядке.`, r.note);
  return r;
}

let SEED_IDX = null;
function seedIndex() {
  if (SEED_IDX) return SEED_IDX;
  const ru = new Map(), inh = new Map(), byId = new Map();
  const push = (m, k, v) => { if (k && !m.has(k)) m.set(k, v); };
  for (const p of SEED) { push(ru, BASE.key(p.ru), p); push(inh, BASE.key(p.inh), p); byId.set(p.id, p); }
  return (SEED_IDX = { ru, inh, byId });
}
const isRuInh = (src, tgt) => (src === "ru" && tgt === "inh") || (src === "inh" && tgt === "ru");

// Знаки ударения из словарей («ва́ла») в перевод не идут: их неудобно копировать. Слово с ударением остаётся в пояснении.
const noStress = (t) => String(t == null ? "" : t).replace(/[\u0300\u0301]/g, "");
const stressNote = (t) => (/[\u0300\u0301]/.test(String(t)) ? `Ударение: ${t}.` : "");
const joinNotes = (...parts) => parts.filter(Boolean).join(" ");
// Пары базы с тем же текстом, самый надёжный источник первым.
function seedBest(text, src) {
  const list = (seedAll(src).get(BASE.key(text)) || []).map((p, order) => ({ p, w: seedSource(p), order }));
  list.sort((a, b) => a.w.rank - b.w.rank || (a.w.prio || 0) - (b.w.prio || 0) || a.order - b.order);
  return list.length ? list[0].p : null;
}
// Пометки внутри ингушского текста из разговорника: «Со балха вода. (говорит мужчина)», «(к женщине)», «(й, б, д)».
// В перевод они не идут (их копировали бы вместе с текстом) — они становятся подписью варианта.
const NOTE_IN_TEXT = /\s*\(((?:говорит|к |о |объект|домой|мн\.|ед\.)[^()]*|[вйдби](?:\s*[,/]\s*[вйдби])*)\)\s*/gi;
function splitNote(t) {
  const notes = [];
  const text = String(t).replace(NOTE_IN_TEXT, (m, n) => { notes.push(/^[вйдби](\s*[,/]\s*[вйдби])*$/i.test(n.trim()) ? `класс ${n.trim()}` : n.trim()); return " "; }).replace(/\s+([.!?,])/g, "$1").replace(/\s+/g, " ").trim();
  return { text: text || String(t).trim(), note: notes.join("; ") };
}

// Как подписать источник пары для человека.
function sourceTitle(p) {
  const w = RET.sourceOf(p);
  return w.from === "paydadosh" ? "словарь PaydaDosh" : w.from === "corpus" ? "слова из настоящих текстов"
    : w.from === "open" ? `открытый словарь ${w.name}` : "словарь проекта";
}
// Пометы источника вроде «PaydaDosh, разговорник: уроки (УРОКИ)» человеку не нужны — это адрес записи, а не пояснение.
// Одна буква класса («д», «й-й») подписывается словом «класс».
// Пометка записи — части через « · »: «PaydaDosh, разговорник: … · говорит мужчина». Адрес записи
// («PaydaDosh, …») человеку не нужен, остальное (кто говорит, к кому, класс) — показываем.
function glossNote(n) {
  return String(n || "").split(" · ").map((x) => x.trim()).filter((x) => x && !/^PaydaDosh,/.test(x))
    .map((x) => (/^[вйдб](\s*[-,/]\s*[вйдб])*$/.test(x) ? `класс ${x}` : x)).join(" · ");
}
// Запись, где ингушское слово совпадает с русским («Таджик = Таджик»), — возможно, заимствование, а возможно,
// пропуск в словаре: так и подписываем.
const SAME_AS_RU = "Как в русском (заимствование?), проверьте у носителя";
const sameAsRu = (p) => !!p && p.rare && BASE.key(p.ru) === BASE.key(p.inh);
// «нийлха // нилха», «нух//нухь»: « // » в записи — разделитель вариантов, как « / »
const splitAlt = (s) => String(s || "").split(/\s*\/\/\s*/).map((x) => x.trim()).filter(Boolean);
function seedResult(p, src, more = []) {
  const sp = src === "ru" ? splitNote(p.inh) : { text: noParens(p.ru), note: "" };
  const [raw, ...alt] = splitAlt(sp.text);
  const gloss = joinNotes(sp.note, p.license ? glossNote(p.note) : "");
  const r = { translation: noStress(raw || sp.text), label: `Из базы: ${sourceTitle(p)}`, kind: "seed", seed: p, more, seedNote: gloss, note: joinNotes(gloss || (p.license ? "" : p.note || ""), stressNote(raw || sp.text)) };
  if (alt.length) r.alternatives = alt.map((text) => ({ text: noStress(text), meaning: "" }));
  if (sameAsRu(p)) { r.label = SAME_AS_RU; r.note = joinNotes(SAME_AS_RU + ".", r.note); }
  return r;
}
// Ответ из словаря по значению записи («носить» в записи «носить, поносить; эксплуатировать»)
// или по начальной форме слова («маму» → запись «мама»). prio — надёжность источника (0 — словарь проекта).
function fromDictionary(text, src, tgt) {
  let lw = RET.lookupWord(text, src, 6, true);
  if (!lw) return null;
  // имя собственное по начальной форме — только если и в тексте слово с большой буквы:
  // «карта» → «карт» → «Карт» (имя, «Кхарт») — не то слово
  if (lw.lemma && !/^[А-ЯЁӀ]/.test(String(text).trim())) {
    const items = lw.items.filter((it) => !(/^[А-ЯЁӀ]/.test(String(it.ru).trim()) && /^[А-ЯЁӀ]/.test(String(it.inh).trim())));
    if (!items.length) return null;
    lw = { ...lw, items };
  }
  const lemmaNote = !lw.lemma ? ""
    : src === "ru"
      ? `В тексте слово стоит в другой форме. Перевод дан для начальной формы «${lw.lemma}»: окончание или класс в ингушском могут быть другими.`
      : `В тексте слово стоит в другой форме (с окончанием падежа, числа или времени). Перевод дан для начальной формы «${lw.lemma}».`;
  if (lw.lemma) {
    const b = BASE.lookup(lw.lemma, src, tgt); // словарик проекта знает слово лучше всех
    // строку словаря в пояснении повторяем, только если в ней есть объяснение (после тире): сами слова уже в вариантах
    if (b && b.kind !== "texts") return { ...b, label: `${b.label}, начальная форма «${lw.lemma}»`, note: joinNotes(lemmaNote, / — /.test(b.note || "") ? b.note : ""), line: b.note, lemma: lw.lemma, prio: 0 };
  }
  const first = lw.items[0];
  const p = first.seed || { source: "Справочник проекта", ru: first.ru, inh: first.inh, note: first.line };
  const r = seedResult({ ...p, inh: first.inh }, src, lw.items.slice(1));
  r.seed = p;
  if (lw.lemma) { r.label += `, начальная форма «${lw.lemma}»`; r.note = joinNotes(lemmaNote, r.note); }
  return { ...r, lemma: lw.lemma, prio: first.prio, items: lw.items };
}

// Готовый ответ без ИИ для текста или одного предложения: { translation, verified?, label, kind?, alternatives?, note? } или null.
// Порядок: проверено носителем → фразы и словарик проекта → словари (PaydaDosh, открытые) → начальная форма
// слова по надёжному словарю → слова из настоящих текстов → начальная форма по остальным словарям.
// Утверждение, на которое в базе есть только вопрос («Это далеко» — в разговорнике «Это далеко? — Гаьна дий
// из?»): знак вопроса при поиске в базе не учитывается. Такой ответ не берём — дальше переведут правила.
// Кроме фраз с вопросительным словом или «ли» («Как дела», «Где ты» пишут и без знака).
function resolveExact(text, src, tgt, pool) {
  const r = resolveExact0(text, src, tgt, pool);
  if (r && !r.verified && r.kind !== "reorder" && src === "ru" && tgt === "inh" && !/\?/.test(text) && /\?\s*$/.test(String(r.translation || ""))) {
    const ws = RET.wordsOf(String(text).toLowerCase());
    const L = require("../lib/rules/lexicon.js");
    if (ws.length >= 2 && !L.QUESTION_WORDS[ws[0]] && !ws.includes("ли")) return null;
  }
  return r;
}
function resolveExact0(text, src, tgt, pool) {
  const saved = exactMatch(pool, text, src, tgt);
  if (saved) return { translation: saved, verified: true, label: "Проверено носителем языка" };
  const b = BASE.lookup(text, src, tgt);
  if (b && b.kind !== "texts") return b;
  if (!isRuInh(src, tgt)) return b || null;
  // ингушская форма глагола или местоимение из библиотеки слов: «вода» — «идёт», а не «бегущий» из словаря
  if (src === "inh") {
    const lx = CHUNKS.inhLexicon(text);
    if (lx) return { translation: lx.translation, label: "Без ИИ: библиотека слов (справочник)", kind: "rules", note: lx.note, rules: { variants: [{ text: lx.translation, note: "" }] } };
  }
  const p = seedBest(text, src); // пара базы с точно таким текстом
  const pp = p ? RET.sourceOf(p).prio : 99;
  const d = fromDictionary(text, src, tgt);
  const exactItems = d && !d.lemma ? d.items : [];
  if (p && pp !== 5 && (!d || d.lemma || pp <= d.prio)) return seedResult(p, src, exactItems);
  // корпус надёжнее редких записей (rare) и translatewiki: «того» — «цул», а не «того» (народ Того);
  // записи словаря остаются в вариантах
  if (p && pp === 5 && d && !d.lemma && d.prio >= 6) return seedResult(p, src, d.items || []);
  if (d && !d.lemma) return d;
  // тот же вопрос с другим порядком слов: «как зовут тебя», «тебя как зовут» — «Как тебя зовут?» из разговорника
  if (src === "ru") { const ro = reorderedQuestion(text); if (ro) return ro; }
  // ингушский → русский: смотрим в пары «русский → ингушский» (разговорник и исправления носителей) — фраза
  // из тех же ингушских слов в другом порядке: «Хьо сона веза» = «Сона хьо веза» — «Я тебя люблю»
  if (src === "inh") { const rv = reverseFromRuInh(text, pool); if (rv) return rv; }
  // предложение, которое можно собрать по правилам грамматики (в обе стороны, от двух слов)
  if (RET.wordsOf(text).length >= 2) {
    const rr = src === "ru" ? RULES.translate(text) : RULES.translateInh(text);
    if (rr) {
      return {
        translation: rr.translation, label: "Без ИИ: по правилам грамматики", kind: "rules", rules: rr,
        note: `Правило: ${rr.ruleName}. Слова взяты из словаря, грамматика — из справочника. Перевод собран без ИИ, но правила пока простые: проверьте у носителя языка.`,
      };
    }
  }
  if (d && d.prio <= 1) return d;
  if (p) return seedResult(p, src);
  if (b) return b;
  if (d) return d;
  if (CORPUS.size()) {
    const c = CORPUS.exact(text, src);
    if (c) return { translation: src === "inh" ? c[1] : c[0], label: "Из базы: перевод из настоящих текстов", kind: "corpus" };
  }
  return null;
}

// ---------------- варианты перевода (до 3) с источником и галочкой у самого надёжного ----------------
// Надёжность: 1 — проверено носителем (/review, исправления с сайта); 2 — словарь и разговорник проекта;
// 3 — открытые словари (PanLex, Викисловарь…); 4 — настоящие тексты (корпус); 5–7 — ИИ (уверен / скорее / не уверен).
// Новых запросов к ИИ здесь нет: берём только то, что уже есть в базе или уже ответил ИИ.
const MAX_VARIANTS = 3;
const shortSource = (s) => String(s || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
const AI_RANK = { high: 5, medium: 6, low: 7 };
const AI_LABEL = { high: "ИИ, уверен", medium: "ИИ, скорее уверен", low: "ИИ, не уверен" };
function aiVariant(text, confidence, note = "") {
  const c = String(confidence || "").toLowerCase();
  return { text, note, source: "ai", sourceLabel: AI_LABEL[c] || "ИИ", rank: AI_RANK[c] || 6 };
}
// Откуда пара из data/phrases.json: { source, sourceLabel, rank, prio }.
// Порядок надёжности: словарь проекта > PaydaDosh > Викисловарь > Википедия/Викиданные > PanLex > корпус > translatewiki.
// rank — для сайта (1 носитель … 7 ИИ), prio — порядок внутри одного rank. Если ту же пару дал и другой
// источник (поле also), берём самый надёжный из них.
// rare: true — в паре есть форма, которой нет в собранных ингушских текстах (scripts/build-phrases.js, пункт 5):
// такая запись идёт после всех остальных записей базы с тем же текстом (и после статистики корпуса), но до ИИ.
function oneSource(name, p) {
  const n = String(name || "");
  if (sameAsRu(p)) return { source: "open", sourceLabel: SAME_AS_RU, rank: 4, prio: 3 };
  if (p.rare && /^(PaydaDosh|Викислов)/.test(n)) return { source: /^PaydaDosh/.test(n) ? "paydadosh" : "open", sourceLabel: /^PaydaDosh/.test(n) ? "Словарь PaydaDosh" : `Открытый словарь: ${shortSource(n)}`, rank: 4, prio: 2 };
  if (/^PaydaDosh/.test(n)) return { source: "paydadosh", sourceLabel: "Словарь PaydaDosh", rank: 3, prio: 0 };
  if (/^Корпус/.test(n)) return { source: "corpus", sourceLabel: "Из настоящих текстов", rank: 4, prio: 0 };
  if (/^translatewiki/i.test(n)) return { source: "open", sourceLabel: `Открытый словарь: ${shortSource(n)}`, rank: 4, prio: 1 };
  if (p.license || n !== p.source) {
    const prio = /^Викислов/.test(n) ? 1 : /^(Ингушская Википедия|Викиданные)/.test(n) ? 2 : 3;
    return { source: "open", sourceLabel: `Открытый словарь: ${shortSource(n)}`, rank: 3, prio };
  }
  return { source: "project", sourceLabel: "Словарь проекта", rank: 2, prio: 0 };
}
function seedSource(p) {
  let best = oneSource(p.source, p);
  for (const a of p.also || []) {
    const o = oneSource(a, p);
    if (o.rank < best.rank || (o.rank === best.rank && o.prio < best.prio)) best = o;
  }
  return best;
}
// Пометка к варианту из строки словаря: «Фу деш ва хьо? (мужчине) / Фу деш я хьо? (женщине)» → «мужчине».
function noteFromLine(text, line) {
  const k = BASE.key(text);
  for (const part of String(line || "").split(/ \/ |\s*\/\/\s*/)) {
    const m = /^(.*?)\s*\(([^()]*)\)\s*[.!?]*\s*$/.exec(part.trim());
    if (m && BASE.key(m[1]) === k) return m[2];
  }
  return "";
}
// Все пары базы с тем же текстом (не только первая).
let SEED_ALL = null;
function seedAll(src) {
  if (!SEED_ALL) {
    SEED_ALL = { ru: new Map(), inh: new Map() };
    const push = (m, k, v) => { if (!k) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
    for (const p of SEED) { push(SEED_ALL.ru, BASE.key(p.ru), p); push(SEED_ALL.inh, BASE.key(p.inh), p); }
  }
  return SEED_ALL[src === "inh" ? "inh" : "ru"];
}
// Список вариантов: лучший первым (best: true), одинаковые тексты склеиваются (остаётся более надёжный источник).
function finishVariants(list, fixT = (x) => x) {
  const byText = new Map();
  list.forEach((v, order) => {
    const text = fixT(String(v.text || "").trim());
    if (!text) return;
    const k = BASE.key(text) || text;
    const old = byText.get(k);
    if (!old) byText.set(k, { ...v, text, note: v.note || "", order });
    else {
      if (v.rank < old.rank || (v.rank === old.rank && (v.prio || 0) < (old.prio || 0))) {
        Object.assign(old, { source: v.source, sourceLabel: v.sourceLabel, rank: v.rank, prio: v.prio });
        if (/^в текстах/.test(old.note)) old.note = ""; // счётчик относился к прежнему источнику
      }
      if (!old.note && v.note && !/^в текстах/.test(v.note)) old.note = v.note;
    }
  });
  const sorted = [...byText.values()].sort((a, b) => a.rank - b.rank || (a.prio || 0) - (b.prio || 0) || a.order - b.order);
  // последнее место — по возможности другому источнику: «второе мнение» полезнее третьего варианта из того же словаря
  let top = sorted.slice(0, MAX_VARIANTS);
  if (sorted.length > MAX_VARIANTS) {
    const head = sorted.slice(0, MAX_VARIANTS - 1);
    const other = sorted.slice(MAX_VARIANTS - 1).find((v) => head.every((h) => h.sourceLabel !== v.sourceLabel));
    if (other) top = [...head, other];
  }
  return top
    .map(({ order, ...v }, i) => ({ text: v.text, note: v.note, source: v.source, sourceLabel: v.sourceLabel, rank: v.rank, best: i === 0 }));
}
// Варианты для готового ответа из базы r (resolveExact / compose) + другие пары базы с тем же текстом.
function exactVariants(r, input, src, tgt, pool, fixT) {
  const list = [];
  let main;
  if (r.verified) main = { source: "native", sourceLabel: "Проверено носителем", rank: 1 };
  else if (r.kind === "seed" && r.seed) main = seedSource(r.seed);
  else if (r.kind === "texts" || r.kind === "corpus") main = { source: "corpus", sourceLabel: "Из настоящих текстов", rank: 4 };
  else if (r.kind === "composed") main = { source: "project", sourceLabel: r.withRules ? "База и правила, по предложениям" : "Из базы, по предложениям", rank: 2 };
  else if (r.kind === "rules") {
    // варианты для мужчины / женщины, «тхо / вай», «ер / из»
    return finishVariants(r.rules.variants.map((v) => ({ text: v.text, note: v.note, source: "rules", sourceLabel: "По правилам грамматики", rank: 3 })), fixT);
  }
  else main = { source: "project", sourceLabel: "Словарь проекта", rank: 2 };
  const line = r.kind === "glossary" || r.kind === "phrase" ? r.line || r.note : "";
  const seedNote = r.kind === "seed" ? r.seedNote || "" : "";
  list.push({ text: r.translation, note: noteFromLine(r.translation, line) || seedNote || "", ...main });
  for (const a of r.alternatives || []) {
    if (!a || !a.text) continue;
    const fromTexts = /^в текстах/.test(a.meaning || "");
    const src2 = fromTexts ? { source: "corpus", sourceLabel: "Из настоящих текстов", rank: 4 } : main;
    list.push({ text: a.text, note: noteFromLine(a.text, line) || (fromTexts ? a.meaning : a.meaning || ""), ...src2 });
  }
  if (r.kind !== "composed" && isRuInh(src, tgt)) {
    // остальные источники базы для того же текста (только если ответ шёл не из них)
    if (!r.verified) {
      const saved = exactMatch(pool, input, src, tgt);
      if (saved) list.push({ text: saved, note: "", source: "native", sourceLabel: "Проверено носителем", rank: 1 });
    }
    if (r.kind === "seed" || r.kind === "corpus") {
      const b = BASE.lookup(input, src, tgt);
      if (b) list.push(...exactVariants({ ...b, alternatives: (b.alternatives || []).slice(0, 2) }, input, src, tgt, [], fixT).map((v) => ({ ...v })));
    }
    for (const it of r.more || []) { // другие записи словаря для того же слова
      const where = it.seed ? seedSource(it.seed) : { source: "project", sourceLabel: "Словарь проекта", rank: 2, prio: 0 };
      list.push({ text: src === "ru" ? it.inh : noParens(it.ru), note: it.seed && it.seed.license ? glossNote(it.seed.note) : "", ...where });
    }
    for (const p of seedAll(src).get(BASE.key(input)) || []) {
      const rev = REVIEW && REVIEW[p.id];
      const sp = src === "ru" && !(rev && rev.inh) ? splitNote(p.inh) : { text: "", note: "" };
      const texts = src === "ru" ? ((rev && rev.inh) ? [rev.inh] : splitAlt(sp.text).map(noStress)) : [noParens(p.ru)];
      const where = rev ? { source: "native", sourceLabel: "Проверено носителем", rank: 1 } : seedSource(p);
      for (const text of texts) list.push({ text, note: sp.note || (p.license ? glossNote(p.note) : noteFromLine(text, p.note)), ...where });
    }
  }
  return finishVariants(list, fixT);
}

// Порядок пар на /review: сначала частые бытовые фразы, потом слова по частоте, редкое — в конце.
//   0 — фразы словаря проекта; 1 — короткие бытовые фразы PaydaDosh (уроки, разговорник, переводы носителей);
//   2 — остальные короткие фразы (до 6 слов); 3 — слова из настоящих текстов (чем чаще, тем раньше);
//   4 — остальные слова; 5 — длинные фразы, пословицы и обороты; 6 — имена собственные.
// Внутри группы — по надёжности источника, потом короче раньше. Решения хранятся по id пары, как и раньше.
const EVERYDAY_TAG = /^PaydaDosh, разговорник: (переводы носителей|уроки|ситуации|обряды и праздники)/;
let REVIEW_ORDER = null;
function reviewOrder() {
  if (REVIEW_ORDER) return REVIEW_ORDER;
  const words = (t) => (String(t).match(/[^\s]+/g) || []).length;
  const tier = (p, src) => {
    if (p.kind === "name") return 6;
    if (p.kind === "phrase") {
      if (src.rank === 2) return 0;
      const n = words(p.ru);
      if (n <= 6 && src.source === "paydadosh" && EVERYDAY_TAG.test(p.note || "")) return 1;
      return n <= 6 ? 2 : 5;
    }
    return p.count ? 3 : 4;
  };
  const keyed = SEED.map((p, i) => {
    const src = seedSource(p);
    return { i, t: tier(p, src), r: src.rank * 10 + (src.prio || 0), c: p.count || 0, l: String(p.ru).length };
  });
  keyed.sort((a, b) => a.t - b.t || (a.t === 3 ? b.c - a.c : 0) || a.r - b.r || a.l - b.l || a.i - b.i);
  return (REVIEW_ORDER = keyed.map((x) => x.i));
}

// «Переведите»: частые русские предложения без ингушского перевода (data/translate-these.json).
// Перевод носителя сохраняется так же, как кнопка «Исправить» на сайте (список "all", русский → ингушский),
// поэтому сразу работает как «Проверено носителем». Формат хранилища не меняется.
const ASK = (() => { try { return require("../data/translate-these.json").items || []; } catch { return []; } })();
async function askAction(action, body, res) {
  const code = process.env.EDITOR_CODE;
  if (!code) return res.status(503).json({ error: "Проверка выключена: добавьте переменную EDITOR_CODE в настройках Netlify и пересоберите сайт." });
  if (body.code !== code) return res.status(403).json({ error: "Неверный код редактора" });
  try {
    if (action === "ask-save") {
      const item = ASK.find((x) => x.id === String(body.id || ""));
      if (!item) return res.status(400).json({ error: "Нет такого предложения" });
      const inh = fixPalochka(String(body.inh || "")).trim();
      if (!inh || inh.length > 600) return res.status(400).json({ error: "Впишите перевод" });
      await savePhrase({ source: "ru", target: "inh", text: item.ru, translation: inh, at: new Date().toISOString() });
    }
    const phrases = await loadPhrases(action === "ask-save");
    const has = (x) => !!exactMatch(phrases, x.ru, "ru", "inh");
    const done = ASK.filter(has).length;
    const after = Number.isInteger(body.after) ? body.after : -1;
    const n = ASK.length;
    let index = -1;
    for (let step = 1; step <= n; step++) {
      const i = (((after + step) % n) + n) % n;
      if (!has(ASK[i])) { index = i; break; }
    }
    if (index < 0) return res.status(200).json({ done: true, translated: done, total: n });
    return res.status(200).json({ item: ASK[index], index, translated: done, total: n, ok: action === "ask-save" });
  } catch (e) {
    console.error("ask:", e.status, e.message);
    return res.status(e.status || 500).json({ error: e.status === 501 ? e.message : "Не получилось. Попробуйте ещё раз." });
  }
}

// Страница /review: следующая непроверенная пара и сохранение решения. Доступ — по коду EDITOR_CODE.
async function reviewAction(action, body, res) {
  const code = process.env.EDITOR_CODE;
  if (!code) return res.status(503).json({ error: "Проверка выключена: добавьте переменную EDITOR_CODE в настройках Netlify и пересоберите сайт." });
  if (body.code !== code) return res.status(403).json({ error: "Неверный код редактора" });
  try {
    if (action === "review-save") {
      const p = seedIndex().byId.get(String(body.id || ""));
      if (!p) return res.status(400).json({ error: "Нет такой пары" });
      let decision = body.decision === "fix" ? "fix" : body.decision === "ok" ? "ok" : null;
      if (!decision) return res.status(400).json({ error: "Нужно решение: ok или fix" });
      const inh = fixPalochka(String(body.inh || "")).trim();
      if (decision === "fix") {
        if (!inh || inh.length > 600) return res.status(400).json({ error: "Пустой или слишком длинный перевод" });
        if (inh === p.inh) decision = "ok";
      }
      const reviewed = await saveReview(p.id, decision, inh);
      return res.status(200).json({ ok: true, reviewed, total: SEED.length });
    }
    const review = await loadReview(true);
    // after / index — место в очереди reviewOrder() (сначала частые фразы)
    const order = reviewOrder();
    const after = Number.isInteger(body.after) ? body.after : -1;
    const n = order.length;
    let index = -1;
    for (let step = 1; step <= n; step++) {
      const pos = (((after + step) % n) + n) % n;
      if (!review[SEED[order[pos]].id]) { index = pos; break; }
    }
    const reviewed = Object.keys(review).filter((id) => seedIndex().byId.has(id)).length;
    if (index < 0) return res.status(200).json({ done: true, reviewed, total: n });
    const p = SEED[order[index]];
    const { id, ru, inh, kind, source, note, count } = p;
    const { sourceLabel } = seedSource(p);
    return res.status(200).json({ item: { id, ru, inh, kind, source, sourceLabel, also: p.also || [], note: note || "", count: count || 0 }, index, reviewed, total: n });
  } catch (e) {
    console.error("review:", e.status, e.message);
    return res.status(e.status || 500).json({ error: e.status === 501 ? e.message : "Не получилось. Попробуйте ещё раз." });
  }
}

async function handleRequest(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { text = "", source, target, mode, action } = body || {};
  if (action === "review-next" || action === "review-save") return reviewAction(action, body || {}, res);
  // библиотека правил для страницы /rules: какие предложения переводятся без ИИ и примеры
  if (action === "rules") {
    const L = require("../lib/rules/lexicon.js");
    return res.status(200).json({
      // ours — как правила переводят образец с русского, back — как обратно с ингушского
      rules: RULES.RULES.map((r) => ({ id: r.id, name: r.name, examples: r.examples.map(([ru, inh]) => ({ ru, inh, ours: (RULES.translate(ru) || {}).translation || "", back: (RULES.translateInh(inh) || {}).translation || "" })) })),
      verbs: L.VERBS.map((v) => ({ ru: v.id, inh: typeof v.pres === "string" ? v.pres : v.pres ? Object.values(v.pres).join(" / ") : v.part, example: v.example })),
    });
  }
  if (action === "ask-next" || action === "ask-save") return askAction(action, body || {}, res);
  // страница спрашивает, включён ли ИИ на сервере: если нет — прячет кнопки «Сравнить ИИ» и «Без ИИ»
  if (action === "config") return res.status(200).json({ ai: aiEnabled() });
  // только свои коды языков: «__proto__», «constructor» и т.п. есть у любого объекта — это не язык
  const isLang = (c) => typeof c === "string" && Object.prototype.hasOwnProperty.call(LANGS, c);
  if (!isLang(source) || !isLang(target)) return res.status(400).json({ error: "Unknown language" });
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Empty text" });
  if (text.length > MAX_CHARS) return res.status(413).json({ error: `Не больше ${MAX_CHARS} символов` });

  const input = (source === "inh" ? fixPalochka(text) : text).trim();
  const fixT = (s) => (target === "inh" ? fixPalochka(s) : String(s || "").trim());

  // --- «Неправильный перевод?»: сохранить жалобу (текст, перевод, направление) для проверки носителем ---
  if (action === "report") {
    const store = phraseStore();
    if (!store) return res.status(501).json({ error: "Сохранение недоступно на этом хостинге." });
    try {
      const list = (await store.get("reports", { type: "json" })) || [];
      list.push({ text: input.slice(0, 500), translation: String(body.translation || "").slice(0, 1000), source, target, at: new Date().toISOString() });
      while (list.length > 2000) list.shift();
      await store.setJSON("reports", list);
      return res.status(200).json({ ok: true, count: list.length });
    } catch (e) {
      console.error("report:", e.message);
      return res.status(500).json({ error: "Не удалось отправить. Попробуйте ещё раз." });
    }
  }

  // --- сохранить исправление ---
  if (action === "correct") {
    const translation = fixT(body.translation || "").trim();
    if (!translation) return res.status(400).json({ error: "Пустой перевод" });
    if (process.env.EDITOR_CODE && body.code !== process.env.EDITOR_CODE) {
      return res.status(403).json({ error: "Неверный код редактора" });
    }
    try {
      const count = await savePhrase({ source, target, text: input, translation, at: new Date().toISOString() });
      return res.status(200).json({ ok: true, count });
    } catch (e) {
      console.error("save:", e.status, e.message);
      return res.status(e.status || 500).json({ error: e.status === 501 ? e.message : "Не удалось сохранить. Попробуйте ещё раз." });
    }
  }

  const phrases = await loadPhrases();
  await loadReview();
  const pool = VERIFIED.length ? [...VERIFIED, ...phrases] : phrases; // исправления с сайта важнее: они в конце
  const ruInh = isRuInh(source, target);
  const noAi = body.noAi === true || !aiEnabled();
  const saved = exactMatch(pool, input, source, target);

  // --- готовый ответ без ИИ: проверено носителем → база (фразы, словарь, настоящие тексты) ---
  const exactResult = (r) => {
    const result = r.verified
      ? { translation: fixT(r.translation), model: r.label, verified: true }
      : { translation: fixT(r.translation), model: r.label, base: true, kind: r.kind };
    if (r.alternatives || r.note) result.details = { alternatives: r.alternatives || [], note: r.note || "" };
    if (r.kind === "rules" || r.withRules) result.rules = true;
    // слова из словаря и собранные правилами уже проверены по источникам — подчёркивать их не нужно
    if (target === "inh" && r.kind !== "glossary" && r.kind !== "seed" && r.kind !== "rules") Object.assign(result, checkIngush(result.translation, input));
    result.variants = exactVariants(r, input, source, target, pool, fixT);
    return result;
  };
  const tryExact = () => {
    const r = resolveExact(input, source, target, pool);
    if (r) return exactResult(r);
    // каждое предложение текста есть в базе — собираем ответ из них
    let withRules = false;
    const c = BASE.compose(input, (part) => {
      const pr = resolveExact(source === "inh" ? fixPalochka(part) : part, source, target, pool);
      if (pr && pr.kind === "rules") withRules = true;
      return pr;
    });
    if (c) {
      const label = c.verified ? "Проверено носителем языка" : withRules ? "Без ИИ: база и правила грамматики, по предложениям" : "Из базы: собрано по предложениям";
      return exactResult({ translation: c.translation, verified: c.verified && !withRules, label, kind: "composed", withRules });
    }
    return null;
  };
  // test: true — замер настоящего ИИ (scripts/check-ai.js): не отвечать из базы и правил и не показывать ИИ
  // эту же фразу в примерах (иначе ИИ просто перепишет готовый ответ); в «Сравнить» — все модели.
  const test = body && body.test === true;
  if (action !== "compare" && !test) {
    const r = tryExact();
    if (r) return res.status(200).json(r);
  }

  // примеры для ИИ: для русского ↔ ингушского — 16 самых похожих пар (lib/retrieval.js),
  // для других языков — исправления носителей с теми же словами (как раньше)
  const distilled = isRuInh(source, target) ? await loadDistilled() : [];
  const same = (x) => RET.normalize(x || "").replace(/[^а-яӏ ]/g, "").trim();
  const examples = (isRuInh(source, target)
    ? RET.pickFewShots(input, source, target, pool, distilled, test ? 17 : 16)
    : pickExamples(pool, input, source, target))
    .filter((e) => !test || (same(e.ru) !== same(input) && same(e.inh) !== same(input) && same(e.text) !== same(input)))
    .slice(0, 16);
  let budget = timeBudget(req);
  const hurried = budget < LONG_BUDGET_MS; // времени мало: ИИ отвечает в быстром режиме, думает меньше

  // примеры из корпуса: ждём его недолго, иначе переводим без них (загрузка продолжится)
  let corpus = [];
  if (hasIngush(source, target) && (source === "ru" || source === "inh")) {
    const t0 = Date.now();
    if (await CORPUS.ready(budget >= LONG_BUDGET_MS && !noAi ? 4000 : 300)) // без ИИ корпус нужен только для подсказок — не ждём corpus = CORPUS.search(input, source === "inh" ? "inh" : "ru", 15).filter(([inh, ru]) => !test || (same(ru) !== same(input) && same(inh) !== same(input)));
    budget -= Date.now() - t0;
  }
  // корпус мог только что загрузиться: ещё раз ищем готовый ответ (целый текст или по предложениям)
  if (ruInh && action !== "compare" && CORPUS.size()) {
    const r = tryExact();
    if (r) return res.status(200).json(r);
  }

  // что база знает про слова этого текста и похожие предложения из настоящих текстов
  const words = ruInh ? RET.breakdown(input, source) : [];
  // подсказки: похожие фразы из базы, потом похожие предложения из настоящих текстов
  const similar = !ruInh ? [] : [
    ...examples.filter((e) => e.ru && e.inh && e.from !== "distilled" && e.from !== "wiki").slice(0, 4).map((e) => (source === "ru" ? [e.ru, fixPalochka(e.inh)] : [fixPalochka(e.inh), e.ru])),
    ...(CORPUS.size()
      ? CORPUS.search(input, source, 8, 2).filter((p) => p[0].length <= 220 && p[1].length <= 220).slice(0, 3)
        .map((p) => (source === "inh" ? [p[0], p[1]] : [p[1], p[0]]))
      : []),
  ].slice(0, 6);

  if (noAi && action !== "compare") {
    // запасной шаг без ИИ: перевод по кускам и словам. Грубый, поэтому не «из базы», а с пометкой
    const ch = ruInh ? CHUNKS.translate(input, source) : null;
    // проверка обратным переводом: русский черновик переводим обратно на ингушский по базе — если получилась
    // та же ингушская фраза, перевод подтверждён парой «русский → ингушский»
    let backOk = false;
    if (ch && source === "inh" && ch.translation && !/\[/.test(ch.translation)) {
      const back = resolveExact(ch.translation, "ru", "inh", pool);
      backOk = !!(back && back.translation && back.kind !== "rules" && bagKey(inhWords(back.translation)) === bagKey(inhWords(input)));
    }
    if (ch) {
      const result = {
        translation: fixT(ch.translation), model: ch.pieces.length && ch.pieces.every((p) => p.how === "name") ? "Имя: не переводится, пишется так же" : backOk ? "Без ИИ: по словам, подтверждено обратным переводом по базе" : "Без ИИ: по словам из словаря", rules: true, chunks: true, roundTrip: backOk || undefined,
        known: ch.known, total: ch.total, words, similar,
        // откуда каждое слово перевода: страница показывает это по нажатию на слово
        pieces: (ch.pieces || []).filter((p) => p && p.to).map((p) => ({ from: String(p.from || ""), to: fixT(p.to), how: String(p.how || ""), src: p.src ? String(p.src) : "", ...(p.syn ? { syn: String(p.syn), synOf: String(p.synOf || "") } : {}), ...(p.name ? { name: String(p.name), nameCase: String(p.nameCase || "") } : {}) })),
        details: { alternatives: [], note: "Собрано по словам из словаря; слова в [скобках] не найдены." + ((ch.pieces || []).some((p) => p.how === "loan") ? " Слова " + ch.pieces.filter((p) => p.how === "loan").map((p) => "«" + p.to + "»").join(", ") + " оставлены как по-русски (новые заимствования)." : "") + ((ch.pieces || []).some((p) => p.how === "name") ? " Имена не переводятся." : "") },
      };
      if (target === "inh") Object.assign(result, checkIngush(result.translation, input));
      result.variants = finishVariants([{ text: result.translation, note: "", source: "chunks", sourceLabel: "по словам из словаря", rank: 4 }], fixT);
      return res.status(200).json(result);
    }
    return res.status(200).json({ translation: "", noAi: true, base: true, words, similar, supported: ruInh, aiOff: !aiEnabled() });
  }

  if (!attempts().length) {
    return res.status(500).json({ error: "Этого нет в базе, а ключа ИИ нет. Добавьте GEMINI_API_KEY: на хостинге — в настройках (и пересоберите сайт), на своём компьютере — в файле .env (и перезапустите server.js)." });
  }

  // --- сравнить все ИИ ---
  if (action === "compare") {
    const results = await askAll(prompts((tier) => textPrompt(input, source, target, examples, tier, corpus)), budget, test);
    for (const r of results) {
      if (r.text) {
        r.text = fixT(readTranslation(r.text).translation || r.text);
        if (target === "inh") Object.assign(r, checkIngush(r.text, input));
      }
    }
    return res.status(200).json({ results, saved: saved || null, examples: examples.length });
  }

  // --- второй проход: заменить слова, которых нет в ингушских текстах; остаётся лучший вариант ---
  if (action === "repair") {
    const draft = fixT(String(body.draft || "")).trim();
    if (target !== "inh" || !draft || draft.length > MAX_CHARS * 2) return res.status(400).json({ error: "Нечего исправлять" });
    const before = suspects(draft, input);
    if (!before.length) return res.status(200).json({ translation: draft, improved: false, ...checkIngush(draft, input) });
    const textKey = `${source}|${target}|t|${input}`;
    const remember = (extra) => { const old = CACHE.get(textKey); if (old && old.translation === draft) cacheSet(textKey, { ...old, ...extra, repaired: true }); };
    try {
      const { text: out, by } = await ask(prompts((tier) => repairPrompt(input, source, target, draft, before, examples, tier, corpus)), false, budget);
      const fixed = BASE.chechenFix(fixT(out)).text.trim();
      const after = suspects(fixed, input);
      const sane = fixed.length >= draft.length * 0.5 && fixed.length <= draft.length * 2 + 20;
      const improved = sane && after.length < before.length; // лучше — значит меньше слов, которых нет в ингушских текстах
      const translation = improved ? fixed : draft;
      const result = { translation, improved, model: by, ai: true, before: before.length, after: improved ? after.length : before.length, ...checkIngush(translation, input) };
      result.variants = finishVariants([improved ? { ...aiVariant(translation, ""), sourceLabel: "ИИ, исправлено по базе" } : aiVariant(translation, "")], fixT);
      if (hurried) result.fast = true;
      remember(improved ? { translation, unknown: result.unknown, coverage: result.coverage, suspect: after, russian: result.russian } : {});
      return res.status(200).json(result);
    } catch (e) {
      const status = e.status === 429 ? 429 : e.status === 401 ? 502 : 503;
      return res.status(status).json({ error: e.message, detail: e.detail });
    }
  }

  // --- обычный перевод ---
  const cacheKey = `${source}|${target}|${mode === "word" ? "w" : "t"}|${input}`;
  const hit = CACHE.get(cacheKey);
  if (hit) return res.status(200).json({ ...hit, cached: true });

  try {
    let result = null;
    const started = Date.now();
    if (mode === "word") {
      const { text: raw, by } = await ask(prompts((tier) => wordPrompt(input, source, target, examples, tier, corpus)), true, budget);
      const v = parseJson(raw);
      if (v && typeof v.translation === "string" && v.translation.trim()) {
        result = { translation: fixT(v.translation.trim()), details: v, model: by };
        result.variants = finishVariants([
          aiVariant(v.translation, v.confidence),
          ...(Array.isArray(v.alternatives) ? v.alternatives : []).filter((a) => a && a.text).map((a) => aiVariant(a.text, v.confidence, a.meaning || "")),
        ], fixT);
      }
    }
    let distill = null;
    if (!result) {
      const left = budget - (Date.now() - started);
      const { text: raw, by, model } = await ask(prompts((tier) => textPrompt(input, source, target, examples, tier, corpus)), TEXT_SCHEMA, left);
      const v = readTranslation(raw);
      if (!v.translation) throw httpError(503, "ИИ вернул пустой ответ. Попробуйте ещё раз.");
      result = { translation: fixT(v.translation), model: by };
      if (v.confidence) result.confidence = v.confidence;
      if (v.unknown_words.length) result.aiUnknown = v.unknown_words;
      // плашка «Уверен / Не уверен» под переводом (её уже умеет показывать страница)
      if (v.confidence || v.unknown_words.length) {
        result.details = { confidence: v.confidence, alternatives: [], note: v.unknown_words.length ? `ИИ не уверен в словах: ${v.unknown_words.join(", ")}` : "" };
      }
      distill = { model, confidence: v.confidence, unknown: v.unknown_words };
    }
    result.examples = examples.length;
    result.corpus = corpus.length;
    result.ai = true;
    if (hurried) result.fast = true;
    if (target === "inh") {
      // чеченские формы, которых в ингушском нет, заменяем по таблице
      const f = BASE.chechenFix(result.translation);
      if (f.fixed.length) { result.translation = f.text; result.fixed = f.fixed; }
      Object.assign(result, checkIngush(result.translation, input));
      if (mode !== "word") result.suspect = suspects(result.translation, input); // для второго прохода
    }
    if (mode !== "word") { result.words = words; result.similar = similar; }
    if (!result.variants) result.variants = finishVariants([aiVariant(result.translation, result.confidence)], fixT);
    else if (result.variants.length && target === "inh") result.variants[0].text = result.translation; // после замены чеченских форм
    if (distill && isRuInh(source, target)) await maybeDistill(input, source, result, distill);
    cacheSet(cacheKey, result);
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 401 ? 502 : 503;
    return res.status(status).json({ error: e.message, detail: e.detail });
  }
}

// ---------------- админка /admin: журнал переводов и жалобы «Неправильный перевод?» ----------------
// Доступ — только по коду ADMIN_CODE (переменная окружения хостинга или .env). Без него админка выключена.
const LOG = require("../lib/activity-log.js").createLog(() => phraseStore());
const INSIGHTS = require("../lib/admin-insights.js");
const looksRussian = require("../lib/lang-detect.js")({ POST });
const phraseId = (p) => require("crypto").createHash("sha1").update(String(p.source) + ">" + String(p.target) + ">" + normKey(p.text)).digest("hex").slice(0, 12);
// убрать исправление из словаря сайта; null — такой записи нет
async function removePhrase(id) {
  const store = phraseStore();
  const list = await loadPhrases(true);
  const kept = list.filter((p) => phraseId(p) !== id);
  if (kept.length === list.length) return null;
  await store.setJSON("all", kept);
  PHRASES = kept; PHRASES_AT = Date.now();
  CACHE.clear();
  return kept.length;
}
const reportId = (r) => require("crypto").createHash("sha1").update(String(r.at || "") + "|" + String(r.text || "") + "|" + String(r.source || "")).digest("hex").slice(0, 12);
function sameCode(given, code) {
  const crypto = require("crypto");
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(String(code)).digest();
  return crypto.timingSafeEqual(a, b);
}
async function adminAction(body, res) {
  const code = process.env.ADMIN_CODE;
  if (!code) return res.status(503).json({ error: "Админка выключена: добавьте переменную ADMIN_CODE в настройках хостинга (Railway → Variables) или в .env и перезапустите." });
  if (!sameCode(body.code, code)) {
    await new Promise((r) => setTimeout(r, 700)); // подбор кода медленный
    return res.status(403).json({ error: "Неверный код" });
  }
  const store = phraseStore();
  const op = body.op || "data";
  try {
    if (op === "data") {
      let reports = [];
      if (store) reports = (await store.get("reports", { type: "json" })) || [];
      const log = await LOG.read();
      return res.status(200).json({
        reports: (Array.isArray(reports) ? reports : []).map((r) => ({ ...r, id: reportId(r) })).reverse(),
        log: log.list.slice().reverse(),
        stats: log.stats,
        storage: store ? (process.env.SUPABASE_URL ? "supabase" : storeOverride ? "local" : "netlify") : "none",
        logging: process.env.ADMIN_LOG !== "0",
        // словарь сайта: исправления, сохранённые кнопкой «Исправить» и из админки (новые сверху)
        dict: (await loadPhrases(true)).map((p) => ({ ...p, id: phraseId(p) })).reverse(),
        popular: INSIGHTS.popular(log.list),
        missed: INSIGHTS.missed(log.list),
        trash: await (async () => { try { const t = await store.get("trash", { type: "json" }); return t && t.what ? { what: t.what, at: t.at } : null; } catch { return null; } })(),
      });
    }
    // резервная копия: всё, что сайт хранит сам (база data/phrases.json и так лежит в git)
    if (op === "backup") {
      const get = async (k, d) => { if (!store) return d; try { const v = await store.get(k, { type: "json" }); return v == null ? d : v; } catch (e) { console.error("backup " + k + ":", e.message); return d; } };
      await LOG.flush();
      return res.status(200).json({
        kind: "ingush-translator-backup", version: 1, at: new Date().toISOString(),
        corrections: await get("all", []), review: await get("review", {}), reports: await get("reports", []),
        distilled: await get("distilled", []), log: await get("log", []), logStats: await get("log-stats", {}),
      });
    }
    // исправить перевод (из жалобы или словаря): сохраняется как исправление носителя — сайт сразу отвечает им
    if (op === "fix" || op === "dict-save") {
      const isLang = (c) => typeof c === "string" && Object.prototype.hasOwnProperty.call(LANGS, c);
      const { source, target } = body;
      if (!isLang(source) || !isLang(target) || source === target) return res.status(400).json({ error: "Неверное направление" });
      const text = (source === "inh" ? fixPalochka(body.text || "") : String(body.text || "")).trim();
      const translation = (target === "inh" ? fixPalochka(body.translation || "") : String(body.translation || "")).trim();
      if (!text || !translation) return res.status(400).json({ error: "Нужны и текст, и перевод" });
      if (text.length > 500 || translation.length > 1000) return res.status(413).json({ error: "Слишком длинно" });
      if (!store) return res.status(501).json({ error: "Хранилище недоступно." });
      if (op === "dict-save" && body.id) await removePhrase(body.id); // правка: старая запись уходит
      const count = await savePhrase({ source, target, text, translation, at: new Date().toISOString() });
      let report = null;
      if (body.reportId) {
        const list = (await store.get("reports", { type: "json" })) || [];
        const r = list.find((x) => reportId(x) === body.reportId);
        if (r) { r.handled = true; r.handledAt = new Date().toISOString(); r.fixed = translation; await store.setJSON("reports", list); report = { id: body.reportId, handled: true, handledAt: r.handledAt, fixed: translation }; }
      }
      const entry = { source, target, text, translation };
      return res.status(200).json({ ok: true, count, entry: { ...entry, id: phraseId(entry) }, report });
    }
    // очистка: прежние данные кладутся в "trash" (одна последняя очистка), их можно вернуть кнопкой «Вернуть»
    if (op === "clear") {
      if (!store) return res.status(501).json({ error: "Хранилище недоступно." });
      const what = body.what;
      const get = async (k, d) => { const v = await store.get(k, { type: "json" }); return v == null ? d : v; };
      await LOG.flush();
      let saved = {};
      if (what === "log") {
        saved = { log: await get("log", []) };
        await LOG.clear({ log: true });
      } else if (what === "stats") {
        saved = { "log-stats": await get("log-stats", {}) };
        await LOG.clear({ log: false, stats: true });
      } else if (what === "reports-handled" || what === "reports") {
        const list = await get("reports", []);
        saved = { reports: list };
        await store.setJSON("reports", what === "reports" ? [] : list.filter((r) => !r.handled));
      } else return res.status(400).json({ error: "Неизвестно, что очищать" });
      const removed = Object.values(saved).map((v) => (Array.isArray(v) ? v.length : Object.keys(v.days || {}).length))[0] || 0;
      await store.setJSON("trash", { what, at: new Date().toISOString(), saved });
      return res.status(200).json({ ok: true, what, removed });
    }
    if (op === "undo-clear") {
      if (!store) return res.status(501).json({ error: "Хранилище недоступно." });
      const trash = await store.get("trash", { type: "json" });
      if (!trash || !trash.saved) return res.status(404).json({ error: "Нечего возвращать." });
      await LOG.flush();
      for (const [k, v] of Object.entries(trash.saved)) {
        if (k === "log") { const now = (await store.get("log", { type: "json" })) || []; await store.setJSON("log", v.concat(now).slice(-require("../lib/activity-log.js").MAX)); }
        else if (k === "reports") { const now = (await store.get("reports", { type: "json" })) || []; const ids = new Set(v.map(reportId)); await store.setJSON("reports", v.concat(now.filter((r) => !ids.has(reportId(r))))); }
        else if (k === "log-stats") {
          const now = ((await store.get("log-stats", { type: "json" })) || {}).days || {};
          const days = { ...(v.days || {}) };
          for (const [d, s] of Object.entries(now)) { const o = days[d] || { total: 0, ruInh: 0, inhRu: 0, empty: 0 }; for (const f of ["total", "ruInh", "inhRu", "empty"]) o[f] = (o[f] || 0) + (s[f] || 0); days[d] = o; }
          await store.setJSON("log-stats", { days });
        }
      }
      await store.setJSON("trash", {});
      return res.status(200).json({ ok: true, what: trash.what });
    }
    if (op === "dict-delete") {
      if (!store) return res.status(501).json({ error: "Хранилище недоступно." });
      const left = await removePhrase(body.id);
      if (left === null) return res.status(404).json({ error: "Запись не найдена (может, уже удалена)." });
      return res.status(200).json({ ok: true, count: left });
    }
    if (op === "report") {
      if (!store) return res.status(501).json({ error: "Хранилище недоступно." });
      const list = (await store.get("reports", { type: "json" })) || [];
      const r = list.find((x) => reportId(x) === body.id);
      if (!r) return res.status(404).json({ error: "Жалоба не найдена (может, уже удалена)." });
      if (body.handled) { r.handled = true; r.handledAt = new Date().toISOString(); } else { delete r.handled; delete r.handledAt; }
      await store.setJSON("reports", list);
      return res.status(200).json({ ok: true, id: body.id, handled: !!r.handled, handledAt: r.handledAt || null });
    }
    return res.status(400).json({ error: "Неизвестное действие" });
  } catch (e) {
    console.error("admin:", e.message);
    return res.status(500).json({ error: "Не удалось загрузить данные. Попробуйте ещё раз." });
  }
}

module.exports = async (req, res) => {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  if (req.method === "POST" && body.action === "admin") return adminAction(body, res);
  // выбрано «ингушский → русский», а текст русский (и в ингушской базе его нет) — переводим с русского на ингушский
  // и говорим об этом странице (switched), чтобы не выдавать «перевод» русских слов как ингушских
  let switched = null;
  if (req.method === "POST" && !body.action && body.source === "inh" && body.target === "ru" && typeof body.text === "string"
    && body.text.length <= MAX_CHARS && looksRussian(body.text) && !resolveExact(fixPalochka(body.text).trim(), "inh", "ru", [])) {
    switched = { source: "ru", target: "inh" };
    body = { ...body, source: "ru", target: "inh" };
    const json0 = res.json;
    res.json = function (obj) {
      if (obj && !obj.error) {
        obj.switched = switched;
        obj.model = "Текст на русском: перевод на ингушский · " + (obj.model || "");
      }
      return json0.call(this, obj);
    };
  }
  // обычный перевод (без action): ответ записывается в журнал для /admin — только текст и перевод
  if (req.method === "POST" && !body.action && res && typeof res.json === "function") {
    const json = res.json;
    // на Netlify / Vercel функция «засыпает» сразу после ответа: там журнал сохраняется до ответа,
    // на обычном сервере (Railway, server.js) — пачкой в фоне, чтобы перевод не ждал хранилище
    const serverless = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.VERCEL);
    res.json = function (obj) {
      try { LOG.add(body, obj); } catch (e) { console.error("log:", e.message); }
      if (!serverless) return json.call(this, obj);
      return LOG.flush().catch(() => {}).then(() => json.call(this, obj));
    };
  }
  return handleRequest({ ...req, body }, res);
};

// для тестов
// Прогрев: строит словарь, таблицу слов и всё, что иначе строится на первом переводе (несколько секунд).
// Сервер (server.js) вызывает его сразу после запуска, чтобы первый человек не ждал.
module.exports.warmup = () => {
  const t0 = Date.now();
  try {
    RET.lookupWord("дом", "ru");
    CHUNKS.translate("отвези еду маме", "ru");
    CHUNKS.translate("Со цӀа вода", "inh");
    RULES.translate("Это мой дом");
    words();
  } catch (e) { console.error("прогрев:", e.message); }
  // и один настоящий запрос: база с исправлениями, проверки ответа — всё, что строится лениво
  const fake = (body) => new Promise((resolve) => {
    const res = { status() { return this; }, json() { resolve(); }, setHeader() {} };
    Promise.resolve(module.exports({ method: "POST", body }, res)).catch(() => resolve());
  });
  return fake({ text: "куда отвезти еду", source: "ru", target: "inh", mode: "text", warmup: true })
    .then(() => fake({ text: "Со цӀа вода", source: "inh", target: "ru", mode: "text", warmup: true }))
    .then(() => Date.now() - t0);
};
module.exports._checkIngush = checkIngush;
module.exports._log = LOG;
module.exports._reportId = reportId;
module.exports._setStore = (s) => { storeOverride = s; PHRASES = null; PHRASES_AT = 0; REVIEW = null; REVIEW_AT = 0; VERIFIED = []; };
module.exports._attempts = attempts;
module.exports._cool = { isCooling, coolDown };
module.exports._resetBroke = () => { for (const k of Object.keys(BROKE_AT)) delete BROKE_AT[k]; COOL.clear(); COOL_HITS.clear(); };
module.exports._prompts = { textPrompt, wordPrompt, repairPrompt, readTranslation, systemPrompt };
module.exports._RET = RET;
module.exports._variants = { finishVariants, aiVariant, noteFromLine };
module.exports._review = { reviewOrder, seedSource, ASK };
