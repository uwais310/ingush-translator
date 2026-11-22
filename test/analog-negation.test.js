// Перевод по образцу (lib/rules/chunks.js, analog) не ставит «не» на место другого слова образца:
// «Мне это нравится» (PaydaDosh) → «Мне не нравится» давало «Сона хоза хет ца» — «ца» на месте «из».
// Отрицание в ингушском меняет форму глагола, это не замена слова. Без ключей и без интернета.
//   node test/analog-negation.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX: require("../lib/corpus-lexicon.js") });
const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "");
const phrases = SEED.filter((p) => p.kind === "phrase" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES.map(([ru, inh]) => [ru, inh]));
const words = SEED.filter((p) => p.kind === "word" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.GLOSSARY.map(([ru, inh]) => [ru, inh]));
const ALIGN = require("../lib/rules/align.js")([...phrases, ...words]);
const C = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN, EXAMPLES: phrases });

// 1. «не» не подставляется по образцу ни вместо слова, ни на место «не»
for (const text of ["Мне не нравится", "Мне не нравится чай", "Ему не нравится чай"]) {
  const r = C.translate(text, "ru");
  assert.ok(r, `${text}: перевод есть`);
  const bad = (r.pieces || []).filter((p) => p.how === "analog" && /(^|\s)не(\s|$)/.test(p.from));
  assert.strictEqual(bad.length, 0, `${text} → ${r.translation}: «не» подставлено по образцу (${bad.map((p) => p.from + "→" + p.to).join(", ")})`);
  assert.notStrictEqual(r.translation, "Сона хоза хет ца", `${text}: «ца» на месте «из»`);
}
console.log("ok 1: «не» по образцу не подставляется");

// 2. обычные замены по образцу работают как раньше (местоимение, слово того же класса)
const r2 = C.translate("Удачи тебе", "ru");
assert.ok(r2 && r2.translation, "Удачи тебе: перевод есть");
console.log("ok 2: остальные замены по образцу на месте:", r2.translation);
console.log("Все проверки отрицания при переводе по образцу прошли.");
