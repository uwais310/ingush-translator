// Серверная функция перевода (Vercel: api/translate.js, Netlify: netlify/functions/translate.js).
//
// 1. Фразы, исправленные носителями языка (кнопка «Исправить» на сайте), хранятся в Netlify Blobs.
//    Если фраза уже есть в этом разговорнике — отдаём сохранённый перевод.
//    Похожие исправленные фразы добавляются в промпт как примеры, поэтому ИИ учится на них.
// 2. Потом — база без ИИ (lib/base.js): проверенные фразы, словарь, слова и целые предложения
//    из настоящих текстов. Такой ответ помечается «Из базы». С noAi: true ИИ не вызывается совсем.
// 3. Иначе промпт уходит по цепочке ИИ: сначала сильные модели, потом запасные.
//    В промпте — справочник по ингушскому (lib/ingush-guide.js): правила, отличия от чеченского,
//    словарик частых слов и проверенные фразы. Gemini и Grok получают его целиком,
//    Groq и OpenRouter — коротко и только нужные слова (у них маленький лимит токенов).
//
// Ключи (переменные окружения хостинга), хватит одного:
//   GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY (платный)
// Необязательно: EDITOR_CODE — если задан, сохранять исправления можно только с этим кодом.
//   TIME_LIMIT_SECONDS — сколько секунд хостинг даёт функции (обычно определяется само).

const WORDS_RAW = require("../lib/ingush-words.js");
const KB = require("../lib/ingush-guide.js");
const CORPUS = require("../lib/corpus.js");
const LEX = require("../lib/corpus-lexicon.js");
const BASE = require("../lib/base.js")(KB, LEX);
const SEED = require("../data/phrases.json"); // база пар; verified ставит только человек на /review

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

const INGUSH_RULES = `Ingush rules:
- Ingush (ГӀалгӀай мотт) is the Nakh language of the Ingush people. It is close to Chechen but different: use Ingush words, grammar and spelling, never Chechen forms.
- Prefer the most common everyday Ingush words, as used in modern Ingush books and the newspaper «Сердало».
- Write Ingush in Cyrillic. Always write the palochka as the letter Ӏ (U+04C0), as in гӀ, кӀ, пӀ, тӀ, хӀ, цӀ, чӀ and standalone Ӏ. Never write it as 1, I, l or |.
- In Ingush input, 1, I, l or | next to letters stand for Ӏ.`;

const hasIngush = (src, tgt) => src === "inh" || tgt === "inh";

// Правила + справочник. tier: "full" (весь справочник) или "compact" (кратко, только нужные слова).
function rulesFor(text, src, tgt, tier) {
  if (!hasIngush(src, tgt)) return "";
  // слова ищем по исходному тексту: он на русском или на ингушском
  const lookup = src === "inh" ? "inh" : "ru";
  return INGUSH_RULES + "\n\n" + KB.knowledgeBlock(text, lookup, tier);
}

function examplesBlock(examples) {
  if (!examples.length) return "";
  const lines = examples.map((e) => `${LANGS[e.source]}: ${e.text}\n${LANGS[e.target]}: ${e.translation}`);
  return `<native_speaker_corrections>\nTranslations checked by native speakers. They are correct: reuse their words, spelling and style, and prefer them over everything else.\n\n${lines.join("\n\n")}\n</native_speaker_corrections>\n\n`;
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
  const list = tier === "full" ? pairs.slice(0, 15) : pairs.slice(0, 8).sort((a, b) => a[0].length - b[0].length).slice(0, 4);
  const lines = list.map(([inh, ru]) => (src === "inh" ? `Ingush: ${inh}\nRussian: ${ru}` : `Russian: ${ru}\nIngush: ${inh}`));
  return `<corpus_examples>\nReal sentence pairs from Ingush books, the Ingush newspaper «Сердало» and Wikipedia that share words with the text. They show how these words are really used in Ingush (the translations can be loose; do not copy names or facts from them).\n\n${lines.join("\n\n")}\n</corpus_examples>\n\n`;
}

function ingushChecks(src, tgt) {
  if (tgt === "inh") {
    return `- Write real Ingush: take words from the glossary, the corpus word statistics, the verified phrases, the corpus examples and the corrections; never use the Chechen forms listed in the reference.
- Make every class mark agree (в for a man, й for a woman, б for many people, д for тхо, вай, шо); use the ergative for the doer of a transitive verb and the dative with хов, хац, лов, деза, хет, гу.
- Do not invent words and do not leave Russian words inside Ingush sentences.
- Before answering, check your draft word by word against the reference, the glossary and the examples: replace Chechen forms, fix class marks and case endings. Output only the corrected final version.\n`;
  }
  if (src === "inh") {
    return `- The Ingush text may use dialect forms, typos or Latin/Chechen spellings: use the reference and the glossary to understand it, and translate the meaning.\n`;
  }
  return "";
}

