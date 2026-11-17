// Раздел «Учить» (/learn): курс из готовых записей базы, упражнения и проверка ответа.
//
// Откуда ингушский текст (только слово в слово, ничего не генерируется и не склеивается):
//   1) фразы «Справочника проекта» (data/phrases.json) и KB.EXAMPLES из lib/ingush-guide.js;
//   2) фразы PaydaDosh из разговорника: уроки, ситуации, переводы носителей, выражения
//      (пословицы и «фразы из статей словаря» пока не берём — сложные);
//   3) отдельные слова «Справочника проекта» и PaydaDosh.
// Единственное преобразование — разрезать готовую фразу на слова для упражнения «собери из слов».
//
// Контракт (на него опирается страница learn.html и следующие доработки):
//   buildCourse(SEED, KB) → { units: [{ id, title, lessons: [{ id, title, items: [{ id, ru, inh, note, source }] }] }] }
//   buildLesson(lesson, unit, seed?) → [{ type, itemId, prompt, promptLang, answer, options?, tiles?, pairs?, accept?, hint?, audio? }]
//   checkAnswer(exercise, userAnswer) → { ok, expected }
//
// Точки расширения:
//   - новая тема: добавьте объект в UNITS (id, title, phrase — ключи для фраз, words — точные слова);
//   - новый тип упражнения: функция в MAKERS (item, ctx) → упражнение или null, и её имя в PLAN
//     или в extraExercises(); страница рисует упражнение по полю type и пропускает незнакомые типы;
//   - проверка нового типа: ветка в CHECKERS.
//   - поле audio: если у записи появится ссылка на запись голоса (item.audio), она попадёт в упражнение.

// ---------- темы ----------
// phrase: ключи для русских фраз. «слово*» — любое слово, начинающееся так; иначе слово целиком;
//         несколько слов через пробел — подряд в фразе. Фраза идёт в первую подходящую тему по порядку.
// words:  отдельные слова — русская часть записи должна совпасть целиком.
const UNITS = [
  {
    id: "greet", title: "Приветствия и вежливость",
    phrase: ["здравств*", "привет*", "доброе утро", "добрый день", "добрый вечер", "доброй ночи", "спокойной ночи",
      "до свидания", "прощай*", "до встречи", "добро пожаловать", "спасибо", "благодар*", "пожалуйста", "извин*",
      "прости", "простите", "как дела", "как твои дела", "как ты", "как вы", "как поживаешь", "как поживаете",
      "мир тебе", "мир вам", "счастливого пути", "удач*", "с праздником", "поздравля*", "ничего страшного",
      "рад", "рада", "рады", "да нет", "будь здоров", "будьте здоровы"],
    words: ["спасибо", "привет", "здравствуйте", "здравствуй", "пожалуйста", "да", "нет", "извините", "до свидания", "хорошо", "приветствие", "благодарность"],
  },
  {
    id: "intro", title: "Знакомство",
    phrase: ["зовут", "имя", "фамилия", "откуда", "родом", "лет", "возраст*", "кто ты", "кто вы", "живешь", "живете",
      "живу", "живет", "знаком*", "познаком*", "язык*", "понимаю", "понимаешь", "понимаете", "говоришь", "говорите",
      "ингушетии", "ингушетия", "ингуш*", "по-ингушски", "по-русски", "учусь", "работаю"],
    words: ["имя", "фамилия", "язык", "человек", "друг", "подруга", "мужчина", "женщина", "город", "село", "страна",
      "возраст", "работа", "учитель", "ученик", "школа", "гость", "сосед"],
  },
  {
    id: "family", title: "Семья",
    phrase: ["мать", "матери", "мама", "мамы", "маме", "маму", "отец", "отца", "отцу", "папа", "папы", "брат*", "сестр*",
      "сын", "сына", "сыну", "сыновья", "дочь", "дочери", "дочка", "бабушк*", "дедушк*", "дед", "внук*", "внучк*",
      "муж", "мужа", "мужу", "жена", "жены", "жену", "женат*", "замуж*", "семья", "семьи", "семье", "семью", "семьей",
      "родител*", "родственник*", "дети", "детей", "детям", "ребенок", "ребенка", "мальчик*", "девочк*", "дядя", "дяди",
      "тетя", "тети", "племянни*", "свадьб*"],
    words: ["мать", "мама", "отец", "папа", "брат", "сестра", "сын", "дочь", "бабушка", "дедушка", "дед", "муж", "жена",
      "семья", "ребенок", "дети", "мальчик", "девочка", "дядя", "тетя", "внук", "внучка", "родители", "родственник"],
  },
  {
    id: "home", title: "Дом, еда, вода",
    phrase: ["дом", "дома", "домой", "доме", "домом", "домашн*", "квартир*", "комнат*", "двер*", "окн*", "стол", "стола",
      "столом", "стул*", "кухн*", "двор*", "крыш*", "кроват*", "еда", "еду", "еды", "хочу есть", "кушать", "куша*",
      "поел*", "поесть", "съел*", "голоден", "голодна", "сыт", "сыта", "хлеб*", "вода", "воды", "воду", "водой",
      "пить", "попить", "выпить", "пью", "чай", "чая", "чаю", "кофе", "молок*", "мяс*", "суп*", "сыр", "сыра", "соль", "соли",
      "сахар*", "масл*", "яйц*", "яблок*", "фрукт*", "овощ*", "картош*", "обед*", "ужин*", "завтрак*", "вкусн*",
      "посуд*", "тарелк*", "ложк*", "стакан*", "чашк*", "гост*"],
    words: ["дом", "комната", "дверь", "окно", "стол", "стул", "кровать", "двор", "крыша", "кухня", "вода", "хлеб", "мясо",
      "молоко", "чай", "сыр", "соль", "сахар", "масло", "яйцо", "яблоко", "суп", "еда", "обед", "ужин", "завтрак",
      "картофель", "мука", "нож", "ложка", "чашка", "тарелка", "огонь", "печь"],
  },
  {
    id: "time", title: "Числа и время",
    phrase: ["один", "одна", "одно", "два", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять",
      "двадцать", "сто", "тысяч*", "сегодня", "завтра", "вчера", "послезавтра", "позавчера", "сейчас", "теперь",
      "утр*", "вечер*", "ноч*", "день", "дня", "днем", "дни", "дней", "недел*", "месяц*", "год", "года", "году",
      "час", "часа", "часов", "который час", "минут*", "время", "времени", "понедельник*", "вторник*", "среда", "среду",
      "четверг*", "пятниц*", "суббот*", "воскресень*", "зим*", "весн*", "лето", "летом", "летн*", "осен*", "рано", "поздно"],
    words: ["один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять", "двадцать", "сто",
      "тысяча", "сегодня", "завтра", "вчера", "сейчас", "день", "ночь", "утро", "вечер", "неделя", "месяц", "год", "час",
      "минута", "время", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье", "зима",
      "весна", "лето", "осень"],
  },
];

