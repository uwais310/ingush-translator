// Прошедшее время по образцу словаря проекта («хатта — хаьттар», «деша — дийшар», «эца»): форма берётся,
// только если ровно такое слово есть в ингушских текстах или в разговорнике PaydaDosh.
//   node test/past-tense.test.js
// Ожидаемые формы — из словаря проекта (прош.) и разговорника PaydaDosh («Аз ийцар тоъаргйолаш…»).
const assert = require("assert");
const T = require("../api/translate.js");

const SEED = require("../data/phrases.json");
const low = (x) => String(x).toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ");
// слова разговорника — как в lib/rules/chunks.js (extraWords)
const PB = new Set(SEED.filter((p) => p.kind === "phrase" && /^PaydaDosh/.test(p.source || "")).flatMap((p) => low(p.inh).match(/[а-яӏ]+/g) || []));
const V = require("../lib/rules/verbs.js")({ RET: T._RET, extraWords: () => PB });
assert.strictEqual(V.pastOf("эца"), "ийцар");
assert.strictEqual(V.pastOf("деша"), "дийшар");
// несколько форм в текстах: выбирает prefer (слова из пар разговорника с тем же русским глаголом)
assert.strictEqual(V.pastOf("хатта"), null);
assert.strictEqual(V.pastOf("хатта", (w) => w === "хаьттар"), "хаьттар");
assert.strictEqual(V.pastOf("лаха"), "лехар");
assert.strictEqual(V.pastOf("ала", (w) => w === "аьлар"), "аьлар");
assert.strictEqual(V.pastOf("болх бе"), null); // не одно слово по образцу
assert.strictEqual(V.pastOf(""), null);

function tr(text) {
  return new Promise((ok) => T({ method: "POST", body: { text, source: "ru", target: "inh" } }, { status() { return this; }, json: ok }));
}
(async () => {
  for (const ru of ["Я купил хлеб.", "Брат купил хлеб.", "Ахмед купил хлеб в Назрани."]) {
    const r = await tr(ru);
    assert.ok(/ийцар/.test(r.translation), `${ru} → ${r.translation}`);
    assert.ok(!/\bэца\b/.test(r.translation), `${ru} → ${r.translation}`);
  }
  // обратно: «ийцар» — прошедшее; существительное со своей записью в словаре («дешар» — учёба) — не глагол
  const back = (text) => new Promise((ok) => T({ method: "POST", body: { text, source: "inh", target: "ru" } }, { status() { return this; }, json: (o) => ok(o.translation) }));
  let t = await back("Аз маькх ийцар.");
  assert.ok(/взял|купил/.test(t), t);
  t = await back("Са дешар дика да.");
  assert.ok(!/растаял/i.test(t), t);
  console.log("ok: прошедшее время по образцу словаря");
})().catch((e) => { console.error(e); process.exit(1); });
