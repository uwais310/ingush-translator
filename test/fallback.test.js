// Запасные ИИ: мёртвая модель (404) пропускается, GPT-OSS на Groq думает мало, понятное сообщение, когда ИИ нет.
//   node test/fallback.test.js
const assert = require("assert");
const calls = [];
let reply = () => ({ status: 500, body: {} });
global.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (String(url).includes("raw.githubusercontent.com")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  const r = reply(String(url), body);
  return { ok: r.status === 200, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
};
const T = require("../api/translate.js");
const CORPUS = require("../lib/corpus.js");
const mem = () => { const m = {}; return { get: async (k) => m[k] || null, setJSON: async (k, v) => { m[k] = v; } }; };
T._setStore(mem());
CORPUS._set({ store: mem(), fetch: global.fetch });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", body }, res);
});
const ok = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } });

(async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.XAI_API_KEY;
  process.env.GROQ_API_KEY = "test";
  T._resetBroke();
  const groq = T._attempts().map((a) => a[1]);
  assert.ok(!groq.some((m) => /kimi|qwen3-32b/.test(m)), "старых моделей нет: " + groq);
  assert.strictEqual(groq[0], "openai/gpt-oss-120b");

  // 1. первая модель Groq «не существует» — отвечает следующая; GPT-OSS просят думать мало
  reply = (url, b) => (b && b.model === "openai/gpt-oss-120b" ? { status: 404, body: { error: { message: "The model does not exist" } } }
    : ok('{"translation":"Дика ди хийла хьа","confidence":"medium","unknown_words":[]}'));
  calls.length = 0;
  let r = await run({ text: "Пусть у тебя будет хороший день сегодня", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  const first = calls.find((c) => c.body && c.body.model === "openai/gpt-oss-120b");
  assert.strictEqual(first.body.reasoning_effort, "low");
  assert.ok(/qwen3\.8/.test(r.data.model), r.data.model);
  // 2. второй перевод: мёртвую модель уже не спрашивают
  calls.length = 0;
  r = await run({ text: "Завтра я поеду к другу в соседнее село", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(!calls.some((c) => c.body && c.body.model === "openai/gpt-oss-120b"), "404-модель пропущена");
  console.log("ok 1: модель без 404 пропускается, GPT-OSS с reasoning_effort=low:", r.data.model);

  // 3. все модели «нет денег / нет модели» — понятное сообщение, без долгого ожидания
  reply = () => ({ status: 404, body: { error: { message: "model not found" } } });
  const t0 = Date.now();
  r = await run({ text: "Мой старший брат работает учителем в школе", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 503, JSON.stringify(r.data));
  assert.ok(/недоступны/.test(r.data.error), r.data.error);
  assert.ok(Date.now() - t0 < 3000, "быстро");
  console.log("ok 2: когда ИИ нет совсем —", r.data.error);
  console.log("все проверки пройдены");
})().catch((e) => { console.error(e); process.exit(1); });
