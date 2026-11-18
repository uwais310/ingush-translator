// Проверка начальных форм и поиска по словарю (без ИИ и без сети): node test/morph.test.js
const assert = require("assert");
const T = require("../api/translate.js");
const RET = T._RET;
T._setStore({ get: async () => null, setJSON: async () => {} });
require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
  T({ method: "POST", body }, res);
});

(async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.XAI_API_KEY;

  // 1. начальные формы: только те, что есть в словаре
  const lemma = (w, lang = "ru") => RET.lemmas(w, lang);
  assert.ok(lemma("маму").includes("мама"));
  assert.ok(lemma("люблю").includes("любить"));
  assert.ok(lemma("поедем").includes("поехать"));
  assert.ok(lemma("хочу").includes("хотеть"));
  assert.ok(lemma("говорил").includes("говорить"));
  assert.deepStrictEqual(lemma("братом"), ["брат"], "«братом» — это «брат», а не «брать»");
  assert.ok(lemma("веза", "inh").includes("деза"), "показатель класса: веза → деза");
  assert.deepStrictEqual(lemma("абвгдежз"), [], "выдуманное слово ничего не находит");
  // повелительное наклонение и краткие прилагательные
  for (const [w, l] of [["позвони", "позвонить"], ["напиши", "написать"], ["садись", "садиться"], ["налей", "налить"], ["забудь", "забыть"], ["голоден", "голодный"], ["спокоен", "спокойный"], ["сыт", "сытый"]]) {
    assert.ok(lemma(w).includes(l), `${w} → ${l}: ${lemma(w)}`);
  }
  assert.ok(lemma("ночей").includes("ночь") && !lemma("ночей").includes("ночить"), "«ночей» — это «ночь»");
  console.log("ok 1: начальные формы — маму → мама, люблю → любить, поедем → поехать, позвони → позвонить, голоден → голодный, веза → деза");

  // 2. подбор словаря: «поедем» находит «поехать», а не «поедание» и «поединок»
  const hits = RET.pickDictionary("Завтра мы с братом поедем к бабушке в горы", "ru", 40);
  const rus = hits.map((h) => h.ru).join(" | ");
  assert.ok(/поехать/.test(rus), rus);
  assert.ok(!/поедание|поединок/.test(rus), rus);
  assert.ok(hits.some((h) => /^бабушка/.test(h.ru)) && hits.some((h) => h.ru === "брат"), rus);
  console.log("ok 2: словарь для ИИ — «поедем» → «поехать», без «поедание» и «поединок»");

  // 3. примеры для ИИ: есть фраза с тем же глаголом в нужной форме
  const shots = RET.pickFewShots("Я хочу пить воду", "ru", "inh", [], [], 16);
  assert.ok(shots.length >= 4 && shots.length <= 16);
  assert.ok(shots.some((s) => /хочу/i.test(s.ru)), shots.map((s) => s.ru).join(" | "));
  assert.strictEqual(new Set(shots.map((s) => s.ru + "|" + s.inh)).size, shots.length, "без повторов");
  console.log("ok 3: примеры для ИИ —", shots.slice(0, 3).map((s) => s.ru).join(" | "));

  // 4. слово в другой форме: ответ из базы без ИИ, с честной подписью
  let r = await run({ text: "маму", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.base, true);
  assert.strictEqual(r.data.translation, "нана");
  assert.ok(/начальная форма «мама»/.test(r.data.model), r.data.model);
  assert.ok(/другой форме/.test(r.data.details.note), "есть пояснение про форму слова");
  console.log(`ok 4: «маму» без ИИ → «${r.data.translation}» [${r.data.model}]`);

  // 5. одно из значений записи словаря («носить, поносить; …») находится по слову
  r = await run({ text: "позориться", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.data.base, true, JSON.stringify(r.data));
  assert.ok(!/[̀́]/.test(r.data.translation), "в переводе нет знака ударения");
  assert.ok(r.data.variants.length >= 1 && r.data.variants[0].sourceLabel === "Словарь PaydaDosh");
  console.log(`ok 5: «позориться» → «${r.data.translation}» [${r.data.model}]`);

  // 6. словарь надёжнее таблицы текстов: «воду» → начальная форма «вода» из словаря проекта
  r = await run({ text: "воду", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.data.translation, "хий");
  assert.strictEqual(r.data.variants[0].source, "project");
  console.log(`ok 6: «воду» → «${r.data.translation}» [${r.data.model}]`);

  // 7. без ИИ и без целого перевода: разбор по словам знает начальные формы, есть похожие фразы
  // («Я люблю свою маму» уже собирают правила, поэтому здесь предложение, для которого правила нет)
  r = await run({ text: "Я очень люблю свою маму", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.strictEqual(r.data.noAi, true);
  const byWord = Object.fromEntries(r.data.words.map((w) => [w.word, w]));
  assert.strictEqual(byWord["люблю"].lemma, "любить");
  assert.ok(/деза/.test(byWord["люблю"].text), byWord["люблю"].text);
  assert.ok(/нана/.test(byWord["маму"].text));
  assert.ok(r.data.similar.length >= 2, "похожие фразы показаны");
  console.log("ok 7: разбор по словам —", r.data.words.map((w) => `${w.word} = ${w.text}`).join("; "));

  // 8. готовые фразы не сломались
  r = await run({ text: "Доброе утро! Как у тебя дела?", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(r.data.translation, "Ӏуйре дика хийла хьа! Фу деш ва хьо?");
  r = await run({ text: "Сона хьо веза", source: "inh", target: "ru", mode: "text" });
  assert.ok(/люблю/.test(r.data.translation), r.data.translation);
  console.log("ok 8: готовые фразы отвечаются из базы, как раньше");

  // 9. замер на фразах базы (scripts/eval-retrieval.js): подсказки для ИИ не должны стать хуже.
  //    Пороги чуть ниже нынешних значений (рус → инг ≈ 77%, инг → рус ≈ 64%); у версии до замера было 76.5% и 62.9%.
  //    Набор фраз случайный и меняется вместе с базой. На одних и тех же 600 фразах чистка и второй проход
  //    по PaydaDosh подняли значения с 77.4% до 80.4% и с 64.4% до 67.5%.
  process.argv.push("300");
  const { measure } = require("../scripts/eval-retrieval.js");
  const ru = measure("ru", true), inh = measure("inh", true);
  assert.ok(ru.stem >= 0.76, `рус → инг: ${(ru.stem * 100).toFixed(1)}% слов перевода в подсказках`);
  assert.ok(inh.stem >= 0.62, `инг → рус: ${(inh.stem * 100).toFixed(1)}% слов перевода в подсказках`);
  console.log(`ok 9: замер на 300 фразах — рус → инг ${(ru.stem * 100).toFixed(1)}%, инг → рус ${(inh.stem * 100).toFixed(1)}% слов перевода есть в подсказках`);

  console.log("\nВсе проверки начальных форм и словаря прошли.");
})().catch((e) => { console.error(e); process.exit(1); });
