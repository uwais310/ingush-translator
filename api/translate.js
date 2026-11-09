// Серверная функция перевода (Vercel: api/translate.js, Netlify: netlify/functions/translate.js).
//
// 1. Фразы, исправленные носителями языка (кнопка «Исправить» на сайте), хранятся в Netlify Blobs.
//    Если фраза уже есть в этом разговорнике — отдаём сохранённый перевод.
//    Похожие исправленные фразы добавляются в промпт как примеры, поэтому ИИ учится на них.
// 2. Иначе один и тот же промпт уходит по цепочке ИИ: сначала сильные модели, потом запасные.
//
// Ключи (переменные окружения хостинга), хватит одного:
//   GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY (платный)
// Необязательно: EDITOR_CODE — если задан, сохранять исправления можно только с этим кодом.

const WORDS_RAW = require("../lib/ingush-words.js");

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
const DEADLINE_MS = 9000; // хостинги обрывают функцию примерно через 10 секунд

// ---------------- промпты (одни и те же для всех ИИ) ----------------

const INGUSH_RULES = `Ingush rules:
- Ingush (ГӀалгӀай мотт) is the Nakh language of the Ingush people. It is close to Chechen but different: use Ingush words, grammar and spelling, never Chechen forms.
- Prefer the most common everyday Ingush words, as used in modern Ingush books and the newspaper «Сердало».
- Write Ingush in Cyrillic. Always write the palochka as the letter Ӏ (U+04C0), as in гӀ, кӀ, пӀ, тӀ, хӀ, цӀ, чӀ and standalone Ӏ. Never write it as 1, I, l or |.
- In Ingush input, 1, I, l or | next to letters stand for Ӏ.`;

const rulesFor = (src, tgt) => (src === "inh" || tgt === "inh" ? INGUSH_RULES + "\n\n" : "");

function examplesBlock(examples) {
  if (!examples.length) return "";
  const lines = examples.map((e) => `${LANGS[e.source]}: ${e.text}\n${LANGS[e.target]}: ${e.translation}`);
  return `Translations checked by native speakers. They are correct: reuse their words, spelling and style, and prefer them over your own guesses.\n\n${lines.join("\n\n")}\n\n`;
}

function textPrompt(text, src, tgt, examples = []) {
  const S = LANGS[src], T = LANGS[tgt];
  return `You are a professional translator. Translate the text inside <text> from ${S} into ${T}.

${rulesFor(src, tgt)}${examplesBlock(examples)}Output rules:
- Output only the translation, with no quotes, notes, labels, transliteration or explanations.
- Keep the line breaks, punctuation, numbers and proper names.
- Keep the meaning and tone, and use natural everyday ${T}.
- If the text is already in ${T}, output it unchanged.

<text>
${text}
</text>`;
}

function wordPrompt(text, src, tgt, examples = []) {
  const S = LANGS[src], T = LANGS[tgt];
  return `You are a bilingual dictionary. Translate the word or short phrase inside <text> from ${S} into ${T}.

${rulesFor(src, tgt)}${examplesBlock(examples)}Reply with JSON only, in exactly this shape:
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

async function callGemini(model, prompt, json, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (json) body.generationConfig = { responseMimeType: "application/json" };
  const data = await postJson(url, { "x-goog-api-key": process.env.GEMINI_API_KEY }, body, timeoutMs);
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

const PROVIDERS = {
  gemini: { label: "Gemini", keyEnv: "GEMINI_API_KEY", call: callGemini },
  groq: { label: "Groq", keyEnv: "GROQ_API_KEY", call: openAiCompatible("https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY") },
  openrouter: {
    label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY",
    call: openAiCompatible("https://openrouter.ai/api/v1/chat/completions", "OPENROUTER_API_KEY", { "X-Title": "Ingush Translator" }),
  },
  grok: { label: "Grok", keyEnv: "XAI_API_KEY", call: openAiCompatible("https://api.x.ai/v1/chat/completions", "XAI_API_KEY") },
};

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
async function ask(prompt, json = false) {
  const started = Date.now();
  const deadKeys = new Set();
  let last = null, sawLimit = false;
  for (const [p, model] of attempts()) {
    if (deadKeys.has(p)) continue;
    const left = DEADLINE_MS - (Date.now() - started);
    if (left < 1200) break;
    try {
      const text = cleanOutput(await PROVIDERS[p].call(model, prompt, json, Math.min(left - 200, 6500)));
      if (!text) throw httpError(503, "Empty answer");
      return { text, by: `${PROVIDERS[p].label} · ${model}` };
    } catch (e) {
      last = e;
      if (e.status === 429) sawLimit = true;
      console.error(`${p} ${model}:`, e.status, e.message);
      if (isBadKey(e)) { deadKeys.add(p); e.badKey = PROVIDERS[p].keyEnv; }
    }
  }
  if (last && last.badKey && attempts().every(([p]) => deadKeys.has(p))) throw httpError(401, `Check ${last.badKey}. ${last.message}`);
  throw httpError(sawLimit ? 429 : 503, "Все переводчики сейчас заняты. Попробуйте через минуту.");
}

// Одна лучшая модель от каждого сервиса, параллельно — для кнопки «Сравнить».
async function askAll(prompt) {
  const seen = new Set();
  const firsts = attempts().filter(([p]) => (seen.has(p) ? false : seen.add(p)));
  return Promise.all(firsts.map(async ([p, model]) => {
    const by = `${PROVIDERS[p].label} · ${model}`;
    try {
      const text = cleanOutput(await PROVIDERS[p].call(model, prompt, false, DEADLINE_MS - 500));
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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { text = "", source, target, mode, action } = body || {};
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

  // --- готовый перевод из разговорника ---
  const saved = exactMatch(phrases, input, source, target);
  if (saved && action !== "compare") {
    const result = { translation: saved, model: "Проверено носителем языка", verified: true };
    if (target === "inh") Object.assign(result, checkIngush(saved));
    return res.status(200).json(result);
  }

  if (!attempts().length) {
    return res.status(500).json({ error: "No API key: add GEMINI_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY) in the hosting settings, then redeploy" });
  }

  const examples = pickExamples(phrases, input, source, target);

  // --- сравнить все ИИ ---
  if (action === "compare") {
    const results = await askAll(textPrompt(input, source, target, examples));
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
    if (mode === "word") {
      const { text: raw, by } = await ask(wordPrompt(input, source, target, examples), true);
      const v = parseJson(raw);
      if (v && typeof v.translation === "string" && v.translation.trim()) {
        result = { translation: fixT(v.translation.trim()), details: v, model: by };
      }
    }
    if (!result) {
      const { text: out, by } = await ask(textPrompt(input, source, target, examples));
      result = { translation: fixT(out), model: by };
    }
    result.examples = examples.length;
    if (target === "inh") Object.assign(result, checkIngush(result.translation));
    cacheSet(cacheKey, result);
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 401 ? 502 : 503;
    return res.status(status).json({ error: e.message });
  }
};

// для тестов
module.exports._checkIngush = checkIngush;
module.exports._setStore = (s) => { storeOverride = s; PHRASES = null; PHRASES_AT = 0; };
module.exports._attempts = attempts;
