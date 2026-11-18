// Падежи ингушских существительных для перевода без ИИ (lib/rules/chunks.js).
//
// В ингушском нет предлогов: роль русского «к маме», «с братом», «о матери», «из села» играют окончания
// (справочник, раздел 6): родительный «сага», «наьна»; эргатив «саго», «нанас»; дательный «нанна»;
// направительный «нанега»; творительный «сагаца»; «о, от» — «сагах»; сравнительный «сагал»;
// «откуда» — «юртара»; город «в, на» — «Назране».
//
// Модуль ничего не придумывает. Форма строится так:
//   1. Окончания (правило «отбросить k букв в конце, добавить окончание») берутся из справочника и из пар
//      фраз разговорника: в паре ищется русское существительное в известном падеже («к маме», «маме»,
//      «из села») и ингушское слово, которое начинается так же, как словарная форма («нана» → «нанега»).
//      Так набираются настоящие пары «основа + окончание» и счёт, какое окончание чаще у какого падежа.
//   2. Из правил получаются кандидаты, и остаются только те, что встречаются в настоящих ингушских текстах
//      (lib/ingush-words.js, ~155 тыс. словоформ) или в парах фраз. Нет такой формы — null, и переводчик
//      оставляет словарную форму.
//   3. Если в парах (или в статистике корпуса GhalghayTools: «отцу — даьна») эта самая форма уже встречалась
//      для этого слова и падежа — она и берётся.
//
//   const C = makeCases({ words, pairs, corpus, baseOf, lemmas });
//   C.context(tokens, k, lemma)  → "dat" | "all" | "ins" | "abl" | "from" | "ot" | "loc" | "dest" | "gen" | null
//   C.form("нана", "all")       → "нанега" или null
//
// words  — Set ингушских словоформ (или строка через \n);
// pairs  — [[ru, inh]] пары фраз, на которых учиться (в замере — без проверяемой части);
// corpus — [[ruWord, inhWord, count]] пары слов из корпуса (необязательно);
// baseOf(lemma) → словарная ингушская форма существительного или null; lemmas(w) → начальные формы.

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ").replace(/[̀́]/g, "");
const toks = (s) => low(String(s).replace(/\([^()]*\)/g, " ").split(" — ")[0]).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];
const VOW = /[аеиоуыэюяь]$/;
// сколько первых букв ингушского слова должно совпасть с основой: «да» — «даьна» (2), «воша» — не «воӀ» (3)
const minCp = (b) => (b.length <= 3 ? b.length : Math.max(3, b.length - 2));

// Окончания из справочника (раздел 6). [отбросить, добавить, основа на согласную C / гласную V]:
// «нана» → «нан» + «ега». Условие C/V — по тому, на что кончаются слова в примерах справочника.
const GUIDE = {
  gen: [["", "а", "C"], ["", "н", "V"]], // сага; дунен
  erg: [["", "о", "C"], ["", "с", "V"]], // саго, котамо; нанас
  dat: [["а", "на"], ["", "на", "V"]], // нанна; цунна
  all: [["а", "ега"], ["", "га", "V"], ["", "ка", "C"]], // нанега; сога; юрташка
  ins: [["", "аца", "C"], ["", "ца", "C"]], // сагаца, котамца
  abl: [["", "ах", "C"], ["", "х", "V"]], // сагах, котамах
  cmp: [["", "ал", "C"], ["", "л", "V"]], // сагал
  from: [["", "ара", "C"], ["", "ра", "V"]], // юртара; мичара
  loc: [["ь", "е"], ["", "е", "C"]], // Назране, ишколе
  dest: [["ь", "е"], ["", "е", "C"]],
};
const GUIDE_PRIOR = 1; // правило справочника весит как одна встреча в парах
const MIN_RULE = 3; // правило только из пар (не из справочника) — если встретилось хотя бы 3 раза

const PREP_CASE = { "к": "all", "ко": "all", "о": "abl", "об": "abl", "обо": "abl", "про": "abl", "из": "from", "изо": "from", "от": "ot", "с": "ins", "со": "ins", "в": "in", "во": "in", "на": "in" };
const ADJ_END = /(ой|ей|ом|ем|ую|юю|ого|его|ому|ему|ых|их|ым|им|ыми|ими|ая|яя|ое|ее|ый|ий|ые|ие|ми|ми|ю)$/;
const RU_NUM = /^(два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|\d+|много|несколько|сколько)$/;

