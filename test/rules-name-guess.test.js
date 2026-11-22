// Правила (lib/rules/index.js, nounOf): имя собственное нельзя брать по догадке о начальной форме.
// «карта» → догадка «карт» → запись PaydaDosh «Карт — Кхарт» давала «Мне нужна карта» → «Сона Кхарт еза».
// Без ключей и без интернета.   node test/rules-name-guess.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const WORDS = require("../lib/ingush-words.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX: require("../lib/corpus-lexicon.js") });
const R = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS });
const out = (t) => { const r = R.translate(t); return r ? r.variants.map((v) => v.text) : []; };

// 1. «карта» не становится именем «Кхарт»
assert.ok(SEED.some((p) => p.ru === "Карт" && p.inh === "Кхарт"), "в базе есть запись-имя «Карт — Кхарт»");
assert.ok(!out("Мне нужна карта").some((t) => /Кхарт/.test(t)), `Мне нужна карта → ${out("Мне нужна карта").join(" | ")}`);
console.log("ok 1: «карта» не превращается в имя «Кхарт»");

// 2. обычные существительные в том же правиле работают
for (const t of ["Мне нужна книга", "Мне нужен врач"]) assert.ok(out(t).length, `${t}: правило должно сработать`);
console.log("ok 2: «Мне нужна книга», «Мне нужен врач» — по-прежнему по правилу");
console.log("Все проверки имён по догадке прошли.");
