// Ингушский → русский по словам (lib/rules/chunks.js, dictWord): пометка о части речи из словаря — не перевод.
// «аьнна» в PaydaDosh записано как «Цитирующая частица; дополняющая частица.», и «Из ала аьнна» давало «Он сказать
// Цитирующая частица». Такое слово остаётся в [скобках]. Значение с заглавной буквы («хилар — Быть; случаться.»)
// в середине русского предложения пишется со строчной; имена («Дала» — «Бог») не трогаем. Без ключей и без интернета.
//   node test/inh-labels.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX: require("../lib/corpus-lexicon.js") });
const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "");
const phrases = SEED.filter((p) => p.kind === "phrase" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES.map(([ru, inh]) => [ru, inh]));
const words = SEED.filter((p) => p.kind === "word" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.GLOSSARY.map(([ru, inh]) => [ru, inh]));
const ALIGN = require("../lib/rules/align.js")([...phrases, ...words]);
const C = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN, EXAMPLES: phrases });
const tr = (t) => (C.translate(t, "inh") || {}).translation || "";

// 1. пометки о части речи не попадают в русский текст
assert.ok(SEED.some((p) => p.inh === "аьнна" && /частица/.test(p.ru)), "в базе «аьнна» записано как частица");
const out1 = tr("Из ала аьнна");
assert.ok(!/частица|суффикс|префикс|междометие/i.test(out1), `Из ала аьнна → ${out1}`);
let leaks = 0;
for (const [, inh] of phrases.slice(0, 3000)) if (/частица|суффикс отглагольн|префикс/i.test(tr(inh))) leaks++;
assert.strictEqual(leaks, 0, `пометки части речи в ${leaks} переводах фраз`);
console.log("ok 1: пометок о части речи в переводе нет (3000 фраз разговорника)");

// 2. заглавная буква словаря — только у имён
const out2 = tr("сердало ца хилар хӀама");
assert.ok(!/ Быть/.test(out2), `сердало ца хилар хӀама → ${out2}`);
const out3 = tr("Дала раьза хилва хьох");
assert.ok(/Бог/.test(out3), `Дала раьза хилва хьох → ${out3}: «Бог» с заглавной`);
console.log("ok 2: «быть» со строчной, «Бог» — с заглавной");
console.log("Все проверки пометок словаря прошли.");
