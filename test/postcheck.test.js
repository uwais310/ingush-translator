// Русские слова в ингушском переводе ИИ (lib/postcheck.js): node test/postcheck.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const L = require("../lib/rules/lexicon.js");
const P = require("../lib/postcheck.js")({ SEED, KB, L });
const api = require("../api/translate.js");
const { measure } = require("../scripts/eval-postcheck.js");

// 1. русские слова, оставленные в переводе, помечаются
const caught = [
  ["Сегодня очень хорошо", "Тахан чӀоагӀа хорошо да", ["хорошо"]],
  ["Купи мне мороженое", "Сона мороженое эца", ["мороженое"]],
  ["Это моя книга", "Из са книга я", ["книга"]],
  ["Он быстро бежит", "Из быстро уадаш ва", ["быстро"]],
];
for (const [ru, inh, want] of caught) assert.deepStrictEqual(P.russian(inh, ru), want, `«${inh}»`);
console.log(`ok 1: русские слова в ингушском переводе помечены (${caught.length} фразы)`);

// 2. не помечаются: ингушские слова, заимствования из словаря, имена, [скобки]
const clean = [
  ["Где холодильник?", "Мичахь я холодильник?"],   // PaydaDosh: холодильник → холодильник
  ["Ахмед купил телефон", "Ахмеда телефон эцар"],    // имя с ингушским окончанием, телефон → телефон
  ["Магомед и Фатима пришли", "Магомед а Фатима а баьхкар"],
  ["Я живу в Назрани", "Со Назрана ваха"],
  ["Я тебя люблю", "Сона хьо [люблю] веза"],          // ИИ сам взял слово в скобки
  ["Доброе утро!", "Ӏуйре дика хийла хьа!"],
  ["Я забыл его имя", "Цун цӀи йицъеннай сона"],
];
for (const [ru, inh] of clean) assert.deepStrictEqual(P.russian(inh, ru), [], `«${inh}»`);
console.log(`ok 2: ингушские слова, заимствования из словаря, имена и [скобки] не помечены (${clean.length} фраз)`);

// 3. сервер: русские слова идут в russian и в unknown (страница их подчёркивает, второй проход заменяет)
const r = api._checkIngush("Тахан чӀоагӀа хорошо да", "Сегодня очень хорошо");
assert.deepStrictEqual(r.russian, ["хорошо"]);
assert.ok(r.unknown.includes("хорошо") && r.coverage < 1, JSON.stringify(r));
const r2 = api._checkIngush("Мичахь я холодильник?", "Где холодильник?");
assert.ok(!r2.russian && r2.coverage === 1, JSON.stringify(r2));
console.log("ok 3: сервер отдаёт russian и считает эти слова неизвестными");

// 4. замер на спрятанном разговорнике PaydaDosh
const m = measure();
assert.ok(m.falseRate <= 0.01, `ложных пометок ${(m.falseRate * 100).toFixed(1)}% > 1%`);
assert.ok(m.recallSrc >= 0.98, `пойманных слов из исходного текста ${(m.recallSrc * 100).toFixed(1)}% < 98%`);
assert.ok(m.recall >= 0.7, `пойманных по словарю ${(m.recall * 100).toFixed(1)}% < 70%`);
console.log(`ok 4: ложных пометок ${(m.falseRate * 100).toFixed(1)}%, пойманы ${(m.recallSrc * 100).toFixed(1)}% слов из исходного текста, ${(m.recall * 100).toFixed(1)}% по словарю`);
