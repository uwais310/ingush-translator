// «его, её, их» (lib/rules/chunks.js): перед существительным — «чей» (родительный: цун, цар), а перед наречием,
// предлогом или «не» — прямое дополнение (в ингушском — именительный, как в правиле: «Я не видел его» → «Сона из
// ца гайра»). Раньше «Я видел его вчера» давало «Сона цун селхан гайра» — «его» как «чей». Без ключей и без интернета.
//   node test/object-pronoun.test.js
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const L = require("../lib/rules/lexicon.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX: require("../lib/corpus-lexicon.js") });
const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "");
const phrases = SEED.filter((p) => p.kind === "phrase" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES.map(([ru, inh]) => [ru, inh]));
const words = SEED.filter((p) => p.kind === "word" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.GLOSSARY.map(([ru, inh]) => [ru, inh]));
const ALIGN = require("../lib/rules/align.js")([...phrases, ...words]);
const C = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN, EXAMPLES: phrases });
const piece = (text, w) => (C.translate(text, "ru").pieces || []).find((p) => p.from.split(" ").includes(w));

// 1. перед наречием и предлогом — дополнение: та же форма, что у подлежащего «он / она» (именительный)
const nom = L.PRONOUNS[L.RU_PRONOUN_FORMS["его"][0]].nom;
for (const [text, w] of [["Я видел его вчера", "его"], ["Я люблю его очень", "его"], ["Я видел её в школе", "её"]]) {
  const p = piece(text, w) || piece(text, w.replace("ё", "е"));
  assert.ok(p, `${text}: кусок для «${w}»`);
  assert.strictEqual(p.to, nom, `${text}: «${w}» → «${p.to}», ждали дополнение «${nom}»`);
}
console.log(`ok 1: перед наречием и предлогом «его / её» — дополнение (${nom})`);

// 2. перед существительным — по-прежнему «чей»
for (const [text, w, gen] of [["Его дом", "его", L.PRONOUNS[L.RU_PRONOUN_FORMS["его"][0]].gen], ["Их дети", "их", L.PRONOUNS[L.RU_PRONOUN_FORMS["их"][0]].gen]]) {
  const p = piece(text, w);
  assert.ok(p && p.to === gen, `${text}: «${w}» → «${p && p.to}», ждали «${gen}»`);
}
console.log("ok 2: перед существительным «его / их» — родительный, как раньше");
console.log("Все проверки «его / её / их» прошли.");
