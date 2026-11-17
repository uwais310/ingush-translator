// Собирает data/phrases.json — базу пар «русский — ингушский».
// Запуск: node scripts/build-phrases.js
//
// Источники:
//   1. lib/ingush-guide.js — проверенные по корпусу фразы и словарик проекта;
//   2. lib/corpus-lexicon.js — слова из настоящих текстов (только пары, которые подтверждают словари);
//   3. data/sources/*.json — выгрузки из открытых источников (их скачивает scripts/fetch-open-sources.py,
//      список и лицензии — в SOURCES.md):
//      { "source": "PanLex", "license": "CC0 1.0", "url": "...", "pairs": [{ "kind": "word", "ru": "...", "inh": "...", "note"?: "..." }] }
//      kind: "word" — словарная статья, "phrase" — фраза или предложение, "name" — имя собственное.
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

// Ключ для дублей — как было до учёта ударений в lib/base.js: «ва́ла» и «вала» — разные записи,
// иначе пересборка выкинула бы уже существующие записи (и их id, по которым хранятся решения /review).
const dkey = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/\([^()]*\)/g, " ").replace(/[^а-яӏa-z0-9]+/g, " ").trim();
const out = new Map(), stats = {}, dropped = {};
// id прежних записей не меняются: по ним хранятся решения носителя с /review. Если ту же пару теперь
// первым даёт другой источник (например, PaydaDosh вместо PanLex), id берётся из старого data/phrases.json.
const OLD_IDS = new Map();
try {
  for (const p of JSON.parse(fs.readFileSync(path.join(ROOT, "data", "phrases.json"), "utf8")))
    OLD_IDS.set(`${dkey(clean(p.ru))}|${dkey(fixPal(clean(p.inh)))}`, p.id);
} catch {}
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
// strict: проверять каждое ингушское слово по частотному словарю (для строк словарика с пояснениями — нет)
function add(kind, ru, inh, source, extra = {}, strict = true) {
  ru = clean(ru); inh = fixPal(clean(inh));
  if (!ru || !inh) return;
  const ws = inhWords(inh);
  if (ws.some((w) => CHECHEN.has(w))) return bump(dropped, `${source}: чеченская форма`);
  if (strict && ws.some((w) => w.length > 1 && !WORDS.has(w))) return bump(dropped, `${source}: слова нет в ингушских текстах`);
  const key = `${dkey(ru)}|${dkey(inh)}`;
  if (out.has(key)) {
    // та же пара из другого источника — запомним и его (так видно, что пару подтверждают двое)
    const prev = out.get(key);
    if (prev.source !== source && extra.license) {
      prev.also = [...new Set([...(prev.also || []), source])];
    }
    return bump(dropped, `${source}: дубль`);
  }
  const id = OLD_IDS.get(key) || crypto.createHash("sha1").update(`${kind}\x01${ru}\x01${inh}`).digest("hex").slice(0, 10);
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
// 4. выгрузки из источников (data/sources/*.json). Порядок — от более надёжных к менее
//    (проверено носителем > словарь проекта > PaydaDosh > Викисловарь > Википедия/Викиданные > PanLex >
//    корпус > translatewiki): при дубле остаётся запись первого источника, остальные пишутся в поле also,
//    а на сайте (api/translate.js, seedSource) подпись и надёжность берутся по самому надёжному из них.
//    Каждое ингушское слово должно встречаться в ингушских текстах (кроме имён собственных);
//    чеченские формы не берём ни из какого источника.
const ORDER = ["paydadosh", "ruwiktionary", "inhwiki", "wikidata", "panlex", "translatewiki"];
const dir = path.join(ROOT, "data", "sources");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".json")) : [];
const rank = (f) => { const i = ORDER.indexOf(f.replace(/\.json$/, "")); return i < 0 ? ORDER.length : i; };
files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
for (const f of files) {
  const src = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const name = src.source || f.replace(/\.json$/, "");
  for (const p of src.pairs || []) {
    const kind = p.kind || "phrase";
    const extra = { license: src.license || "" };
    if (p.note) extra.note = p.note;
    // «Дог Ӏаткъаш / Дега Ӏаткъаш» при одном русском — отдельные пары (как во фразах справочника)
    const variants = / \/ /.test(p.inh) && !/ \/ /.test(p.ru) ? p.inh.split(" / ") : [p.inh];
    for (const inh of variants) add(kind, p.ru, inh, name, extra, src.strict !== false && kind !== "name");
  }
}

// 5. Пометки внутри ингушского текста — в поле note, чтобы их не копировали вместе с переводом:
//    «Со цӀа воал. (говорит мужчина)» → inh «Со цӀа воал.», note «говорит мужчина»;
//    «Бага ваха (й, б, д)» → inh «Бага ваха», note «й, б, д» (классы). Ингушские слова не меняются,
//    варианты слов в скобках («(шун)», «(еза)») остаются в тексте. id не меняются.
//    У PaydaDosh раздел сайта («разговорник: уроки (УРОКИ)») хранится отдельно, в поле section.
//    Записи словаря проекта не трогаем: их note — строка словаря целиком.
const CLASS_NOTE = /^[вйдби](?:\s*[,/]\s*[вйдби])*$/i;
const RU_NOTE = /^(говорит (мужчина|женщина)|к (мужчине|женщине|нескольким|старшему|младшему|ребёнку|детям|1 человеку|одному человеку)|к нескольким|вежливо|объект (мужчина|женщина)|о мужч\.\/жен\.[^()]*|домой|мн\.|ед\.|усиленная просьба|прямо сейчас|как-нибудь)$/i;
const isNote = (c) => c.split(/\s*·\s*/).every((x) => CLASS_NOTE.test(x.trim()) || RU_NOTE.test(x.trim()));
const moved = { note: 0, section: 0 };
for (const [k, p] of out) {
  if (!p.license) continue;
  let section;
  if (/^PaydaDosh,\s*/.test(p.note || "")) { section = p.note.replace(/^PaydaDosh,\s*/, ""); delete p.note; moved.section++; }
  const notes = [];
  const inh = p.inh.replace(/\s*\(([^()]*)\)/g, (m, c) => (isNote(c.trim()) ? (notes.push(c.trim().replace(/\s*,\s*/g, ", ")), " ") : m))
    .replace(/\s+([.!?,;:])/g, "$1").replace(/\s+/g, " ").trim();
  let note = p.note;
  if (notes.length && inh) {
    const parts = notes.map((n) => (CLASS_NOTE.test(n) && (notes.length > 1 || note) ? `класс ${n}` : n));
    note = [...parts, note].filter(Boolean).join("; ");
    moved.note++;
  }
  const { id, kind, ru, source, verified, note: _n, inh: _i, ...rest } = p;
  out.set(k, { id, kind, ru, inh: notes.length && inh ? inh : p.inh, ...(note ? { note } : {}), ...(section ? { section } : {}), ...rest, source, verified });
}

const list = [...out.values()];
fs.writeFileSync(path.join(ROOT, "data", "phrases.json"), "[\n" + list.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n");
console.log("пар в базе:", list.length, stats);
console.log("пометки из ингушского текста перенесены в note:", moved.note, "· разделы PaydaDosh перенесены в section:", moved.section);
console.log("не вошли:", dropped);
