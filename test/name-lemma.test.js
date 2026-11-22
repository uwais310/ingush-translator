// «карта» не становится именем «Кхарт»: имя собственное по начальной форме не берём.
//   node test/name-lemma.test.js
const assert = require("assert");
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
const T = require("../api/translate.js");
const CORPUS = require("../lib/corpus.js");
const mem = () => { const m = {}; return { get: async (k) => m[k] || null, setJSON: async (k, v) => { m[k] = v; } }; };
T._setStore(mem());
CORPUS._set({ store: mem(), fetch: global.fetch });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", headers: {}, body: { noAi: true, ...body } }, res);
});
const tr = async (text, source = "ru", target = "inh") => (await run({ text, source, target })).data;

(async () => {
  for (const t of ["карта", "Где карта?", "карту"]) {
    const r = await tr(t);
    assert.ok(!/Кхарт/.test(r.translation), `${t} → ${r.translation}`);
  }
  assert.ok(/Муса/.test((await tr("Где Муса?")).translation), "имена с большой буквы остаются");
  // запись с большой буквы только по-русски — не имя: «Магазин открыт» — «Тика хьаккхашта я»
  assert.ok(/хьаккхашта/.test((await tr("Магазин открыт")).translation), "обычное слово не выброшено");
  console.log("ok: «карта» — не имя «Кхарт»");
})().catch((e) => { console.error(e); process.exit(1); });
