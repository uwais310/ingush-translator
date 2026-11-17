// Перевод по правилам без ИИ (lib/rules): node test/rules.test.js
// Проверяет: каждый образец из библиотеки правил собирается так же, как в источнике; правила молчат там,
// где не уверены; варианты для мужчины и женщины; замер на разговорнике PaydaDosh не падает.
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const WORDS = require("../lib/ingush-words.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const R = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS });
const norm = (s) => String(s).toLowerCase().replace(/ӏ/g, "Ӏ").replace(/[.,!?]/g, "").replace(/\s+/g, " ").trim();

(async () => {
  // 1. образцы из источников
  let n = 0;
  for (const rule of R.RULES) {
    for (const [ru, inh] of rule.examples) {
      const r = R.translate(ru);
      assert.ok(r, `«${ru}» — правило «${rule.id}» не сработало (${JSON.stringify(R.why(ru))})`);
      assert.ok(r.variants.some((v) => norm(v.text) === norm(inh)), `«${ru}»: ждали «${inh}», получили ${r.variants.map((v) => v.text).join(" | ")}`);
      n++;
    }
  }
  console.log(`ok 1: все ${n} образцов из справочника и разговорника собираются правилами так же, как в источнике`);

  // 2. там, где правила не уверены, они молчат (переводит ИИ или база)
  const silent = [
    "Мне холодно",            // не «я холодный»
    "Снег идёт",              // «Лоа делх», не «вода»
    "Куда мы идём?",          // о многих — другой глагол («Мича долха вай?»)
    "Это большая машина",     // формы «большой» для класса й нет в источниках
    "Мать сын",               // подпись, а не предложение
    "до вечера",              // предлог без правила
    "Я знаю этого человека",  // знать человека — другой глагол (вовза)
    "Я болею",                // глагол, а не существительное
    "Это дорого",             // не «это дорога»
    "У нас нет детей",        // о людях говорят иначе
    "Мы любим свою маму",     // «свой» для «мы» в источниках нет
  ];
  for (const s of silent) assert.strictEqual(R.translate(s), null, `«${s}» должно остаться без перевода по правилам, а получилось ${JSON.stringify(R.translate(s))}`);
  console.log(`ok 2: в ${silent.length} трудных случаях правила молчат (Мне холодно, Снег идёт, Куда мы идём?…)`);

  // 3. пол говорящего и собеседника
  let r = R.translate("Я иду на работу");
  assert.deepStrictEqual(r.variants.map((v) => v.text), ["Со балха вода", "Со балха йода"]);
  assert.deepStrictEqual(r.variants.map((v) => v.note), ["говорит мужчина", "говорит женщина"]);
  r = R.translate("Я была дома");
  assert.deepStrictEqual(r.variants.map((v) => v.text), ["Со цӀагӀа яр"], "«была» — значит, говорит женщина");
  r = R.translate("Где ты?");
  assert.deepStrictEqual(r.variants.map((v) => v.note), ["к мужчине", "к женщине"]);
  r = R.translate("Где наш дом?");
  assert.ok(r.variants.some((v) => /^Вай /.test(v.text)) && r.variants.some((v) => /^Тха /.test(v.text)), "«наш» — тха и вай");
  r = R.translate("Я люблю свою маму");
  assert.strictEqual(r.translation, "Сона сай нана еза", "«свою» после «я» — сай (справочник: са, сай)");
  console.log("ok 3: варианты — «говорит мужчина / женщина», «к мужчине / к женщине», «тха / вай», «свой» по лицу");

  // 4. замер на разговорнике: правила совпадают с переводами носителей
  const { run } = require("../scripts/eval-rules.js");
  const m = run(true);
  const rate = m.exact / m.done;
  assert.ok(m.done >= 50, `правила перевели только ${m.done} фраз разговорника`);
  assert.ok(rate >= 0.65, `с носителями совпало ${(rate * 100).toFixed(1)}% — правила стали хуже`);
  console.log(`ok 4: разговорник PaydaDosh — правила перевели ${m.done} фраз, ${(rate * 100).toFixed(1)}% точно как у носителей`);

  // 5. ингушский → русский: каждый образец переводится обратно
  const normRu = (x) => String(x).toLowerCase().replace(/ё/g, "е").replace(/[.,!?—-]/g, "").replace(/\s+/g, " ").trim();
  let back = 0;
  for (const rule of R.RULES) {
    for (const [ru, inh] of rule.examples) {
      const r = R.translateInh(inh);
      assert.ok(r && r.variants.some((v) => normRu(v.text) === normRu(ru)), `«${inh}» → ждали «${ru}», получили ${r ? r.variants.map((v) => v.text).join(" | ") : "ничего"}`);
      back++;
    }
  }
  const silentInh = ["ЧӀоагӀа шийла я", "Ер Эса да", "Хьо бакъ ва", "Дала хоастам ба!", "Со меца ва", "ХӀанз тӀехьа да"];
  for (const s of silentInh) assert.strictEqual(R.translateInh(s), null, `«${s}» должно остаться без перевода по правилам: ${JSON.stringify(R.translateInh(s))}`);
  let ri = R.translateInh("Сона талмач веза");
  assert.deepStrictEqual(ri.variants.map((v) => v.text), ["Мне нужен переводчик", "Я люблю переводчика"], "деза — и «нужен», и «люблю»");
  ri = R.translateInh("Да цӀагӀа вац");
  assert.strictEqual(ri.translation, "Отца нет дома");
  ri = R.translateInh("Со цӀагӀа яр");
  assert.strictEqual(ri.translation, "Я была дома", "класс й — говорит женщина");
  ri = R.translateInh("Сога ши книжка да");
  assert.strictEqual(ri.translation, "У меня есть две книги");
  const mi = run(true, true);
  assert.ok(mi.done >= 60 && mi.exact / mi.done >= 0.8, `инг → рус: ${mi.done} фраз, совпало ${(100 * mi.exact / mi.done).toFixed(1)}%`);
  console.log(`ok 5: ингушский → русский — ${back} образцов обратно, ${silentInh.length} случаев молчания, разговорник: ${mi.done} фраз, ${(100 * mi.exact / mi.done).toFixed(1)}% как в базе`);

  // 6. через сервер: без ИИ, с меткой правил
  global.fetch = async () => { throw new Error("no network"); };
  const T = require("../api/translate.js");
  T._setStore({ get: async () => null, setJSON: async () => {} });
  require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  const call = (body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } }; T({ method: "POST", body }, res); });
  delete process.env.GEMINI_API_KEY;
  let s = await call({ text: "Это мой дом", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.strictEqual(s.data.translation, "Ер са цӀа да");
  assert.strictEqual(s.data.rules, true);
  assert.ok(/правилам/.test(s.data.model), s.data.model);
  s = await call({ text: "Доброе утро! Мой отец врач.", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.strictEqual(s.data.translation, "Ӏуйре дика хийла хьа! Са да лор ва.");
  assert.strictEqual(s.data.rules, true);
  s = await call({ text: "Ер са нана я", source: "inh", target: "ru", mode: "text", noAi: true });
  assert.ok(/^Это моя (мать|мама)$/.test(s.data.translation) || s.data.translation === "Это моя мать.", s.data.translation);
  s = await call({ text: "Са да лор ва", source: "inh", target: "ru", mode: "text", noAi: true });
  assert.strictEqual(s.data.translation, "Мой отец — врач");
  assert.strictEqual(s.data.rules, true);
  s = await call({ action: "rules" });
  assert.ok(s.data.rules.length >= 8 && s.data.verbs.length >= 10);
  console.log("ok 6: сервер — «Это мой дом», «Са да лор ва» и текст из двух предложений переводятся без ИИ, есть список правил для /rules");

  console.log("\nВсе проверки правил прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
