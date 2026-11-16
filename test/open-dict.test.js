// Проверка базы пар после добавления открытых словарей (SOURCES.md). Без ключей и без интернета.
//   node test/open-dict.test.js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const SEED = require("../data/phrases.json");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });

// 1. у каждой записи есть источник, verified = false, id уникальны, палочка — только Ӏ
const ids = new Set();
const OPEN = SEED.filter((p) => p.license);
for (const p of SEED) {
  assert.ok(p.id && !ids.has(p.id), `id ${p.id}`);
  ids.add(p.id);
  assert.ok(p.source, `нет источника: ${p.id}`);
  assert.strictEqual(p.verified, false, `verified ставит только человек: ${p.id}`);
  assert.ok(["word", "phrase", "name"].includes(p.kind), `kind ${p.kind}`);
  assert.ok(!/[A-Za-z1|Іі](?=[а-яӀ])|[а-яӀ][1Il|Іі]/i.test(p.inh), `палочка не исправлена: ${p.inh}`);
}
assert.ok(OPEN.length > 5000, `открытых записей мало: ${OPEN.length}`);
// 2. каждый источник из data/sources описан в SOURCES.md и у каждой его записи есть лицензия
const md = fs.readFileSync(path.join(__dirname, "..", "SOURCES.md"), "utf8");
const dir = path.join(__dirname, "..", "data", "sources");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const src = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  assert.ok(src.license && src.url, `${f}: нет лицензии или ссылки`);
  assert.ok(md.includes(src.source), `${f}: источника «${src.source}» нет в SOURCES.md`);
  for (const p of OPEN.filter((x) => x.source === src.source)) assert.strictEqual(p.license, src.license);
}
console.log("ok 1: записей", SEED.length, "из них открытых словарей", OPEN.length, "— у всех есть источник и лицензия, verified = false");

// 3. старые записи на месте (их id используют решения носителя на /review)
for (const id of ["aa4c7de015", "17a38be0a3", "3fb7aafcc1"]) assert.ok(ids.has(id), `пропала старая запись ${id}`);
const first = SEED.findIndex((p) => p.license);
assert.ok(SEED.slice(0, first).every((p) => !p.license) && SEED.slice(first).every((p) => p.license), "открытые словари идут после записей проекта");
console.log("ok 2: записи проекта не изменились и идут первыми");

// 4. слова открытых словарей находятся подбором словаря
const open = OPEN.find((p) => p.kind === "word" && p.source === "PanLex" && /^[а-я]{5,}$/.test(p.ru) && p.inh !== p.ru &&
  !SEED.some((q) => q.source !== "PanLex" && q.ru.toLowerCase() === p.ru)); // слово, которое есть только в PanLex
const hits = RET.pickDictionary(`Я вижу ${open.ru}`, "ru", 40);
assert.ok(hits.some((h) => h.from === "open" && h.ru === open.ru), `не нашлось «${open.ru}»`);
assert.ok(!RET.missingWords(`Я вижу ${open.ru}`, "ru", hits, []).includes(open.ru), "слово с записью не считается неизвестным");
console.log(`ok 3: «${open.ru}» → «${open.inh}» (${open.source}) находится подбором словаря`);

// 5. точный ответ без ИИ по слову из открытого словаря (с подписью источника)
const T = require("../api/translate.js");
T._setStore({ get: async () => null, setJSON: async () => {} });
require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", body }, res);
});
(async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;
  const r = await run({ text: open.ru, source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.base, true, "ответ из базы, без ИИ");
  assert.strictEqual(r.data.model, `Из базы: ${open.source}`, "подписан источник");
  assert.ok(r.data.translation.length > 0);
  console.log(`ok 4: «${open.ru}» без ИИ → «${r.data.translation}» [${r.data.model}]`);
  console.log("\nВсе проверки базы прошли.");
})().catch((e) => { console.error(e); process.exit(1); });
