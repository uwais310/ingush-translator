// Коды языков: «__proto__», «constructor», «toString» — ошибка 400, а не перевод.
//   node test/lang-codes.test.js
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
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", ["ru"], 5]) {
    const a = await run({ text: "привет", source: bad, target: "inh" });
    assert.strictEqual(a.code, 400, `source ${JSON.stringify(bad)} → ${a.code}`);
    const b = await run({ text: "привет", source: "ru", target: bad });
    assert.strictEqual(b.code, 400, `target ${JSON.stringify(bad)} → ${b.code}`);
  }
  assert.strictEqual((await run({ text: "привет", source: "ru", target: "inh" })).code, 200);
  console.log("ok: чужие коды языков — 400");
})().catch((e) => { console.error(e); process.exit(1); });
