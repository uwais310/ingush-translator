// Замер перевода «по кускам» (lib/rules/chunks.js) на разговорнике: фразы носителей против наших.
//
// Для каждой фразы разговорника (PaydaDosh, фразы справочника) модуль переводит её, не глядя на саму
// фразу целиком (иначе он просто нашёл бы готовый ответ). Считается:
//   «переведено» — фраза, где известно хотя бы полслова (иначе модуль молчит);
//   «слова на месте» — сколько слов нашего перевода есть в переводе носителя (точность по словам);
//   «совпало» — ровно как у носителя (без регистра, знаков и порядка слов).
//
//   node scripts/eval-chunks.js           — русский → ингушский
//   node scripts/eval-chunks.js --inh     — ингушский → русский
//   node scripts/eval-chunks.js --diff    — показать 40 примеров

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const CHUNKS = require("../lib/rules/chunks.js")({ RET, SEED });

const INH = process.argv.includes("--inh");
const SHOW = process.argv.includes("--diff");
const norm = (s) => String(s).replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/ё/g, "е")
  .replace(/[1lI|Ӏ]/g, "ӏ").replace(/[.,!?;:«»"—–…-]/g, " ").replace(/\s+/g, " ").trim();

function run(quiet = false, inh = INH) {
  const log = quiet ? () => {} : console.log;
  const src = inh ? "inh" : "ru";
  const refs = new Map();
  const add = (from, to) => { const k = norm(from); if (!k || k.split(" ").length < 2) return; if (!refs.has(k)) refs.set(k, { from, to: [] }); refs.get(k).to.push(to); };
  for (const p of SEED) {
    if (p.kind !== "phrase" || !/^(PaydaDosh|Справочник)/.test(p.source)) continue;
    inh ? add(p.inh, p.ru) : add(p.ru, p.inh);
  }
  for (const [ru, i] of KB.EXAMPLES) inh ? add(i, ru) : add(ru, i);

  let done = 0, same = 0, hitW = 0, allW = 0, shown = 0;
  for (const { from, to } of refs.values()) {
    const r = CHUNKS.translate(from, src, { noWhole: true });
    if (!r) continue;
    done++;
    const ours = norm(r.translation).split(" ").filter(Boolean);
    const refWords = new Set(to.flatMap((t) => norm(t).split(" ")));
    const good = ours.filter((w) => refWords.has(w)).length;
    hitW += good; allW += ours.length;
    const bag = (s) => norm(s).split(" ").sort().join(" ");
    if (to.some((t) => bag(t) === bag(r.translation))) same++;
    if (SHOW && shown < 40 && done % 7 === 0) { shown++; log(`${from}\n  наш:     ${r.translation}\n  носитель: ${to[0]}`); }
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0.0") + "%";
  log(`Фраз (от 2 слов): ${refs.size}. Переведено по кускам: ${done} (${pct(done, refs.size)}).`);
  log(`  слова на месте (есть в переводе носителя): ${pct(hitW, allW)}`);
  log(`  совпало целиком (порядок слов не важен):   ${same} (${pct(same, done)})`);
  return { total: refs.size, done, words: allW ? hitW / allW : 0, same };
}

if (require.main === module) run();
module.exports = { run };
