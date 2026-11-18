// Перевод «по кускам» без ИИ (lib/rules/chunks.js) и то, что сервер отвечает им, когда ИИ выключен.
//   node test/chunks.test.js
// Ожидаемые ингушские слова — из справочника (lib/ingush-guide.js) и словаря проекта, не придуманы.
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const C = require("../lib/rules/chunks.js")({ RET, SEED });
const tr = (t, src = "ru") => (C.translate(t, src) || {}).translation;

(async () => {
  // 1. глаголы знания — с дательным (справочник: «сона хов»), дополнение в именительном, глагол в конце
  assert.strictEqual(tr("Я знаю этого человека"), "Сона ер саг хов");
  console.log("ok 1: «Я знаю этого человека» →", tr("Я знаю этого человека"));

  // 2. «и» — «а» после каждого слова (справочник: «да а нана а»)
  assert.ok(/^Да а нана а /.test(tr("Отец и мать работают дома")), tr("Отец и мать работают дома"));
  console.log("ok 2: «Отец и мать…» →", tr("Отец и мать работают дома"));

  // 3. «идёт» согласуется с подлежащим: мальчик — в (вода), она — й (йода); предлог «в» не переводится
  assert.ok(/ вода$/.test(tr("Мальчик идёт в школу")), tr("Мальчик идёт в школу"));
  assert.ok(/^Из .* йода$/.test(tr("Она идёт в магазин")), tr("Она идёт в магазин"));
  console.log("ok 3: класс глагола по подлежащему —", tr("Мальчик идёт в школу"), "|", tr("Она идёт в магазин"));

  // 4. «люблю» согласуется с тем, кого любят (справочник: «Сона хьо веза» — мужчине)
  assert.strictEqual(tr("Я тебя люблю"), "Сона хьо веза");
  assert.ok(/нана еза$/.test(tr("Я люблю свою маму")), tr("Я люблю свою маму"));
  console.log("ok 4: «Я тебя люблю» →", tr("Я тебя люблю"), "|", tr("Я люблю свою маму"));

  // 5. ингушский → русский: местоимения, глаголы по лицу, связка в конце не переводится
  assert.strictEqual(tr("Хьо мича вода?", "inh"), "Ты куда идешь?");
  assert.strictEqual(tr("Из кхалсаг я", "inh"), "Она женщина");
  console.log("ok 5: ингушский → русский —", tr("Хьо мича вода?", "inh"), "|", tr("Из кхалсаг я", "inh"));

  // 6. неизвестное слово — в [скобках]; почти ничего не известно — модуль молчит
  assert.ok(/\[[а-я]+\]/.test(tr("Сегодня хорошая погода, мы пойдём на реку")), tr("Сегодня хорошая погода, мы пойдём на реку"));
  assert.strictEqual(C.translate("Квазиэлектрон фрактализуется", "ru"), null);
  console.log("ok 6: неизвестные слова в скобках, бессмыслица — без ответа");

  // 6б. связка, если глагола нет (справочник, раздел 4): «Из дика саг ва»; с «не» — вац; в вопросе — за вопросительным словом
  assert.strictEqual(tr("Он мой брат"), "Из са воша ва");
  assert.strictEqual(tr("Мой брат не дома"), "Са воша цӀагӀа вац");
  assert.strictEqual(tr("Где мой брат?"), "Мичахьа ва са воша?");
  assert.ok(!/ (ва|да)$/.test(tr("Старый друг вернулся")), "«старый друг» — не «друг старый»: связки нет");
  console.log("ok 6б: связка —", tr("Он мой брат"), "|", tr("Мой брат не дома"), "|", tr("Где мой брат?"));

  // 6в. шаблоны разговорника с «…» (PaydaDosh: «Меня зовут … — Со … яхаш ва» / «Са цӀи … я»); имя остаётся как есть
  assert.ok(/Ахмед/.test(tr("Меня зовут Ахмед")) && /(яхаш|цӀи)/.test(tr("Меня зовут Ахмед")), tr("Меня зовут Ахмед"));
  assert.strictEqual(tr("Са цӀи Ахмед я", "inh"), "Меня зовут Ахмед");
  // повелительное наклонение не угадываем: остаётся в скобках
  assert.ok(/\[приходи\]/.test(tr("Приходи завтра")), tr("Приходи завтра"));
  // «Мишта ва хьо?» — связка перед местоимением в русском не нужна
  assert.strictEqual(tr("Мишта ва хьо?", "inh"), "Как ты?");
  console.log("ok 6в: шаблоны и осторожность —", tr("Меня зовут Ахмед"), "|", tr("Приходи завтра"), "|", tr("Мишта ва хьо?", "inh"));

  // 6г. падежи существительных (lib/rules/cases.js). Формы — из справочника, раздел 6:
  // нанега (to mother), нанна (to mother, dative), сагаца (with the man), сагах (about the man), юртара (from the village), сага (of the man)
  const makeCases = require("../lib/rules/cases.js");
  const CS = makeCases({ words: require("../lib/ingush-words.js") });
  assert.strictEqual(CS.form("нана", "all"), "нанега");
  assert.strictEqual(CS.form("нана", "dat"), "нанна");
  assert.strictEqual(CS.form("саг", "ins"), "сагаца");
  assert.strictEqual(CS.form("саг", "abl"), "сагах");
  assert.strictEqual(CS.form("юрт", "from"), "юртара");
  assert.strictEqual(CS.form("саг", "gen"), "сага");
  assert.strictEqual(CS.form("квазиэлектрон", "dat"), null, "формы нет в текстах — null");
  // падеж русского слова — по предлогу и окончанию
  const ctx = (s, k, l) => CS.context(s.split(" "), k, l, () => true);
  assert.strictEqual(ctx("к маме", 1, "мама"), "all");
  assert.strictEqual(ctx("позвони маме", 1, "мама"), "dat");
  assert.strictEqual(ctx("с братом", 1, "брат"), "ins");
  assert.strictEqual(ctx("о матери", 1, "мать"), "abl");
  assert.strictEqual(ctx("из села", 1, "село"), "from");
  assert.strictEqual(ctx("дом человека", 1, "человек"), "gen");
  // в предложении: «Я иду к маме» — направительный, «дом человека» — родительный перед существительным
  assert.ok(/нанега/.test(tr("Я иду к маме")), tr("Я иду к маме"));
  assert.ok(/^Сага цӀа/.test(tr("Дом человека")), tr("Дом человека"));
  assert.ok(/сагаца/.test(tr("Я говорю с человеком")), tr("Я говорю с человеком"));
  console.log("ok 6г: падежи —", tr("Я иду к маме"), "|", tr("Дом человека"), "|", tr("Я говорю с человеком"));

  // 7. сервер: без USE_AI=1 ИИ не вызывается, отвечает перевод по кускам
  let aiCalls = 0;
  global.fetch = async () => { aiCalls++; throw new Error("no network"); };
  process.env.GEMINI_API_KEY = "test"; // ключ есть, но ИИ выключен
  const T = require("../api/translate.js");
  T._setStore({ get: async () => null, setJSON: async () => {} });
  require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  const call = (body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } }; T({ method: "POST", body }, res); });
  const s = await call({ text: "Мальчик идёт в большую школу", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(s.code, 200);
  assert.strictEqual(s.data.chunks, true);
  assert.ok(!s.data.ai, "не ИИ");
  assert.ok(/ вода$/.test(s.data.translation), s.data.translation);
  assert.strictEqual(aiCalls, 0, "к ИИ не обращались");
  // одно ингушское слово — форма глагола из библиотеки слов, а не «бегущий» из словаря
  const v = await call({ text: "вода", source: "inh", target: "ru", mode: "word" });
  assert.ok(/^ид[её]т$/.test(v.data.translation), v.data.translation);
  console.log(`ok 7: сервер без ИИ → «${s.data.translation}» [${s.data.model}]`);

  console.log("\nВсе проверки перевода по кускам прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
