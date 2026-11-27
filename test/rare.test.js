// Редкие записи (rare) против корпуса, «как в русском», « // » и имена в слове «имя».
//   node test/rare.test.js
const assert = require("assert");
global.fetch = async () => { throw new Error("no network"); };
delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;
const T = require("../api/translate.js");
T._setStore({ get: async () => null, setJSON: async () => {} });
require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
const call = (body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve(o); } }; T({ method: "POST", body }, res); });
const SEED = require("../data/phrases.json");

(async () => {
  // 1. корпус обгоняет rare: «того» — «цул», «пятнадцать» — «пхийтта» (записи корпуса GhalghayTools в базе)
  let r = await call({ text: "того", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.translation, "цул", r.translation + " [" + r.model + "]");
  assert.ok(r.variants.some((v) => v.text === "того"), "запись словаря осталась в вариантах");
  r = await call({ text: "пятнадцать", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.translation, "пхийтта", r.translation + " [" + r.model + "]");

  console.log("ok 1: корпус выше rare — того → цул, пятнадцать → пхийтта");

  // 2. rare, где ингушское = русское: подпись «Как в русском»
  const same = SEED.find((p) => p.rare && p.kind === "word" && p.ru.toLowerCase() === p.inh.toLowerCase() && !SEED.some((q) => q !== p && q.ru.toLowerCase() === p.ru.toLowerCase() && !q.rare));
  if (same) {
    r = await call({ text: same.ru, source: "ru", target: "inh", mode: "word" });
    if (r.translation && r.translation.toLowerCase() === same.inh.toLowerCase()) assert.ok(/Как в русском/.test(r.model + " " + JSON.stringify(r.variants)), JSON.stringify([r.model, r.variants]));
    console.log(`ok 2: «${same.ru}» → «${r.translation}» [${r.model}]`);
  }

  // 3. « // » — разделитель вариантов
  const alt = SEED.find((p) => p.kind === "word" && /\s\/\/\s/.test(p.inh) && !/[()]/.test(p.inh));
  if (alt) {
    r = await call({ text: alt.ru, source: "ru", target: "inh", mode: "word" });
    assert.ok(!/\/\//.test(r.translation), r.translation);
    console.log(`ok 3: «${alt.ru}» → «${r.translation}», варианты: ${r.variants.map((v) => v.text).join(" | ")}`);
  }

  // 4. «имя» не переводится именем человека
  const RET = require("../lib/retrieval.js")({ KB: require("../lib/ingush-guide.js"), SEED, LEX: require("../lib/corpus-lexicon.js") });
  const lw = RET.lookupWord("имя", "ru", 10);
  assert.ok(lw && !lw.items.some((it) => it.seed && /мужск|женск/.test(String(it.seed.note) + it.inh)), JSON.stringify(lw && lw.items.map((i) => i.inh)));
  console.log("ok 4: «имя» →", lw.items.map((i) => i.inh).slice(0, 3).join(", "));

  // 5. имена: не «нет в словаре», а как есть (записи «имя = …» PaydaDosh, большая буква в середине предложения)
  r = await call({ text: "Ахмед", source: "ru", target: "inh", mode: "word" });
  assert.strictEqual(r.translation, "Ахьмад"); // по-ингушски (подписи Википедии)
  assert.ok(/Имя/.test(r.model), r.model);
  r = await call({ text: "Мурад и Амина пьют чай", source: "ru", target: "inh", mode: "text" });
  assert.ok(/Мурад а Амина а/.test(r.translation), r.translation);
  r = await call({ text: "Ахьмад цӀа вахар", source: "inh", target: "ru", mode: "text" });
  assert.ok(/^Ахмед /.test(r.translation), r.translation); // имя — по-русски (подписи Википедии)
  r = await call({ text: "Брат работает в Москве", source: "ru", target: "inh", mode: "text" });
  assert.ok(/Моске/.test(r.translation), "город — не имя: " + r.translation);
  console.log("ok 5: имена —", r.translation);
  // 6. имя с маленькой буквы перед глаголом и новое заимствование: не «нет в базе», а предложение
  r = await call({ text: "увейс кушает бургер", source: "ru", target: "inh", mode: "text" });
  assert.ok(/^Увейс бургер /.test(r.translation), r.translation);
  console.log("ok 6: «увейс кушает бургер» →", r.translation);

  console.log("\nВсе проверки редких записей прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
