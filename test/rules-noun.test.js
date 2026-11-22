// Правила (lib/rules/index.js, nounOf): «брат», «село» кончаются как глагол («брать», «сеть»), но в словаре это
// существительные с классом — правила должны их узнавать. Раньше «Мой брат дома», «Это мой брат», «Мой брат живёт
// в Назрани» правила пропускали (дальше переводили по словам). Без ключей и без интернета.
//   node test/rules-noun.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const WORDS = require("../lib/ingush-words.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX: require("../lib/corpus-lexicon.js") });
const R = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS });

// «брат» в словаре — «воша» (класс в): берём из самих источников, а не из теста
const brother = SEED.find((p) => p.source === "Справочник проекта" && p.kind === "word" && p.ru === "брат");
assert.ok(brother, "в словаре проекта есть «брат»");
const word = String(brother.inh).split(/[\s(/,;]/)[0];
assert.ok(word, "ингушское слово для «брат»");

// 1. правила узнают «брат» как существительное
for (const text of ["Мой брат дома", "Это мой брат", "Мой брат живёт в Назрани"]) {
  const r = R.translate(text);
  assert.ok(r, `${text}: правило должно сработать`);
  assert.ok(r.variants.every((v) => v.text.toLowerCase().split(/[\s.,!?]+/).includes(word.toLowerCase())), `${text} → ${r.variants.map((v) => v.text).join(" | ")}: нет «${word}»`);
}
console.log(`ok 1: «брат» (${word}) — существительное для правил`);

// 2. глаголы на -ал/-ет по-прежнему не принимаются за существительные
for (const text of ["Он брал книгу", "Он берёт книгу"]) {
  const r = R.translate(text);
  assert.ok(!r || r.rule !== "copula", `${text}: глагол принят за существительное (${r && r.rule})`);
}
console.log("ok 2: «брал», «берёт» — не существительные");
console.log("Все проверки существительных, похожих на глаголы, прошли.");
