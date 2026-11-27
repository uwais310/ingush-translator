// Имена людей: правила «Меня зовут …» в обе стороны и имена в переводе по словам.
//   node test/names.test.js
// Ингушские фразы — только из данных проекта (PaydaDosh, справочник проекта), источник — у каждой проверки.
// Имя не склоняется по-ингушски: формы имён с окончаниями не подтверждены, поэтому имя — в именительном.
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const WORDS = require("../lib/ingush-words.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const R = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS });
const C = require("../lib/rules/chunks.js")({ RET, SEED });
const texts = (r) => (r ? r.variants.map((v) => v.text) : []);
const norm = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[.,!?]/g, "").trim();

// 1. «Меня зовут …» по правилам (PaydaDosh: «Меня зовут Увайс. — Са цӀи Увайс я.», «Меня зовут Яха — Са цӀи яха я»,
// «Как тебя (вас) зовут? — Хьа цӀи мишта я?»). Имя переносится как написано.
{
  for (const [ru, inh] of [["Меня зовут Увайс.", "Са цӀи Увайс я."], ["Меня зовут Яха", "Са цӀи Яха я"], ["Как тебя зовут?", "Хьа цӀи мишта я?"]]) {
    const r = R.translate(ru);
    assert.ok(texts(r).some((t) => norm(t) === norm(inh)), `${ru} → ${JSON.stringify(texts(r))}`);
  }
  // любое имя — без ингушского окончания
  const a = R.translate("Меня зовут Ахмед");
  assert.ok(texts(a).includes("Са цӀи Ахмед я"), JSON.stringify(texts(a)));
  // имя с маленькой буквы — не имя: правило молчит
  assert.strictEqual(R.translate("Меня зовут домой"), null);
  console.log("ok 1: «Меня зовут Увайс» →", R.translate("Меня зовут Увайс.").translation);
}

// 2. Обратно (те же записи PaydaDosh; «Как его зовут? — Фуй цун цӀи?», справочник проекта)
{
  for (const [inh, ru] of [["Са цӀи Увайс я.", "Меня зовут Увайс."], ["Хьа цӀи мишта я?", "Как тебя зовут?"], ["Фуй цун цӀи?", "Как его зовут?"]]) {
    const r = R.translateInh(inh);
    assert.ok(texts(r).some((t) => norm(t) === norm(ru)), `${inh} → ${JSON.stringify(texts(r))}`);
  }
  console.log("ok 2: «Са цӀи Увайс я.» →", R.translateInh("Са цӀи Увайс я.").translation);
}

// 3. По словам, русский → ингушский. Прямое дополнение без предлога — в именительном («люблю Мадину» → «Мадина»,
// «вижу Ахмеда» → «Ахмед»: в ингушском дополнение в именительном). После предлога и в дательном нужен ингушский
// падеж, формы имён с окончаниями не подтверждены — имя вместе с предлогом остаётся в [скобках] как написано
// (раньше «Я был у Ахмеда» → «Со Ахмед вар» — «я был Ахмед»).
{
  const name = (r) => r.pieces.filter((p) => p.how === "name").map((p) => p.to);
  const a = C.translate("Я люблю Мадину", "ru");
  assert.deepStrictEqual(name(a), ["Мадина"], JSON.stringify(a.pieces));
  const b = C.translate("Я вижу Ахмеда", "ru");
  assert.deepStrictEqual(name(b), ["Ахмед"], JSON.stringify(b.pieces));
  for (const [t, chunk] of [["Я был у Ахмеда", "[у Ахмеда]"], ["Подарок для Ахмеда", "[для Ахмеда]"], ["Я иду с Мадиной", "[с Мадиной]"], ["Позвони Мадине", "[Мадине]"], ["Скажи Увайсу", "[Увайсу]"]]) {
    const r = C.translate(t, "ru");
    assert.ok(r.translation.includes(chunk) && !name(r).length, t + " → " + r.translation);
  }
  console.log("ok 3:", a.translation, "|", b.translation, "|", C.translate("Я был у Ахмеда", "ru").translation);
}

// 4. По словам, ингушский → русский: имя в начале предложения не становится словом «имя»
// (PaydaDosh: «Цагена цӀи цкъа яьккхача, иттаза йоаккх» — о Цагене; «Мурада наб» — сон Мурада)
{
  const a = C.translate("Цагена цӀи цкъа яьккхача, иттаза йоаккх.", "inh", { noWhole: true });
  assert.ok(/^Цагена/.test(a.translation) && !/^Имен/.test(a.translation), a.translation);
  // а само слово «цӀи» (имя, справочник проекта) — не имя человека
  assert.ok(a.pieces.some((p) => p.from === "цӏи" && p.how !== "name"), JSON.stringify(a.pieces));
  const b = C.translate("Мурада наб", "inh", { noWhole: true });
  assert.ok(/Мурада/.test(b.translation), b.translation);
  console.log("ok 4:", a.translation, "|", b.translation);
}

console.log("все проверки имён прошли");
