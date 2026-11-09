// Серверная функция Vercel: принимает текст, спрашивает ИИ, возвращает перевод.
// Работает на бесплатном ключе Google Gemini (GEMINI_API_KEY) или на ключе Grok (XAI_API_KEY).
// Ключ хранится на сервере, в браузер он не попадает.

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
const PROVIDER = process.env.GEMINI_API_KEY ? "gemini" : process.env.XAI_API_KEY ? "grok" : null;
const MODEL = PROVIDER === "gemini"
  ? (process.env.GEMINI_MODEL || "gemini-flash-latest")
  : (process.env.XAI_MODEL || "grok-4");

const INGUSH_RULES = `Ingush rules:
- Ingush (ГӀалгӀай мотт) is the Nakh language of the Ingush people. It is close to Chechen but different: use Ingush words, grammar and spelling, never Chechen forms.
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

// Палочка: 1, I, l, | рядом с кириллицей -> Ӏ
const LOOK = "1Il|ІіΙⅠǀ";
const PAL_RE = new RegExp(`([\\u0400-\\u04FF])([${LOOK}])|([${LOOK}])(?=[\\u0400-\\u04FF])`, "g");
const fixPalochka = (s) =>
  String(s || "").replace(/ӏ/g, "Ӏ").replace(PAL_RE, (m, a) => (a ? a + "Ӏ" : "Ӏ"));

const cleanOutput = (t) =>
  String(t || "").replace(/^\s*<text>\s*/i, "").replace(/\s*<\/text>\s*$/i, "").trim();

function parseJson(raw) {
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function callGrok(prompt) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && (data.error.message || data.error)) || data.message || `xAI error ${r.status}`;
    const e = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    e.status = r.status;
    throw e;
  }
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return String(content || "").trim();
}

async function callGemini(prompt, json) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (json) body.generationConfig = { responseMimeType: "application/json" };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((data.error && data.error.message) || `Gemini error ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || "").join("").trim();
}

const ask = (prompt, json = false) => (PROVIDER === "gemini" ? callGemini(prompt, json) : callGrok(prompt));

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  if (!PROVIDER) {
    return res.status(500).json({ error: "No API key: add GEMINI_API_KEY in the hosting settings (Environment variables), then redeploy" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { text = "", source, target, mode } = body || {};
  if (!LANGS[source] || !LANGS[target]) return res.status(400).json({ error: "Unknown language" });
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Empty text" });
  if (text.length > MAX_CHARS) return res.status(413).json({ error: `Max ${MAX_CHARS} characters` });

  const input = source === "inh" ? fixPalochka(text) : text;
  const fixT = (s) => (target === "inh" ? fixPalochka(s) : String(s || ""));

  try {
    if (mode === "word") {
      const v = parseJson(await ask(wordPrompt(input, source, target), true));
      if (v && typeof v.translation === "string" && v.translation.trim()) {
        return res.status(200).json({ translation: fixT(v.translation.trim()), details: v, model: MODEL });
      }
    }
    const out = fixT(cleanOutput(await ask(textPrompt(input, source, target))));
    return res.status(200).json({ translation: out, model: MODEL });
  } catch (e) {
    console.error("AI error:", e.status, e.message);
    const status = e.status === 429 ? 429 : 502;
    const keyName = PROVIDER === "gemini" ? "GEMINI_API_KEY" : "XAI_API_KEY";
    const modelName = PROVIDER === "gemini" ? "GEMINI_MODEL" : "XAI_MODEL";
    const hint = e.status === 401 || e.status === 403 || /api key/i.test(e.message) ? `Check ${keyName}. ` :
                 e.status === 404 || /model/i.test(e.message) ? `Check ${modelName} (now "${MODEL}"). ` : "";
    return res.status(status).json({ error: hint + e.message });
  }
};