const LESSONS_PER_UNIT = 5;
const ITEMS_MIN = 6, ITEMS_MAX = 8;
const WORDS_PER_UNIT = 16; // отдельных слов в теме не больше; остальное — фразы
const MAX_WORDS = 8;

// ---------- нормализация ----------
const PAL = /[1Il|ӏӀІі]/g; // 1, I, l, |, ӏ (и похожая украинская І) — это палочка Ӏ
const ruKey = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[\u0300\u0301]/g, "")
  .replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
// ключ ответа: регистр, знаки препинания, лишние пробелы и вид палочки не важны; ё = е
const answerKey = (s) => String(s == null ? "" : s).replace(/[\u0300\u0301]/g, "").replace(PAL, "ӏ").toLowerCase()
  .replace(/ё/g, "е").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
// варианты в одной записи: « / » или «;»
const variants = (s) => String(s || "").split(/\s+\/\s+|\s*;\s*/).map((v) => v.trim()).filter(Boolean);
const wordCount = (s) => String(s || "").split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
// слово для «собери из слов»: снимаем только знаки по краям, само слово не меняем
const tileWord = (w) => w.replace(/^[^\p{L}Ӏӏ]+|[^\p{L}Ӏӏ]+$/gu, "");
const tilesOf = (s) => String(variants(s)[0] || "").split(/\s+/).map(tileWord).filter(Boolean);

// латиница или цифры в ингушском — пропускаем (палочка Ӏ/ӏ — кириллица, она разрешена)
// многоточие — заготовка с пропуском; скобки — необязательная часть, её не проверить однозначно
const badInh = (s) => /[A-Za-z0-9]/.test(s) || /…|\.\.\.|[()\[\]]/.test(s);

