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
  const hits = RET.pickDictionary(text, src, tier === "full" ? 40 : 25);
  const missing = RET.missingWords(text, src, hits, shots);
  let out = "";
  if (hits.length) {
    out += `<dictionary_entries>\nRussian — Ingush dictionary entries for the words of this text (found by word stem, so some may be another form or a false match; class of the singular / of the plural; мн. = plural):\n${hits.map((h) => `${h.ru} — ${h.inh}`).join("\n")}\n</dictionary_entries>\n\n`;
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
  const LABEL = { native: " (checked by a native speaker)", guide: "", open: " (open dictionary, not checked)", distilled: " (by a stronger AI model, not checked)" };
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

let WORDS = null;
const words = () => (WORDS || (WORDS = new Set(WORDS_RAW.split("\n"))));
const wordKey = (w) =>
  fixPalochka(w.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC")).toLowerCase().replace(/Ӏ/g, "ӏ");

// Слова в [квадратных скобках] ИИ сам пометил как неизвестные — их не проверяем.
const noBrackets = (t) => String(t || "").replace(/\[[^\]\n]{0,80}\]/g, " ");

function checkIngush(text) {
  const found = noBrackets(text).match(/[Ѐ-ӿ]+(?:-[Ѐ-ӿ]+)*/g) || [];
  const set = words();
  const unknown = new Set();
  let checked = 0, known = 0;
  for (const t of found) {
    const k = wordKey(t);
    if (k.length < 2) continue;
    checked++;
    const ok = set.has(k) || (k.includes("-") && k.split("-").every((p) => p.length < 2 || set.has(p)));
    if (ok) known++; else unknown.add(t);
  }
  return { unknown: [...unknown], coverage: checked ? Math.round((known / checked) * 100) / 100 : 1 };
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
  const { unknown } = checkIngush(translation); // слова в [скобках] сюда не попадают
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
  const { system, user } = asParts(prompt);
  const sys = !system ? null
    : opts.cache && system.length >= 4000 ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;
  const messages = (s) => (s ? [{ role: "system", content: s }, { role: "user", content: user }] : [{ role: "user", content: user }]);
  let data;
  try {
    data = await send({ messages: messages(sys), temperature: temperature() }, timeoutMs);
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
const callOpts = (p, model, fast) => ({ fast, cache: p === "openrouter" && model.startsWith("anthropic/") });
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
// самая сильная из бесплатных; 3.8 Flash и 2.5 Flash — запасные; 3.5 Flash-Lite — самая быстрая.
const PAID_DEFAULT = "anthropic/claude-haiku-5.5";
function defaultSequence() {
  const paid = String(process.env.OPENROUTER_MODEL || PAID_DEFAULT).trim();
  return [
    ...(paid && paid.toLowerCase() !== "off" ? [["openrouter", paid]] : []),
    ["gemini", "gemini-4-hydrogen"],
    ["gemini", "gemini-3.8-flash"],
    ["gemini", "gemini-2.5-flash"],
    ["grok", "grok-4"],
    ["groq", "moonshotai/kimi-k2-instruct-0905"],
    ["groq", "moonshotai/kimi-k2-instruct"],
    ["openrouter", "moonshotai/kimi-k2:free"],
    ["openrouter", "openrouter/free"],
    ["gemini", "gemini-3.5-flash-lite"],
    ["groq", "qwen/qwen3-32b"],
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
  let last = null, sawLimit = false;

  const attempt = async (p, model, ms) => {
    const text = cleanOutput(await PROVIDERS[p].call(model, prompt(tierNow(p, model, fast)), json, ms, callOpts(p, model, fast)));
    if (!text) throw httpError(503, "Empty answer");
    return { text, by: modelLabel(p, model), p, model };
  };
  const failed = (p, model, e) => {
    last = e;
    trail.push(`${modelLabel(p, model)}: ${whyFailed(e)}`);
    console.error(`${p} ${model}:`, e.status, e.message);
    if (e.status === 402) { BROKE_AT[p] = Date.now(); return; }
    if (e.status === 429) sawLimit = true;
    if (e.status === 504) slow.add(p);
    if (isBadKey(e)) { deadKeys.add(p); e.badKey = PROVIDERS[p].keyEnv; }
  };
  const usable = ([p, model]) => !deadKeys.has(p) && !(isBroke(p) && isPaid(p, model));

  let queue = attempts().filter(usable);

  if (fast) {
    // Времени мало: первая модель каждого сервиса стартует сразу.
    // Ждём по порядку силы: если сильная не ответила, ответ следующей уже готов.
    const seen = new Set(), firsts = [], rest = [];
    for (const a of queue) (seen.has(a[0]) ? rest : (seen.add(a[0]), firsts)).push(a);
    const ms = Math.max(1500, budget - 900);
    const runs = firsts.map(([p, model]) => attempt(p, model, ms).then((r) => ({ r }), (e) => ({ e })));
    // сильную модель ждём не до конца: если она думает слишком долго, а у следующей ответ готов — берём его
    const graceEnd = started + Math.max(3500, Math.round(budget * 0.65));
    const wait = (i) => Promise.race([runs[i], new Promise((res) => setTimeout(() => res(null), Math.max(0, graceEnd - Date.now())))]);
    const pending = [];
    for (let i = 0; i < firsts.length; i++) {
      const out = await wait(i);
      if (!out) { pending.push(i); continue; }
      if (out.r) return out.r;
      failed(firsts[i][0], firsts[i][1], out.e);
    }
    for (const i of pending) { // готовых ответов нет — дожидаемся тех, кто ещё думает
      const out = await runs[i];
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
      return await attempt(p, model, Math.min(left - 200, cap));
    } catch (e) {
      failed(p, model, e);
    }
  }
  if (last && last.badKey && attempts().every(([p]) => deadKeys.has(p))) throw httpError(401, `Check ${last.badKey}. ${last.message}`);
  const err = httpError(sawLimit ? 429 : 503, "Все переводчики сейчас заняты. Попробуйте через минуту.");
  err.detail = trail.slice(0, 8).join("; ");
  throw err;
}

// Для кнопки «Сравнить»: по одной бесплатной модели от каждого сервиса и, если на счёте OpenRouter
// есть деньги, платные модели из COMPARE_PAID — все параллельно.
async function askAll(prompt, budget = DEADLINE_MS) {
  const seen = new Set();
  const free = attempts().filter(([p, model]) => !isPaid(p, model)).filter(([p]) => (seen.has(p) ? false : seen.add(p)));
  const paid = hasKey("openrouter") && !isBroke("openrouter") ? COMPARE_PAID.map(([model, price]) => ["openrouter", model, price]) : [];
  const fast = budget < LONG_BUDGET_MS;
  const results = await Promise.all([...paid, ...free].map(async ([p, model, price]) => {
    const by = modelLabel(p, model) + (price ? ` · ${price}` : "");
    try {
      const text = cleanOutput(await PROVIDERS[p].call(model, prompt(tierNow(p, model, fast)), false, budget - 500, callOpts(p, model, fast)));
      return text ? { by, text } : { by, error: "Пустой ответ" };
    } catch (e) {
      if (e.status === 402) { BROKE_AT[p] = Date.now(); return { by, noMoney: true }; }
      return { by, error: e.status === 429 ? "Лимит исчерпан" : e.status === 504 ? "Не успел ответить" : e.status === 404 ? "Нет такой модели" : isBadKey(e) ? "Ключ не работает" : "Занят или недоступен" };
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

let SEED_IDX = null;
function seedIndex() {
  if (SEED_IDX) return SEED_IDX;
  const ru = new Map(), inh = new Map(), byId = new Map();
  const push = (m, k, v) => { if (k && !m.has(k)) m.set(k, v); };
  for (const p of SEED) { push(ru, BASE.key(p.ru), p); push(inh, BASE.key(p.inh), p); byId.set(p.id, p); }
  return (SEED_IDX = { ru, inh, byId });
}
const isRuInh = (src, tgt) => (src === "ru" && tgt === "inh") || (src === "inh" && tgt === "ru");

// Готовый ответ без ИИ для текста или одного предложения: { translation, verified?, label, kind?, alternatives?, note? } или null.
function resolveExact(text, src, tgt, pool) {
  const saved = exactMatch(pool, text, src, tgt);
  if (saved) return { translation: saved, verified: true, label: "Проверено носителем языка" };
  const b = BASE.lookup(text, src, tgt);
  if (b) return b;
  if (!isRuInh(src, tgt)) return null;
  const p = (src === "ru" ? seedIndex().ru : seedIndex().inh).get(BASE.key(text)); // пары из других источников
  if (p) return { translation: src === "ru" ? p.inh : noParens(p.ru), label: `Из базы: ${p.source}`, kind: "seed", note: p.note || "" };
  if (CORPUS.size()) {
    const c = CORPUS.exact(text, src);
    if (c) return { translation: src === "inh" ? c[1] : c[0], label: "Из базы: перевод из настоящих текстов", kind: "corpus" };
  }
  return null;
}

// Похожие фразы из базы — подсказки под переводом. [[на языке текста, перевод], ...]
function seedHints(text, src, max = 3) {
  const stems = (t) => new Set((BASE.key(t).match(/[а-яӏ]+/g) || []).filter((w) => w.length > 1).map((w) => w.slice(0, 5)));
  const want = stems(text);
  if (!want.size) return [];
  const out = [];
  for (const p of SEED) {
    if (p.kind !== "phrase") continue;
    const have = stems(src === "ru" ? p.ru : p.inh);
    let both = 0;
    for (const w of have) if (want.has(w)) both++;
    const score = both / (want.size + have.size - both);
    if (both >= Math.min(2, want.size) && score >= 0.4) {
      const r = REVIEW && REVIEW[p.id];
      const inh = (r && r.inh) || p.inh;
      out.push({ score, pair: src === "ru" ? [p.ru, inh] : [inh, p.ru] });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.pair);
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
    const after = Number.isInteger(body.after) ? body.after : -1;
    const n = SEED.length;
    let index = -1;
    for (let step = 1; step <= n; step++) {
      const i = (((after + step) % n) + n) % n;
      if (!review[SEED[i].id]) { index = i; break; }
    }
    const reviewed = Object.keys(review).length;
    if (index < 0) return res.status(200).json({ done: true, reviewed, total: n });
    const { id, ru, inh, kind, source, note, count } = SEED[index];
    return res.status(200).json({ item: { id, ru, inh, kind, source, note: note || "", count: count || 0 }, index, reviewed, total: n });
  } catch (e) {
    console.error("review:", e.status, e.message);
    return res.status(e.status || 500).json({ error: e.status === 501 ? e.message : "Не получилось. Попробуйте ещё раз." });
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { text = "", source, target, mode, action } = body || {};
  if (action === "review-next" || action === "review-save") return reviewAction(action, body || {}, res);
  if (!LANGS[source] || !LANGS[target]) return res.status(400).json({ error: "Unknown language" });
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Empty text" });
  if (text.length > MAX_CHARS) return res.status(413).json({ error: `Не больше ${MAX_CHARS} символов` });

  const input = (source === "inh" ? fixPalochka(text) : text).trim();
  const fixT = (s) => (target === "inh" ? fixPalochka(s) : String(s || "").trim());

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
  const noAi = body.noAi === true;
  const saved = exactMatch(pool, input, source, target);

  // --- готовый ответ без ИИ: проверено носителем → база (фразы, словарь, настоящие тексты) ---
  const exactResult = (r) => {
    const result = r.verified
      ? { translation: fixT(r.translation), model: r.label, verified: true }
      : { translation: fixT(r.translation), model: r.label, base: true, kind: r.kind };
    if (r.alternatives || r.note) result.details = { alternatives: r.alternatives || [], note: r.note || "" };
    if (target === "inh" && r.kind !== "glossary" && r.kind !== "seed") Object.assign(result, checkIngush(result.translation));
    return result;
  };
  const tryExact = () => {
    const r = resolveExact(input, source, target, pool);
    if (r) return exactResult(r);
    // каждое предложение текста есть в базе — собираем ответ из них
    const c = BASE.compose(input, (part) => resolveExact(source === "inh" ? fixPalochka(part) : part, source, target, pool));
    if (c) return exactResult({ translation: c.translation, verified: c.verified, label: c.verified ? "Проверено носителем языка" : "Из базы: собрано по предложениям", kind: "composed" });
    return null;
  };
  if (action !== "compare") {
    const r = tryExact();
    if (r) return res.status(200).json(r);
  }

  // примеры для ИИ: для русского ↔ ингушского — 16 самых похожих пар (lib/retrieval.js),
  // для других языков — исправления носителей с теми же словами (как раньше)
  const distilled = isRuInh(source, target) ? await loadDistilled() : [];
  const examples = isRuInh(source, target)
    ? RET.pickFewShots(input, source, target, pool, distilled, 16)
    : pickExamples(pool, input, source, target);
  let budget = timeBudget(req);
  const hurried = budget < LONG_BUDGET_MS; // времени мало: ИИ отвечает в быстром режиме, думает меньше

  // примеры из корпуса: ждём его недолго, иначе переводим без них (загрузка продолжится)
  let corpus = [];
  if (hasIngush(source, target) && (source === "ru" || source === "inh")) {
    const t0 = Date.now();
    if (await CORPUS.ready(budget >= LONG_BUDGET_MS ? 4000 : 300)) corpus = CORPUS.search(input, source === "inh" ? "inh" : "ru", 15);
    budget -= Date.now() - t0;
  }
  // корпус мог только что загрузиться: ещё раз ищем готовый ответ (целый текст или по предложениям)
  if (ruInh && action !== "compare" && CORPUS.size()) {
    const r = tryExact();
    if (r) return res.status(200).json(r);
  }

  // что база знает про слова этого текста и похожие предложения из настоящих текстов
  const words = ruInh ? BASE.breakdown(input, source) : [];
  // подсказки: похожие фразы из базы, потом похожие предложения из настоящих текстов
  const similar = !ruInh ? [] : [
    ...seedHints(input, source),
    ...(CORPUS.size()
      ? CORPUS.search(input, source, 8, 2).filter((p) => p[0].length <= 220 && p[1].length <= 220).slice(0, 3)
        .map((p) => (source === "inh" ? [p[0], p[1]] : [p[1], p[0]]))
      : []),
  ].slice(0, 5);

  if (noAi && action !== "compare") {
    return res.status(200).json({ translation: "", noAi: true, base: true, words, similar, supported: ruInh });
  }

  if (!attempts().length) {
    return res.status(500).json({ error: "Этого нет в базе, а ключа ИИ нет. Добавьте GEMINI_API_KEY: на хостинге — в настройках (и пересоберите сайт), на своём компьютере — в файле .env (и перезапустите server.js)." });
  }

  // --- сравнить все ИИ ---
  if (action === "compare") {
    const results = await askAll(prompts((tier) => textPrompt(input, source, target, examples, tier, corpus)), budget);
    for (const r of results) {
      if (r.text) {
        r.text = fixT(readTranslation(r.text).translation || r.text);
        if (target === "inh") Object.assign(r, checkIngush(r.text));
      }
    }
    return res.status(200).json({ results, saved: saved || null, examples: examples.length });
  }

  // --- второй проход: заменить слова, которых нет в ингушских текстах; остаётся лучший вариант ---
  if (action === "repair") {
    const draft = fixT(String(body.draft || "")).trim();
    if (target !== "inh" || !draft || draft.length > MAX_CHARS * 2) return res.status(400).json({ error: "Нечего исправлять" });
    const before = suspects(draft, input);
    if (!before.length) return res.status(200).json({ translation: draft, improved: false, ...checkIngush(draft) });
    const textKey = `${source}|${target}|t|${input}`;
    const remember = (extra) => { const old = CACHE.get(textKey); if (old && old.translation === draft) cacheSet(textKey, { ...old, ...extra, repaired: true }); };
    try {
      const { text: out, by } = await ask(prompts((tier) => repairPrompt(input, source, target, draft, before, examples, tier, corpus)), false, budget);
      const fixed = BASE.chechenFix(fixT(out)).text.trim();
      const after = suspects(fixed, input);
      const sane = fixed.length >= draft.length * 0.5 && fixed.length <= draft.length * 2 + 20;
      const improved = sane && after.length < before.length; // лучше — значит меньше слов, которых нет в ингушских текстах
      const translation = improved ? fixed : draft;
      const result = { translation, improved, model: by, ai: true, before: before.length, after: improved ? after.length : before.length, ...checkIngush(translation) };
      if (hurried) result.fast = true;
      remember(improved ? { translation, unknown: result.unknown, coverage: result.coverage, suspect: after } : {});
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
      Object.assign(result, checkIngush(result.translation));
      if (mode !== "word") result.suspect = suspects(result.translation, input); // для второго прохода
    }
    if (mode !== "word") { result.words = words; result.similar = similar; }
    if (distill && isRuInh(source, target)) await maybeDistill(input, source, result, distill);
    cacheSet(cacheKey, result);
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 401 ? 502 : 503;
    return res.status(status).json({ error: e.message, detail: e.detail });
  }
};

// для тестов
module.exports._checkIngush = checkIngush;
module.exports._setStore = (s) => { storeOverride = s; PHRASES = null; PHRASES_AT = 0; REVIEW = null; REVIEW_AT = 0; VERIFIED = []; };
module.exports._attempts = attempts;
module.exports._resetBroke = () => { for (const k of Object.keys(BROKE_AT)) delete BROKE_AT[k]; };
module.exports._prompts = { textPrompt, wordPrompt, repairPrompt, readTranslation, systemPrompt };
module.exports._RET = RET;
