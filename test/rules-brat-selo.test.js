// Правила узнают «брат» и «село»: похожи на глагол (брать, сесть), но в словаре это существительные с классом.
//   node test/rules-brat-selo.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const T = require("../api/translate.js");
const SEED = require("../data/phrases.json");
const R = require("../lib/rules/index.js")({ RET: T._RET, KB, SEED: SEED.phrases || SEED, WORDS: null });
const want = {
  "Мой брат дома": "Са воша цӀагӀа ва", // как «Мой отец дома — Са да цӀагӀа ва» (rules)
  "Это мой брат": "Ер са воша ва",
  "Это село": "Ер юрт я",
};
for (const [ru, inh] of Object.entries(want)) {
  const r = R.translate(ru);
  assert.ok(r, `${ru}: правило не сработало`);
  assert.strictEqual(r.translation, inh, `${ru} → ${r.translation}`);
}
// глаголы остаются глаголами: «брал», «села» — не существительные
for (const ru of ["Он брал книгу", "Она села"]) assert.ok(!/воша|юрт/.test((R.translate(ru) || {}).translation || ""), ru);
console.log("ok: правила знают «брат» и «село»");
