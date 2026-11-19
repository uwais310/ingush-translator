// Проверка ответа ИИ: какие слова в ингушском переводе остались русскими.
//
// Список словоформ из ингушских текстов (lib/ingush-words.js) этого не ловит: тексты двуязычные,
// и в списке есть «мама», «город», «хорошо», «книга». Поэтому здесь своя мерка.
//
//   Ингушское слово — есть в ингушской части словарей, которым мы верим: справочник проекта,
//     PaydaDosh, Викисловарь, библиотека правил. Сама форма или та же с другим показателем класса
//     или окончанием (lib/morph.js принимает только формы из этих словарей).
//   Русское слово — есть в русской части словаря (сама форма или её начальная форма)
//     или стоит в русском исходном тексте.
//
// Помечается слово, которое русское и при этом не ингушское. Заимствования, которые словарь даёт
// как ингушские (в PaydaDosh «холодильник → холодильник», «телефон → телефон»), не помечаются.
// Имена (с заглавной буквы не в начале предложения) и слова в [скобках] не проверяются.
//
// russian(text, source) → ["мама", "хорошо"] — слова так, как они написаны в переводе, без повторов.

const makeMorph = require("./morph.js");

const key = (s) => makeMorph.stripStress(String(s)).toLowerCase().replace(/ё/g, "е").replace(/[Ӏ1]/g, "ӏ");
const noParens = (s) => String(s || "").replace(/\([^()]*\)/g, " ");
const WORD_RE = /[Ѐ-ӿ]+(?:-[Ѐ-ӿ]+)*/g;
const TRUSTED = /^(PaydaDosh|Справочник|Викислов)/;
// Сочетания, которых в русских словах не бывает: палочка, гласная + ь, хь, кх, къ, оа.
const NOT_RUSSIAN = /ӏ|[аеиоуыэюя]ь|хь|кх|къ|оа/;
// В русской части записей PaydaDosh бывают ингушские примеры и ссылки («понуд. ф. от де́лха», «Примеры: …»).
const ruPart = (s) => noParens(String(s || "").split(/Примеры:|Прим\.|•/)[0]);

module.exports = function makePostcheck({ SEED, KB, L }) {
  let INH = null, RU = null, MORPH = null;

  function build() {
    if (INH) return;
    INH = new Set();
    const add = (set, s) => { for (const w of key(s).match(/[а-яӏ]+/g) || []) set.add(w); };
    // русское слово — то, что есть в русской части записей, кроме слов, которые есть и в ингушской части
    // (так ссылка «от де́лха» в русской части не делает «делха» русским)
    const seen = new Map();
    // только слова, написанные со строчной буквы: имена («Ахмед», «Назрань») русскими словами не считаем
    const addRu = (s) => {
      for (const raw of ruPart(s).match(/[\u0400-\u04FF]+/g) || []) {
        if (raw[0] !== raw[0].toLowerCase()) continue;
        const w = key(raw);
        if (!NOT_RUSSIAN.test(w)) seen.set(w, true);
      }
    };
    for (const p of SEED) {
      if (p.ru) addRu(p.ru);
      if (p.inh && (p.verified || (!p.rare && TRUSTED.test(p.source || "")))) add(INH, noParens(p.inh));
    }
    for (const [ru, inh] of KB.GLOSSARY || []) { addRu(ru); add(INH, noParens(inh)); }
    for (const [ru, inh] of KB.EXAMPLES || []) { addRu(ru); add(INH, inh); }
    if (L) {
      const walk = (x) => { if (typeof x === "string") add(INH, x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
      walk(L.PRONOUNS); walk(L.COPULA); walk(L.STATES); walk(L.DESTINATIONS); walk(L.LOCATIONS); walk(L.QUESTION_WORDS);
      walk(L.DEMONSTRATIVES); walk(L.NUMBERS); walk(L.ATTESTED_CLASS); walk(L.ADJECTIVES); walk(L.OWN_BY_PERSON);
      walk(L.INH_FUNCTION_WORDS);
      for (const v of L.VERBS || []) { walk(v.pres); walk(v.past); walk(v.part); walk(v.neg); walk(v.inf); }
    }
    RU = new Set();
    for (const w of seen.keys()) if (!INH.has(w)) RU.add(w);
    MORPH = makeMorph((lang, w) => (lang === "inh" ? INH : RU).has(w));
  }

  const isInh = (w) => { build(); return INH.has(w) || MORPH.lemmas(w, "inh", 1).length > 0; };
  const isRu = (w) => { build(); return RU.has(w) || MORPH.lemmas(w, "ru", 1).length > 0; };

  // Имена и названия: с заглавной буквы не в начале предложения.
  function names(text) {
    const out = new Set();
    const s = String(text);
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(s))) {
      const w = m[0];
      const first = w[0] === "Ӏ" ? w[1] || "" : w[0]; // палочка всегда выглядит заглавной
      if (!first || first === first.toLowerCase()) continue;
      const before = s.slice(0, m.index).replace(/[\s"«»(\[—–-]+$/, "");
      if (before && !/[.!?…:;]$/.test(before)) out.add(key(w));
    }
    return out;
  }

  function russian(text, source = "") {
    build();
    const t = String(text || "").replace(/\[[^\]\n]{0,80}\]/g, " "); // [слово] ИИ сам пометил
    const skip = names(t);
    const src = new Set(key(source).match(/[а-яӏ]+/g) || []);
    // имена из исходного текста с ингушским окончанием («Ахмед» → «Ахмеда»), даже в начале предложения
    const srcCaps = (String(source).match(WORD_RE) || []).filter((w) => w[0] !== w[0].toLowerCase()).map(key);
    const nameFromSource = (raw, w) => raw[0] !== raw[0].toLowerCase() && !isRu(w) && srcCaps.some((s) => s.length >= 3 && w.startsWith(s.slice(0, 4)));
    // то же слово из исходного текста в другой форме («смартфоне» → «смартфон»); с ингушским
    // окончанием множественного числа («билеташ») это уже ингушское слово
    const fromSource = (w) => {
      if (src.has(w)) return true;
      if (w.length < 5 || /аш[а-яӏ]{0,3}$/.test(w)) return false;
      for (const s of src) {
        const need = Math.max(5, Math.min(w.length, s.length) - 2);
        if (s.length >= 5 && s.slice(0, need) === w.slice(0, need)) return true;
      }
      return false;
    };
    // одно слово (без дефиса): русское и не ингушское
    const one = (w) => w.length >= 2 && !NOT_RUSSIAN.test(w) && !isInh(w) && (fromSource(w) || isRu(w));
    const out = [];
    const seen = new Set();
    for (const raw of t.match(WORD_RE) || []) {
      const w = key(raw);
      if (seen.has(w) || skip.has(w) || w.length < 2 || nameFromSource(raw, w)) continue;
      seen.add(w);
      const parts = w.split("-").filter((p) => p.length >= 2);
      const bad = w.includes("-") ? !isInh(w) && parts.length > 0 && parts.every(one) : one(w);
      if (bad) out.push(raw);
    }
    return out;
  }

  return { russian, isInh, isRu, _sizes: () => (build(), { inh: INH.size, ru: RU.size }) };
};