// ---------- откуда берём записи ----------
const PD_ALLOWED = /^PaydaDosh, разговорник: (уроки|ситуации|переводы носителей|выражения) /;
const isProjectPhrase = (p) => p.kind === "phrase" && p.source === "Справочник проекта";
const isPdPhrase = (p) => p.kind === "phrase" && p.source === "PaydaDosh" && PD_ALLOWED.test(p.note || "");
const isAllowedWord = (p) => p.kind === "word" && (p.source === "Справочник проекта" || p.source === "PaydaDosh");

// пометка под заданием: от неё зависит форма (к кому обращаются, кто говорит, класс)
const PROJECT_NOTE = { "мужчине": "к мужчине", "женщине": "к женщине", "мужчина": "говорит мужчина", "женщина": "говорит женщина" };
function hintOf(p) {
  const note = String(p.note || "").trim();
  if (!note) return "";
  if (p.source === "PaydaDosh") return note.split(" · ").slice(1).join(", ");
  if (p.kind === "word") return ""; // в пометке слова стоит само слово и его формы — подсказала бы ответ
  return PROJECT_NOTE[note] || note;
}

// ---------- темы по ключевым словам ----------
function compileKeys(list) {
  return list.map((k) => {
    const parts = ruKey(k.replace(/\*/g, "")).split(" ");
    return { parts, prefix: k.endsWith("*") };
  });
}
const COMPILED = UNITS.map((u) => ({ ...u, keys: compileKeys(u.phrase), wordSet: new Set(u.words.map(ruKey)) }));
function phraseUnit(ru) {
  const toks = ruKey(ru).split(" ");
  for (const u of COMPILED) {
    for (const k of u.keys) {
      const n = k.parts.length;
      for (let i = 0; i + n <= toks.length; i++) {
        let ok = true;
        for (let j = 0; j < n && ok; j++) {
          const last = j === n - 1;
          ok = last && k.prefix ? toks[i + j].startsWith(k.parts[j]) : toks[i + j] === k.parts[j];
        }
        if (ok) return u.id;
      }
    }
  }
  return null;
}
const wordUnit = (ru) => { const k = ruKey(ru); for (const u of COMPILED) if (u.wordSet.has(k)) return u.id; return null; };

// ---------- курс ----------

function collect(SEED, KB) {
  const skip = { latinOrDigits: 0, tooLong: 0, noTopic: 0, duplicate: 0, ambiguousWord: 0, notUsed: 0 };
  const phrases = []; // по порядку: справочник проекта, примеры справочника, PaydaDosh (порядок файла)
  const pushPhrase = (rec) => {
    if (!rec.ru || !rec.inh) return;
    if (badInh(rec.inh) || /…|\.\.\./.test(rec.ru)) { skip.latinOrDigits++; return; }
    if (wordCount(rec.inh) > MAX_WORDS) { skip.tooLong++; return; }
    phrases.push(rec);
  };
  for (const p of SEED) if (isProjectPhrase(p)) pushPhrase({ id: p.id, ru: p.ru, inh: p.inh, note: hintOf(p), source: p.source, kind: "phrase" });
  (KB.EXAMPLES || []).forEach(([ru, inh], i) => pushPhrase({ id: `kb-${i}`, ru, inh, note: "", source: "Справочник проекта (примеры)", kind: "phrase" }));
  for (const p of SEED) if (isPdPhrase(p)) pushPhrase({ id: p.id, ru: p.ru, inh: p.inh, note: hintOf(p), source: p.source, kind: "phrase" });

  // слова: сначала справочник проекта; PaydaDosh — только если запись с таким русским словом одна (иначе омонимы)
  const words = new Map(); // ruKey → запись
  const pdByRu = new Map();
  for (const p of SEED) {
    if (!isAllowedWord(p) || !wordUnit(p.ru)) continue;
    if (badInh(p.inh) || wordCount(p.inh) > 2) { skip.latinOrDigits++; continue; }
    const k = ruKey(p.ru);
    if (p.source === "Справочник проекта") { if (!words.has(k)) words.set(k, { id: p.id, ru: p.ru, inh: p.inh, note: "", source: p.source, kind: "word" }); }
    else (pdByRu.get(k) || pdByRu.set(k, []).get(k)).push(p);
  }
  for (const [k, list] of pdByRu) {
    if (words.has(k)) continue;
    if (list.length !== 1) { skip.ambiguousWord += list.length; continue; }
    const p = list[0];
    words.set(k, { id: p.id, ru: p.ru, inh: p.inh, note: "", source: p.source, kind: "word" });
  }
  return { phrases, words: [...words.values()], skip };
}

