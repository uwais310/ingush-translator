// Строки словарика-пояснения («ала (наст. оал, прош. аьлар); Цо аьлар — он сказал») не должны попадать
// в перевод целиком: в перевод — заглавное слово из этой же строки, вся строка — в пояснение.
// Строки без заглавного слова («наст. воагӀа/…», «отдельного слова нет — …») не трогаем: что дать одним
// словом, решает носитель языка. Без ключей и без интернета.
//   node test/gloss-note.test.js
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const BASE = require("../lib/base.js")(KB, LEX);

// 1. разбор строки: заглавное слово берётся из самой строки справочника, ничего не придумывается
const lineOf = (ru) => (KB.GLOSSARY.find(([r]) => r === ru) || [])[1];
for (const [ru, head] of [["сказать", "ала"], ["спрашивать", "хатта"], ["просить", "деха"], ["мочь", "мага"], ["здравствуйте", "Ассалам Ӏалайкум"]]) {
  const line = lineOf(ru);
  assert.ok(line && line.startsWith(head), `в справочнике строка «${ru}» начинается с «${head}»`);
  const g = BASE.gloss(line);
  assert.strictEqual(g.translation, head, `${ru}: перевод — заглавное слово`);
  assert.strictEqual(g.note, line, `${ru}: вся строка — в пояснении`);
}
for (const ru of ["пожалуйста", "прийти", "приходить"]) assert.ok(BASE.gloss(lineOf(ru)).raw, `${ru}: строка без заглавного слова остаётся как есть`);
console.log("ok 1: заглавное слово — из строки справочника, строки без него не тронуты");

// 2. ни один ответ словарика ru→inh (кроме строк без заглавного слова) не содержит пояснений
let n = 0;
for (const [ru, inh] of KB.GLOSSARY) {
  if (BASE.gloss(inh).raw) continue;
  const r = BASE.lookup(ru.replace(/\([^()]*\)/g, " ").trim(), "ru", "inh");
  if (!r || r.kind !== "glossary") continue;
  n++;
  assert.ok(!/;|\bнаст\.|\bпрош\.| — /.test(r.translation), `«${ru}» → «${r.translation}»: пояснение попало в перевод`);
}
assert.ok(n > 300, `проверено строк словарика: ${n}`);
console.log(`ok 2: ${n} ответов словарика без пояснений в переводе`);

// 3. через сервер (как на сайте без ИИ): перевод — слово, пояснение — в details.note, в вариантах нет строки целиком
(async () => {
  global.fetch = async () => { throw new Error("no network"); };
  const T = require("../api/translate.js");
  T._setStore({ get: async () => null, setJSON: async () => {} });
  require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  const call = (body) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
    Promise.resolve(T({ method: "POST", body }, res)).catch((e) => resolve({ code: 500, data: { error: String(e && e.message) } }));
  });
  for (const [text, want, inNote] of [["сказать", "ала", "наст. оал"], ["Здравствуйте", "Ассалам Ӏалайкум", "ответ: Ва Ӏалайкум салам"], ["мочь", "мага", "мегаргда"]]) {
    const { code, data } = await call({ text, source: "ru", target: "inh", mode: "word" });
    assert.strictEqual(code, 200);
    assert.strictEqual(data.translation, want, `${text} → ${data.translation}`);
    assert.ok(String(data.details && data.details.note).includes(inNote), `${text}: пояснение в details.note: ${JSON.stringify(data.details)}`);
    for (const v of data.variants || []) assert.ok(!/;|\bнаст\.| — по времени/.test(v.text), `${text}: вариант с пояснением «${v.text}»`);
  }
  console.log("ok 3: сервер отдаёт слово, пояснение — отдельно");
  console.log("Все проверки строк-пояснений словарика прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
