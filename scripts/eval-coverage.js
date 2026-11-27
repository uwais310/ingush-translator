// Сколько коротких фраз переводят правила (а не перевод по словам) и насколько верно.
//
// Берутся короткие фразы разговорника (PaydaDosh, справочник; 2–5 слов) — похоже на то, что пишут на сайте.
// Для каждой: ответили ли правила (lib/rules/grammar.js — русский → ингушский, reverse.js — ингушский → русский),
// совпал ли ответ с переводом носителя (или те же слова в другом порядке), и кто ответил бы без правил —
// перевод по словам (lib/rules/chunks.js, без самой фразы целиком). Так видно долю «правила против по словам»
// после базы — как в api/translate.js (resolveExact: база → правила → по словам).
//
//   node scripts/eval-coverage.js           — обе стороны
//   node scripts/eval-coverage.js --miss    — ещё и самые частые виды фраз, которые правила пропускают

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const WORDS = require("../lib/ingush-words.js");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const RULES = require("../lib/rules/index.js")({ RET, KB, SEED, WORDS });
const CH = require("../lib/rules/chunks.js")({ RET, SEED });
const L = require("../lib/rules/lexicon.js");

const MISS = process.argv.includes("--miss");
const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ");
const norm = (s) => low(String(s).replace(/\([^()]*\)/g, " ")).replace(/[.,!?;:«»"—–…-]/g, " ").replace(/\s+/g, " ").trim();
const bag = (s) => norm(s).split(" ").sort().join(" ");

function pairs() {
  const out = [];
  for (const p of SEED) if (p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source) && !p.rare) out.push([p.ru, p.inh]);
  for (const [ru, inh] of KB.EXAMPLES) out.push([ru, inh]);
  return out;
}

// вид русской фразы — для поиска того, чего не хватает правилам
const RU_PRON = new Set(Object.keys(L.RU_PRONOUN_FORMS || {}));
function shape(ru) {
  const ws = norm(ru).split(" ");
  const tag = (w) => (RU_PRON.has(w) ? "PRON" : L.QUESTION_WORDS[w] ? "Q:" + w : w === "не" ? "НЕ" : w === "у" ? "У" : w === "это" ? "ЭТО"
    : /(ть|ться|ти)$/.test(w) ? "INF" : /(л|ла|ло|ли|лся|лась|лись)$/.test(w) ? "PAST" : /(ю|у|ешь|ет|ем|ете|ют|ут|ишь|ит|им|ите|ят|ат)$/.test(w) ? "V?" : "w");
  return ws.map(tag).join(" ");
}

function side(dir) {
  const refs = new Map();
  for (const [ru, inh] of pairs()) {
    const from = dir === "ru" ? ru : inh, to = dir === "ru" ? inh : ru;
    for (const alt of dir === "inh" ? String(from).split(/\s*\/\s*/) : [from]) {
      const k = norm(alt);
      const n = k.split(" ").length;
      if (n < 2 || n > 5) continue;
      if (!refs.has(k)) refs.set(k, { from: alt, to: [] });
      refs.get(k).to.push(to);
    }
  }
  let total = 0, rules = 0, exact = 0, same = 0, chunks = 0;
  const misses = new Map();
  for (const { from, to } of refs.values()) {
    total++;
    const r = dir === "ru" ? RULES.translate(from) : RULES.translateInh(from);
    if (r) {
      rules++;
      const ours = r.variants.map((v) => v.text);
      if (ours.some((o) => to.some((x) => norm(x) === norm(o)))) exact++;
      if (ours.some((o) => to.some((x) => bag(x) === bag(o)))) same++;
      continue;
    }
    if (CH.translate(from, dir, { noWhole: true })) chunks++;
    if (dir === "ru") { const s = shape(from); misses.set(s, (misses.get(s) || []).concat([from])); }
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "—");
  const name = dir === "ru" ? "русский → ингушский" : "ингушский → русский";
  console.log(`${name}: коротких фраз ${total}. Правила ответили: ${rules} (${pct(rules, total)}); по словам: ${chunks} (${pct(chunks, total)}).`);
  console.log(`  где ответили правила — совпало с носителем: ${pct(exact, rules)}, те же слова: ${pct(same, rules)}`);
  console.log(`  доля правил среди ответов без базы: ${pct(rules, rules + chunks)}`);
  if (MISS && dir === "ru") {
    console.log("  чаще всего правила пропускают (вид фразы — сколько — пример):");
    for (const [s, list] of [...misses].sort((a, b) => b[1].length - a[1].length).slice(0, 40)) console.log(`    ${String(list.length).padStart(4)}  ${s.padEnd(28)} ${list.slice(0, 3).join(" | ")}`);
  }
  return { total, rules, exact, same, chunks };
}

if (require.main === module) { side("ru"); side("inh"); }
module.exports = { side };