// все разрешённые ингушские варианты для одного русского текста (для проверки «напиши сам»)
function acceptIndex(all) {
  const m = new Map();
  for (const it of all) {
    const k = ruKey(it.ru) + "|" + it.note;
    (m.get(k) || m.set(k, new Set()).get(k)).add(it.inh);
  }
  return m;
}

let COURSE_MEMO = null;
function buildCourse(SEED, KB) {
  if (COURSE_MEMO && COURSE_MEMO.SEED === SEED && COURSE_MEMO.KB === KB) return COURSE_MEMO.course;
  const { phrases, words, skip } = collect(SEED, KB);
  const byUnit = new Map(UNITS.map((u) => [u.id, { phrases: [], words: [] }]));
  const seenRu = new Set(), seenInh = new Set();
  const dup = (it) => {
    const r = ruKey(it.ru) + "|" + it.note, i = answerKey(it.inh);
    if (seenRu.has(r) || seenInh.has(i)) return true;
    seenRu.add(r); seenInh.add(i); return false;
  };
  for (const it of phrases) {
    const u = phraseUnit(it.ru);
    if (!u) { skip.noTopic++; continue; }
    if (dup(it)) { skip.duplicate++; continue; }
    byUnit.get(u).phrases.push(it);
  }
  for (const it of words) {
    if (dup(it)) { skip.duplicate++; continue; }
    byUnit.get(wordUnit(it.ru)).words.push(it);
  }

  const accept = acceptIndex([...phrases, ...words]);
  const units = [];
  for (const def of UNITS) {
    const pool = byUnit.get(def.id);
    const maxItems = LESSONS_PER_UNIT * ITEMS_MAX;
    // фразы — по порядку источников (справочник, потом PaydaDosh как в файле); затем короткие раньше длинных
    // слова — в порядке списка темы (числа по порядку, сначала самые нужные)
    const order = new Map(def.words.map((w, i) => [ruKey(w), i]));
    const wd = pool.words.slice().sort((a, b) => order.get(ruKey(a.ru)) - order.get(ruKey(b.ru))).slice(0, WORDS_PER_UNIT);
    const ph = pool.phrases.slice(0, maxItems - wd.length);
    skip.notUsed += pool.phrases.length - ph.length + pool.words.length - wd.length;
    const total = ph.length + wd.length;
    const nLessons = Math.min(LESSONS_PER_UNIT, Math.floor(total / ITEMS_MIN));
    if (!nLessons) { skip.notUsed += total; continue; }
    const byLen = (a, b) => wordCount(a.inh) - wordCount(b.inh) || a.inh.length - b.inh.length;
    const phSorted = ph.map((x, i) => ({ x, i })).sort((a, b) => byLen(a.x, b.x) || a.i - b.i).map((o) => o.x);
    const lessons = [];
    // делим поровну: в каждом уроке и фразы, и слова
    const used = Math.min(total, nLessons * ITEMS_MAX);
    let pi = 0, wi = 0;
    for (let l = 0; l < nLessons; l++) {
      const size = Math.floor(used / nLessons) + (l < used % nLessons ? 1 : 0);
      const wantPh = Math.round((phSorted.length * size) / Math.max(1, used));
      const items = [];
      while (items.length < wantPh && pi < phSorted.length) items.push(phSorted[pi++]);
      while (items.length < size && wi < wd.length) items.push(wd[wi++]);
      while (items.length < size && pi < phSorted.length) items.push(phSorted[pi++]);
      items.sort(byLen); // в уроке сначала короткие
      lessons.push({
        id: `${def.id}-${l + 1}`,
        title: `Урок ${l + 1}`,
        items: items.map(({ id, ru, inh, note, source, audio }) => ({ id, ru, inh, note, source, ...(audio ? { audio } : {}), accept: [...(accept.get(ruKey(ru) + "|" + note) || [inh])] })),
      });
    }
    skip.notUsed += total - used;
    units.push({ id: def.id, title: def.title, lessons });
  }
  const course = { units, skipped: skip };
  COURSE_MEMO = { SEED, KB, course };
  return course;
}

function findLesson(course, id) {
  for (const unit of course.units) for (const lesson of unit.lessons) if (lesson.id === id) return { unit, lesson };
  return null;
}

