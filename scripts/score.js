// Общий счёт перевода без ИИ одной командой: обе стороны и «туда и обратно».
//
//   node scripts/score.js              — таблица
//   node scripts/score.js --json f.json — и сохранить цифры (для сравнения до/после)
//
// Что входит (подробности — в каждом скрипте):
//   правила      — scripts/eval-rules.js: правила против переводов носителей из разговорника;
//   по кускам    — scripts/eval-chunks.js: перевод по словам, фраза не видит саму себя (5 частей);
//   туда-обратно — scripts/eval-roundtrip.js: согласованность, не правильность;
//   бытовые      — scripts/check-everyday.js: весь путь сервера без ИИ на ~466 бытовых предложениях,
//                  сколько ответов с явной поломкой (слово в [скобках], русское слово в ингушском,
//                  пояснения словаря, пустой ответ и т. п.; кроме «pb-near»).
// Ничего не меняет в коде и данных; к ИИ не обращается.
delete process.env.USE_AI;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const pct = (x) => (100 * x).toFixed(1) + "%";
const rules = require("./eval-rules.js");
const chunks = require("./eval-chunks.js");
const trip = require("./eval-roundtrip.js");

const out = {};
for (const [dir, inh] of [["ru→inh", false], ["inh→ru", true]]) {
  const r = rules.run(true, inh), c = chunks.run(true, inh), t = trip.run(true, inh, false);
  out[dir] = {
    rules: { fired: r.done, exact: r.done ? r.exact / r.done : 0, sameWords: r.done ? r.same / r.done : 0 },
    chunks: { done: c.done, total: c.total, wordsInPlace: c.words, whole: c.done ? c.same / c.done : 0 },
    roundTrip: { total: t.total, words: t.words, whole: t.total ? t.whole / t.total : 0 },
  };
}

// бытовые предложения: весь путь сервера (отдельным процессом — у скрипта свой запуск)
const tmp = path.join(os.tmpdir(), `score-everyday-${process.pid}.json`);
execFileSync(process.execPath, [path.join(__dirname, "check-everyday.js"), "--json", tmp], { stdio: "ignore", maxBuffer: 1 << 26 });
const every = JSON.parse(fs.readFileSync(tmp, "utf8"));
fs.unlinkSync(tmp);
for (const [dir, src] of [["ru→inh", "ru"], ["inh→ru", "inh"]]) {
  const rs = every.filter((r) => r.src === src);
  const n = (fs) => rs.filter((r) => r.flags.some((f) => fs.includes(f))).length;
  out[dir].everyday = {
    total: rs.length,
    broken: rs.filter((r) => r.flags.some((f) => f !== "pb-near")).length,
    leak: n(["explain", "russian", "ingush-left"]), // пояснения словаря или слова другого языка в ответе
    unknown: n(["bracket", "empty"]), // слово не найдено или ответа нет
  };
}

const rows = [
  ["правила: совпало с носителем", (d) => `${pct(d.rules.exact)} из ${d.rules.fired}`],
  ["правила: те же слова", (d) => pct(d.rules.sameWords)],
  ["по кускам: слова на месте", (d) => pct(d.chunks.wordsInPlace)],
  ["по кускам: совпало целиком", (d) => pct(d.chunks.whole)],
  ["туда-обратно: слов вернулось", (d) => pct(d.roundTrip.words)],
  ["туда-обратно: фраза целиком", (d) => pct(d.roundTrip.whole)],
  ["бытовые: с любым флагом (меньше — лучше)", (d) => `${d.everyday.broken} из ${d.everyday.total}`],
  ["  — пояснения / чужой язык в ответе", (d) => String(d.everyday.leak)],
  ["  — слово не найдено / пусто", (d) => String(d.everyday.unknown)],
];
console.log(`${"".padEnd(42)}${"ru→inh".padEnd(16)}inh→ru`);
for (const [name, f] of rows) console.log(`${name.padEnd(42)}${f(out["ru→inh"]).padEnd(16)}${f(out["inh→ru"])}`);
const i = process.argv.indexOf("--json");
if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 1));
