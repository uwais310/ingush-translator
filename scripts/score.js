// Общий счёт переводчика без ИИ одной командой: правила, перевод по словам (в обе стороны) и «туда-обратно».
// Запускает готовые замеры (scripts/eval-rules.js, eval-chunks.js, check-roundtrip.js) и сводит их в таблицу.
// Сравнивайте числа до и после изменения: ни одно не должно упасть.
//
//   node scripts/score.js            — все замеры (несколько минут)
//   node scripts/score.js --json     — то же, но одной строкой JSON (удобно сохранить и сравнить)

const { execFileSync } = require("child_process");
const path = require("path");

// Что запускать и какие числа брать из вывода. Каждое число — первая скобка с процентами в нужной строке.
const PARTS = [
  { id: "rules", name: "Правила ru→inh, совпало с носителем", script: "eval-rules.js", args: [], line: /совпало с переводом носителя/ },
  { id: "chunks_ru", name: "По словам ru→inh, слова на месте", script: "eval-chunks.js", args: [], line: /слова на месте/ },
  { id: "chunks_inh", name: "По словам inh→ru, слова на месте", script: "eval-chunks.js", args: ["--inh"], line: /слова на месте/ },
  { id: "roundtrip", name: "Туда-обратно ru→inh→ru, смысл вернулся", script: "check-roundtrip.js", args: [], line: /Смысл вернулся/ },
];

// «  совпало с переводом носителя:   53 (68.8%)» → 68.8; «Смысл вернулся: 55 (58.5%)» → 58.5
function pick(out, re) {
  const l = String(out).split("\n").find((x) => re.test(x));
  if (!l) return null;
  const m = /(\d+(?:\.\d+)?)%/.exec(l.slice(l.search(re)));
  return m ? Number(m[1]) : null;
}

function run() {
  const rows = [];
  for (const p of PARTS) {
    let out = "";
    try {
      out = execFileSync(process.execPath, [path.join(__dirname, p.script), ...p.args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    } catch (e) { out = String(e.stdout || ""); }
    rows.push({ id: p.id, name: p.name, pct: pick(out, p.line) });
  }
  return rows;
}

if (require.main === module) {
  const rows = run();
  if (process.argv.includes("--json")) console.log(JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.pct]))));
  else for (const r of rows) console.log(`${r.name.padEnd(42)} ${r.pct === null ? "—" : r.pct.toFixed(1) + "%"}`);
}
module.exports = { pick, PARTS, run };
