// Помогают ли пары предложений корпуса GhalghayTools таблице слов (lib/rules/align.js)?
//
// Замер scripts/eval-chunks.js (5 частей; проверяемая часть разговорника никогда не попадает в обучение)
// дважды: как есть и с короткими (до 12 слов с каждой стороны) хорошо выровненными парами корпуса,
// добавленными только в обучение таблицы слов. Корпус фильтруется так же, как в lib/corpus.js (тот же
// список отпечатков lib/corpus-keep.js); пары, совпадающие с любой фразой разговорника, выбрасываются,
// чтобы проверяемые фразы не попали в обучение через корпус.
//
// Корпус скачивается один раз и кладётся во временную папку системы (не в репозиторий).
//   node scripts/eval-align-corpus.js            — оба направления
//   node scripts/eval-align-corpus.js --min-q 5  — только пары с оценкой выравнивания ≥ 5 (0–9)

const fs = require("fs");
const os = require("os");
const path = require("path");
const CORPUS = require("../lib/corpus.js");
const { run } = require("./eval-chunks.js");
const KB = require("../lib/ingush-guide.js");
const SEED = require("../data/phrases.json");
const { toks } = require("../lib/rules/align.js");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MIN_Q = Number(arg("--min-q", 0));
const MAX_W = 12;
const CACHE = path.join(os.tmpdir(), `ingush-corpus-${CORPUS._blobKey}.json`);

// файловое «хранилище» вместо Netlify Blobs: корпус скачивается один раз
const fileStore = {
  get: async () => { try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; } },
  setJSON: async (_k, v) => fs.writeFileSync(CACHE, JSON.stringify(v)),
};

const key = (s) => toks(s).join(" ");

// короткие пары корпуса [ru, inh] без фраз разговорника
function corpusPairs(minQ = MIN_Q) {
  const book = new Set();
  for (const p of SEED) if (p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source)) { book.add(key(p.ru)); book.add(key(p.inh)); }
  for (const [ru, inh] of KB.EXAMPLES) { book.add(key(ru)); book.add(key(inh)); }
  const out = [];
  for (const [inh, ru, q] of CORPUS.pairs()) {
    const a = toks(inh), b = toks(ru);
    if (q < minQ || !a.length || !b.length || a.length > MAX_W || b.length > MAX_W) continue;
    if (book.has(a.join(" ")) || book.has(b.join(" "))) continue;
    out.push([ru, inh]);
  }
  return out;
}

async function main() {
  CORPUS._set({ store: fileStore });
  if (!(await CORPUS.ready(120000))) { console.error("корпус не загрузился"); process.exit(1); }
  const extra = corpusPairs();
  console.log(`Корпус: ${CORPUS.size()} пар, коротких (≤${MAX_W} слов, оценка ≥ ${MIN_Q}, без фраз разговорника): ${extra.length}`);
  const fmt = (r) => `переведено ${r.done}/${r.total}, слова на месте ${(100 * r.words).toFixed(1)}%, совпало ${r.same}`;
  for (const inh of [false, true]) {
    const before = run(true, inh), after = run(true, inh, {}, extra);
    console.log(`${inh ? "ингушский → русский" : "русский → ингушский"}`);
    console.log(`  без корпуса: ${fmt(before)}`);
    console.log(`  с корпусом:  ${fmt(after)}`);
  }
}

if (require.main === module) main();
module.exports = { corpusPairs };
