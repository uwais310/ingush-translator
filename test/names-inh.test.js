// Имена по-ингушски (lib/rules/names-inh.js): написание и форма на -а у того, кто делает.
//   node test/names-inh.test.js
// Источник форм — подписи Википедии к людям: «Матиев Ахмет Хасанович | Матенаькъан Хьасана Ахьмад»,
// «Кодзоева Дугурхан Ахмедовна | Коазой Ахьмада Дугурхан»; разговорник PaydaDosh: «ДоттагӀа вайзар мохьмада».
const assert = require("assert");
const N = require("../lib/rules/names-inh.js")(require("../data/sources/wikidata.json").pairs);
assert.strictEqual(N.nom("Ахмед"), "Ахьмад");
assert.strictEqual(N.nom("Хасан"), "Хьасан");
assert.strictEqual(N.erg("Ахмед"), "Ахьмада");
assert.strictEqual(N.erg("Хасан"), "Хьасана");
assert.strictEqual(N.nom("Пётр"), null);
assert.strictEqual(N.erg("Пётр"), null);

const T = require("../api/translate.js");
const tr = (text) => new Promise((ok) => T({ method: "POST", body: { text, source: "ru", target: "inh" } }, { status() { return this; }, json: (o) => ok(o.translation) }));
(async () => {
  // делает (переходный глагол, есть что): форма на -а
  let t = await tr("Ахмед купил хлеб в Назрани.");
  assert.ok(/^Ахьмада /.test(t) && /ийцар/.test(t) && /маькх/.test(t) && /Наьсаре/.test(t), t);
  // имя само по себе и при непереходном глаголе — ингушское написание, без -а
  t = await tr("Ахмед дома.");
  assert.ok(/Ахьмад(?![а-яӀ])/.test(t) && !/Ахьмада/.test(t), t);
  t = await tr("Ахмед пошёл домой.");
  assert.ok(!/Ахьмада/.test(t), t);
  // имя — дополнение («вижу Ахмеда»): не тот, кто делает
  t = await tr("Я вижу Ахмеда.");
  assert.ok(!/Ахьмада/.test(t), t);
  // после предлога — как раньше, в [скобках]
  t = await tr("Я был у Ахмеда.");
  assert.ok(/\[у Ахмеда\]/.test(t), t);
  // неизвестное имя — как написано
  t = await tr("Пётр купил хлеб.");
  assert.ok(/Пётр|Петр/.test(t), t);
  // два имени через «и» — без формы на -а, с «… а … а»; наречие — не дополнение (код-ревью)
  t = await tr("Хасан и Ахмед купили хлеб.");
  assert.ok(!/Хьасана|Ахьмада/.test(t), t);
  t = await tr("Ахмед бежал быстро.");
  assert.ok(!/Ахьмада/.test(t), t);
  // обратно: ингушское имя и его форма на -а → русское имя (не «Имя дома»)
  const back = (text) => new Promise((ok) => T({ method: "POST", body: { text, source: "inh", target: "ru" } }, { status() { return this; }, json: (o) => ok(o.translation) }));
  t = await back("Ахьмад цӀагӀа ва.");
  assert.ok(/Ахмед/.test(t) && !/Имя/.test(t), t);
  t = await back("Ахьмада маькх ийцар.");
  assert.ok(/Ахмед/.test(t), t);
  assert.strictEqual(N.ru("ахьмада"), "Ахмед");
  assert.strictEqual(N.ru("маькх"), null);
  console.log("ok: имена по-ингушски");
})().catch((e) => { console.error(e); process.exit(1); });
