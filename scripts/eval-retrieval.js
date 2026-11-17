// Замер: насколько хорошо ИИ «подготовлен» к переводу — без ИИ и без ключей.
//
// Берутся фразы из базы с готовым переводом (по умолчанию — разговорник PaydaDosh и фразы справочника).
// Каждая фраза по очереди «прячется»: её саму ИИ в подсказках не увидит. Для неё собирается то же, что
// сервер отправляет ИИ: записи словаря и похожие фразы. Потом считается, какая доля слов правильного
// перевода есть в этих подсказках:
//   точно — то же слово в той же форме;
//   основа — то же слово с другим окончанием (ИИ остаётся только поставить нужное окончание).
// Подсказки — как у Gemini: справочник целиком (правила, частые слова), записи словаря под текст,
// статистика слов по корпусу и похожие фразы. Пары предложений из корпуса (их сервер скачивает из сети)
// здесь не учитываются, поэтому на сайте подсказки немного богаче.
// Слова, которых нет в подсказках, ИИ вынужден угадывать — там и рождаются ошибки.
//
//   node scripts/eval-retrieval.js            — 600 случайных фраз, оба направления
//   node scripts/eval-retrieval.js 2000 ru    — 2000 фраз, только русский → ингушский
//   node scripts/eval-retrieval.js 600 ru --misses — показать слова, которые чаще всего не находятся

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });

const GUIDE_WORDS = new Set(RET.wordsOf(KB.GUIDE));
const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a))) || 600;
const DIRS = args.includes("ru") ? ["ru"] : args.includes("inh") ? ["inh"] : ["ru", "inh"];
const SHOW_MISSES = args.includes("--misses");

// Те же служебные слова, что не считаются при поиске: их ИИ знает и так.
const SKIP = new Set(["и", "в", "на", "не", "с", "к", "по", "за", "из", "у", "о", "а", "но", "же", "ли", "бы", "что", "как", "это", "то", "так",
  "я", "ты", "он", "она", "мы", "вы", "они", "ва", "да", "ба", "ца", "ма", "хьо", "со", "е", "ю", "й", "из", "уж", "вай", "тхо", "шо", "вей"]);

// Фразы для замера: 2–12 слов, без пословиц с «Букв.» (там дословный перевод, а не обычная речь).
let seed = 20261117;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pool = SEED.filter((p) => p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source) && !/Букв\./.test(p.ru))
  .filter((p) => { const n = RET.wordsOf(p.ru).length; return n >= 2 && n <= 12; });
const sample = [];
const taken = new Set();
while (sample.length < Math.min(N, pool.length)) {
  const i = Math.floor(rnd() * pool.length);
  if (!taken.has(i)) { taken.add(i); sample.push(pool[i]); }
}

function measure(dir, quiet = false) {
  const log = quiet ? () => {} : console.log;
  const tgt = dir === "ru" ? "inh" : "ru";
  let words = 0, exact = 0, stem = 0, lines = 0, full = 0, useful = 0, srcWords = 0, srcHit = 0;
  const srcMiss = new Map();
  const part = { "словарь": 0, "примеры": 0, "справочник+статистика": 0 };
  const misses = new Map();
  const t0 = Date.now();
  for (const p of sample) {
    const text = dir === "ru" ? p.ru : p.inh;
    // пометы в скобках («(говорит мужчина)», «ср.») — не часть перевода
    const ref = (dir === "ru" ? p.inh : p.ru).replace(/\([^()]*\)/g, " ").replace(/(^|[^а-яё])(срв|ср|прим)\./gi, "$1 ");
    const hide = (s) => RET.normalize(s).replace(/[^а-яӏ ]/g, "").trim();
    const hidden = [hide(p.ru), hide(p.inh)];
    const dict = RET.pickDictionary(text, dir, 40);
    const shots = RET.pickFewShots(text, dir, tgt, [], [], 17)
      .filter((s) => hide(s.ru) !== hidden[0] && hide(s.inh) !== hidden[1]).slice(0, 16);
    lines += dict.length + shots.length;
    const sets = {
      "словарь": dict.map((h) => RET.wordsOf(tgt === "inh" ? h.inh : h.ru)),
      "примеры": shots.map((s) => RET.wordsOf(tgt === "inh" ? s.inh : s.ru)),
      "справочник+статистика": [[...GUIDE_WORDS], ...LEX.lookup(text, dir, 30).map((l) => RET.wordsOf(l.split("→")[1] || ""))],
    };
    const ctx = new Set(Object.values(sets).flat(2));
    const ctxList = [...ctx];
    const refWords = [...new Set(RET.wordsOf(ref))].filter((w) => w.length >= 2 && !SKIP.has(w));
    const hit = (w, list) => list.some((c) => c === w || RET.wordSim(w, c) > 0);
    for (const [name, groups] of Object.entries(sets)) {
      const flat = groups.flat();
      for (const w of refWords) if (hit(w, flat)) part[name]++;
    }
    // слова текста, к которым есть подсказка: запись словаря или пример с тем же словом (в любой форме)
    const srcSide = [...dict.flatMap((h) => h.hits || []), ...shots.flatMap((s) => RET.wordsOf(dir === "inh" ? s.inh : s.ru)),
      ...LEX.lookup(text, dir, 30).flatMap((l) => RET.wordsOf(l.split("→")[0]))];
    for (const w of new Set(RET.wordsOf(text))) {
      if (w.length < 2 || SKIP.has(w)) continue;
      srcWords++;
      if (hit(w, srcSide)) srcHit++; else srcMiss.set(w, (srcMiss.get(w) || 0) + 1);
    }
    // строка подсказки полезна, если в ней есть хоть одно слово правильного перевода
    for (const g of [...sets["словарь"], ...sets["примеры"]]) if (refWords.some((w) => hit(w, g))) useful++;
    let all = true;
    for (const w of new Set(RET.wordsOf(ref))) {
      if (w.length < 2 || SKIP.has(w)) continue;
      words++;
      if (ctx.has(w)) { exact++; stem++; continue; }
      if (ctxList.some((c) => RET.wordSim(w, c) > 0)) { stem++; continue; }
      all = false;
      misses.set(w, (misses.get(w) || 0) + 1);
    }
    if (all) full++;
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "—");
  log(`\n${dir === "ru" ? "русский → ингушский" : "ингушский → русский"}: ${sample.length} фраз, ${words} слов перевода`);
  log(`  слов текста с подсказкой:       ${pct(srcHit, srcWords)}`);
  log(`  слова перевода есть в подсказках точно: ${pct(exact, words)}`);
  log(`  ... точно или с другим концом:  ${pct(stem, words)}`);
  log(`  фраз, где есть все слова:       ${pct(full, sample.length)}`);
  log(`  строк в подсказках (в среднем): ${(lines / sample.length).toFixed(1)}, из них полезных ${pct(useful, lines)}   время: ${Date.now() - t0} мс`);
  log(`  по частям: ${Object.entries(part).map(([k, v]) => `${k} ${pct(v, words)}`).join(", ")}`);
  if (SHOW_MISSES) log("  слова текста без подсказки:", [...srcMiss].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w, n]) => `${w}×${n}`).join(", "));
  if (SHOW_MISSES) log("  слова перевода, которых нет в подсказках:", [...misses].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w, n]) => `${w}×${n}`).join(", "));
  return { src: srcHit / srcWords, exact: exact / words, stem: stem / words, full: full / sample.length };
}

if (require.main === module) for (const d of DIRS) measure(d);
else module.exports = { measure };
