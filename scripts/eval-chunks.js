// Замер перевода «по кускам» (lib/rules/chunks.js) на разговорнике: фразы носителей против наших.
//
// Для каждой фразы разговорника (PaydaDosh, фразы справочника) модуль переводит её, не глядя на саму
// фразу целиком (иначе он просто нашёл бы готовый ответ). Таблица слов из пар фраз (lib/rules/align.js)
// учится честно, по частям: фразы делятся на 5 частей, и каждая часть переводится таблицей, выученной
// на остальных четырёх (фраза никогда не видит саму себя).
//   «переведено» — фраза, где известно хотя бы полслова (иначе модуль молчит);
//   «слова на месте» — сколько слов нашего перевода есть в переводе носителя (точность по словам);
//   «совпало» — ровно как у носителя (без регистра, знаков и порядка слов).
//
//   node scripts/eval-chunks.js           — русский → ингушский
//   node scripts/eval-chunks.js --inh     — ингушский → русский
//   node scripts/eval-chunks.js --diff    — показать 40 примеров
//   node scripts/eval-chunks.js --no-align — без таблицы слов (как было)

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const makeChunks = require("../lib/rules/chunks.js");
const makeAlign = require("../lib/rules/align.js");

const INH = process.argv.includes("--inh");
const SHOW = process.argv.includes("--diff");
const NO_ALIGN = process.argv.includes("--no-align");
const FOLDS = 5;
// --dump файл.json — сохранить все переводы (для сравнения версий)
const DUMP = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;
const norm = (s) => String(s).replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/ё/g, "е")
  .replace(/[1lI|Ӏ]/g, "ӏ").replace(/[.,!?;:«»"—–…-]/g, " ").replace(/\s+/g, " ").trim();

// пары для обучения таблицы слов: фразы разговорника и словарные записи (без самой проверяемой фразы)
const phrasePairs = () => SEED.filter((p) => p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source)).map((p) => [p.ru, p.inh]);
const wordPairs = () => [
  ...SEED.filter((p) => p.kind === "word" && /^(PaydaDosh|Справочник)/.test(p.source)).map((p) => [p.ru, p.inh]),
  ...KB.GLOSSARY.map(([ru, inh]) => [ru, inh]),
];

// extra — дополнительные пары [ru, inh] только для обучения таблицы слов (например, корпус; scripts/eval-align-corpus.js)
function run(quiet = false, inh = INH, tune = {}, extra = []) {
  const log = quiet ? () => {} : console.log;
  const src = inh ? "inh" : "ru";
  const refs = new Map();
  const add = (from, to) => { const k = norm(from); if (!k || k.split(" ").length < 2) return; if (!refs.has(k)) refs.set(k, { from, to: [] }); refs.get(k).to.push(to); };
  for (const p of SEED) {
    if (p.kind !== "phrase" || !/^(PaydaDosh|Справочник)/.test(p.source)) continue;
    inh ? add(p.inh, p.ru) : add(p.ru, p.inh);
  }
  for (const [ru, i] of KB.EXAMPLES) inh ? add(i, ru) : add(ru, i);
  const items = [...refs.values()];

  // часть, в которой фраза проверяется: по самой фразе (одна и та же фраза — всегда в одной части)
  const foldOf = (s) => { let h = 0; for (const ch of norm(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % FOLDS; };
  const allPhrases = phrasePairs(), words = wordPairs();
  const chunksFor = [];
  for (let f = 0; f < FOLDS; f++) {
    let ALIGN = null, train = null;
    if (!NO_ALIGN) {
      train = allPhrases.filter(([ru, i]) => foldOf(inh ? i : ru) !== f);
      for (const [ru, i] of KB.EXAMPLES) if (foldOf(inh ? i : ru) !== f) train.push([ru, i]);
      ALIGN = makeAlign([...train, ...words, ...extra]);
    }
    chunksFor.push(makeChunks({ RET, SEED, ALIGN, EXAMPLES: train, tune }));
  }

  let done = 0, same = 0, hitW = 0, allW = 0, shown = 0;
  const dump = [];
  for (const { from, to } of items) {
    const r = chunksFor[foldOf(from)].translate(from, src, { noWhole: true });
    if (!r) continue;
    done++;
    const ours = norm(r.translation).split(" ").filter(Boolean);
    const refWords = new Set(to.flatMap((t) => norm(t).split(" ")));
    const good = ours.filter((w) => refWords.has(w)).length;
    hitW += good; allW += ours.length;
    const bag = (s) => norm(s).split(" ").sort().join(" ");
    const ok = to.some((t) => bag(t) === bag(r.translation));
    if (ok) same++;
    if (DUMP) dump.push({ from, ours: r.translation, ref: to[0], same: ok, good, n: ours.length });
    if (SHOW && shown < 40 && done % 7 === 0) { shown++; log(`${from}\n  наш:     ${r.translation}\n  носитель: ${to[0]}`); }
  }
  if (DUMP && !quiet) require("fs").writeFileSync(DUMP, JSON.stringify(dump, null, 1));
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0.0") + "%";
  log(`Фраз (от 2 слов): ${refs.size}. Переведено по кускам: ${done} (${pct(done, refs.size)}).`);
  log(`  слова на месте (есть в переводе носителя): ${pct(hitW, allW)}`);
  log(`  совпало целиком (порядок слов не важен):   ${same} (${pct(same, done)})`);
  return { total: refs.size, done, words: allW ? hitW / allW : 0, same };
}

if (require.main === module) run();
module.exports = { run, phrasePairs, wordPairs };