// Падеж русского существительного words[k] (начальная форма lemma) по предлогу и окончанию.
function context(words, k, lemma, opts = {}) {
  if (!words[k]) return null;
  const w = words[k], l = low(lemma || w);
  let prep = null;
  for (let j = k - 1; j >= Math.max(0, k - 3); j--) {
    if (PREP_CASE[words[j]] !== undefined || /^(у|до|по|за|для|без|при|под|над|через|перед|между|после|около|возле|вокруг|среди|кроме)$/.test(words[j])) { prep = words[j]; break; }
    if (!ADJ_END.test(words[j]) && !opts.isMod?.(words[j])) break; // «к моей старой маме»
  }
  const fem = /[ая]$/.test(l), soft = /ь$/.test(l), neut = /[ое]$/.test(l), masc = !fem && !soft && !neut;
  const instr = /(ом|ем|ой|ей|ою|ею|ью|ами|ями)$/.test(w);
  const prepos = w !== l && (/е$/.test(w) || (/и$/.test(w) && (soft || /ия$/.test(l))) || /(ах|ях)$/.test(w));
  // «-и» (книги, кровати, времени) — чаще родительный или множественное число, чем дательный: не берём
  const dat = w !== l && ((fem && /е$/.test(w)) || ((masc || neut) && /[ую]$/.test(w) && !/мя$/.test(l)) || /(ам|ям)$/.test(w));
  if (prep) {
    const c = PREP_CASE[prep];
    if (!c) return null;
    if (c === "ins") return instr ? "ins" : null; // «с горы» — другое значение
    if (c === "in") {
      const place = prepos ? "loc" : (w === l && masc) || ((fem && /[ую]$/.test(w))) ? "dest" : null;
      // «на крыше», «на рынок» — послелог тӀа (справочник, раздел 6: базар тӀа, наькъа тӀа)
      return place && prep === "на" ? "on" : place;
    }
    if (c === "all") return dat || w === l ? "all" : null;
    return c;
  }
  if (dat) return "dat";
  // «книга отца»: родительный после существительного
  const gen = w !== l && ((fem && /[ыи]$/.test(w)) || ((masc || neut) && /[ая]$/.test(w)) || /(ов|ев|ей)$/.test(w));
  if (gen && k > 0 && opts.prevNoun && opts.prevNoun(k - 1)) return "gen";
  // множественное число без предлога: «столы», «врачи» (у слов на -а «-ы» — чаще родительный: «нет воды»); после числа — единственное (справочник: «ши саг»)
  if (w !== l && masc && /[ыи]$/.test(w) && !/[ыи]$/.test(l) && !(k > 0 && RU_NUM.test(words[k - 1]))) return "pl";
  return null;
}

