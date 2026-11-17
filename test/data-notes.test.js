// Пометки вне ингушского текста (scripts/build-phrases.js, шаг 5). Без ключей и без интернета.
//   node test/data-notes.test.js
const assert = require("assert");
const SEED = require("../data/phrases.json");
const NOTE = /\((говорит (мужчина|женщина)|к (мужчине|женщине|нескольким)[^()]*|объект (мужчина|женщина)|[вйдби](\s*,\s*[вйдби])*)\)/i;
// 1. в ингушском тексте открытых источников и PaydaDosh таких пометок больше нет
const left = SEED.filter((p) => p.license && NOTE.test(p.inh));
assert.strictEqual(left.length, 0, "пометки в тексте: " + left.slice(0, 3).map((p) => p.inh).join(" | "));
// 2. пометка теперь в note; раздел PaydaDosh — в section, а не в note
const moved = SEED.filter((p) => /^говорит (мужчина|женщина)$/.test(p.note || ""));
assert.ok(moved.length >= 20, "пометок «говорит …» в note: " + moved.length);
assert.ok(!SEED.some((p) => /^PaydaDosh,/.test(p.note || "")), "раздел PaydaDosh остался в note");
assert.ok(SEED.filter((p) => p.section).length > 5000, "у фраз PaydaDosh есть section");
// 3. варианты слов в скобках (ингушский текст) не тронуты
assert.ok(SEED.some((p) => /\(шун\)/.test(p.inh)), "вариант «(шун)» должен остаться в тексте");
console.log("ok: пометок вне текста", moved.length, "· с разделом PaydaDosh", SEED.filter((p) => p.section).length);

// 4. сайт показывает пометку подписью варианта
const T = require("../api/translate.js");
T._setStore({ get: async () => null, setJSON: async () => {} });
require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", body }, res);
});
(async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;
  const r = await run({ text: "Я иду домой", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.ok(r.data.variants && r.data.variants.length >= 2, JSON.stringify(r.data));
  for (const v of r.data.variants) assert.ok(!/\(/.test(v.text), "в тексте варианта нет скобок: " + v.text);
  assert.ok(r.data.variants.some((v) => v.note === "говорит мужчина") && r.data.variants.some((v) => v.note === "говорит женщина"));
  console.log("ok: «Я иду домой» →", r.data.variants.map((v) => `${v.text} (${v.note})`).join(" | "));
})().catch((e) => { console.error(e); process.exit(1); });
