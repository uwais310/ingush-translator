// Проверка страницы /review (без ключей и без интернета): порядок очереди, «Верно/Исправить»,
// раздел «Переведите» и что перевод носителя сразу отдаётся как «Проверено носителем».
//   node test/review.test.js
const assert = require("assert");
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
const T = require("../api/translate.js");
const CORPUS = require("../lib/corpus.js");
const SEED = require("../data/phrases.json");
const mem = () => { const m = {}; return { get: async (k) => m[k] || null, setJSON: async (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); }, _m: m }; };
const store = mem();
T._setStore(store);
CORPUS._set({ store: mem(), fetch: global.fetch });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", body }, res);
});

(async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;
  process.env.EDITOR_CODE = "secret";

  // 0. без кода — отказ
  assert.strictEqual((await run({ action: "review-next", code: "nope" })).code, 403);
  assert.strictEqual((await run({ action: "ask-next", code: "nope" })).code, 403);

  // 1. очередь: каждая пара ровно один раз, сначала фразы, имена собственные — в конце
  const order = T._review.reviewOrder();
  assert.strictEqual(order.length, SEED.length);
  assert.strictEqual(new Set(order).size, SEED.length);
  const firstK = order.slice(0, 50).map((i) => SEED[i].kind);
  assert.ok(firstK.every((k) => k === "phrase"), "сначала фразы: " + firstK.join(","));
  assert.strictEqual(SEED[order[order.length - 1]].kind, "name", "имена — в конце");
  console.log("ok 1: очередь /review —", SEED.length, "пар, первые:", order.slice(0, 3).map((i) => `«${SEED[i].ru}»`).join(", "));

  // 2. review-next отдаёт источник и счётчик; «Верно» сохраняется по id пары (формат прежний)
  let r = await run({ action: "review-next", after: -1, code: "secret" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  const it = r.data.item;
  assert.ok(it.id && it.ru && it.inh && it.source && it.sourceLabel, JSON.stringify(it));
  assert.strictEqual(r.data.reviewed, 0); assert.strictEqual(r.data.total, SEED.length); assert.strictEqual(r.data.index, 0);
  r = await run({ action: "review-save", id: it.id, decision: "ok", code: "secret" });
  assert.strictEqual(r.data.reviewed, 1);
  assert.deepStrictEqual(Object.keys(store._m.review[it.id]).sort(), ["at", "s"]);
  r = await run({ action: "review-next", after: 0, code: "secret" });
  assert.notStrictEqual(r.data.item.id, it.id); assert.strictEqual(r.data.reviewed, 1);
  console.log(`ok 2: «${it.ru}» → «${it.inh}» [${it.sourceLabel}] — «Верно» сохранено, счётчик ${r.data.reviewed} из ${r.data.total}`);

  // 3. «Переведите»: 200 русских предложений без ингушского
  assert.strictEqual(T._review.ASK.length, 200);
  assert.ok(T._review.ASK.every((x) => x.id && x.ru && !("inh" in x)));
  r = await run({ action: "ask-next", after: -1, code: "secret" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.total, 200);
  const ask = r.data.item, before = r.data.translated;
  // тестовый ингушский текст — только для проверки механики (в базу проекта не попадает)
  r = await run({ action: "ask-save", id: ask.id, inh: "Тест1 перевод", after: r.data.index, code: "secret" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.translated, before + 1);
  assert.notStrictEqual(r.data.item.id, ask.id);
  const saved = store._m.all.at(-1);
  assert.deepStrictEqual(Object.keys(saved).sort(), ["at", "source", "target", "text", "translation"], "формат исправлений прежний");
  assert.deepStrictEqual([saved.source, saved.target, saved.text, saved.translation], ["ru", "inh", ask.ru, "ТестӀ перевод"]);
  r = await run({ text: ask.ru, source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.data.translation, "ТестӀ перевод");
  assert.strictEqual(r.data.variants[0].source, "native");
  assert.strictEqual(r.data.variants[0].best, true);
  assert.strictEqual((await run({ action: "ask-save", id: ask.id, inh: "  ", code: "secret" })).code, 400);
  console.log(`ok 3: «Переведите» — «${ask.ru}» сохранено как исправление носителя и отдаётся первым вариантом с галочкой`);

  // 4. надёжность источников: PaydaDosh выше открытых словарей, корпус и translatewiki ниже
  const S = T._review.seedSource;
  const pd = S({ source: "PaydaDosh", license: "x" }), wk = S({ source: "Викисловарь (ru.wiktionary.org)", license: "x" });
  const wd = S({ source: "Викиданные (wikidata.org)", license: "x" }), pl = S({ source: "PanLex", license: "x" });
  const co = S({ source: "Корпус GhalghayTools (статистика слов)" }), tw = S({ source: "translatewiki.net (интерфейс MediaWiki)", license: "x" });
  const pr = S({ source: "Справочник проекта" });
  const seq = [pr, pd, wk, wd, pl, co, tw].map((x) => x.rank * 10 + x.prio);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i - 1] < seq[i], "порядок надёжности " + seq.join(","));
  assert.strictEqual(S({ source: "Корпус GhalghayTools (статистика слов)", also: ["PaydaDosh"] }).sourceLabel, "Словарь PaydaDosh");
  console.log("ok 4: порядок надёжности: проект > PaydaDosh > Викисловарь > Википедия/Викиданные > PanLex > корпус > translatewiki");
  console.log("\nВсе проверки /review прошли.");
})().catch((e) => { console.error(e); process.exit(1); });