// ---------- упражнения ----------
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, rand) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// неправильные варианты: из той же темы, похожей длины, без повторов и без других верных ответов
function distractors(item, field, ctx, n = 3) {
  const target = item[field];
  const bad = new Set([answerKey(target)]);
  for (const a of item.accept || []) bad.add(answerKey(a));
  const sameRu = ruKey(item.ru), sameInh = answerKey(item.inh);
  const pick = (cands) => cands
    .filter((c) => c.id !== item.id && ruKey(c.ru) !== sameRu && answerKey(c.inh) !== sameInh)
    .map((c) => ({ c, d: Math.abs(c[field].length - target.length) + ctx.rand() * 6 }))
    .sort((a, b) => a.d - b.d).map((o) => o.c[field]);
  const out = [];
  for (const v of [...pick(ctx.unitItems), ...pick(ctx.allItems)]) {
    const k = answerKey(v);
    if (bad.has(k)) continue;
    bad.add(k); out.push(v);
    if (out.length === n) break;
  }
  return out;
}

const base = (item, type) => ({ type, itemId: item.id, ...(item.note ? { hint: item.note } : {}), ...(item.audio ? { audio: item.audio } : {}) });

const MAKERS = {
  // выбери ингушский перевод русской фразы
  chooseInh(item, ctx) {
    const wrong = distractors(item, "inh", ctx);
    if (wrong.length < 3) return null;
    return { ...base(item, "choose"), prompt: item.ru, promptLang: "ru", answer: item.inh, options: shuffle([item.inh, ...wrong], ctx.rand) };
  },
  // выбери русский перевод ингушской фразы
  chooseRu(item, ctx) {
    const wrong = distractors(item, "ru", ctx);
    if (wrong.length < 3) return null;
    return { ...base(item, "choose"), prompt: item.inh, promptLang: "inh", answer: item.ru, options: shuffle([item.ru, ...wrong], ctx.rand) };
  },
  // собери ингушскую фразу из слов: слова фразы + 2–3 лишних из той же темы
  tiles(item, ctx) {
    const words = tilesOf(item.inh);
    if (words.length < 2 || /\s—\s/.test(item.inh)) return null;
    const own = new Set(words.map(answerKey));
    const extra = [];
    for (const it of [...shuffle(ctx.unitItems, ctx.rand), ...shuffle(ctx.allItems, ctx.rand)]) { // сначала из той же темы
      for (const w of tilesOf(it.inh)) {
        const k = answerKey(w);
        if (!k || own.has(k)) continue;
        own.add(k); extra.push(w);
        break;
      }
      if (extra.length === 3) break;
    }
    const answer = variants(item.inh)[0];
    return { ...base(item, "tiles"), prompt: item.ru, promptLang: "ru", answer, accept: [answer], tiles: shuffle([...words, ...extra], ctx.rand) };
  },
  // напиши перевод сам (на странице есть кнопка Ӏ)
  type(item) {
    return { ...base(item, "type"), prompt: item.ru, promptLang: "ru", answer: item.inh, accept: [...new Set([...(item.accept || []), item.inh])] };
  },
};

// 5 пар «русское — ингушское», без повторов с обеих сторон
function makeMatch(lesson, ctx) {
  const pairs = [], ru = new Set(), inh = new Set();
  const take = (it) => {
    const r = ruKey(it.ru), i = answerKey(it.inh);
    if (ru.has(r) || inh.has(i) || it.inh.length > 40 || it.ru.length > 40) return;
    // пары с подсказкой (к мужчине / к женщине) в «соедини» не ставим: без подсказки ответ неоднозначен
    if (it.note) return;
    ru.add(r); inh.add(i); pairs.push({ ru: it.ru, inh: it.inh, itemId: it.id });
  };
  const byLen = (a, b) => a.inh.length - b.inh.length;
  for (const it of lesson.items.slice().sort(byLen)) if (pairs.length < 5) take(it);
  for (const it of shuffle(ctx.unitItems, ctx.rand)) if (pairs.length < 5) take(it);
  if (pairs.length < 5) return null;
  return { type: "match", itemId: pairs[0].itemId, prompt: "Соедините пары", promptLang: "ru", answer: pairs.map((p) => [p.ru, p.inh]), pairs: shuffle(pairs, ctx.rand) };
}

// основной порядок типов по словам урока (по кругу)
const PLAN = ["chooseInh", "chooseRu", "tiles", "type"];
const FALLBACK = { tiles: ["chooseRu", "chooseInh"], type: ["tiles", "chooseInh"], chooseInh: ["chooseRu", "type"], chooseRu: ["chooseInh", "type"] };

