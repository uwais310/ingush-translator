// Замер «туда и обратно»: русский → ингушский → русский и ингушский → русский → ингушский, без ИИ.
//
// Берутся фразы разговорника (PaydaDosh, справочник; от 2 слов) и переводятся модулем «по кускам»
// (lib/rules/chunks.js) туда, а затем результат — обратно. Как в scripts/eval-chunks.js, фраза никогда не
// видит саму себя: фразы делятся на 5 частей по исходной фразе, и обе половины пути переводятся таблицей
// слов, выученной на остальных четырёх частях. Слова, оставшиеся [в скобках] (не найдены), считаются
// потерянными и обратно не передаются — иначе русское слово «вернулось» бы само собой.
//
//   «слов вернулось» — доля слов исходной фразы, которые есть в обратном переводе (то же слово или та же
//                      начальная форма: «маму» ≈ «мама»);
//   «вернулась целиком» — вернулись все слова фразы.
//
// Это проверка согласованности, а не правильности: ошибка, сделанная одинаково в обе стороны, её пройдёт.
// Правильность меряют scripts/eval-rules.js и scripts/eval-chunks.js (сравнение с переводами носителей).
//
//   node scripts/eval-roundtrip.js         — русский → ингушский → русский
//   node scripts/eval-roundtrip.js --inh   — ингушский → русский → ингушский
//   node scripts/eval-roundtrip.js --diff  — показать 30 примеров, где вернулось меньше половины слов

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const makeChunks = require("../lib/rules/chunks.js");
const makeAlign = require("../lib/rules/align.js");
const { phrasePairs, wordPairs } = require("./eval-chunks.js");

const FOLDS = 5;
const norm = (s) => String(s).replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/ё/g, "е")
  .replace(/[1lI|Ӏ]/g, "ӏ").replace(/[.,!?;:«»"—–…-]/g, " ").replace(/\s+/g, " ").trim();
const foldOf = (s) => { let h = 0; for (const ch of norm(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % FOLDS; };

function run(quiet = false, inh = process.argv.includes("--inh"), show = process.argv.includes("--diff")) {
  const log = quiet ? () => {} : console.log;
  const src = inh ? "inh" : "ru", mid = inh ? "ru" : "inh";
  // исходные фразы: та сторона пары, с которой начинаем; пометки в скобках («(говорит уходящий)») —
  // не часть фразы, их не переводим
  const items = new Map();
  for (const [ru, i] of [...phrasePairs(), ...KB.EXAMPLES.map(([r, x]) => [r, x])]) {
    const from = String(inh ? i : ru).replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
    const k = norm(from);
    if (k && k.split(" ").length >= 2 && !items.has(k)) items.set(k, from);
  }
  const allPhrases = phrasePairs(), words = wordPairs();
  const chunksFor = [];
  for (let f = 0; f < FOLDS; f++) {
    const train = allPhrases.filter(([ru, i]) => foldOf(inh ? i : ru) !== f);
    for (const [ru, i] of KB.EXAMPLES) if (foldOf(inh ? i : ru) !== f) train.push([ru, i]);
    chunksFor.push(makeChunks({ RET, SEED, ALIGN: makeAlign([...train, ...words]), EXAMPLES: train }));
  }

  // слово вернулось: то же слово или общая начальная форма
  const lemmaCache = new Map();
  const keys = (w) => {
    if (!lemmaCache.has(w)) lemmaCache.set(w, new Set([w, ...RET.lemmas(w, src).map(norm)]));
    return lemmaCache.get(w);
  };
  const back = (w, outKeys) => [...keys(w)].some((k) => outKeys.has(k));

  let there = 0, both = 0, whole = 0, hit = 0, all = 0, shown = 0;
  for (const from of items.values()) {
    const ws = norm(from).split(" ").filter(Boolean);
    all += ws.length;
    const C = chunksFor[foldOf(from)];
    const r1 = C.translate(from, src, { noWhole: true });
    if (!r1) continue;
    there++;
    const midText = String(r1.translation).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    const r2 = midText ? C.translate(midText, mid, { noWhole: true }) : null;
    if (!r2) continue;
    both++;
    const outKeys = new Set();
    for (const w of norm(r2.translation).split(" ").filter(Boolean)) for (const k of keys(w)) outKeys.add(k);
    const got = ws.filter((w) => back(w, outKeys)).length;
    hit += got;
    if (got === ws.length) whole++;
    if (show && shown < 30 && got * 2 < ws.length) { shown++; log(`${from}\n  туда:     ${r1.translation}\n  обратно:  ${r2.translation}`); }
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0.0") + "%";
  log(`${src}→${mid}→${src}. Фраз (от 2 слов): ${items.size}. Переведено туда: ${there}, туда и обратно: ${both} (${pct(both, items.size)}).`);
  log(`  слов вернулось (из всех слов всех фраз): ${pct(hit, all)}`);
  log(`  фраза вернулась целиком:                 ${whole} (${pct(whole, items.size)})`);
  return { total: items.size, there, both, words: all ? hit / all : 0, whole };
}

if (require.main === module) run();
module.exports = { run };
