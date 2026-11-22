// Проверка «туда и обратно» (идея Увайса): русское предложение → ингушский → снова русский.
// Если смысл вернулся тот же, перевод, скорее всего, понял предложение; если нет — где-то взято не то значение слова.
//
// Смысл сравнивается по значимым словам: у каждого слова берётся начальная форма (lib/morph.js), служебные
// слова не считаются. «Сохранился» — вернулось не меньше 70 % значимых слов исходного предложения.
// Это грубая автоматическая оценка: синоним («кушать» ↔ «есть») она посчитает ошибкой, поэтому смотрите примеры глазами.
//
//   node scripts/check-roundtrip.js            — бытовые предложения из scripts/check-everyday.js
//   node scripts/check-roundtrip.js --all      — показать все предложения, а не только потерявшие смысл

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.fetch = async () => { throw new Error("no network"); };
delete process.env.USE_AI;
const T = require(path.join(ROOT, "api/translate.js"));
T._setStore({ get: async () => null, setJSON: async () => {} });
require(path.join(ROOT, "lib/corpus.js"))._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
const KB = require(path.join(ROOT, "lib/ingush-guide.js"));
const SEED = require(path.join(ROOT, "data/phrases.json"));
const RET = require(path.join(ROOT, "lib/retrieval.js"))({ KB, SEED, LEX: require(path.join(ROOT, "lib/corpus-lexicon.js")) });
const call = (body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve(o); } }; T({ method: "POST", body }, res); });

// предложения: русская часть списка из check-everyday.js (строки между RU = ` и `)
const src = fs.readFileSync(path.join(__dirname, "check-everyday.js"), "utf8");
const block = (/const RU = `([\s\S]*?)`/.exec(src) || [])[1] || "";
const SENT = ["Я хочу отвезти еду туда", ...block.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("//"))];

const STOP = new Set(["и", "в", "во", "на", "не", "с", "со", "к", "ко", "по", "за", "из", "у", "о", "об", "от", "до", "а", "но", "же", "ли", "бы",
  "что", "как", "это", "то", "так", "для", "я", "ты", "он", "она", "мы", "вы", "они", "оно", "мне", "тебе", "меня", "тебя", "его", "ее", "их",
  "нас", "вас", "им", "ему", "ей", "есть", "был", "была", "было", "были", "очень", "уже", "еще", "мой", "твой", "наш", "ваш", "свой", "этот"]);
const words = (s) => RET.wordsOf(s).filter((w) => !STOP.has(w) && !/^\[/.test(w));
const base = (w) => { const l = RET.lemmas(w, "ru"); return l.length ? l[0] : w; };
const keys = (s) => new Set(words(s).flatMap((w) => [w, base(w)]));

(async () => {
  const ALL = process.argv.includes("--all");
  let n = 0, kept = 0, empty = 0;
  const bad = [];
  for (const ru of SENT) {
    const a = await call({ text: ru, source: "ru", target: "inh", mode: ru.includes(" ") ? "text" : "word" });
    const inh = String(a.translation || "").replace(/\[[^\]]*\]/g, " ").trim();
    if (!inh) { empty++; continue; }
    const b = await call({ text: inh, source: "inh", target: "ru", mode: inh.includes(" ") ? "text" : "word" });
    const back = String(b.translation || "");
    const want = words(ru);
    if (!want.length) continue;
    n++;
    const got = keys(back);
    const hit = want.filter((w) => got.has(w) || got.has(base(w))).length;
    const ok = hit / want.length >= 0.7;
    if (ok) kept++; else bad.push({ ru, inh, back, hit, of: want.length });
    if (ALL || !ok) console.log(`${ok ? "ok " : "✗  "} ${ru}  →  ${inh}  →  ${back || "∅"}`);
  }
  console.log(`\nПредложений: ${n} (без перевода: ${empty}). Смысл вернулся: ${kept} (${(100 * kept / n).toFixed(1)}%), потерян: ${n - kept} (${(100 * (n - kept) / n).toFixed(1)}%).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
