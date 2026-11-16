// Варианты перевода (до 3) с источником и галочкой у самого надёжного. Без ключей и без интернета.
//   node test/variants.test.js
const assert = require("assert");
const calls = [];
let reply = () => ({ status: 500, body: {} });
global.fetch = async (url, init = {}) => {
  calls.push(String(url));
  if (String(url).includes("raw.githubusercontent.com")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  const r = reply(String(url), init.body ? JSON.parse(init.body) : null);
  return { ok: r.status === 200, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
};
const T = require("../api/translate.js");
const mem = () => { const m = {}; return { get: async (k) => m[k] || null, setJSON: async (k, v) => { m[k] = v; }, _m: m }; };
const store = mem();
T._setStore(store);
require("../lib/corpus.js")._set({ store: mem(), fetch: global.fetch });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", body }, res);
});
const shape = (vs) => {
  assert.ok(Array.isArray(vs) && vs.length >= 1 && vs.length <= 3, "1–3 варианта: " + JSON.stringify(vs));
  assert.strictEqual(vs.filter((v) => v.best).length, 1, "ровно одна галочка");
  assert.strictEqual(vs[0].best, true, "галочка у первого");
  for (const v of vs) {
    for (const k of ["text", "note", "source", "sourceLabel", "rank", "best"]) assert.ok(k in v, `нет поля ${k}`);
    assert.ok(v.text && v.sourceLabel);
  }
  for (let i = 1; i < vs.length; i++) assert.ok(vs[i - 1].rank <= vs[i].rank, "по надёжности");
  assert.strictEqual(new Set(vs.map((v) => v.text.toLowerCase())).size, vs.length, "без повторов");
};

(async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;

  // 1. «Как дела?» — из словаря проекта, пометки «мужчине / женщине» сохранились, старые поля на месте
  let r = await run({ text: "Как дела?", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200);
  shape(r.data.variants);
  assert.strictEqual(r.data.translation, "Фу деш ва хьо?");
  assert.ok(r.data.details && r.data.details.alternatives.length, "старые details.alternatives на месте");
  assert.deepStrictEqual(r.data.variants.map((v) => v.note).slice(0, 2), ["мужчине", "женщине"]);
  assert.strictEqual(r.data.variants[0].sourceLabel, "Словарь проекта");
  assert.strictEqual(r.data.variants[0].rank, 2);
  console.log("ok 1: «Как дела?» →", r.data.variants.map((v) => `${v.best ? "✓ " : ""}${v.text} (${v.note}) [${v.sourceLabel}]`).join(" | "));

  // 2. слово из словарей PaydaDosh и PanLex (не из словаря проекта): без ИИ, PaydaDosh надёжнее — первым
  r = await run({ text: "бурый", source: "ru", target: "inh", mode: "word" });
  shape(r.data.variants);
  assert.ok(r.data.variants.every((v) => v.rank === 3 && ["paydadosh", "open"].includes(v.source)), JSON.stringify(r.data.variants));
  assert.strictEqual(r.data.variants[0].sourceLabel, "Словарь PaydaDosh");
  assert.ok(r.data.variants.some((v) => v.sourceLabel === "Открытый словарь: PanLex"), "PanLex тоже показан");
  assert.ok(r.data.variants.length >= 2, "другие пары базы тоже показаны");
  console.log("ok 2: «бурый» →", r.data.variants.map((v) => v.text).join(", "));

  // 3. словарь проекта важнее открытого словаря
  r = await run({ text: "дом", source: "ru", target: "inh", mode: "word" });
  shape(r.data.variants);
  assert.strictEqual(r.data.variants[0].source, "project");
  assert.ok(r.data.variants.some((v) => v.source === "open" || v.source === "paydadosh"), "другой словарь тоже в списке");
  console.log("ok 3: «дом» →", r.data.variants.map((v) => `${v.text} [${v.sourceLabel}]`).join(" | "));

  // 4. проверенное носителем — первое (исправление с сайта)
  store._m.all = [{ source: "ru", target: "inh", text: "бурый", translation: "бора", at: "2026-11-16T00:00:00Z" }];
  T._setStore(store);
  r = await run({ text: "бурый", source: "ru", target: "inh", mode: "word" });
  shape(r.data.variants);
  assert.strictEqual(r.data.variants[0].text, "бора");
  assert.strictEqual(r.data.variants[0].sourceLabel, "Проверено носителем");
  assert.strictEqual(r.data.variants[0].rank, 1);
  console.log("ok 4: проверенное носителем — с галочкой:", r.data.variants.map((v) => `${v.best ? "✓ " : ""}${v.text} [${v.sourceLabel}]`).join(" | "));
  store._m.all = []; T._setStore(store);

  // 5. ИИ: один вызов, один вариант с меткой уверенности; лишних запросов ради 3 вариантов нет
  process.env.GEMINI_API_KEY = "test";
  T._resetBroke();
  reply = (url) => url.includes("generativelanguage")
    ? { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ translation: "Со хьалха вода", confidence: "low", unknown_words: [] }) }] } }] } }
    : { status: 404, body: {} };
  calls.length = 0;
  r = await run({ text: "Я иду вперёд сегодня утром", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  const aiCalls = calls.filter((u) => u.includes("generativelanguage")).length;
  assert.strictEqual(aiCalls, 1, "ровно один запрос к ИИ");
  shape(r.data.variants);
  assert.strictEqual(r.data.variants.length, 1);
  assert.deepStrictEqual([r.data.variants[0].source, r.data.variants[0].sourceLabel, r.data.variants[0].rank], ["ai", "ИИ, не уверен", 7]);
  console.log("ok 5: ИИ (low) →", JSON.stringify(r.data.variants[0]), "· запросов к ИИ:", aiCalls);

  // 6. сортировка и склейка дублей
  const { finishVariants, aiVariant } = T._variants;
  const vs = finishVariants([aiVariant("а", "high"), { text: "б", source: "open", sourceLabel: "Открытый словарь: PanLex", rank: 3 },
    aiVariant("в", "medium"), { text: "А", source: "native", sourceLabel: "Проверено носителем", rank: 1 }, aiVariant("г", "low")]);
  assert.deepStrictEqual(vs.map((v) => [v.text, v.rank, v.best]), [["а", 1, true], ["б", 3, false], ["в", 6, false]]);
  console.log("ok 6: порядок надёжности и склейка одинаковых текстов");

  // 7. страница: код вариантов есть и скрипт без синтаксических ошибок
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.includes('id="variants"') && html.includes("function renderVariants") && html.includes("Самый надёжный"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  new Function(scripts); // бросит SyntaxError, если скрипт сломан
  console.log("ok 7: index.html — блок вариантов на месте, скрипт разбирается");
  console.log("\nВсе проверки вариантов прошли.");
})().catch((e) => { console.error(e); process.exit(1); });
