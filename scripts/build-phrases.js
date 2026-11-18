// Собирает data/phrases.json — базу пар «русский — ингушский».
// Запуск: node scripts/build-phrases.js            (с --why — примеры отброшенных пар в /tmp/phrases-why.json)
//
// Источники:
//   1. lib/ingush-guide.js — проверенные по корпусу фразы и словарик проекта;
//   2. lib/corpus-lexicon.js — слова из настоящих текстов (только пары, которые подтверждают словари);
//   3. data/sources/*.json — выгрузки из открытых источников (их скачивает scripts/fetch-open-sources.py,
//      список и лицензии — в SOURCES.md):
//      { "source": "PanLex", "license": "CC0 1.0", "url": "...", "pairs": [{ "kind": "word", "ru": "...", "inh": "...", "note"?: "..." }] }
//      kind: "word" — словарная статья, "phrase" — фраза или предложение, "name" — имя собственное.
//
// Чистка: палочка → Ӏ, латинские буквы-двойники → русские, номера страниц и пунктов, имена в диалогах,
// ингушский текст в русском поле, разбор грамматики вместо перевода; дубли убираются; пары с чеченскими
// формами в базу не идут. Каждое ингушское слово должно встречаться в ингушских текстах
// (lib/ingush-words.js); для PaydaDosh и Викисловаря есть второй проход (пункт 5 ниже) — пары с формами,
// которых в текстах нет, но которые подтверждает другой словарь или похожая форма из текстов (rare: true).
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
// пометки внутри текста («(говорит мужчина)», «(й, б, д)») уходят в поле note — lib/notes.js
const { splitNotes, cleanPair, NOTE_INH, NOTE_RU } = require("../lib/notes.js");
// как в api/translate.js: без ударений и надстрочных знаков (в списке слов «й» записана как «и»)
const noMarks = (s) => String(s).normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC");
const wkey = (w) => noMarks(w).toLowerCase().replace(/Ӏ/g, "ӏ");
// Ударения убираются до деления на слова: раньше «шо́взткъа» делилось на «шо» и «взткъа»,
// и словарные статьи с ударением выпадали как «слова нет в текстах».
const inhWords = (s) => (noMarks(s).replace(/\([^()]*\)/g, " ").match(/[А-Яа-яЁёӀӏ]+/g) || []).map(wkey);
const CHECHEN = new Set(Object.keys(BASE.CHECHEN));
// уь / оь / юь — чеченское письмо: в ингушских текстах таких слов 11 на 155 тысяч (похоже на опечатки)
const CHECHEN_SPELL = /уь|оь|юь/;

// ---------- чистка мусора (для всех источников, кроме справочника проекта) ----------
// Латинские и греческие буквы-двойники (ошибки распознавания): «Xox» → «Хох», «Koca» → «Коса», «гό» → «го́».
// I и l не трогаем — это палочка, её чинит fixPal.
const LOOK1 = { A: "А", a: "а", B: "В", C: "С", c: "с", E: "Е", e: "е", H: "Н", K: "К", k: "к", M: "М", O: "О", o: "о",
  P: "Р", p: "р", T: "Т", X: "Х", x: "х", y: "у", Y: "У", "ο": "о", "α": "а", "ε": "е", "κ": "к",
  "ρ": "р", "τ": "т", "χ": "х", "ό": "о́", "ά": "а́", "έ": "е́" };
// внутри русского слова распознавание путает ещё r/г и u/и: «поroда» → «погода»
const LOOK_MIXED = { r: "г", u: "и" };
const FOREIGN = /[A-Za-zͰ-Ͽ]/;
function fixLookalikes(s) {
  return s.replace(/[A-Za-zͰ-ϿЀ-ӿ̀-ͯ]+/g, (tok) => {
    if (!FOREIGN.test(tok)) return tok;
    const map = /[Ѐ-ӿ]/.test(tok) ? { ...LOOK1, ...LOOK_MIXED } : LOOK1;
    if ([...tok].some((ch) => FOREIGN.test(ch) && !map[ch] && ch !== "I" && ch !== "l")) return tok;
    return [...tok].map((ch) => map[ch] || ch).join("");
  });
}
// Ингушский текст или транскрипция в русском поле: палочка, «ь» после гласной, кх / хь / къ, «хӀа:м».
const INH_IN_RU = /[Ӏӏ]|[аеёиоуыэюя]ь|кх|хь|къ|[а-яё]:[а-яё]/i;
const INH_TOKEN = /[Ӏӏ:]|[аеёиоуыэюя]ь|кх|хь|къ/i;
// Короткие русские слова: в разговорнике короткие слова без них — обрывки транскрипции («са», «шо», «аз»).
const SHORT_RU = new Set(("я ты он она оно мы вы они на за от до по из в с к у о об и а но не ни да же ли бы то как что кто " +
  "где все всё уже еще ещё мне нам вам вас нас его её ее им их ей там тут вот так это эта эти тот той был мой моя моё мое " +
  "мои твой наш ваш чем чей при для без под над про раз два три час год день нет вид").split(" "));