function buildLesson(lesson, unit, seed = 0, allItems = null) {
  const unitItems = unit.lessons ? unit.lessons.flatMap((l) => l.items) : lesson.items;
  const ctx = { rand: rng(`${lesson.id}|${seed}`), unitItems, allItems: allItems || unitItems };
  const out = [], used = new Set();
  const make = (name, item) => {
    const key = name + "|" + item.id;
    if (used.has(key)) return null;
    // «напиши сам» — только для коротких (до 4 слов)
    if (name === "type" && wordCount(item.inh) > 4) return null;
    const ex = MAKERS[name](item, ctx);
    if (ex) used.add(key);
    return ex;
  };
  lesson.items.forEach((item, k) => {
    const first = PLAN[k % PLAN.length];
    for (const name of [first, ...FALLBACK[first]]) { const ex = make(name, item); if (ex) { out.push(ex); break; } }
  });
  const extra = [];
  const has = (t) => out.concat(extra).some((e) => e.type === t);
  // каждый из четырёх типов хотя бы раз
  if (!has("tiles")) for (const it of lesson.items.slice().reverse()) { const ex = make("tiles", it); if (ex) { extra.push(ex); break; } }
  if (!has("type")) for (const it of lesson.items) { const ex = make("type", it); if (ex) { extra.push(ex); break; } }
  if (!has("choose")) for (const it of lesson.items) { const ex = make("chooseInh", it); if (ex) { extra.push(ex); break; } }
  const match = makeMatch(lesson, ctx);
  // добираем до 8–12 упражнений: обратный выбор, «напиши сам»
  const target = Math.min(12, Math.max(8, lesson.items.length + 3)) - (match ? 1 : 0);
  for (const name of ["chooseRu", "type", "chooseInh", "tiles"]) {
    for (const it of lesson.items) {
      if (out.length + extra.length >= target) break;
      const ex = make(name, it); if (ex) extra.push(ex);
    }
  }
  const all = out.concat(extra).slice(0, 12 - (match ? 1 : 0));
  if (match) all.splice(Math.ceil(all.length / 2), 0, match);
  return all;
}

// ---------- проверка ответа ----------
const CHECKERS = {
  match(ex, user) {
    const want = new Set(ex.pairs.map((p) => answerKey(p.ru) + "=" + answerKey(p.inh)));
    const got = (Array.isArray(user) ? user : []).map((p) => (Array.isArray(p) ? p : [p && p.ru, p && p.inh])).map(([r, i]) => answerKey(r) + "=" + answerKey(i));
    return got.length === want.size && got.every((g) => want.has(g));
  },
};
function checkAnswer(ex, userAnswer) {
  const expected = ex.type === "match" ? ex.pairs.map((p) => `${p.ru} — ${p.inh}`).join("; ") : String(ex.answer);
  if (CHECKERS[ex.type]) return { ok: !!CHECKERS[ex.type](ex, userAnswer), expected };
  const given = answerKey(Array.isArray(userAnswer) ? userAnswer.join(" ") : userAnswer);
  if (!given) return { ok: false, expected };
  const ok = [ex.answer, ...(ex.accept || [])].some((a) => [a, ...variants(a)].some((v) => answerKey(v) === given));
  return { ok, expected };
}

// для API: список тем и уроков без упражнений
function courseSummary(course) {
  return {
    units: course.units.map((u) => ({ id: u.id, title: u.title, lessons: u.lessons.map((l) => ({ id: l.id, title: l.title, count: l.items.length, preview: l.items.slice(0, 3).map((i) => i.ru) })) })),
  };
}
function lessonPayload(course, id, seed = 0) {
  const found = findLesson(course, id);
  if (!found) return null;
  const allItems = course.units.flatMap((u) => u.lessons.flatMap((l) => l.items));
  return { id, title: found.lesson.title, unit: { id: found.unit.id, title: found.unit.title }, exercises: buildLesson(found.lesson, found.unit, seed, allItems) };
}

module.exports = { UNITS, buildCourse, buildLesson, checkAnswer, courseSummary, lessonPayload, findLesson, _norm: { answerKey, ruKey, variants, tilesOf, wordCount, phraseUnit, wordUnit, isProjectPhrase, isPdPhrase, isAllowedWord } };
