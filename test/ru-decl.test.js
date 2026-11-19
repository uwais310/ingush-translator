// Склонение русских существительных и прилагательных (lib/rules/ru-decl.js) — только русская грамматика.
//   node test/ru-decl.test.js
const assert = require("assert");
const D = require("../lib/rules/ru-decl.js");
const all = (w) => ["gen", "dat", "acc", "ins", "prep"].map((k) => D.noun(w, k)).join(" ");

// 1-е склонение (-а, -я, -ия), мужской род на -а
assert.strictEqual(all("машина"), "машины машине машину машиной машине");
assert.strictEqual(all("книга"), "книги книге книгу книгой книге");
assert.strictEqual(all("неделя"), "недели неделе неделю неделей неделе");
assert.strictEqual(all("линия"), "линии линии линию линией линии");
assert.strictEqual(all("папа"), "папы папе папу папой папе");
assert.strictEqual(all("улица"), "улицы улице улицу улицей улице");
// 2-е склонение: одушевлённые (винительный = родительный), беглая гласная, -й, средний род
assert.strictEqual(all("брат"), "брата брату брата братом брате");
assert.strictEqual(all("отец"), "отца отцу отца отцом отце");
assert.strictEqual(all("дом"), "дома дому дом домом доме");
assert.strictEqual(all("день"), "дня дню день днем дне");
assert.strictEqual(all("музей"), "музея музею музей музеем музее");
assert.strictEqual(all("село"), "села селу село селом селе");
assert.strictEqual(all("здание"), "здания зданию здание зданием здании");
assert.strictEqual(all("сердце"), "сердца сердцу сердце сердцем сердце");
assert.strictEqual(all("ребенок"), "ребенка ребенку ребенка ребенком ребенке");
// 3-е склонение и неправильные
assert.strictEqual(all("мать"), "матери матери мать матерью матери");
assert.strictEqual(all("Назрань"), "Назрани Назрани Назрань Назранью Назрани");
assert.strictEqual(all("имя"), "имени имени имя именем имени");
assert.strictEqual(all("люди"), "людей людям людей людьми людях");
assert.strictEqual(D.noun("кофе", "gen"), "кофе");
assert.strictEqual(D.noun("лес", "prep", { loc2: true }), "лесу");
// род не виден — null (слово останется в словарной форме)
assert.strictEqual(D.noun("гвоздик", "gen"), "гвоздика");
assert.strictEqual(D.noun("брюки", "gen"), null);
console.log("ok 1: существительные —", all("машина"), "|", all("отец"), "|", all("мать"));

// прилагательные и местоимения в роде и падеже
assert.strictEqual(D.adj("хороший", "f", "dat"), "хорошей");
assert.strictEqual(D.adj("хороший", "m", "gen"), "хорошего");
assert.strictEqual(D.adj("большой", "f", "acc"), "большую");
assert.strictEqual(D.adj("синий", "m", "prep"), "синем");
assert.strictEqual(D.adj("новый", "pl", "ins"), "новыми");
assert.strictEqual(D.adj("новый", "m", "acc", false), "новый");
assert.strictEqual(D.adj("новый", "m", "acc", true), "нового");
assert.strictEqual(D.adj("новый", "n", "acc", true), "новое");
assert.strictEqual(D.poss("мой", "f", "dat"), "моей");
assert.strictEqual(D.poss("моя", "f", "acc"), "мою");
assert.strictEqual(D.poss("мой", "m", "acc", true), "моего");
assert.strictEqual(D.poss("его", "f", "dat"), "его");
console.log("ok 2: прилагательные —", D.adj("хороший", "f", "dat"), D.adj("большой", "f", "acc"), D.poss("мой", "m", "acc", true));

// предлоги перед словом
assert.deepStrictEqual([D.prep("с", "сестрой"), D.prep("с", "змеей"), D.prep("о", "отце"), D.prep("в", "Владикавказе"), D.prep("к", "мне")], ["с", "со", "об", "во", "ко"]);
console.log("ok 3: предлоги");

// множественное: беглая гласная («подарок» — подарки), род. мн. без окончания после ж, ш, ч, щ («тысяча» — тысяч)
assert.deepStrictEqual([D.nounPl("подарок", "nom"), D.nounPl("подарок", "gen"), D.nounPl("тысяча", "gen"), D.nounPl("задача", "gen"), D.nounPl("свеча", "gen")], ["подарки", "подарков", "тысяч", "задач", "свечей"]);
// после числа: 2–4 — род. ед., 5 и больше — род. мн. («три часа», «пять кроватей»)
assert.deepStrictEqual([D.noun("час", "gen"), D.nounPl("кровать", "gen"), D.noun("кровать", "gen")], ["часа", "кроватей", "кровати"]);
console.log("ok 4: множественное и формы после числа");

console.log("\nВсе проверки склонения прошли.");
