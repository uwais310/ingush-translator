// Перевод «по кускам» без ИИ (lib/rules/chunks.js) и то, что сервер отвечает им, когда ИИ выключен.
//   node test/chunks.test.js
// Ожидаемые ингушские слова — из справочника (lib/ingush-guide.js) и словаря проекта, не придуманы.
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const C = require("../lib/rules/chunks.js")({ RET });
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
  console.log(`ok 7: сервер без ИИ → «${s.data.translation}» [${s.data.model}]`);

  console.log("\nВсе проверки перевода по кускам прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
