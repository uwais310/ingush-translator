// Словарик: перевод — само слово, а не вся строка с пояснением («сказать» → «ала», пояснение — в note).
//   node test/gloss-word.test.js
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
  const want = { "Здравствуйте": "Ассалам Ӏалайкум", "сказать": "ала", "просить": "деха", "спрашивать": "хатта", "мочь": "мага" };
  for (const [ru, inh] of Object.entries(want)) {
    const r = await tr(ru);
    assert.strictEqual(r.translation, inh, `${ru} → ${r.translation}`);
    assert.ok(r.details && /;/.test(r.details.note), `${ru}: пояснение осталось в note`);
  }
  // «прийти» — открытый вопрос (CLAUDE.md): строка без отдельного слова остаётся как есть
  assert.ok(/прош\./.test((await tr("прийти")).translation));
  console.log("ok: словарик показывает слово, пояснение — отдельно");
})().catch((e) => { console.error(e); process.exit(1); });
