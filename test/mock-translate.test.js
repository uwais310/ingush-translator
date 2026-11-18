// Проверка без ключей и без интернета: вместо настоящих ИИ — заглушка fetch.
//   node test/mock-translate.test.js
// Проверяет: какой ИИ вызывается первым, что уходит в запрос (system/user, temperature, схема JSON,
// думание Gemini), что ответ JSON разбирается, что [неизвестные] слова не идут на второй проход.
process.env.USE_AI = "1"; // эти проверки про ИИ: он выключен по умолчанию
const assert = require("assert");

const calls = [];
let reply = () => ({ status: 500, body: {} });
global.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body, headers: init.headers || {} });
  if (String(url).includes("raw.githubusercontent.com")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  const r = reply(String(url), body);
  return { ok: r.status === 200, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
};

const T = require("../api/translate.js");
const CORPUS = require("../lib/corpus.js");
const mem = () => { const m = {}; return { get: async (k) => m[k] || null, setJSON: async (k, v) => { m[k] = v; }, _m: m }; };
const store = mem();
T._setStore(store);
CORPUS._set({ store: mem(), fetch: global.fetch });

function run(body) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
    T({ method: "POST", body }, res);
  });
}
const geminiOk = (obj) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const orOk = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } });

(async () => {
  // ---------- 1. только Gemini (бесплатная версия) ----------
  process.env.GEMINI_API_KEY = "test";
  delete process.env.OPENROUTER_API_KEY;
  T._resetBroke();
  assert.deepStrictEqual(T._attempts().map((a) => a[1]).slice(0, 2), ["gemini-4-hydrogen", "gemini-3.8-flash"]);

  reply = (url) => (url.includes("generativelanguage") ? geminiOk({ translation: "Кхоана вай [поедем] даьнанай йолча", confidence: "medium", unknown_words: ["поедем"] }) : { status: 404, body: {} });
  calls.length = 0;
  let r = await run({ text: "Завтра мы с братом поедем к бабушке в горы", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  const g = calls.find((c) => c.url.includes("generativelanguage"));
  assert.ok(g.url.includes("gemini-4-hydrogen:generateContent"), g.url);
  assert.ok(g.body.systemInstruction.parts[0].text.includes("INGUSH REFERENCE"), "справочник в system");
  assert.ok(!g.body.contents[0].parts[0].text.includes("INGUSH REFERENCE"), "справочник не дублируется в user");
  assert.ok(g.body.contents[0].parts[0].text.includes("кхоана"), "в user — слова словаря для этого текста");
  assert.ok(!g.body.contents[0].parts[0].text.includes("пещера"), "в user нет всего словаря");
  assert.strictEqual(g.body.generationConfig.responseMimeType, "application/json");
  assert.strictEqual(g.body.generationConfig.responseSchema.required[0], "translation");
  assert.strictEqual(g.body.generationConfig.temperature, undefined, "Gemini 4 — без temperature");
  assert.deepStrictEqual(g.body.generationConfig.thinkingConfig, { thinkingLevel: "low" }, "на хостинге — думает мало");
  assert.strictEqual(r.data.translation, "Кхоана вай [поедем] даьнанай йолча");
  assert.strictEqual(r.data.confidence, "medium");
  assert.deepStrictEqual(r.data.aiUnknown, ["поедем"]);
  assert.ok(!(r.data.suspect || []).includes("поедем"), "слово в [скобках] не идёт на второй проход");
  console.log("ok 1: Gemini 4 Hydrogen, system+user, JSON-схема, без temperature; длина промпта:",
    g.body.systemInstruction.parts[0].text.length, "+", g.body.contents[0].parts[0].text.length, "знаков");

  // ---------- 2. Gemini 2.5 получает temperature, ответ не JSON тоже принимается ----------
  process.env.GEMINI_MODELS = "gemini-2.5-flash";
  process.env.AI_TEMPERATURE = "0.1";
  reply = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "Сона хьо веза" }] } }] } });
  calls.length = 0;
  r = await run({ text: "я тебя очень люблю, брат", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.strictEqual(calls.find((c) => c.url.includes("generativelanguage")).body.generationConfig.temperature, 0.1);
  assert.strictEqual(r.data.translation, "Сона хьо веза");
  console.log("ok 2: Gemini 2.5 — temperature 0.1; ответ без JSON принят как текст");
  delete process.env.GEMINI_MODELS;

  // ---------- 3. OpenRouter: Haiku 5.5 первым, кэш system, temperature, своя модель ----------
  process.env.OPENROUTER_API_KEY = "test";
  T._resetBroke();
  assert.deepStrictEqual(T._attempts()[0], ["openrouter", "anthropic/claude-haiku-5.5"]);
  process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-5.5";
  assert.deepStrictEqual(T._attempts()[0], ["openrouter", "anthropic/claude-sonnet-5.5"]);
  process.env.OPENROUTER_MODEL = "off";
  assert.ok(!T._attempts().some(([p, m]) => m.startsWith("anthropic/")), "off — без платной модели");
  delete process.env.OPENROUTER_MODEL;
  process.env.PROVIDER_ORDER = "gemini,openrouter";
  assert.strictEqual(T._attempts()[0][0], "gemini");
  delete process.env.PROVIDER_ORDER;

  reply = (url) => (url.includes("openrouter") ? orOk('```json\n{"translation":"Тахан ди дика да","confidence":"high","unknown_words":[]}\n```') : { status: 500, body: {} });
  calls.length = 0;
  r = await run({ text: "Сегодня хороший день, правда?", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  const o = calls.find((c) => c.url.includes("openrouter"));
  assert.strictEqual(o.body.model, "anthropic/claude-haiku-5.5");
  assert.strictEqual(o.body.messages[0].role, "system");
  assert.ok(Array.isArray(o.body.messages[0].content) && o.body.messages[0].content[0].cache_control, "system помечен для кэша");
  assert.strictEqual(o.body.temperature, 0.1);
  assert.strictEqual(r.data.translation, "Тахан ди дика да");
  assert.strictEqual(r.data.details.confidence, "high");
  console.log("ok 3: OpenRouter Haiku 5.5 первым, system с cache_control, temperature, JSON в ```json разобран");

  // ---------- 4. 402 (нет денег) → бесплатный Gemini ----------
  T._resetBroke();
  reply = (url) => (url.includes("openrouter") ? { status: 402, body: { error: { message: "Insufficient credits" } } } : geminiOk({ translation: "Моаршал хийла", confidence: "high", unknown_words: [] }));
  r = await run({ text: "Мир вам, друзья мои", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(/Gemini/.test(r.data.model), r.data.model);
  console.log("ok 4: без денег на OpenRouter переводит Gemini:", r.data.model);

  // ---------- 5. дистилляция (DISTILL_MODELS) ----------
  T._resetBroke();
  process.env.DISTILL_MODELS = "anthropic/claude-haiku-5.5";
  reply = (url) => (url.includes("openrouter") ? orOk('{"translation":"Сона баркал хьона","confidence":"high","unknown_words":[]}') : { status: 500, body: {} });
  r = await run({ text: "Спасибо тебе большое от меня", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(store._m.distilled) && store._m.distilled[0].inh === "Сона баркал хьона", "сохранено в distilled");
  calls.length = 0;
  reply = (url) => (url.includes("openrouter") ? orOk('{"translation":"Баркал","confidence":"high","unknown_words":[]}') : { status: 500, body: {} });
  r = await run({ text: "Спасибо тебе большое, мама", source: "ru", target: "inh", mode: "text" });
  const u = calls.find((c) => c.url.includes("openrouter")).body.messages[1].content;
  assert.ok(u.includes("Сона баркал хьона") && u.includes("stronger AI model"), "пример сильной модели попал в промпт");
  console.log("ok 5: дистилляция: перевод сохранён и стал примером для следующего запроса");
  delete process.env.DISTILL_MODELS;

  // ---------- 6. режим слова и «Сравнить» не сломаны ----------
  reply = (url) => (url.includes("openrouter") ? orOk('{"translation":"говр","alternatives":[],"part_of_speech":"noun","example":{"source":"","target":""},"note":"","confidence":"high"}') : { status: 500, body: {} });
  r = await run({ text: "лошадка", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.translation, "говр");
  reply = (url) => (url.includes("openrouter") ? orOk('{"translation":"Дика да","confidence":"high","unknown_words":[]}') : geminiOk({ translation: "Дика да", confidence: "high", unknown_words: [] }));
  r = await run({ text: "Это хорошо, брат", source: "ru", target: "inh", action: "compare" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(r.data.results.every((x) => !x.text || x.text === "Дика да"), JSON.stringify(r.data.results));
  console.log("ok 6: режим слова и «Сравнить ИИ» работают; в сравнении JSON превращён в текст");

  // ---------- 7. английский → ингушский: словарь целиком, как раньше ----------
  reply = (url) => (url.includes("openrouter") ? orOk('{"translation":"Моаршал","confidence":"low","unknown_words":[]}') : { status: 500, body: {} });
  calls.length = 0;
  r = await run({ text: "Hello my dear friend", source: "en", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(calls.find((c) => c.url.includes("openrouter")).body.messages[1].content.includes("пещера"), "для английского — весь словарик");
  console.log("ok 7: английский → ингушский получает весь словарик (как раньше)");

  // ---------- 8. модель ответила «лимит»: в следующий раз её спрашивают последней ----------
  T._resetBroke();
  delete process.env.OPENROUTER_API_KEY; delete process.env.GEMINI_MODELS;
  process.env.GEMINI_API_KEY = "test";
  const okFlash = geminiOk({ translation: "Дика да", confidence: "high", unknown_words: [] });
  reply = (url) => (url.includes("gemini-4-hydrogen") ? { status: 429, body: { error: { message: "Quota exceeded. Please retry in 35s." } } } : okFlash);
  calls.length = 0;
  r = await run({ text: "Сегодня очень тёплая погода на улице", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(calls.some((c) => c.url.includes("gemini-4-hydrogen")) && /3\.8/.test(r.data.model), r.data.model);
  assert.ok(T._cool.isCooling("gemini", "gemini-4-hydrogen"), "модель на паузе после лимита");
  calls.length = 0;
  r = await run({ text: "Завтра будет холодная погода в горах", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(!calls.some((c) => c.url.includes("gemini-4-hydrogen")), "модель на паузе не спрашивают, пока отвечают другие");
  T._resetBroke();
  console.log("ok 8: после ответа «лимит» модель пропускается, перевод идёт следующей моделью");

  // ---------- 9. test: true (scripts/check-ai.js): не из базы, и ИИ не видит эту фразу в примерах ----------
  T._resetBroke();
  reply = () => okFlash;
  calls.length = 0;
  r = await run({ text: "Я забыл его имя", source: "ru", target: "inh", mode: "text", test: true });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.ok(!r.data.base, "в тестовом режиме ответ не из базы");
  const sent = calls.filter((c) => c.url.includes("generativelanguage")).map((c) => JSON.stringify(c.body));
  assert.ok(sent.length >= 1, "ИИ вызван");
  assert.ok(sent.every((b) => !b.includes("йицъеннай")), "готового перевода этой фразы («Цун цӀи йицъеннай сона») в подсказках нет");
  calls.length = 0;
  r = await run({ action: "compare", text: "Сегодня очень тёплая погода", source: "ru", target: "inh", test: true });
  assert.ok(r.data.results.length >= 2 && r.data.results.every((x) => typeof x.ms === "number"), "в замере — все модели и время каждой");
  T._resetBroke();
  console.log("ok 9: тестовый режим для scripts/check-ai.js — без базы, без подсказки-ответа, все модели со временем");

  console.log("\nВсе проверки прошли (настоящие ИИ не вызывались).");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
