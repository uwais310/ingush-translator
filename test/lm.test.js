// Языковая модель (lib/rules/lm.js): триграммы с сглаживанием Кнезера — Нея; выбор между готовыми вариантами.
//   node test/lm.test.js
const assert = require("assert");
const makeLM = require("../lib/rules/lm.js");
const KB = require("../lib/ingush-guide.js");

// 1. Русская сторона: порядок слов, который был в обучающих фразах, вероятнее перестановки
const ru = makeLM(["я иду домой", "я иду в школу", "он идёт домой", "мы идём домой", "я читаю книгу"]);
assert.ok(ru.score("я иду домой") > ru.score("домой иду я"), "виденный порядок слов лучше");
assert.ok(ru.score("он идёт домой") > ru.score("он идёт книгу"), "виденное продолжение лучше");
assert.ok(Number.isFinite(ru.score("совсем новое слово")), "незнакомые слова не ломают модель");
assert.ok(ru.score("я иду домой") <= 0);
assert.strictEqual(ru.score(""), -Infinity);
// ё = е, регистр и знаки не важны
assert.strictEqual(ru.score("Он идёт домой!"), ru.score("он идет домой"));

// 2. Сглаживание: биграмма, которой не было в этом контексте, всё же вероятнее совсем незнакомого слова
{
  const lm = makeLM(["а б в", "а б г", "б в г", "в г а"]);
  assert.ok(lm.score("а б в") > lm.score("а в б"));
  assert.ok(lm.score("г б в") > lm.score("г б яяя"));
}

// 3. Ингушская сторона — только на настоящих примерах справочника (lib/ingush-guide.js, EXAMPLES)
{
  const inh = makeLM(KB.EXAMPLES.map(([, i]) => i));
  const [, ex] = KB.EXAMPLES.find(([, i]) => (i.match(/\S+/g) || []).length >= 3);
  const w = makeLM.toks(ex);
  const rev = w.slice().reverse();
  if (rev.join(" ") !== w.join(" ")) assert.ok(inh.score(w) > inh.score(rev), "фраза справочника лучше её перестановки: " + ex);
}

// 4. В переводе по кускам модель выбирает между образцом и переводом по словам; быстро (< 50 мс на фразу)
{
  const SEED = require("../data/phrases.json");
  const LEX = require("../lib/corpus-lexicon.js");
  const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
  const phr = SEED.filter((p) => p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source)).slice(0, 3000).map((p) => [p.ru, p.inh]);
  const A = require("../lib/rules/align.js")(phr);
  const C = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN: A, EXAMPLES: phr });
  const C0 = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN: A, EXAMPLES: phr, tune: { noLM: true } });
  const qs = ["Я иду домой", "Где ты живёшь?", "Мой брат работает в школе", "Как тебя зовут?", "Сколько стоит хлеб?"];
  C.translate(qs[0], "ru", { noWhole: true }); // модель строится при первом вызове
  const t0 = Date.now();
  for (const q of qs) { const r = C.translate(q, "ru", { noWhole: true }); const r0 = C0.translate(q, "ru", { noWhole: true }); assert.ok(!!r === !!r0, q); }
  const ms = (Date.now() - t0) / qs.length / 2;
  assert.ok(ms < 50, "в среднем " + ms.toFixed(1) + " мс на фразу");
}

console.log("lm: ok");