function textPrompt(text, src, tgt, examples = [], tier = "full", corpus = []) {
  const S = LANGS[src], T = LANGS[tgt];
  return `You are a professional translator${hasIngush(src, tgt) ? " and a native speaker of Ingush" : ""}. Translate the text inside <text> from ${S} into ${T}.

${rulesFor(text, src, tgt, tier)}${lexiconBlock(text, src, tgt, tier)}${corpusBlock(corpus, src, tier)}${examplesBlock(examples)}Output rules:
- Output only the translation, with no quotes, notes, labels, transliteration or explanations.
- Keep the line breaks, punctuation, numbers and proper names.
- Keep the meaning and tone, and use natural everyday ${T}.
${ingushChecks(src, tgt)}- If the text is already in ${T}, output it unchanged.

<text>
${text}
</text>`;
}

function wordPrompt(text, src, tgt, examples = [], tier = "full", corpus = []) {
  const S = LANGS[src], T = LANGS[tgt];
  return `You are a bilingual dictionary${hasIngush(src, tgt) ? " made by native speakers of Ingush" : ""}. Translate the word or short phrase inside <text> from ${S} into ${T}.

${rulesFor(text, src, tgt, tier)}${lexiconBlock(text, src, tgt, tier)}${corpusBlock(corpus, src, tier)}${examplesBlock(examples)}${ingushChecks(src, tgt)}Reply with JSON only, in exactly this shape:
{"translation": "best ${T} translation",
 "alternatives": [{"text": "another ${T} translation", "meaning": "short gloss in Russian of how it differs"}],
 "part_of_speech": "noun | verb | adjective | adverb | phrase | other",
 "example": {"source": "a short everyday sentence in ${S} using it", "target": "that sentence in ${T}"},
 "note": "one short usage note in Russian, or an empty string",
 "confidence": "high | medium | low"}
Give 0 to 3 alternatives. Set confidence to low if you are not sure the ${T} words are correct.

<text>
${text}
</text>`;
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

function checkIngush(text) {
  const found = String(text).match(/[Ѐ-ӿ]+(?:-[Ѐ-ӿ]+)*/g) || [];
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

// Когда времени мало, просим Gemini думать недолго (у моделей 2.5 и 3 это задаётся по-разному).
function geminiThinking(model) {
  if (/lite/i.test(model)) return null;
  if (/gemini-2\.5/i.test(model)) return { thinkingBudget: 512 };
  return { thinkingLevel: "low" };
}

async function callGemini(model, prompt, json, timeoutMs, opts = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const started = Date.now();
  const gen = {};
  if (json) gen.responseMimeType = "application/json";
  const thinking = opts.fast ? geminiThinking(model) : null;
  if (thinking) gen.thinkingConfig = thinking;
  const send = (g, ms) => postJson(
    url, { "x-goog-api-key": process.env.GEMINI_API_KEY },
    { contents: [{ role: "user", parts: [{ text: prompt }] }], ...(Object.keys(g).length ? { generationConfig: g } : {}) },
    ms
  );
  let data;
  try {
    data = await send(gen, timeoutMs);
  } catch (e) {
    // модель не поддерживает такую настройку — повторяем без неё
    if (!thinking || e.status !== 400 || !/think/i.test(e.message)) throw e;
    const left = timeoutMs - (Date.now() - started);
    if (left < 1500) throw e;
    delete gen.thinkingConfig;
    data = await send(gen, left);
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

const openAiCompatible = (url, keyEnv, extraHeaders = {}) => async (model, prompt, json, timeoutMs) => {
  const data = await postJson(
    url,
    { Authorization: `Bearer ${process.env[keyEnv]}`, ...extraHeaders },
    { model, messages: [{ role: "user", content: prompt }], temperature: 0 },
    timeoutMs
  );
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return (msg && msg.content) || "";
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

// Сколько миллисекунд у нас есть на ответ.
function timeBudget(req) {
  const env = Number(process.env.TIME_LIMIT_SECONDS) * 1000;
  if (env > 0) return Math.max(4000, env - 1000);
  const left = Number(req && req.deadlineMs);
  if (left > 0) return Math.max(4000, Math.min(left - 1500, 26000));
  return DEADLINE_MS;
}

// Промпт под нужный размер, каждый собирается один раз.
function prompts(build) {
  const memo = {};
  return (tier) => memo[tier] || (memo[tier] = build(tier));
}

// Порядок по умолчанию: сначала сильные модели, слабые — в самом конце.
const DEFAULT_SEQUENCE = [
  ["gemini", "gemini-flash-latest"],
  ["gemini", "gemini-2.5-flash"],
  ["grok", "grok-4"],
  ["groq", "moonshotai/kimi-k2-instruct-0905"],
  ["groq", "moonshotai/kimi-k2-instruct"],
  ["openrouter", "moonshotai/kimi-k2:free"],
  ["openrouter", "openrouter/free"],
  ["gemini", "gemini-flash-lite-latest"],
  ["groq", "qwen/qwen3-32b"],
];
const MODEL_ENV = { gemini: "GEMINI_MODELS", groq: "GROQ_MODELS", openrouter: "OPENROUTER_MODELS", grok: "XAI_MODELS" };

const hasKey = (p) => PROVIDERS[p] && process.env[PROVIDERS[p].keyEnv];

function attempts() {
  const order = envList("PROVIDER_ORDER");
  let seq = DEFAULT_SEQUENCE.slice();
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
  return e.status === 401 || e.status === 403 || /api key|unauthori[sz]ed|invalid.*key/i.test(e.message);
}

// Пробует модели по очереди, пока одна не ответит. Возвращает { text, by }.
// prompt(tier) возвращает промпт нужного размера.
async function ask(prompt, json = false, budget = DEADLINE_MS) {
  const started = Date.now();
  const fast = budget < LONG_BUDGET_MS;
  // одной модели — не всё время, чтобы успели запасные; на своём компьютере времени много, ждём дольше
  const cap = fast ? 6500 : Math.max(16000, Math.min(45000, Math.round(budget * 0.5)));
  const deadKeys = new Set();
  const slow = new Set(); // сервис не успел ответить — сначала пробуем другие сервисы
  let last = null, sawLimit = false;
  const queue = attempts();
  const later = [];
  while (queue.length || later.length) {
    const [p, model] = queue.length ? queue.shift() : later.shift();
    if (deadKeys.has(p)) continue;
    if (slow.has(p) && queue.some(([q]) => !slow.has(q) && !deadKeys.has(q))) { later.push([p, model]); continue; }
    const left = budget - (Date.now() - started);
    if (left < 1200) break;
    try {
      const pr = PROVIDERS[p];
      const text = cleanOutput(await pr.call(model, prompt(pr.tier), json, Math.min(left - 200, cap), { fast }));
      if (!text) throw httpError(503, "Empty answer");
      return { text, by: `${pr.label} · ${model}` };
    } catch (e) {
      last = e;
      if (e.status === 429) sawLimit = true;
      if (e.status === 504) slow.add(p);
      console.error(`${p} ${model}:`, e.status, e.message);
      if (isBadKey(e)) { deadKeys.add(p); e.badKey = PROVIDERS[p].keyEnv; }
    }
  }
  if (last && last.badKey && attempts().every(([p]) => deadKeys.has(p))) throw httpError(401, `Check ${last.badKey}. ${last.message}`);
  throw httpError(sawLimit ? 429 : 503, "Все переводчики сейчас заняты. Попробуйте через минуту.");
}

// Одна лучшая модель от каждого сервиса, параллельно — для кнопки «Сравнить».
async function askAll(prompt, budget = DEADLINE_MS) {
  const seen = new Set();
  const firsts = attempts().filter(([p]) => (seen.has(p) ? false : seen.add(p)));
  const fast = budget < LONG_BUDGET_MS;
  return Promise.all(firsts.map(async ([p, model]) => {
    const pr = PROVIDERS[p];
    const by = `${pr.label} · ${model}`;
    try {
      const text = cleanOutput(await pr.call(model, prompt(pr.tier), false, budget - 500, { fast }));
      return text ? { by, text } : { by, error: "Пустой ответ" };
    } catch (e) {
      return { by, error: e.status === 429 ? "Лимит исчерпан" : e.status === 504 ? "Не успел ответить" : isBadKey(e) ? "Ключ не работает" : "Занят или недоступен" };
    }
  }));
}

// ---------------- кэш ----------------
const CACHE = new Map();
function cacheSet(k, v) {
  if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, v);
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

  const examples = pickExamples(pool, input, source, target);
  let budget = timeBudget(req);

  // примеры из корпуса: ждём его недолго, иначе переводим без них (загрузка продолжится)
  let corpus = [];
  if (hasIngush(source, target) && (source === "ru" || source === "inh")) {
    const t0 = Date.now();
    if (await CORPUS.ready(budget >= LONG_BUDGET_MS ? 4000 : 1500)) corpus = CORPUS.search(input, source === "inh" ? "inh" : "ru", 15);
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
        r.text = fixT(r.text);
        if (target === "inh") Object.assign(r, checkIngush(r.text));
      }
    }
    return res.status(200).json({ results, saved: saved || null, examples: examples.length });
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
    if (!result) {
      const left = budget - (Date.now() - started);
      const { text: out, by } = await ask(prompts((tier) => textPrompt(input, source, target, examples, tier, corpus)), false, left);
      result = { translation: fixT(out), model: by };
    }
    result.examples = examples.length;
    result.corpus = corpus.length;
    result.ai = true;
    if (target === "inh") {
      // чеченские формы, которых в ингушском нет, заменяем по таблице
      const f = BASE.chechenFix(result.translation);
      if (f.fixed.length) { result.translation = f.text; result.fixed = f.fixed; }
      Object.assign(result, checkIngush(result.translation));
    }
    if (mode !== "word") { result.words = words; result.similar = similar; }
    cacheSet(cacheKey, result);
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 401 ? 502 : 503;
    return res.status(status).json({ error: e.message });
  }
};

// для тестов
module.exports._checkIngush = checkIngush;
module.exports._setStore = (s) => { storeOverride = s; PHRASES = null; PHRASES_AT = 0; REVIEW = null; REVIEW_AT = 0; VERIFIED = []; };
module.exports._attempts = attempts;
