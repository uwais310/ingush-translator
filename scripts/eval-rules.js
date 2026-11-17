// Замер перевода по правилам: правила против переводов носителей из разговорника.
//
// Для каждой русской фразы базы (разговорник PaydaDosh, фразы справочника) правила пробуют собрать перевод.
// Если собрали — перевод сравнивается со всеми переводами этой фразы в базе (регистр, знаки препинания
// и пометки в скобках не учитываются; вариант для мужчины или женщины тоже засчитывается).
//
//   node scripts/eval-rules.js            — итог по каждому правилу
//   node scripts/eval-rules.js --diff     — показать все фразы, где правила ответили не так, как в базе
//
// «Совпало» — ровно как у носителя. «Те же слова» — те же слова в другом порядке (в ингушском порядок
// слов свободнее, оба варианта обычно правильные). Остальное надо смотреть глазами: там бывают и ошибки
// правил, и просто другой правильный перевод.

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const WORDS = require("../lib/ingush-words.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const RULES = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS });

const SHOW = process.argv.includes("--diff");
const norm = (s) => String(s).replace(/\([^()]*\)/g, " ").toLowerCase().replace(/ё/g, "е").replace(/[1lI|ӏ]/g, "Ӏ".toLowerCase())
  .replace(/Ӏ/g, "ӏ").replace(/[.,!?;:«»"—–…-]/g, " ").replace(/\s+/g, " ").trim();
const bag = (s) => norm(s).split(" ").sort().join(" ");

function run(quiet = false) {
  const log = quiet ? () => {} : console.log;
  // все переводы каждой русской фразы
  const refs = new Map();
  for (const p of SEED) {
    if (p.kind !== "phrase" || !/^(PaydaDosh|Справочник)/.test(p.source)) continue;
    const k = norm(p.ru);
    if (!refs.has(k)) refs.set(k, { ru: p.ru, inh: [] });
    refs.get(k).inh.push(p.inh);
  }
  for (const [ru, inh] of KB.EXAMPLES) {
    const k = norm(ru);
    if (!refs.has(k)) refs.set(k, { ru, inh: [] });
    refs.get(k).inh.push(inh);
  }
  const by = new Map();
  let total = 0, done = 0, exact = 0, same = 0;
  const diffs = [];
  for (const { ru, inh } of refs.values()) {
    total++;
    const r = RULES.translate(ru);
    if (!r) continue;
    done++;
    const st = by.get(r.rule) || { n: 0, exact: 0, same: 0 };
    st.n++;
    const ours = r.variants.map((v) => v.text);
    const hitExact = ours.some((o) => inh.some((x) => norm(x) === norm(o)));
    const hitSame = hitExact || ours.some((o) => inh.some((x) => bag(x) === bag(o)));
    if (hitExact) { exact++; st.exact++; }
    if (hitSame) { same++; st.same++; }
    if (!hitSame) diffs.push(`${ru}\n    правила: ${ours.join(" | ")}   [${r.rule}]\n    в базе:  ${inh.join(" | ")}`);
    by.set(r.rule, st);
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "—");
  log(`Фраз в базе: ${total}. Правила перевели: ${done} (${pct(done, total)}).`);
  log(`  совпало с переводом носителя:          ${exact} (${pct(exact, done)})`);
  log(`  совпало или те же слова в другом порядке: ${same} (${pct(same, done)})`);
  for (const [id, st] of [...by].sort((a, b) => b[1].n - a[1].n)) log(`  ${id.padEnd(12)} ${String(st.n).padStart(4)} фраз, совпало ${pct(st.exact, st.n)}, те же слова ${pct(st.same, st.n)}`);
  if (SHOW) log("\nНе совпало:\n" + diffs.join("\n"));
  return { total, done, exact, same, diffs };
}

if (require.main === module) run();
else module.exports = { run };