// Разбор грамматики и пояснения вместо перевода: «Например: …», «60 = 3 раза по 20», «Букв.:», «Запомните…».
const LESSON = /(^|[^А-Яа-яЁёӀӏ])(Например|Напр\.|Букв\.|Прим\.|Срв\.|Примеры|Запомните)|[=+]/;
const CAPS_WORD = /[А-ЯЁӀ]{2,}/g;
const CAPS = /(^|[^А-Яа-яЁёӀӏ])[А-ЯЁӀ]{3,}(?=$|[^А-Яа-яЁёӀӏ])/;

// Русские слова для проверки русского поля: слова корпуса (lib/corpus-lexicon.js), справочника проекта
// и русской стороны открытых словарей, где русское поле чистое (Викисловарь, PanLex, Википедия…).
// Для форм слова — первые 5 букв («опаздываю» ~ «опаздывать»).
let RU_CLEAN = null;
function ruClean() {
  if (RU_CLEAN) return RU_CLEAN;
  const set = new Set(LEX.keys("ru")), pre = new Set();
  const addRu = (s) => { for (const w of String(s).toLowerCase().replace(/ё/g, "е").match(/[а-я]+/g) || []) set.add(w); };
  for (const [ru] of [...KB.GLOSSARY, ...KB.EXAMPLES]) addRu(ru);
  for (const { f, data } of SRC) if (!/paydadosh/.test(f)) for (const p of data.pairs || []) addRu(p.ru);
  for (const w of set) if (w.length >= 5) pre.add(w.slice(0, 5));
  return (RU_CLEAN = { set, pre });
}
const isRu = (w) => { const R = ruClean(); w = w.replace(/ё/g, "е"); return R.set.has(w) || (w.length >= 5 && R.pre.has(w.slice(0, 5))); };
// Русское поле разговорника с ингушской транскрипцией («Желаю счастья Ираз ха:лд», «Я опаздываю Поезда: тӀехь
// на поезд»): убираем транскрипцию и слова ингушской строки. Берём остаток, только если в нём одни русские
// слова («Желаю счастья», «Я опаздываю на поезд»); иначе пара не идёт в базу.
function salvageRu(ru, inh) {
  if (!/[а-яё]:[а-яё]|[А-ЯЁа-яё]:\s/.test(ru) || LESSON.test(ru)) return "";
  const inhSet = new Set(inhWords(inh));
  const kept = [];
  for (const tok of ru.split(/\s+/)) {
    const w = noMarks(tok).toLowerCase().replace(/[^а-яёӏ:]/g, "");
    if (!w) { kept.push(tok); continue; }
    if (INH_TOKEN.test(w)) continue;
    if (inhSet.has(wkey(w)) && (w.length <= 3 || !ruClean().set.has(w))) continue;
    if (w.length <= 3 ? !SHORT_RU.has(w) : !isRu(w)) return "";
    kept.push(tok);
  }
  const out = kept.join(" ").replace(/\s+([.!?,…])/g, "$1").replace(/^[\s.,!?–—-]+/, "").trim();
  if ((out.match(/[А-Яа-яЁё]+/g) || []).length < 2 || INH_IN_RU.test(noMarks(out)) || /\/|•/.test(out)) return "";
  return out[0].toUpperCase() + out.slice(1);
}

