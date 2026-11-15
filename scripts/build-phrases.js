// Собирает data/phrases.json — базу пар «русский — ингушский».
// Запуск: node scripts/build-phrases.js
//
// Источники:
//   1. lib/ingush-guide.js — проверенные по корпусу фразы и словарик проекта;
//   2. lib/corpus-lexicon.js — слова из настоящих текстов (только пары, которые подтверждают словари);
//   3. data/sources/*.json — выгрузки из других источников (например, PaydaDosh):
//      { "source": "PaydaDosh", "license": "...", "pairs": [{ "ru": "...", "inh": "..." }] }
//
// Чистка: палочка → Ӏ, дубли убираются, каждое ингушское слово должно встречаться в ингушских
// текстах (lib/ingush-words.js); пары с чеченскими формами в базу не идут.
// verified здесь всегда false: «проверено» ставит только человек на странице /review.

const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const BASE = require("../lib/base.js")(KB, LEX);
const WORDS = new Set(require("../lib/ingush-words.js").split("\n"));

const LOOK = "1Il|ІіΙⅠǀ";
const PAL = new RegExp("([\\u0400-\\u04FF])([" + LOOK + "])|([" + LOOK + "])(?=[\\u0400-\\u04FF])", "g");
const fixPal = (s) => String(s).replace(/ӏ/g, "Ӏ").replace(PAL, (m, a) => (a ? a + "Ӏ" : "Ӏ"));
const clean = (s) => String(s || "").replace(/[­​]/g, "").replace(/\s+/g, " ").trim();
// как в api/translate.js: без ударений и надстрочных знаков (в списке слов «й» записана как «и»)
const wkey = (w) => w.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC").toLowerCase().replace(/Ӏ/g, "ӏ");
const inhWords = (s) => (s.replace(/\([^()]*\)/g, " ").match(/[А-Яа-яЁёӀӏ]+/g) || []).map(wkey);
const CHECHEN = new Set(Object.keys(BASE.CHECHEN));

const out = new Map(), stats = {}, dropped = {};
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
// strict: проверять каждое ингушское слово по частотному словарю (для строк словарика с пояснениями — нет)
function add(kind, ru, inh, source, extra = {}, strict = true) {
  ru = clean(ru); inh = fixPal(clean(inh));
  if (!ru || !inh) return;
  const ws = inhWords(inh);
  if (ws.some((w) => CHECHEN.has(w))) return bump(dropped, `${source}: чеченская форма`);
  if (strict && ws.some((w) => w.length > 1 && !WORDS.has(w))) return bump(dropped, `${source}: слова нет в ингушских текстах`);
  const key = `${BASE.key(ru)}|${BASE.key(inh)}`;
  if (out.has(key)) return bump(dropped, `${source}: дубль`);
  const id = crypto.createHash("sha1").update(`${kind}\x01${ru}\x01${inh}`).digest("hex").slice(0, 10);
  out.set(key, { id, kind, ru, inh, ...extra, source, verified: false });
  bump(stats, source);
}

// 1. фразы справочника (варианты через « / » — отдельными парами)
const S_GUIDE = "Справочник проекта";
for (const [ru, inh] of KB.EXAMPLES) {
  const rs = ru.split(" / "), is = inh.split(" / ");
  const pairs = rs.length > 1 && rs.length === is.length ? rs.map((r, i) => [r, is[i]]) : rs.flatMap((r) => is.map((i) => [r, i]));
  for (const [r, i] of pairs) add("phrase", r, i, S_GUIDE);
}
// 2. словарик справочника: перевод + полная строка с классами и формами
for (const [ru, inh] of KB.GLOSSARY) {
  const g = BASE.gloss(inh);
  if (g.raw) add("word", ru, inh, S_GUIDE, {}, false);
  else add("word", ru, g.translation, S_GUIDE, g.note ? { note: g.note } : {});
}
// 3. слова из настоящих текстов, подтверждённые словарями (не реже 5 раз)
const S_TEXTS = "Корпус GhalghayTools (статистика слов)";
for (const w of LEX.keys("ru")) {
  const e = LEX.entry(w, "ru");
  const c = e && e.exact && e.list.find((x) => x.sure);
  if (c && c.n >= 5) add("word", e.key, c.text, S_TEXTS, { count: c.n });
}
// 4. выгрузки из других источников
const dir = path.join(ROOT, "data", "sources");
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort() : []) {
  const src = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  for (const p of src.pairs || []) add(p.kind || "phrase", p.ru, p.inh, src.source || f.replace(/\.json$/, ""));
}

const list = [...out.values()];
fs.writeFileSync(path.join(ROOT, "data", "phrases.json"), "[\n" + list.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n");
console.log("пар в базе:", list.length, stats);
console.log("не вошли:", dropped);