module.exports = function makeCases({ words, pairs = [], corpus = [], baseOf = () => null, lemmas = () => [], isMod } = {}) {
  const W = typeof words === "string" ? new Set(words.split("\n")) : words || new Set();
  const seen = new Set();
  for (const [, inh] of pairs) for (const t of toks(inh)) seen.add(t);
  const attested = (f) => W.has(f) || seen.has(f);

  // правило: «отбросить strip, добавить add»; для strip = "" — с учётом, на гласную или согласную кончается основа
  const ruleKey = (strip, add, b) => strip + "→" + add + (strip ? "" : VOW.test(b) ? "|V" : "|C");
  const credit = new Map(); // case -> Map(ruleKey -> count)
  const memo = new Map(); // base|case -> Map(form -> count)
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
  const learn = (b, kase, form) => {
    if (!b || !form || !kase) return;
    let cp = 0;
    while (cp < b.length && cp < form.length && b[cp] === form[cp]) cp++;
    if (cp < minCp(b)) return;
    let m = credit.get(kase); if (!m) credit.set(kase, (m = new Map()));
    bump(m, ruleKey(b.slice(cp), form.slice(cp), b));
    let mm = memo.get(b + "|" + kase); if (!mm) memo.set(b + "|" + kase, (mm = new Map()));
    bump(mm, form);
  };

  // ингушское слово пары, которое начинается как основа: «нана» — «нанега»
  const match = (b, I) => {
    let best = null, cpb = 0;
    for (const t of I) {
      let cp = 0;
      while (cp < b.length && cp < t.length && b[cp] === t[cp]) cp++;
      if (cp >= minCp(b) && cp > cpb && t.length >= cp) { cpb = cp; best = t; }
    }
    return best;
  };
  for (const [ru, inh] of pairs) {
    const r = toks(ru), I = toks(inh);
    if (!r.length || !I.length || r.length > 14) continue;
    for (let k = 0; k < r.length; k++) {
      const w = r[k];
      if (w.length < 3 || PREP_CASE[w] !== undefined) continue;
      const lem = lemmas(w).find((l) => l !== w && !/(ть|ти|чь|ться|тись)$/.test(l));
      if (!lem) continue;
      const prevNoun = (j) => [r[j], ...lemmas(r[j])].some((l) => baseOf(l));
      const kase = context(r, k, lem, { isMod, prevNoun });
      if (!kase) continue;
      const b = baseOf(lem);
      if (!b || / /.test(b)) continue;
      const t = match(b, I);
      if (t) learn(b, kase, t);
    }
  }
  // корпус: «отцу — даьна», «городе — шахьаре» (по русскому окончанию, без предлога)
  const CORPUS = new Map();
  for (const [ru, inh, n] of corpus) { const k = low(ru); if (!CORPUS.has(k) || CORPUS.get(k)[1] < n) CORPUS.set(k, [low(inh), n || 1]); }

  // Кандидаты: сначала окончания справочника; если ни одна такая форма не встречается в текстах —
  // окончания, выученные из пар (не реже MIN_RULE раз).
  function candidates(b, kase, opts = {}) {
    const out = new Map(); // form -> score
    const add = (f, s) => { if (f && f !== b && f.length > 1 && !f.includes("-") && attested(f)) out.set(f, Math.max(out.get(f) || 0, s)); };
    const m = credit.get(kase) || new Map();
    for (const [strip, end, vc] of GUIDE[kase] || []) {
      if ((strip && !b.endsWith(strip)) || (vc && (vc === "V") !== VOW.test(b))) continue;
      add(b.slice(0, b.length - strip.length) + end, GUIDE_PRIOR + (m.get(ruleKey(strip, end, b)) || 0));
    }
    if (out.size || opts.guideOnly) return out;
    for (const [rk, n] of m) {
      const [strip, rest] = rk.split("→");
      const [end, vc] = rest.split("|");
      if (!end || n < MIN_RULE || (strip && !b.endsWith(strip)) || (vc && (vc === "V") !== VOW.test(b))) continue;
      add(b.slice(0, b.length - strip.length) + end, n);
    }
    return out;
  }

  // форма base в падеже kase; ruWord — сама русская форма (для пар из корпуса)
  function form(base, kase, ruWord) {
    const b = low(base);
    if (!b || / /.test(b) || !kase) return null;
    const mm = memo.get(b + "|" + kase);
    // эта форма этого слова уже встречалась в парах; чаще всего — без изменения: тогда словарная форма
    // (без изменения — не в счёт: часто это просто другая конструкция в ингушской фразе)
    if (mm) { const top = [...mm].filter(([f]) => f !== b && attested(f)).sort((x, y) => y[1] - x[1])[0]; if (top) return top[0]; }
    if (ruWord && (kase === "dat" || kase === "loc" || kase === "gen")) {
      const c = CORPUS.get(low(ruWord));
      if (c && c[0] !== b && attested(c[0]) && c[0].slice(0, 2) === b.slice(0, 2)) return c[0];
    }
    const cand = candidates(b, kase);
    if (!cand.size) return null;
    const best = [...cand].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0][0];
    return best;
  }

  return { form, context: (ws, k, lemma, prevNoun) => context(ws, k, lemma, { isMod, prevNoun }), candidates, credit, memo, attested };
};
module.exports.context = context;
module.exports.GUIDE = GUIDE;
