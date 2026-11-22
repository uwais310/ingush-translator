// «не» по образцу не подставляется вместо другого слова: «Мне не нравится» — не «Сона хоза хет ца».
//   node test/ne-analog.test.js
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
  const r = await run({ text: "Мне не нравится", source: "ru", target: "inh" });
  const t = r.data.translation;
  assert.ok(!/хет ца$/.test(t), t);
  assert.ok(!(r.data.pieces || []).some((p) => p.how === "analog" && /(^|\s)не(\s|$)/.test(p.from)), JSON.stringify(r.data.pieces));
  assert.ok(/(^|\s)ца\s/.test(t), "отрицание перед глаголом: " + t); // справочник: «ца» перед глаголом
  console.log("ok: «не» не заменяется по образцу —", t);
})().catch((e) => { console.error(e); process.exit(1); });
