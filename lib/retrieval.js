// Подбор подсказок для ИИ под конкретный текст (вместо того чтобы отдавать весь справочник).
//
// Что делает:
//   1. normalize() — приводит текст к одному виду: строчные буквы, ё → е, палочка 1 / I / l / | → Ӏ.
//   2. Для каждого слова текста ищет похожие слова (по общему началу слова, «основе»)
//      в словарике (lib/ingush-guide.js), в базе пар (data/phrases.json) и в таблице корпуса.
//      Так «маму», «мамой», «маме» находят запись «мама».
//   3. pickFewShots() — выбирает 10–20 самых похожих проверенных пар «фраза — перевод»
//      (исправления носителей, проверенные на /review, фразы справочника, при желании —
//      переводы сильной модели), чтобы ИИ переводил по образцу.
//   4. missingWords() — слова текста, для которых в базе ничего не нашлось: ИИ просим
//      не выдумывать их, а писать в [квадратных скобках].
//
// Модуль ничего не скачивает и не вызывает ИИ — его можно проверить на своём компьютере:
//   node scripts/try-retrieval.js "Я люблю свою маму"

const LOOK = "1Il|ІіΙⅠǀӀӏ";
const PAL = new RegExp(`([\\u0400-\\u04FF])[${LOOK}]|[${LOOK}](?=[\\u0400-\\u04FF])`, "g");

// «к1ант», «кIант», «кlант», «кӀант» → «кӏант» (для сравнения; в ответе палочка остаётся Ӏ).
function normalize(s) {
  return String(s || "")
    .replace(PAL, (m, a) => (a ? a + "ӏ" : "ӏ"))
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/Ӏ/g, "ӏ");
}
const wordsOf = (s) => normalize(s).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];

// Частые служебные слова: по ним похожие фразы не ищем (иначе «и», «в», «не» совпадут со всем).
const STOP = new Set([
  "и", "в", "во", "на", "не", "с", "со", "к", "ко", "по", "за", "из", "у", "о", "об", "от", "до", "а", "но", "же",
  "ли", "бы", "что", "как", "это", "то", "так", "для", "мы", "вы", "он", "она", "они", "оно", "я", "ты", "его", "ее",
  "их", "мне", "тебе", "меня", "тебя", "нас", "вас", "есть", "был", "была", "было", "были", "уже", "еще", "очень",
  // ингушские служебные — только самые короткие и частые
  "а", "я", "ва", "да", "ба", "ца", "ма", "из", "уж", "хьо", "со",
]);

// Длина общего начала двух слов.
function prefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Насколько слово текста похоже на слово записи: 1 — то же слово, 0.6–0.9 — то же начало
// (другое окончание), 0 — не похоже. Работает одинаково для русского и ингушского.
function wordSim(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0; // короткие слова — только точное совпадение
  const p = prefixLen(a, b);
  const short = Math.min(a.length, b.length);
  if (short < 3) return 0;
  // нужно общее начало хотя бы из 4 букв (у коротких слов — из 3 и короткое окончание)
  if (p < 4 && !(p === 3 && short <= 4 && Math.max(a.length, b.length) <= 6)) return 0;
  const s = p / Math.max(a.length, b.length);
  return s >= 0.5 ? 0.5 + 0.4 * s : 0;
}

// Индекс по первым трём буквам — чтобы не сравнивать каждое слово со всей базой.
function makeIndex(items, wordsFn) {
  const idx = new Map();
  items.forEach((it, i) => {
    for (const w of new Set(wordsFn(it))) {
      if (w.length < 2) continue;
      const k = w.slice(0, 3);
      let a = idx.get(k);
      if (!a) idx.set(k, (a = []));
      a.push([i, w]);
    }
  });
  return idx;
}

// Лучшее сходство каждого слова текста с записями: Map<номер записи, { score, hits }>.
// stop = true: служебные слова не считаем (для поиска похожих фраз).
function scoreItems(textWords, idx, stop = true) {
  const out = new Map();
  for (const tw of textWords) {
    if (tw.length < 2 || (stop && STOP.has(tw))) continue;
    const bucket = idx.get(tw.slice(0, 3));
    if (!bucket) continue;
    const best = new Map();
    for (const [i, w] of bucket) {
      const s = wordSim(tw, w);
      if (s > (best.get(i) || 0)) best.set(i, s);
    }
    for (const [i, s] of best) {
      const o = out.get(i) || { score: 0, hits: [] };
      o.score += s;
      o.hits.push(tw);
      out.set(i, o);
    }
  }
  return out;
}

