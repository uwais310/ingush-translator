// Коды языков в запросе к api/translate.js: только настоящие языки. «__proto__», «constructor», «toString» —
// ключи любого объекта JS, и раньше проходили проверку (ответ 200 с пустым переводом). Без ключей и без интернета.
//   node test/api-lang-codes.test.js
delete process.env.USE_AI;
const assert = require("assert");
global.fetch = async () => { throw new Error("no network"); };
const T = require("../api/translate.js");
T._setStore({ get: async () => null, setJSON: async () => {} });
require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  Promise.resolve(T({ method: "POST", body }, res)).catch((e) => resolve({ code: 500, data: { error: String(e && e.message) } }));
});
(async () => {
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "xx"]) {
    for (const [source, target] of [[bad, "inh"], ["ru", bad]]) {
      const { code } = await call({ text: "привет", source, target });
      assert.strictEqual(code, 400, `${source}→${target}: ждали 400, пришло ${code}`);
    }
  }
  console.log("ok 1: ключи объекта и неизвестные коды — 400");
  const { code, data } = await call({ text: "дом", source: "ru", target: "inh" });
  assert.strictEqual(code, 200);
  assert.ok(data.translation, "ru→inh «дом» переводится");
  console.log("ok 2: настоящие коды работают");
  console.log("Все проверки кодов языков прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
