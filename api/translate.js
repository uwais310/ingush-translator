// Серверная функция перевода (Vercel: api/translate.js, Netlify: netlify/functions/translate.js).
//
// Один и тот же промпт отправляется по цепочке бесплатных ИИ: если первый занят или
// исчерпал лимит, перевод делает следующий. Ключи хранятся в настройках хостинга:
//   GEMINI_API_KEY      — Google AI Studio (бесплатно, без карты)
//   GROQ_API_KEY        — Groq: Kimi K2, Qwen3 (бесплатно, без карты)
//   OPENROUTER_API_KEY  — OpenRouter: бесплатные модели :free
//   XAI_API_KEY         — Grok (платно), необязательно
// Достаточно одного ключа; чем больше, тем реже «занято».
//
// Ингушский перевод проверяется по частотному словарю ингушских текстов (lib/ingush-words.js):
// слова, которых нет в ингушских книгах и газетах, сайт подчёркивает.

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

function textPrompt(text, src, tgt) {
  const S = LANGS[src], T = LANGS[tgt];
  return `You are a professional translator. Translate the text inside <text> from ${S} into ${T}.

${rulesFor(src, tgt)}Output rules:
- Output only the translation, with no quotes, notes, labels, transliteration or explanations.
- Keep the line breaks, punctuation, numbers and proper names.
- Keep the meaning and tone, and use natural everyday ${T}.
- If the text is already in ${T}, output it unchanged.

<text>
${text}
</text>`;
}

function wordPrompt(text, src, tgt) {
  const S = LANGS[src], T = LANGS[tgt];
  return `You are a bilingual dictionary. Translate the word or short phrase inside <text> from ${S} into ${T}.

${rulesFor(src, tgt)}Reply with JSON only, in exactly this shape:
{"translation": "best ${T} translation",
 "alternatives": [{"text": "another ${T} translation", "meaning": "short English gloss of how it differs"}],
 "part_of_speech": "noun | verb | adjective | adverb | phrase | other",
 "example": {"source": "a short everyday sentence in ${S} using it", "target": "that sentence in ${T}"},
 "note": "one short usage note in English, or an empty string",
 "confidence": "high | medium | low"}
Give 0 to 3 alternatives. Set confidence to low if you are not sure the ${T} words are correct.

<text>
${text}
</text>`;
}

// ---------------- текст ----------------

// Палочка: 1, I, l, | рядом с кириллицей -> Ӏ
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

// ---------------- проверка по словарю ----------------

let WORDS = null;
const words = () => (WORDS || (WORDS = new Set(WORDS_RAW.split("\n"))));

const wordKey = (w) =>
  fixPalochka(w.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC")).toLowerCase().replace(/Ӏ/g, "ӏ");

function checkIngush(text) {
  const tokens = String(text).match(/[Ѐ-ӿ]+(?:-[Ѐ-ӿ]+)*/g) || [];
  const set = words();
  const unknown = new Set();
  let checked = 0, known = 0;
  for (const t of tokens) {
    const k = wordKey(t);
    if (k.length < 2) continue;
    checked++;
    const ok = set.has(k) || (k.includes("-") && k.split("-").every((p) => p.length < 2 || set.has(p)));
    if (ok) known++; else unknown.add(t);
  }
  return { unknown: [...unknown], coverage: checked ? Math.round((known / checked) * 100) / 100 : 1 };
}

// ---------------- ИИ-провайдеры ----------------

const envList = (name, fallback) =>
  process.env[name] ? process.env[name].split(",").map((s) => s.trim()).filter(Boolean) : fallback;

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
  gemini: {
    label: "Gemini", keyEnv: "GEMINI_API_KEY", call: callGemini,
    models: () => envList("GEMINI_MODELS", [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"]),
  },
  groq: {
    label: "Groq", keyEnv: "GROQ_API_KEY",
    call: openAiCompatible("https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY"),
    models: () => envList("GROQ_MODELS", ["moonshotai/kimi-k2-instruct-0905", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b"]),
  },
  openrouter: {
    label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY",
    call: openAiCompatible("https://openrouter.ai/api/v1/chat/completions", "OPENROUTER_API_KEY", { "X-Title": "Ingush Translator" }),
    models: () => envList("OPENROUTER_MODELS", ["moonshotai/kimi-k2:free", "openrouter/free"]),
  },
  grok: {
    label: "Grok", keyEnv: "XAI_API_KEY",
    call: openAiCompatible("https://api.x.ai/v1/chat/completions", "XAI_API_KEY"),
    models: () => envList("XAI_MODELS", [process.env.XAI_MODEL || "grok-4"]),
  },
};
const ORDER = () => envList("PROVIDER_ORDER", ["gemini", "groq", "openrouter", "grok"]);
const configured = () => ORDER().filter((p) => PROVIDERS[p] && process.env[PROVIDERS[p].keyEnv]);

// Пробует модели по очереди, пока одна не ответит. Возвращает { text, by }.
async function ask(prompt, json = false) {
  const started = Date.now();
  let last = null, sawLimit = false;
  for (const name of configured()) {
    const prov = PROVIDERS[name];
    for (const model of [...new Set(prov.models())]) {
      const left = DEADLINE_MS - (Date.now() - started);
      if (left < 1200) break;
      try {
        const text = cleanOutput(await prov.call(model, prompt, json, Math.min(left - 200, 5500)));
        if (!text) throw httpError(503, "Empty answer");
        return { text, by: `${prov.label} · ${model}` };
      } catch (e) {
        last = e;
        if (e.status === 429) sawLimit = true;
        console.error(`${prov.label} ${model}:`, e.status, e.message);
        const badKey = e.status === 401 || e.status === 403 || /api key|unauthori[sz]ed|invalid.*key/i.test(e.message);
        if (badKey) { e.badKey = prov.keyEnv; break; } // ключ этого провайдера не работает — к следующему
      }
    }
  }
  if (last && last.badKey && configured().length === 1) throw httpError(401, `Check ${last.badKey}. ${last.message}`);
  throw httpError(sawLimit ? 429 : 503, "All translators are busy right now. Try again in a minute.");
}

// ---------------- кэш ----------------
// Одинаковый запрос получает одинаковый ответ, пока сервер «тёплый».
const CACHE = new Map();
const cacheGet = (k) => CACHE.get(k);
function cacheSet(k, v) {
  if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, v);
}

// ---------------- обработчик ----------------

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  if (!configured().length) {
    return res.status(500).json({ error: "No API key: add GEMINI_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY) in the hosting settings, then redeploy" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { text = "", source, target, mode } = body || {};
  if (!LANGS[source] || !LANGS[target]) return res.status(400).json({ error: "Unknown language" });
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Empty text" });
  if (text.length > MAX_CHARS) return res.status(413).json({ error: `Max ${MAX_CHARS} characters` });

  const input = (source === "inh" ? fixPalochka(text) : text).trim();
  const fixT = (s) => (target === "inh" ? fixPalochka(s) : String(s || ""));
  const cacheKey = `${source}|${target}|${mode === "word" ? "w" : "t"}|${input}`;
  const hit = cacheGet(cacheKey);
  if (hit) return res.status(200).json({ ...hit, cached: true });

  try {
    let result = null;
    if (mode === "word") {
      const { text: raw, by } = await ask(wordPrompt(input, source, target), true);
      const v = parseJson(raw);
      if (v && typeof v.translation === "string" && v.translation.trim()) {
        result = { translation: fixT(v.translation.trim()), details: v, model: by };
      }
    }
    if (!result) {
      const { text: out, by } = await ask(textPrompt(input, source, target));
      result = { translation: fixT(out), model: by };
    }
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