module.exports = function makeRetrieval({ KB, SEED, LEX }) {
  // ---------- словарь: записи «русское — ингушское» ----------
  // Словарик справочника (с классами и мн. числом) + слова из базы пар (data/phrases.json).
  let DICT = null;
  function dict() {
    if (DICT) return DICT;
    const items = [];
    const seen = new Set();
    for (const [ru, inh] of KB.GLOSSARY) {
      items.push({ ru, inh, from: "glossary" });
      seen.add(normalize(ru));
    }
    for (const p of SEED) {
      if (p.kind !== "word" || seen.has(normalize(p.ru))) continue;
      items.push({ ru: p.ru, inh: p.note || p.inh, from: p.source && p.source.startsWith("Корпус") ? "corpus" : "glossary" });
    }
    // в ингушской части берём только слова до тире (после него — пояснения)
    const inhPart = (s) => String(s).split(" — ")[0].replace(/\([^()]*\)/g, " ");
    DICT = {
      items,
      ru: makeIndex(items, (it) => wordsOf(String(it.ru).replace(/\([^()]*\)/g, " "))),
      inh: makeIndex(items, (it) => wordsOf(inhPart(it.inh))),
    };
    return DICT;
  }

  // Записи словаря для слов текста. source — язык текста ("ru" или "inh").
  // Возвращает [{ ru, inh, from, score }], сначала точные совпадения.
  function pickDictionary(text, source, max = 40, perWord = 3) {
    const d = dict();
    const tw = [...new Set(wordsOf(text))];
    const scored = scoreItems(tw, source === "inh" ? d.inh : d.ru, false);
    const list = [...scored.entries()].map(([i, o]) => {
      const it = d.items[i];
      const n = wordsOf(source === "inh" ? String(it.inh).split(" — ")[0].replace(/\([^()]*\)/g, " ") : it.ru).length || 1;
      // запись из нескольких слов засчитываем по доле совпавших слов (длинная запись не должна побеждать)
      const score = o.score / Math.max(1, Math.sqrt(n)) + (it.from === "glossary" ? 0.05 : 0);
      return { ...it, score, hits: o.hits, i };
    }).filter((x) => x.score >= 0.55);
    list.sort((a, b) => b.score - a.score || a.i - b.i);
    // на каждое слово текста — не больше perWord записей (иначе «свою» займёт все места формами «свой, свои, своей…»)
    const used = new Map(), out = [];
    for (const x of list) {
      if (x.hits.every((h) => (used.get(h) || 0) >= perWord)) continue;
      for (const h of x.hits) used.set(h, (used.get(h) || 0) + 1);
      out.push(x);
      if (out.length >= max) break;
    }
    return out;
  }

  // Слова текста, для которых нет ни записи словаря, ни строки в таблице корпуса.
  // shots — выбранные примеры: слово, которое есть в похожей фразе, тоже считается известным.
  function missingWords(text, source, dictHits, shots = []) {
    const covered = new Set();
    for (const h of [...dictHits, ...shots]) {
      for (const w of wordsOf(source === "inh" ? h.inh : h.ru)) covered.add(w);
    }
    const out = [];
    for (const w of new Set(wordsOf(text))) {
      if (w.length < 3 || STOP.has(w)) continue;
      if (/^\d/.test(w)) continue;
      let ok = false;
      for (const c of covered) if (wordSim(w, c) > 0) { ok = true; break; }
      if (!ok && LEX && (source === "ru" || source === "inh") && LEX.entry(w, source)) ok = true;
      if (!ok) out.push(w.replace(/ӏ/g, "Ӏ"));
    }
    return out;
  }

  // ---------- примеры: пары «фраза — перевод» ----------
  // pool — исправления носителей и пары, проверенные на /review: [{ source, target, text, translation }].
  // extra — например, переводы сильной модели: [{ ru, inh, from: "distilled" }].
  // Возвращает [{ ru, inh, from }] — самые похожие первыми, не больше max.
  function pickFewShots(text, source, target, pool = [], extra = [], max = 16) {
    if (!((source === "ru" && target === "inh") || (source === "inh" && target === "ru"))) {
      // для других языков — только исправления носителей с теми же языками
      return [];
    }
    const items = [];
    for (const p of pool) {
      if (p.source === "ru" && p.target === "inh") items.push({ ru: p.text, inh: p.translation, from: "native" });
      else if (p.source === "inh" && p.target === "ru") items.push({ ru: p.translation, inh: p.text, from: "native" });
    }
    for (const [ru, inh] of KB.EXAMPLES) items.push({ ru, inh, from: "guide" });
    for (const p of SEED) if (p.kind === "phrase") items.push({ ru: p.ru, inh: p.inh, from: "guide" });
    for (const e of extra) items.push({ ru: e.ru, inh: e.inh, from: e.from || "distilled" });

    const side = (it) => (source === "inh" ? it.inh : it.ru);
    const idx = makeIndex(items, (it) => wordsOf(side(it)));
    const tw = [...new Set(wordsOf(text))];
    const scored = scoreItems(tw, idx);
    const BONUS = { native: 1.5, guide: 1, distilled: 0.8 }; // проверенное носителем — важнее
    const seen = new Set();
    const list = [];
    for (const [i, o] of scored) {
      const it = items[i];
      const len = wordsOf(side(it)).length || 1;
      // короткая пара, где совпало много слов, лучше длинной, где совпало одно
      const score = (o.score / Math.sqrt(len)) * (BONUS[it.from] || 1);
      list.push({ it, score, i });
    }
    list.sort((a, b) => b.score - a.score || a.i - b.i);
    const out = [];
    for (const { it } of list) {
      const k = normalize(it.ru) + "|" + normalize(it.inh);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
      if (out.length >= max) break;
    }
    // совпадений мало — добавим несколько свежих исправлений носителей, чтобы ИИ видел их стиль
    for (let i = items.length - 1; i >= 0 && out.length < Math.min(4, max); i--) {
      const it = items[i];
      if (it.from !== "native") continue;
      const k = normalize(it.ru) + "|" + normalize(it.inh);
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
    return out;
  }

  return { normalize, wordsOf, wordSim, pickDictionary, pickFewShots, missingWords };
};
module.exports.normalize = normalize;
module.exports.wordSim = wordSim;