// Возвращает исправленные { ru, inh, extra } или причину, по которой пара не идёт в базу.
function tidy(kind, ru, inh, extra) {
  ru = fixLookalikes(ru); inh = fixPal(fixLookalikes(inh));
  // «c) Я приехал…», «5. Давнопрошедшее время» — номер пункта из учебника
  const num = /^(?:[a-cабвс]\)|\d{1,2}[.)])\s+/i;
  if (num.test(ru) && !num.test(inh)) ru = ru.replace(num, "");
  // «Саид: Где ты живёшь?», «ЯХА:Да…» — реплика диалога: имя говорящего в перевод не идёт
  const who = /^[А-ЯЁ][А-ЯЁа-яё]{1,15}:\s*(?=[А-ЯЁа-яё\d])/;
  if (who.test(ru) && !who.test(inh)) ru = ru.replace(who, "");
  // «от ала ^3 → алийта» — ссылка словаря на исходное ингушское слово, а не перевод
  const ref = /^от\s+([^\s]+)(?:\s+\^?\d)?$/.exec(ru);
  if (ref && !isRu(noMarks(ref[1]).toLowerCase())) return "ссылка на другое слово вместо перевода";
  ru = ru.replace(/\s*\^\d+/g, ""); // «^1», «^2» — номер омонима в словаре
  // «ЙоӀ 17 3», «Ма эхь да из! 49 )» — номера страниц из книги
  if (/\d/.test(inh) && !/\d/.test(ru)) inh = inh.replace(/\s+\d[\d\s)(.,„"“”'’°=]*$/, "").trim();
  // «Цхьа бӀаьи ткъаь итт (100+20+10)», «ШИ БӀАЬ (2 раза по 100)» — разбор числа уходит в пояснение
  inh = inh.replace(/\s*\(([^()]*\d[^()]*)\)/g, (m, n) => { extra = { ...extra, note: [extra.note, n.trim()].filter(Boolean).join("; ") }; return ""; }).trim();
  if (/\d/.test(inh) && !/\d/.test(ru)) return "цифры, которых нет в русском";
  if (FOREIGN.test(inh)) return "латиница в ингушском";
  if (/[Ͱ-Ͽ]/.test(ru)) return "греческие буквы в русском";
  if (kind !== "name") {
    // «Какой позор! Ма эхь да из!» — в конце русского поля повторена ингушская фраза
    if (ru.length > inh.length && ru.endsWith(" " + inh)) {
      const head = ru.slice(0, -inh.length).trim();
      if (inhWords(inh).length >= 2 && /[.!?…]$/.test(head)) ru = head;
      // «юрид. в, я, -аш, -а, -аца адвокат → адвокат» — перед словом грамматические пометы, а не перевод
      else if (kind === "word" && /(^|[\s,])-[а-яё]|\/\//.test(head)) ru = inh;
    }
    if (INH_IN_RU.test(noMarks(ru))) {
      const r = salvageRu(ru, inh);
      if (!r) return "ингушский текст в русском поле";
      if (WHY) (WHY["исправлено: русское поле"] = WHY["исправлено: русское поле"] || []).push(`${ru}  ⇒  ${r}  → ${inh}`);
      ru = r;
    }
  }
  if (LESSON.test(inh)) return "пояснение вместо перевода";
  // «АЬННАДИЙ Ӏа цунга?» — учебник выделил слово заглавными. Если все слова строки есть в ингушских
  // текстах, это обычная фраза: пишем строчными. Иначе это разбор («это дважды двадцать ШОВЗТКЪА»).
  if (CAPS.test(inh) && !CAPS.test(ru)) {
    const low = inh.replace(CAPS_WORD, (w, at) => (at === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase())).replace(/ӏ/g, "Ӏ");
    const ws = inhWords(low), plain = inhWords(inh.replace(CAPS_WORD, " "));
    // все слова — из ингушских текстов, и среди строчных нет русских («это 40 и 10 ШОВЗТКЪА ИТТ»)
    if (ws.length < 2 || /\d/.test(inh) || ws.some((w) => w.length > 1 && !WORDS.has(w)) ||
        plain.some((w) => w.length > 1 && !/ӏ|аь|оа|хь|къ|кх/.test(w) && ruClean().set.has(w))) return "пояснение вместо перевода";
    inh = low.replace(/\s+([.!?,])/g, "$1");
  }
  // русская фраза, переписанная в ингушское поле без перевода
  if (kind === "phrase" && inhWords(inh).length >= 2 && dkey(inh) === dkey(ru)) return "русский текст вместо перевода";
  if (!ru || !inh || !/[А-Яа-яЁёӀӏ]/.test(inh)) return "пусто после чистки";
  return { ru, inh, extra };
}

// Ключ для дублей и прежних id — как в lib/base.js до учёта ударений: «де́за» и «деза» — разные записи.
// С новым BASE.key (ударения убираются) пересборка выкидывала 117 существующих записей вместе с их id
// (по id хранятся решения носителя на /review), поэтому здесь ключ свой.
function dkey(s) { return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/\([^()]*\)/g, " ").replace(/[^а-яӏa-z0-9]+/g, " ").trim(); }
const out = new Map(), stats = {}, dropped = {};
// id прежних записей не меняются: по ним хранятся решения носителя с /review. Если ту же пару теперь
// первым даёт другой источник (например, PaydaDosh вместо PanLex), id берётся из старого data/phrases.json.
const OLD_IDS = new Map(), OLD_RU = new Map(), OLD_RARE = new Set();
try {
  for (const p of JSON.parse(fs.readFileSync(path.join(ROOT, "data", "phrases.json"), "utf8"))) {
    OLD_RU.set(p.id, dkey(clean(p.ru)));
    if (p.rare) OLD_RARE.add(p.id);
    OLD_IDS.set(`${dkey(clean(p.ru))}|${dkey(fixPal(clean(p.inh)))}`, p.id);
    // тот же ключ без пометок — чтобы после чистки у записи остался прежний id
    const r = splitNotes(clean(p.ru), NOTE_RU).text, i = splitNotes(fixPal(clean(p.inh)), NOTE_INH).text;
    const k = `${dkey(r)}|${dkey(i)}`;
    if (!OLD_IDS.has(k)) OLD_IDS.set(k, p.id);
  }
} catch {}
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const WHY = process.argv.includes("--why") ? {} : null;
const why = (k, ru, inh) => { if (WHY) (WHY[k] = WHY[k] || []).push(`${ru} → ${inh}`); bump(dropped, k); };

const S_GUIDE = "Справочник проекта";
// strict: проверять каждое ингушское слово по частотному словарю (для строк словарика с пояснениями — нет)
// later: куда отложить пару, если слова нет в текстах (второй проход ниже решит, брать ли её)
function add(kind, ru, inh, source, extra = {}, strict = true, later = null) {
  ru = clean(ru); inh = fixPal(clean(inh));
  if (!ru || !inh) return;
  // ключ до чистки (как его считала прежняя сборка) — чтобы исправленная запись сохранила прежний id
  const old = kind === "phrase" ? cleanPair(ru, inh, extra.note) : { ru, inh };
  const origKey = `${dkey(old.ru)}|${dkey(old.inh)}`;
  if (source !== S_GUIDE) { // справочник проекта писали вручную — его строки с пояснениями не трогаем
    const t = tidy(kind, ru, inh, extra);
    if (typeof t === "string") return why(`${source}: ${t}`, ru, inh);
    ({ ru, inh, extra } = t);
  }
  if (kind === "phrase") {
    const c = cleanPair(ru, inh, extra.note);
    if (c.ru !== ru || c.inh !== inh) { ru = c.ru; inh = c.inh; extra = { ...extra, note: c.note }; }
  }
  const ws = inhWords(inh);
  if (ws.some((w) => CHECHEN.has(w) || CHECHEN_SPELL.test(w))) return why(`${source}: чеченская форма`, ru, inh);
  const miss = strict ? ws.filter((w) => w.length > 1 && !WORDS.has(w)) : [];
  if (miss.length) {
    if (later) return void later.push({ kind, ru, inh, source, extra, miss });
    return bump(dropped, `${source}: слова нет в ингушских текстах`);
  }
  const key = `${dkey(ru)}|${dkey(inh)}`;
  if (out.has(key)) {
    // та же пара из другого источника — запомним и его (так видно, что пару подтверждают двое)
    const prev = out.get(key);
    if (prev.source !== source && extra.license) {
      prev.also = [...new Set([...(prev.also || []), source])];
    }
    return bump(dropped, `${source}: дубль`);
  }
  const oldId = OLD_IDS.get(key) || OLD_IDS.get(origKey);
  // запись, которая уже была в базе, не понижаем: раньше «да́иман» делилось на «да» + «иман» и проходило
  // проверку, теперь форма «даиман» в текстах не находится — но ответ, который сайт давал, остаётся прежним
  if (oldId && extra.rare && !OLD_RARE.has(oldId)) { extra = { ...extra }; delete extra.rare; }
  const id = oldId || crypto.createHash("sha1").update(`${kind}\x01${ru}\x01${inh}`).digest("hex").slice(0, 10);
  out.set(key, { id, kind, ru, inh, ...extra, source, verified: false });
  bump(stats, source);
}

// 1. фразы справочника (варианты через « / » — отдельными парами)
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
const SRC = files.map((f) => ({ f, data: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
// Словари, у которых пары с редкими формами смотрим ещё раз (пункт 5): ингушскую сторону в них писали
// люди, знающие язык. PanLex, Википедия, Викиданные и translatewiki — только строгая проверка.
const RELAX = new Set(["paydadosh", "ruwiktionary"]);
const LATER = [];
for (const { f, data: src } of SRC) {
  const name = src.source || f.replace(/\.json$/, "");
  const later = RELAX.has(f.replace(/\.json$/, "")) ? LATER : null;
  for (const p of src.pairs || []) {
    const kind = p.kind || "phrase";
    const extra = { license: src.license || "" };
    if (p.note) extra.note = p.note;
    // «Дог Ӏаткъаш / Дега Ӏаткъаш» при одном русском — отдельные пары (как во фразах справочника)
    const variants = / \/ /.test(p.inh) && !/ \/ /.test(p.ru) ? p.inh.split(" / ") : [p.inh];
    for (const inh of variants) add(kind, p.ru, inh, name, extra, src.strict !== false && kind !== "name", later);
  }
}

// 5. Второй проход: пары PaydaDosh и Викисловаря, где какой-то формы нет в собранных ингушских текстах.
//    Тексты покрывают не все формы: в словаре «мизкъденна», а в текстах только «мизкъделла».
//    Пара берётся, если каждое такое слово
//      — есть в другом открытом словаре (его подтверждают два источника), или
//      — похоже на слово из текстов (те же первые 5 букв: другая форма того же слова);
//    отдельное слово (kind "word") берётся и без этого: это заголовок словарной статьи.
//    Фразы с совсем неизвестными словами не берём. Такие записи помечены rare: true —
//    на сайте они идут после записей, чьи слова есть в текстах, и не считаются «подтверждёнными» формами.
const DICT_WORDS = new Map();
for (const { f, data: src } of SRC) {
  for (const p of src.pairs || []) {
    for (const w of inhWords(fixPal(clean(p.inh)))) {
      const s = DICT_WORDS.get(w);
      if (s) s.add(src.source || f); else DICT_WORDS.set(w, new Set([src.source || f]));
    }
  }
}
const PRE5 = new Set(), PRE4 = new Set();
for (const w of WORDS) { if (w.length >= 5) PRE5.add(w.slice(0, 5)); if (w.length >= 4) PRE4.add(w.slice(0, 4)); }
const related = (w) => (w.length >= 5 && PRE5.has(w.slice(0, 5))) || (w.length === 4 && PRE4.has(w));
const elsewhere = (w, source) => [...(DICT_WORDS.get(w) || [])].some((s) => s !== source);
for (const c of LATER) {
  const backed = c.miss.every((w) => elsewhere(w, c.source) || related(w));
  if (!backed && c.kind !== "word") { why(`${c.source}: слова нет в ингушских текстах`, c.ru, `${c.inh}  [${c.miss}]`); continue; }
  add(c.kind, c.ru, c.inh, c.source, { ...c.extra, rare: true }, false);
}

// Прежние записи — в прежнем порядке, новые — после них: при равной надёжности сайт берёт первую
// запись, так что ответы, которые уже давала база, от пересборки не меняются. Запись, у которой чистка
// поменяла русское поле («c) Незнакомый» → «Незнакомый»), тоже идёт после: по новому тексту её раньше не находили.
const OLD_POS = new Map([...new Set(OLD_IDS.values())].map((id, i) => [id, i]));
const oldPos = (p) => (OLD_POS.has(p.id) && OLD_RU.get(p.id) === dkey(p.ru) ? OLD_POS.get(p.id) : Infinity);
const list = [...out.values()].map((p, i) => ({ p, i, o: oldPos(p) }))
  .sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.p);
fs.writeFileSync(path.join(ROOT, "data", "phrases.json"), "[\n" + list.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n");
console.log("пар в базе:", list.length, "из них rare:", list.filter((p) => p.rare).length, stats);
console.log("не вошли:", dropped);
if (WHY) fs.writeFileSync(path.join(require("os").tmpdir(), "phrases-why.json"), JSON.stringify(WHY, null, 1));
