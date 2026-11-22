// «его / её» перед наречием или предлогом — «из» (прямое дополнение в именительном, справочник), а не «цун» (чей).
//   node test/ego-iz.test.js
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
  for (const t of ["Я видел его вчера", "Я знаю его хорошо", "Я видел её вчера"]) {
    const r = await tr(t);
    assert.ok(/(^|\s)из(\s|$)/.test(r.translation) && !/цун/.test(r.translation), `${t} → ${r.translation}`);
  }
  // перед существительным — по-прежнему «чей»: «Это его книга» — «цун»
  for (const t of ["Это его книга", "Его брат дома"]) assert.ok(/цун/i.test((await tr(t)).translation), t);
  console.log("ok: «его» перед наречием — «из», перед существительным — «цун»");
})().catch((e) => { console.error(e); process.exit(1); });
