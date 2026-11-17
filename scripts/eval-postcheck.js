// Замер проверки «русские слова в ингушском переводе» (lib/postcheck.js): node scripts/eval-postcheck.js [--list]
//
// Разговорник PaydaDosh (около 7000 пар) прячем от проверки: его ингушская часть не попадает в список
// ингушских слов, которым мы верим. Потом:
//   ложные пометки — сколько слов настоящего ингушского текста из разговорника помечено как русские;
//   пойманные — сколько русских слов из тех же фраз помечено, если ИИ оставил бы их в переводе как есть.
// Отдельно: сколько слов из 155 000 словоформ ингушских текстов помечено как русские (их и ловим).
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const L = require("../lib/rules/lexicon.js");
const WORDS = require("../lib/ingush-words.js").split("\n");
const makePostcheck = require("../lib/postcheck.js");

const isBook = (p) => p.kind === "phrase" && /^PaydaDosh/.test(p.source || "");

function measure({ list = false } = {}) {
  const held = SEED.filter(isBook);
  const P = makePostcheck({ SEED: SEED.map((p) => (isBook(p) ? { ...p, inh: "" } : p)), KB, L });
  const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ");

  // ложные пометки на настоящем ингушском тексте
  let inhWords = 0;
  const falseHits = new Map();
  for (const p of held) {
    const ws = String(p.inh).match(/[Ѐ-ӿ]+(?:-[Ѐ-ӿ]+)*/g) || [];
    inhWords += ws.length;
    for (const w of P.russian(p.inh, p.ru)) falseHits.set(low(w), (falseHits.get(low(w)) || 0) + 1);
  }
  const falseCount = [...falseHits.values()].reduce((a, b) => a + b, 0);

  // пойманные: русские слова тех же фраз, оставленные ИИ в переводе (кроме общих для двух языков: «да», «из»).
  // Слово взято из исходного текста — проверка видит его там. Без исходного текста — только по словарю,
  // из которого эти фразы убраны целиком (как слово, которого словарь ещё не видел в этой фразе).
  const P2 = makePostcheck({ SEED: SEED.filter((p) => !isBook(p)), KB, L });
  const inhOfBook = new Set();
  for (const p of held) for (const w of low(p.inh).match(/[а-яӏ]+/g) || []) inhOfBook.add(w);
  let tried = 0, caught = 0, caughtSrc = 0;
  const missed = [];
  const seenRu = new Set();
  for (const p of held) {
    for (const w of low(p.ru).match(/[а-яӏ]+/g) || []) {
      if (w.length < 2 || seenRu.has(w) || inhOfBook.has(w) || P.isInh(w) || P2.isInh(w)) continue;
      seenRu.add(w);
      tried++;
      if (P.russian(w, p.ru).length) caughtSrc++;
      if (P2.russian(w, "").length) caught++; else missed.push(w);
    }
  }
  // словоформы ингушских текстов, которые на деле русские
  const full = makePostcheck({ SEED, KB, L });
  const corpusRu = WORDS.filter((w) => w && full.russian(w, "").length);

  const r = {
    phrases: held.length,
    inhWords,
    falseRate: falseCount / inhWords,
    falseTop: [...falseHits].sort((a, b) => b[1] - a[1]).slice(0, list ? 60 : 15),
    recall: caught / tried, recallSrc: caughtSrc / tried, tried, caught,
    missed: missed.slice(0, list ? 60 : 15),
    corpusRu: corpusRu.length, corpusTotal: WORDS.length,
    corpusSample: corpusRu.filter((_, i) => i % Math.max(1, Math.floor(corpusRu.length / (list ? 80 : 25))) === 0),
  };
  return r;
}

if (require.main === module) {
  const r = measure({ list: process.argv.includes("--list") });
  const pc = (x) => (x * 100).toFixed(1) + "%";
  console.log(`Разговорник PaydaDosh спрятан: ${r.phrases} фраз, ${r.inhWords} ингушских слов.`);
  console.log(`Ложные пометки (ингушское слово названо русским): ${pc(r.falseRate)}`);
  console.log(`  чаще всего: ${r.falseTop.map(([w, n]) => `${w} ${n}`).join(", ")}`);
  console.log(`Пойманные русские слова, если ИИ оставил слово из исходного текста: ${pc(r.recallSrc)} (из ${r.tried})`);
  console.log(`  …если такого слова в исходном тексте нет (только по словарю): ${pc(r.recall)} (${r.caught} из ${r.tried})`);
  console.log(`  не пойманы: ${r.missed.join(", ")}`);
  console.log(`Словоформы ингушских текстов, которые проверка считает русскими: ${r.corpusRu} из ${r.corpusTotal}`);
  console.log(`  например: ${r.corpusSample.join(", ")}`);
}

module.exports = { measure };
