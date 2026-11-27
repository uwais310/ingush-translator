// Перевод «по кускам» — запасной шаг без ИИ, когда нет готовой фразы и не подошло ни одно правило.
//
// Так работали классические переводчики до ИИ (таблица фраз + словарь + морфология):
//   1. Текст делится на предложения, предложение — на слова.
//   2. Слева направо ищется самый длинный кусок (до 6 слов), который целиком есть в словаре или
//      разговорнике (словарь проекта, PaydaDosh, Викисловарь — без автоматически выровненных текстов).
//   3. Остальное — по одному слову: местоимения, вопросительные и указательные слова — из библиотеки
//      слов (lib/rules/lexicon.js), остальные — из словаря, при необходимости по начальной форме
//      (lib/morph.js: «маму» → «мама»).
//   4. Русские предлоги в ингушском — это падежные окончания и послелоги: отдельно не переводятся, а
//      существительное после них ставится в падеж (lib/rules/cases.js): «к маме» → «нанега», «с человеком» →
//      «сагаца», «на крыше» → «тхов тӀа», «книга отца» → родительный перед словом. Форма — только если она
//      есть в настоящих текстах; иначе словарная.
//      «и» между словами — «а» после каждого слова (справочник, раздел 8: «да а нана а»), «или» — «е».
//   5. Порядок слов: в ингушском глагол обычно в конце (справочник, раздел 8: подлежащее, дополнение,
//      глагол). Если в предложении ровно один глагол и он не последний, он переносится в конец.
//   6. Слово, которого нет нигде, остаётся как есть в [квадратных скобках]. Новых ингушских слов
//      модуль не придумывает: каждое слово ответа взято из источника.
//
// Такой перевод грубый: окончания падежей и формы глаголов (время, класс) не ставятся — берутся
// словарные формы. Поэтому ответ помечается как «по словам» и предлагается проверить у носителя.
//
// translate(text, src) → { translation, pieces: [{ from, to, how }], known, total } или null.

const L = require("./lexicon.js");
const makeCases = require("./cases.js");
const RUC = require("./ru-conj.js");
const D = require("./ru-decl.js");
const makeVerbs = require("./verbs.js");
const makeInhVerbs = require("./inh-verbs.js");
const R = require("./russian.js");
const GUIDE = require("../ingush-guide.js");
const makeSense = require("./sense.js");

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const MAX_SPAN = 6;
// русские предлоги: в ингушском их роль играют окончания и послелоги
const RU_PREPS = new Set(["в", "во", "на", "к", "ко", "с", "со", "из", "от", "до", "по", "за", "о", "об", "обо", "у", "при", "под", "над", "про", "для", "без", "через", "перед"]);
// время суток и года в творительном падеже — обстоятельство «когда», не дополнение
const RU_WHEN = new Set(["утром", "днем", "вечером", "ночью", "летом", "зимой", "весной", "осенью"]);
// частицы, у которых нет отдельного слова в ингушском
const RU_SKIP = new Set(["же", "ли", "бы", "вот", "ведь", "-то", "пожалуйста"]); // «пожалуйста» — отдельного слова нет (справочник, раздел 7)
// надёжность записей словаря (retrieval.sourceOf): 0 — словарь проекта, 1 — PaydaDosh, 2 — Викисловарь,
// 3 — Википедия и Викиданные, 4 — PanLex и др.; 5 — выровненные тексты, 6 — translatewiki
const PHRASE_PRIO = 2; // кусок из нескольких слов — только из самых надёжных источников
const WORD_PRIO = 4;

// «цӀа (д/д; мн. цӀенош) / фусам (й/й)» → «цӀа»; «пойти, прийти, посетить» → «пойти»
function firstSense(s) {
  const t = String(s || "").split(" — ")[0].split(" / ")[0].replace(/\([^()]*\)/g, " ").split(/[,;(]|\s\d\)/)[0];
  return t.replace(/~/g, "").replace(/\s+/g, " ").trim();
}

module.exports = function makeChunks({ RET, SEED = [], ALIGN = null, EXAMPLES = null, tune = {} }) {
  // языковая модель (lib/rules/lm.js) для выбора между готовыми вариантами: учится на целевой стороне EXAMPLES
  const LM_ = {};
  const lmOf = (lang) => {
    if (tune.noLM || !EXAMPLES) return null;
    const tgt = lang === "ru" ? "inh" : "ru";
    if (!LM_[tgt]) LM_[tgt] = require("./lm.js")((EXAMPLES || []).map(([ru, inh]) => (tgt === "inh" ? inh : ru)));
    return LM_[tgt];
  };
  // вес модели при выборе между образцами одного вида (analog, construction): по замеру 0 — лучше всего,
  // там выбирает надёжность образца; оставлено для замеров (tune.lmW)
  const LM_W = tune.lmW ?? 0;
  const LM_PRIOR = tune.lmPrior ?? 0;
  const LEXC = (() => { try { return require("../corpus-lexicon.js"); } catch (e) { return null; } })();
  const corpusWord = (w) => { const e = LEXC && LEXC.entry(w, "ru"); const c = e && e.exact && e.list.find((x) => x.sure && x.n >= 2); return c && !/\s/.test(c.text) ? c.text : null; };
  // Имена людей и мест из базы: записи «имя / фамилия = Абукар {мужское}» (PaydaDosh) и имена Википедии / Викиданных
  let NAMES_ = null;
  const NAMES = () => {
    if (NAMES_) return NAMES_;
    NAMES_ = new Set();
    const add = (x) => { for (const w of low(String(x || "").replace(/[({][^)}]*[)}]/g, " ")).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || []) if (w.length >= 3) NAMES_.add(w); };
    for (const p of SEED) {
      if (!p) continue;
      if (p.kind === "name") { add(p.ru); add(p.inh); }
      else if (/^(имя|фамилия)$/i.test(String(p.ru).trim())) add(p.inh);
    }
    return NAMES_;
  };
  // ALIGN — таблица слов, выученная из пар фраз (lib/rules/align.js): форма слова в контексте («маме» — «нанна»)
  const SENSE = makeSense({ ALIGN, LEX: require("../corpus-lexicon.js"), attested: (w) => require("./verbs.js").attested(w) });
  const SENSE_INH = require("./sense-inh.js")({ ALIGN, LEX: require("../corpus-lexicon.js"), tune: tune.senseInh });
  const AL_N = tune.n || 2, AL_P = tune.p || 0.3, AL_MODE = tune.mode === undefined ? 1 : tune.mode;
  // Формы, которые ждут носителей (CLAUDE.md): «пришёл / пришла / пришли» (вера или хьавенав) — их не даём
  // ни из словаря, ни из таблицы слов, ни по аналогии.
  // и «мы идём» (долха или лелха)
  const OPEN_RU = (w) => /^(пришел|пришла|пришло|пришли|приходил|приходила|приходило|приходили|идем)$/.test(w);
  // ингушские служебные слова: таблица слов не должна заменять ими полноценное слово
  const FUNC_INH = new Set(["ва", "я", "да", "ба", "вац", "яц", "дац", "бац", "со", "хьо", "из", "тхо", "вай", "шо", "уж", "аз", "ӏа", "цо", "а", "е"]);
  const FUNC_RU = new Set(["не", "ли", "же", "бы", "и", "а"]);
  function aligned(w, lang, isVerb, minP) {
    if (!ALIGN || !AL_MODE || (isVerb && AL_MODE < 2)) return null;
    if (lang === "ru" && OPEN_RU(w)) return null;
    const b = ALIGN.best(w, lang);
    // слово, которое «переводится» само в себя («маме» — «маме»), — ошибка пары, а не перевод
    if (!b || b.n < AL_N || b.p < Math.max(AL_P, minP || 0) || b.to === low(w)) return null;
    if (lang === "ru" && FUNC_INH.has(b.to) && !L.RU_PRONOUN_FORMS[w]) return null;
    // обрывок вроде «ӀӀ» (ошибка распознавания в словаре) — не слово: нужно хотя бы две буквы и слово из текстов или словаря
    if (lang === "ru" && (low(b.to).replace(/ӏ/g, "").length < 2 || !require("./verbs.js").attested(b.to))) return null;
    return b.to;
  }
  const RU_POSS = L.POSSESSIVES, RU_POSS_INV = L.POSSESSIVE_INVARIABLE;
  const VERB_FORMS = new Map();
  for (const v of L.VERBS) {
    (v.ru.pres || []).forEach((f, n) => VERB_FORMS.set(f, { v, tense: "pres", person: (n % 3) + 1 }));
    (v.ru.past || []).forEach((f) => VERB_FORMS.has(f) || VERB_FORMS.set(f, { v, tense: "past" }));
    (v.ru.inf || []).forEach((f) => VERB_FORMS.has(f) || VERB_FORMS.set(f, { v, tense: "inf" }));
  }
  const isVerbLemma = (l) => /(ть|ться|ти|чь|чься)$/.test(l);
  // Множественное число из словаря проекта и его класс — второй в записи: «бер (д/д; мн. бераш)» → бераш: д,
  // «нана (й/б; мн. ноаной)» → ноаной: б (справочник, раздел 4: многие люди — б; PaydaDosh: «Тха бераш дац»)
  const PL_CLS = new Map();
  for (const [, line] of GUIDE.GLOSSARY || []) {
    for (const m of String(line).matchAll(/\(\s*[вйдб]\s*\/\s*([вйдб])\s*;\s*мн\.\s*([а-яӀӏ1-]+)\)/gi)) {
      const pl = low(m[2].replace(/1/g, "Ӏ"));
      if (!PL_CLS.has(pl)) PL_CLS.set(pl, m[1]);
    }
  }
  // Прилагательные с классным показателем (справочник, раздел 4: класс стоит в начале многих прилагательных):
  // «большой — доккха» (справочник), «большой — боккха» (PaydaDosh), «большой мальчик — воккха кӀаьнк», «большая
  // девочка — йоккха йиӀиг» (PaydaDosh), «старуха — йоккха саг» (справочник). Группа берётся, только если словарь
  // сам даёт для этого русского прилагательного формы хотя бы двух классов; формы других классов — если они
  // есть в текстах или в парах фраз. «Хороший — дика», «плохой — во» — один класс в словаре: не меняются
  // (справочник: «дика саг», «хоза йоӀ»; PaydaDosh: «во сесаг»).
  let ADJ_CLS_ = null;
  function adjClassGroup(inh) {
    if (!ADJ_CLS_) {
      ADJ_CLS_ = new Map();
      const entries = SEED.filter((p) => p && p.kind === "word" && !p.rare && /^(PaydaDosh|Справочник)/.test(p.source || "")).map((p) => [p.ru, p.inh]).concat(GUIDE.GLOSSARY || []);
      const byRu = new Map();
      for (const [ru, inh0] of entries) {
        const r = low(String(ru).split(/[,(]/)[0].trim());
        if (!/^[а-я]+(ый|ий|ой)$/.test(r)) continue;
        for (const t of low(String(inh0).replace(/\([^()]*\)/g, " ")).split(/\s*[\/,;]\s*/).map((x) => x.trim())) {
          if (!/^[вйдб][а-яӏ]{2,}$/.test(t)) continue;
          const k = r + "|" + t.slice(1);
          if (!byRu.has(k)) byRu.set(k, new Set());
          byRu.get(k).add(t[0]);
        }
      }
      for (const [k, cls] of byRu) {
        if (cls.size < 2) continue;
        const rest = k.split("|")[1], g = {};
        for (const c of ["в", "й", "д", "б"]) {
          const opts = c === "й" ? ["й" + rest, ...(/^[еи]/.test(rest) ? [rest] : [])] : [c + rest];
          const f = cls.has(c) ? c + rest : opts.find((x) => V.seen(x));
          if (f) g[c] = f;
        }
        if (Object.keys(g).length >= 2) for (const f of Object.values(g)) if (!ADJ_CLS_.has(f)) ADJ_CLS_.set(f, g);
      }
    }
    return ADJ_CLS_.get(low(inh)) || null;
  }
  const VERBISH = /(ю|у|ешь|ишь|ет|ит|ем|им|ете|ите|ут|ют|ат|ят|л|ла|ло|ли|ся|сь)$/;

  // Кусок из нескольких слов целиком: «доброе утро», «как дела».
  function phrase(words, lang) {
    const r = RET.lookupWord(words.join(" "), lang, 3);
    if (!r || r.lemma) return null;
    const it = r.items.find((x) => x.prio <= PHRASE_PRIO);
    if (!it) return null;
    const to = firstSense(lang === "ru" ? it.inh : it.ru).replace(/[.!?…]+$/, "").trim(); // знак в конце ставит translate()
    return to ? { to, how: "phrase", src: it.name } : null;
  }

  // Кандидаты-значения русского слова: все записи для найденной начальной формы, записи других начальных
  // форм («детей» — «ребёнок» и «дети») и «мн.» из словаря проекта для формы слова; выбирает lib/rules/sense.js.
  const okSense = (to) => to && !/[a-z]/i.test(to) && !/^(прош|наст|мн)\./.test(to);
  function senseCands(w, r, selfOk) {
    const cands = [], seen = new Set();
    const add = (it, to, lemma, rank, plural, pl) => { const k = low(to); if (!okSense(to) || seen.has(k)) return; seen.add(k); cands.push({ it, to, lemma, rank, plural, pl }); };
    const all = RET.lookupWord(w, "ru", 12) || r;
    const plOf = (x) => { const m = x.prio === 0 && /мн\.\s*([а-яӀӏ1-]+)/i.exec(String(x.line || "")); return m ? m[1].replace(/1/g, "Ӏ") : null; };
    for (const x of all.items) if (x.prio <= WORD_PRIO && selfOk(x)) add(x, firstSense(x.inh), r.lemma || w, 0, false, plOf(x));
    if (r.lemma) {
      for (const x of all.items) {
        const pl = plOf(x);
        if (pl) add(x, pl, r.lemma, 0, true);
      }
      for (const l of RET.lemmas(w, "ru")) {
        if (low(l) === low(r.lemma)) continue;
        const q = RET.lookupWord(l, "ru", 12);
        if (q && !q.lemma) for (const x of q.items) if (x.prio <= WORD_PRIO) add(x, firstSense(x.inh), l, 1, false);
      }
    } else if (/(ая|яя|ое|ее|ые|ие|ую|юю)$/.test(w)) {
      // форма прилагательного, у которой своя запись в словаре — часто это другое слово или сочетание:
      // «добрая, радостная весть — кхаъ». Начальная форма («добрый — дика», справочник) — тоже кандидат.
      for (const l of RET.lemmas(w, "ru")) {
        if (low(l) === w || !/(ый|ий|ой)$/.test(l)) continue;
        const q = RET.lookupWord(l, "ru", 12);
        if (q && !q.lemma) for (const x of q.items) if (x.prio <= WORD_PRIO) add(x, firstSense(x.inh), l, 1, false);
      }
    }
    return cands;
  }

  // Одно слово из словаря (или по начальной форме).
  function dictWord(w, lang, deep = 0) {
    const r = RET.lookupWord(w, lang, 6);
    if (!r) return null;
    // запись, где перевод совпадает с самим словом («маме — маме» в PaydaDosh), — ошибка данных, кроме словаря проекта (школа — школа)
    // (только для падежной формы, у которой есть своя начальная форма в словаре: «маме» → «мама»; «чай — чай» остаётся)
    const selfOk = (x) => x.prio === 0 || low(firstSense(lang === "ru" ? x.inh : x.ru)) !== low(w) || deep
      || !RET.lemmas(w, lang).some((l) => l !== w && (RET.lookupWord(l, lang, 1) || {}).lemma === "");
    // по начальной форме имя собственное берём, только если в тексте слово с большой буквы:
    // «Где карта?» — «карта» → «карт» → «Карт» (имя, «Кхарт») — не то слово; «в Москве» → «Москва» — да
    // (имя — когда с большой буквы обе стороны записи: «Карт — Кхарт»; «Открыт — …» с маленькой — обычное слово)
    const nameOk = (x) => !(deep || r.lemma) || capWord || !isNameEntry(x);
    let it = r.items.find((x) => x.prio <= WORD_PRIO && selfOk(x) && nameOk(x));
    if (!it) {
      // осталась только ошибочная запись — пробуем начальную форму («маме» → «мама»)
      if (deep || r.lemma) return null;
      for (const l of RET.lemmas(w, lang)) { if (l === w) continue; const d = dictWord(l, lang, 1); if (d) return { ...d, how: "lemma", lemma: l }; }
      return null;
    }
    let to = firstSense(lang === "ru" ? it.inh : it.ru);
    if (!to || /[a-z]/i.test(to) || /^(прош|наст|мн)\./.test(to)) return null;
    // несколько записей — выбираем значение по текстам, парам фраз и части речи (lib/rules/sense.js)
    let lemOut = r.lemma || "";
    // у глаголов значение выбирает bestSense (по формам); здесь — существительные, прилагательные, наречия
    const verbish = isVerbLemma(low(r.lemma || w)) && !/\(\s*[вйдб]\s*[\/,);-]/.test(String(it.line || it.inh));
    let rejected = [];
    if (lang === "ru" && !tune.noSense && !verbish) {
      const cs = senseCands(w, r, selfOk), c = SENSE.pick(w, cs);
      if (c) { it = c.it; to = c.to; if (c.rank) lemOut = c.lemma; rejected = cs.filter((x) => x !== c).map((x) => low(x.to)); }
    }
    // ингушское слово: значение из всех записей словаря (и перевод формы в корпусе) — lib/rules/sense-inh.js
    let how = r.lemma ? "lemma" : "word";
    if (lang === "inh" && !tune.noSense) {
      const c = SENSE_INH.pick(w, SENSE_INH.cands(w, r, selfOk, WORD_PRIO));
      if (c) { it = c.it; to = c.to; if (c.corpus) how = "corpus"; }
    }
    const line = String(it.line || it.inh);
    // «(й/б; мн. …)»; в словаре проекта и короткая запись «шура (й)», «дулх (д)»
    const cm = /\(\s*([вйдб])\s*[\/,-]/.exec(line) || (it.prio === 0 && /^[^(]*\(\s*([вйдб])\s*\)/.exec(line));
    // у существительного в словаре есть класс: «нана (й/б; мн. ноаной)», «да (в/б…)»
    const noun = /\(\s*[вйдб]\s*[\/,-]/.test(String(it.line || it.inh)) || !!(it.prio === 0 && cm) || /^[вйдб](\s*[-,/]\s*[вйдб])?$/.test(String((it.seed && it.seed.note) || "").trim());
    if (lang === "inh") {
      // описание вместо перевода («аьнна» — «Цитирующая частица; дополняющая частица»): переводить нечем,
      // слово останется в [скобках]
      if (GRAMMAR_TERM.test(to)) return null;
      // «Быть» с большой буквы посреди фразы: большая буква только у имён
      if (/^[А-ЯЁ][а-яё]/.test(to) && !NAMES().has(low(w))) to = to[0].toLowerCase() + to.slice(1);
    }
    return { to, how, lemma: lemOut, rejected, src: it.name, noun, dictCls: cm ? cm[1] : null, line };
  }
  // пояснение из грамматики, а не слово: «цитирующая частица», «суффикс …», «показатель …»
  const GRAMMAR_TERM = /(^|\s)(частиц[аы]|суффикс|окончание|показатель|послелог|аффикс)(\s|[;.,]|$)/i;

  // Формы глагола из строки словаря проекта: «даа (наст. дуъ, прош. диар)», «ала (наст. оал, прош. аьлар)»,
  // «даха — идти (наст. вода/йода/дода/бода; прош. вахар/яхар/дахар/бахар)», «вагӀа/ягӀа/дагӀа (наст. вагӀа…)».
  // Формы через «/» — по классам в, й, д, б. Возвращает { inf, pres, past }: строка или { в, й, д, б }.
  const CLASS_OF = { "в": "в", "й": "й", "е": "й", "я": "й", "ю": "й", "д": "д", "б": "б" };
  function classForms(t) {
    const parts = String(t || "").split("/").map((x) => x.replace(/[«»"]/g, "").trim()).filter(Boolean);
    if (parts.length < 2) return parts[0] || null;
    const out = {};
    const byLetter = parts.every((p) => CLASS_OF[low(p)[0]]) && new Set(parts.map((p) => CLASS_OF[low(p)[0]])).size === parts.length;
    parts.forEach((p, n) => { const c = byLetter ? CLASS_OF[low(p)[0]] : ["в", "й", "д", "б"][n]; if (c) out[c] = p; });
    return out;
  }
  function verbForms(line) {
    const l = String(line || "");
    const inf = l.split(/\s—\s|\(|;|,/)[0].trim();
    const pres = /наст\.\s*([^,;)]+)/.exec(l), past = /прош\.\s*([^,;)]+)/.exec(l);
    const clean = (m) => (m ? m[1].replace(/\s*\(.*$/, "").trim() : null);
    return { inf: classForms(inf), pres: classForms(clean(pres)), past: classForms(clean(past)) };
  }
  // прошедшее «пришёл / пришла» ждёт подтверждения носителей (CLAUDE.md, открытые вопросы)
  const OPEN_PAST = new Set(["прийти", "приходить"]);
  // будущее время, вид и переходность глагола (lib/rules/verbs.js)
  let EXW_ = null;
  const V = makeVerbs({ RET, extraWords: () => EXW_ || (EXW_ = new Set((EXAMPLES || []).flatMap(([, inh]) => low(String(inh)).match(/[а-яӏ]+/g) || []))) });
  // местоимения и связка — не глагол (их таблица ALIGN иногда ставит в пару с глаголом)
  const INH_PRON_SET = new Set(["со", "хьо", "из", "тхо", "вай", "шо", "уж", "аз", "ӏа", "цо", "оаха", "оаша", "цар", "сона", "хьона", "цунна", "са", "хьа", "цун", "ва", "я", "да", "ба", "ма", "ца"]);
  function formsOf(ruLemma) {
    const r = RET.lookupWord(ruLemma, "ru", 3);
    const it = r && !r.lemma && r.items.find((x) => x.prio <= 1);
    return it ? verbForms(it.line || it.inh) : null;
  }
  // Переходный ли ингушский глагол — по парам фраз разговорника, на которых учится модуль (EXAMPLES):
  // с кем стоят его формы — с эргативом («Аз эцаргда из», «Цо аьлар») или с именительным («Со хьежаргва»).
  const ERG_P = new Set(["аз", "ӏа", "цо", "оаха", "оаша"]), NOM_P = new Set(["со", "хьо", "тхо", "шо", "уж"]);
  let TRANS_ = null;
  function transOf(forms) {
    if (!TRANS_) {
      TRANS_ = new Map();
      for (const [, inh] of EXAMPLES || []) {
        const t = low(String(inh)).match(/[а-яӏ]+/g) || [];
        const e = t.some((x) => ERG_P.has(x)), n = t.some((x) => NOM_P.has(x));
        if (e === n) continue;
        for (const x of new Set(t)) { if (ERG_P.has(x) || NOM_P.has(x)) continue; const c = TRANS_.get(x) || [0, 0]; c[e ? 0 : 1]++; TRANS_.set(x, c); }
      }
    }
    let e = 0, n = 0;
    for (const f of new Set(forms.filter(Boolean).map(low))) { const c = TRANS_.get(f); if (c) { e += c[0]; n += c[1]; } }
    if (e + n < 2) return null;
    return e >= 2 * n ? true : n >= 2 * e ? false : null;
  }
  // Несколько глаголов в словаре («пойти — ба / баха / ваха»): берём тот, чьи формы чаще стоят в паре с этим
  // русским словом в разговорнике (таблица слов ALIGN); нет подсказки — первый, как раньше.
  function bestSense(w, lemma, items) {
    if (!items.length) return null;
    // «пойти — ба / баха / ваха»: одна буква класса («ба») — не перевод, а обрывок; берём полные формы
    const full = items.filter((x) => !CLASS_SENSE[low(firstSense(x.inh))]);
    if (full.length && w !== "есть") items = full; // «есть (имеется) — да / ва / я / ба» — это и есть перевод
    if (!ALIGN || items.length < 2) return items[0];
    let best = items[0], bs = 0;
    for (const it of items.slice(0, 5)) {
      const f = verbForms(it.line || it.inh);
      const forms = [...flat(f.inf), ...flat(f.pres), ...flat(f.past), firstSense(it.inh)].filter(Boolean).flatMap((x) => low(x).split(/\s+/));
      let sc = 0;
      for (const x of forms) sc = Math.max(sc, ALIGN.prob(w, x, "ru"), ALIGN.prob(lemma, x, "ru"));
      if (sc > bs + 0.05) { bs = sc; best = it; }
    }
    return best;
  }
  const flat = (x) => (!x ? [] : typeof x === "string" ? [x] : Object.values(x));
  const futForms = (fut) => [...Object.values(fut.pos), ...Object.values(fut.neg)];
  const futPiece = (lemma, fut, ingForms = [], src = "") => ({ how: "fut", lemma, verb: true, inf: false, tense: "fut", fut, aux: lemma === "быть", refl: /(ся|сь)$/.test(lemma),
    to: fut.pos.д || fut.pos.в || Object.values(fut.pos)[0] || Object.values(fut.neg)[0], ingForms: [...ingForms, ...futForms(fut)], src });

  // Русское слово → { to, how, verb?, dat?, pron? } или null.
  const RU_WAS = { "был": "в", "была": "й", "было": "д", "были": "б" };
  const IMP_IRREGULAR = { "дай": "дать", "дайте": "дать", "возьми": "взять", "возьмите": "взять", "ешь": "есть", "ешьте": "есть", "пей": "пить", "пейте": "пить",
    "иди": "идти", "идите": "идти", "сядь": "сесть", "сядьте": "сесть", "встань": "встать", "вставай": "вставать", "давай": "давать", "ляг": "лечь", "лягте": "лечь", "лей": "лить",
    // формы, которые морфология не сводит к глаголу («позови» — не найдено, «плачь» — как «плач»)
    "позови": "позвать", "позовите": "позвать", "зови": "звать", "зовите": "звать", "убери": "убрать", "уберите": "убрать",
    "собери": "собрать", "соберите": "собрать", "бери": "брать", "берите": "брать", "плачь": "плакать", "плачьте": "плакать",
    "ложись": "лечь", "ложитесь": "лечь", "жди": "ждать", "ждите": "ждать", "подожди": "подождать", "подождите": "подождать", "спи": "спать", "спите": "спать" };
  const CLASS_SENSE = { "ва": "в", "я": "й", "е": "й", "да": "д", "ба": "б" };
  // и возвратные: «бойся», «садись», «вернитесь» (PaydaDosh: «Не бойтесь — Ма кхера»)
  const IMP_END = /(и|ите|ай|айте|яй|яйте|ей|ейте|ой|ойте|уй|уйте|ь|ьте|йся|йтесь|ись|итесь|ься|ьтесь)$/;
  function imperative(w) {
    if (!IMP_END.test(w) && !IMP_IRREGULAR[w]) return null;
    if (/л[аои]?$/.test(w) || (isVerbLemma(w) && !IMP_IRREGULAR[w]) || L.RU_PRONOUN_FORMS[w] || L.QUESTION_WORDS[w]) return null; // «плачь» — не инфинитив
    // «большой», «чай» — не глаголы; «дочь», «мать» кончаются на -чь, -ть, но это люди (существительные)
    const isV = (l) => isVerbLemma(l) && !L.PERSON_CLASS[l];
    if (/вши(сь)?$/.test(w)) return null; // деепричастие («евши»), не повелительное
    if (!IMP_IRREGULAR[w] && !RET.lemmas(w, "ru").some(isV)) return null;
    const own = IMP_IRREGULAR[w] ? null : RET.lookupWord(w, "ru", 3);
    if (own && !own.lemma) {
      const it = own.items.find((x) => x.prio <= 1);
      const to = it && firstSense(it.inh);
      if (to && !/^(прош|наст|мн)\./.test(to)) return { to, how: "word", verb: true, inf: false, imper: true };
    }
    const lemmas = IMP_IRREGULAR[w] ? [IMP_IRREGULAR[w]] : RET.lemmas(w, "ru").filter(isV);
    // форма повелительного из пар разговорника (таблица ALIGN: «приходи» — «вола»), если такое слово есть в текстах
    if (lemmas.length && ALIGN) {
      const b = ALIGN.best(w, "ru");
      if (b && b.n >= AL_N && b.p >= AL_P && b.to !== low(w) && V.attested(b.to) && !INH_PRON_SET.has(b.to)) return { to: b.to, how: "align", lemma: lemmas[0], verb: true, inf: false, imper: true };
    }
    for (const l of lemmas) {
      const r = RET.lookupWord(l, "ru", 3);
      // «принести — ба / да / хьада»: перевод — одна буква класса с гласной. Это один глагол по классам
      // предмета («Я (да, ба) сона из» — дай мне это, PaydaDosh): собираем формы в byClass
      const items = r && !r.lemma ? r.items.filter((x) => x.prio <= 1) : [];
      const bc = {};
      for (const x of items) { const t = low(firstSense(x.inh)); if (CLASS_SENSE[t] && !bc[CLASS_SENSE[t]]) bc[CLASS_SENSE[t]] = firstSense(x.inh); }
      if (items.length && CLASS_SENSE[low(firstSense(items[0].inh))]) return { to: bc.д || Object.values(bc)[0], how: "lemma", lemma: l, verb: true, inf: false, imper: true, byClass: bc, byObject: true };
      const it = items.find((x) => !CLASS_SENSE[low(firstSense(x.inh))]);
      const vf = it && verbForms(it.line || it.inh).inf;
      const to = typeof vf === "string" ? vf : vf ? vf.в || vf.д || Object.values(vf)[0] : "";
      if (to && !/^(прош|наст|мн)\./.test(to)) return { to, how: "lemma", lemma: l, verb: true, inf: false, imper: true, byClass: vf && typeof vf === "object" ? vf : null };
    }
    return lemmas.length ? false : null; // false — повелительное, но формы не знаем: лучше [скобки], чем чужое слово
  }
  const isNameEntry = (x) => /^[А-ЯЁӀ]/.test(String(x.ru || "").trim()) && /^[А-ЯЁӀ]/.test(String(x.inh || "").trim());
  let capWord = false; // слово в тексте с большой буквы — см. nameOk в dictWord
  // ---------- неизвестное слово: синоним (русский → ингушский) и запасной поиск (ингушский → русский) ----------
  // Русские синонимы — только из нашего же словаря: значения одной записи («большой, крупный — доккха»,
  // «поручить, поручать — …»). Если слово есть лишь в записи, которую перевод по словам не берёт (редкая форма
  // PaydaDosh), а другое значение той же записи есть в надёжном словаре, берётся перевод этого значения.
  // Осторожно: только группа из 2–3 значений через запятую, все значения — одно слово; синоним — та же часть речи, от 4 букв,
  // не служебное слово; формы, которые ждут носителей («прийти», «пришла»), не трогаем.
  const SYN_SRC = /^(PaydaDosh|Справочник|Викислов)/;
  const ruSenses = (ru) => String(ru || "").split(" — ")[0].replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
    .split(/[,;]|\s\d+\)\s*|^\d+\)\s*/).map((x) => low(x).replace(/[.!?…:~]+$/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  let SYN_ = null;
  function synIndex() {
    if (SYN_) return SYN_;
    SYN_ = new Map();
    const rows = SEED.filter((p) => p && p.kind === "word" && SYN_SRC.test(p.source || "")).map((p) => p.ru).concat((GUIDE.GLOSSARY || []).map(([ru]) => ru));
    // значения через «;» и «2)» — уже другие смыслы («мудрец; колдун; оратор», «очищение; 2) оправдание»):
    // синонимы — только внутри одной группы через запятую
    const groups = (ru) => String(ru || "").split(" — ")[0].replace(/\([^()]*\)/g, " ").split(/;|\s\d+\)\s*|^\d+\)\s*/);
    for (const ss of rows.flatMap(groups).map((g) => [...new Set(ruSenses(g))])) {
      if (ss.length < 2 || ss.length > 3 || !ss.every((x) => /^[а-я]+(-[а-я]+)?$/.test(x))) continue;
      for (const x of ss) { if (!SYN_.has(x)) SYN_.set(x, []); SYN_.get(x).push(ss); }
    }
    for (const list of SYN_.values()) list.sort((a, b) => a.length - b.length);
    return SYN_;
  }
  // часть речи по окончанию начальной формы: глагол, прилагательное, остальное
  const posOfLemma = (l) => (isVerbLemma(l) ? "v" : /(ый|ий|ой)$/.test(l) ? "a" : "n");
  // союзы и частицы, которые попадают в одну запись со значащим словом («желая, хотя»)
  const SYN_STOP = new Set(["хотя", "пока", "едва", "чтоб", "словно", "будто", "точно", "якобы", "даже", "лишь", "только"]);
  const OPEN_LEMMA = (l) => OPEN_RU(l) || /^(прийти|приходить)$/.test(l);
  // форма синонима по образцу: «раздражает» (раздражать) → «расстраивает» (расстраивать); только при одинаковом
  // конце начальных форм, иначе — сама начальная форма синонима
  function synForm(w, l, s) {
    if (w === l) return s;
    let p = 0;
    while (p < w.length && p < l.length && w[p] === l[p]) p++;
    const tailL = l.slice(p), tailW = w.slice(p);
    if (tailL.length < 2 || l.slice(-3) !== s.slice(-3) || !s.endsWith(tailL)) return s;
    const f = s.slice(0, s.length - tailL.length) + tailW;
    return RET.lemmas(f, "ru").includes(s) ? f : s;
  }
  // неопределённые местоимения: «что-либо», «кто-либо», «какое-то» → «что-нибудь», «кто-нибудь», «какой-нибудь»
  // (есть в словаре). Только именительный: формы падежей («кого-то», «чем-то») словарь по-ингушски не даёт,
  // а именительный на их месте вводит в заблуждение — такие остаются в [скобках].
  const INDEF = { кто: "кто", что: "что", какой: "какой", какая: "какой", какое: "какой", какие: "какой", где: "где", куда: "куда", когда: "когда" };
  // падежные формы — только чтобы узнать заполнитель «кого-либо» в толковании словаря (он пропускается)
  const INDEF_OBL = new Set(["кого", "кому", "кем", "ком", "чего", "чему", "чем", "какую", "какого", "каком", "какому", "каким", "каких"]);
  function ruSynonym(w, next, ctx) {
    if (tune.noSyn || OPEN_LEMMA(w)) return null;
    const im = /^([а-я]+)-(либо|нибудь|то)$/.exec(w);
    if (im) {
      const b = INDEF[im[1]];
      if (!b) return null;
      for (const c of [b + "-нибудь", b + "-то"]) {
        if (c === w) continue;
        const d = dictWord(c, "ru");
        if (d && d.to && !/\[/.test(d.to)) return { ...d, how: "synonym", syn: c, lemma: c };
      }
      return null;
    }
    if (w.length < 4 || L.FUNCTION_WORDS.has(w) || RU_PREPS.has(w) || RU_SKIP.has(w)) return null;
    const idx = synIndex();
    for (const l of [w, ...RET.lemmas(w, "ru")]) {
      if (OPEN_LEMMA(l)) return null;
      // у самого слова есть запись надёжного словаря — синоним не нужен (слово не перевелось по другой причине)
      const own = RET.lookupWord(l, "ru", 6);
      if (own && !own.lemma && own.items.some((x) => x.prio <= WORD_PRIO)) continue;
      const pos = posOfLemma(l);
      // «заросло» — не «заросль»: форма глагола не бывает от существительного
      if (l !== w && pos === "n" && /(л|ла|ло|ли|ся|сь|ет|ит|ут|ют|ат|ят|ешь|ишь)$/.test(w)) continue;
      // «закрутится» — не «закрутить», «удаляется» — не «удалять»: возвратность формы и начальной формы совпадает
      if (pos === "v" && /(ся|сь)$/.test(w) !== /(ся|сь)$/.test(l)) continue;
      for (const ss of idx.get(l) || []) {
        for (const s of ss) {
          if (s === l || s.length < 4 || L.FUNCTION_WORDS.has(s) || SYN_STOP.has(s) || OPEN_LEMMA(s) || posOfLemma(s) !== pos) continue;
          if (pos === "v" && /(ся|сь)$/.test(s) !== /(ся|сь)$/.test(l) && !/(ся|сь)$/.test(w)) continue;
          // синоним сам должен быть словом надёжного словаря, а не начальной формой по догадке
          const q = RET.lookupWord(s, "ru", 6);
          if (!q || q.lemma || !q.items.some((x) => x.prio <= 1)) continue;
          const f = synForm(w, l, s);
          const h = ruWord(f, next, ctx);
          if (!h || !h.to || /^\[/.test(h.to) || /[a-z]/i.test(h.to)) continue;
          return { ...h, how: "synonym", syn: s, synOf: l };
        }
      }
    }
    return null;
  }
  // Ингушское слово, которое иначе осталось бы в [скобках]. Ключ — всегда настоящая запись, ингушских слов здесь
  // не создаётся, ответ — русский:
  //   1. эта самая форма в таблице корпуса (lib/corpus-lexicon.js), перевод подтверждают печатные словари (*),
  //      примеров не меньше трёх (по замеру с двумя — чаще мимо): «эггара» — «самых», «шийтта» — «двенадцать».
  //      Если перевод из таблицы есть и среди строк корпуса в базе (data/phrases.json), берётся он. how: "corpus";
  //   2. редкая запись PaydaDosh или Викисловаря (слово есть в словаре, но не в собранных текстах): «доарех» —
  //      «дёшево», «гӏоккхаз» — «пастух». how: "near".
  // Похожие слова (другой класс, другое написание) и слова через дефис по частям сюда не входят: по замеру они
  // чаще дают другое слово («детт» → «етт» — корова, «дай-ноаной» → «дешёвый материнский»), а неверный смысл
  // хуже [скобок].
  let CORPUS_ROWS_ = null;
  // надёжный словарь называет слово частицей или суффиксом («аьнна» — цитирующая частица, PaydaDosh): перевода-слова
  // у него нет, и перевод корпуса («сказал») по замеру почти всегда мимо («ТӀап аьнна» — внезапно)
  const particle = (w) => { const r = RET.lookupWord(w, "inh", 6); return !!(r && !r.lemma && r.items.some((x) => x.prio <= WORD_PRIO && GRAMMAR_TERM.test(firstSense(x.ru)))); };
  function inhFallback(w) {
    if (tune.noInhFallback) return null;
    const e = LEXC && LEXC.entry(w, "inh");
    if (e && e.exact) {
      const ok = e.list.filter((c) => c.sure && c.n >= 3 && !/\s/.test(c.text) && !/[a-z]/i.test(c.text));
      if (ok.length && ok[0] === e.list[0] && !particle(w)) {
        if (!CORPUS_ROWS_) {
          CORPUS_ROWS_ = new Map();
          for (const p of SEED) if (p && p.kind === "word" && /^Корпус/.test(p.source || "")) { const k = low(p.inh); if (!CORPUS_ROWS_.has(k)) CORPUS_ROWS_.set(k, new Set()); CORPUS_ROWS_.get(k).add(low(p.ru)); }
        }
        const rows = CORPUS_ROWS_.get(w);
        const c = (rows && ok.find((x) => rows.has(low(x.text)))) || ok[0];
        return { to: c.text, how: "corpus", src: "настоящие тексты" };
      }
    }
    const r = RET.lookupWord(w, "inh", 6);
    if (r && !r.lemma) {
      const it = r.items.find((x) => x.prio === 6 && /^(PaydaDosh|Викислов)/.test(x.name || ""));
      const to = it && firstSense(it.ru);
      if (to && !/[a-z]/i.test(to) && !/^(прош|наст|мн)\./.test(to) && !GRAMMAR_TERM.test(to) && to.split(" ").length <= 2 && !/^(имя|фамилия)$/i.test(to))
        return { to: /^[А-ЯЁ][а-яё]/.test(to) ? to[0].toLowerCase() + to.slice(1) : to, how: "near", src: it.name, rare: true };
    }
    return null;
  }

  function ruWord(w, next, ctx = {}) {
    capWord = !!ctx.cap;
    if (OPEN_RU(w)) return null; // ждёт носителей языка
    if (w === "не") return { to: "ца", how: "neg" };
    // «пусть будет» — желательная форма (ниже, по классу: хилва, хийла, хилда, хилба); «пусть» отдельно не переводится
    if (w === "пусть") return { to: "", how: "optative" };
    if (RU_WAS[w]) return { to: "", how: "was", known: true };
    // «как» в вопросе — «мишта» (справочник, раздел 3: «мишта (how) — not муха»; «Как вы живёте? — Мишта дах шо?»);
    // вне вопроса «как» — сравнение («как ты» — «хьо санна», PaydaDosh): его переводит словарь и таблица слов
    if (L.QUESTION_WORDS[w] && w !== "что" && (w !== "как" || ctx.question)) return { to: L.QUESTION_WORDS[w], how: "lexicon" };
    if (L.RU_PRONOUN_FORMS[w]) {
      const [p, c] = L.RU_PRONOUN_FORMS[w];
      // «его, её, их» перед существительным — «чей»: родительный (цун, цар)
      // («Я видел его вчера», «знаю его хорошо», «жду его в школе»: перед наречием или предлогом это не «чей», а «кого»)
      if (RU_POSS_INV[w] && next && !VERB_FORMS.has(next) && !L.RU_PRONOUN_FORMS[next] && !RU_ADV.has(next) && !RU_PREPS.has(next)) return { to: L.PRONOUNS[RU_POSS_INV[w]].gen, how: "lexicon" };
      // прямое дополнение в ингушском — в именительном (номинатив), как и подлежащее
      const caseName = c === "acc" ? "nom" : c;
      const f = L.PRONOUNS[p] && L.PRONOUNS[p][caseName];
      if (f) return { to: f, how: "lexicon", pron: p, case: caseName, cls: L.PRONOUNS[p].cls };
    }
    for (const l of [w, ...RET.lemmas(w, "ru")]) {
      if (RU_POSS[l]) {
        const p = RU_POSS[l];
        if (p === "свой") return { to: "ший", how: "lexicon", own: true }; // справочник, раздел 3; лицо уточним ниже
        return { to: L.PRONOUNS[p].gen, how: "lexicon" };
      }
      if (L.DEMONSTRATIVES[l] && (l === w || l !== "то")) return { to: L.DEMONSTRATIVES[l], how: "lexicon" };
    }
    // «хочу есть» — «есть (кушать) — даа» (справочник), а не «есть (имеется) — да»
    if (w === "есть" && ctx.wantInf) {
      const r = RET.lookupWord("есть", "ru", 12);
      const it = r && !r.lemma && r.items.find((x) => x.prio === 0 && /кушать/.test(String(x.ru)));
      if (it) return { to: firstSense(it.inh), how: "lemma", lemma: "есть", verb: true, inf: true };
    }
    if (L.NUMBERS && L.NUMBERS[w]) return { to: typeof L.NUMBERS[w] === "string" ? L.NUMBERS[w] : Object.values(L.NUMBERS[w])[0], how: "lexicon" };
    const vf = VERB_FORMS.get(w);
    if (vf) {
      const v = vf.v;
      const form = vf.tense === "past" ? v.past : vf.tense === "pres" ? v.pres : null;
      // форма, которая не зависит от класса («хов», «гу»), — сразу; иначе — словарная форма ниже
      const inf = typeof v.inf === "string" ? v.inf : "";
      // с «не» — своя форма, если она есть в библиотеке слов: «Сона хац» (не знаю), «Со кхетац» (не понимаю)
      if (typeof form === "string") return { to: form, how: "lexicon", verb: true, dat: v.type === "dat", negForm: vf.tense === "pres" && v.neg ? v.neg : null };
      // форма по классу («вода / йода»): класс выберем по подлежащему, иначе — словарная форма
      if (form && typeof form === "object" && v.type !== "dat" && v.type !== "erg") return { to: inf || Object.values(form)[0], how: inf ? "lemma" : "lexicon", verb: true, byClass: form, person: vf.person, progPart: vf.tense === "pres" && v.part && typeof v.part === "object" ? v.part : null };
      // «люблю»: класс — по тому, кого любят (справочник: «Сона хьо еза» о женщине, «веза» о мужчине)
      if (form && typeof form === "object" && v.type === "dat") return { to: inf || form.д || Object.values(form)[0], how: inf ? "lemma" : "lexicon", verb: true, dat: true, byClass: form, byObject: true };
      if (inf) return { to: inf, how: "lemma", verb: true, dat: v.type === "dat" };
    }
    // повелительное наклонение («отвези», «приходи», «сделай»): в ингушском это словарная форма глагола
    // (справочник, раздел 7: «Ма де!» — не делай, «Хабар ма дувца!» — не болтай; де, дувца — словарные формы).
    // Если у самой формы есть запись в словаре («дай — хьа», «возьми — хӀа», PaydaDosh) — берём её.
    // повелительное обычно в начале: «Купи хлеб», «Не уходи», «Пожалуйста, подожди» («чай» в «пей чай» — не глагол)
    // «приду, пойдёшь, будет» — формы, которые морфология не узнаёт: будущее сразу
    const irr = V.irregular(w);
    if (irr) { const fut = V.futureOf(irr.lemma, formsOf); if (fut) return { ...futPiece(irr.lemma, fut, [...flat((formsOf(irr.lemma) || {}).inf), ...flat((formsOf(irr.lemma) || {}).pres)]), pn: irr.pn }; }
    const imp = ctx.first ? imperative(w) : null;
    if (imp) return imp;
    if (imp === false) return null;
    // после глагола «еду», «воду» — скорее существительное (еда, вода), чем «ехать», «водить»
    const exact = RET.lookupWord(w, "ru", 1);
    if (ctx.afterVerb && !(exact && !exact.lemma) && RET.lemmas(w, "ru").some(isVerbLemma)) {
      // сама форма в словаре разобрана как существительное («детей» — «ребёнок, дети»): выбор значения — в dictWord
      const dw = !tune.noSense && exact && exact.lemma && !isVerbLemma(low(exact.lemma)) ? dictWord(w, "ru") : null;
      if (dw) return dw;
      for (const l of RET.lemmas(w, "ru")) {
        // «мать» кончается на -ть, но это существительное (в словаре с классом): «Скажи матери»
        if (isVerbLemma(l) && (tune.noSense || !(dictWord(l, "ru") || {}).noun)) continue;
        const n = dictWord(l, "ru");
        if (n && !n.presOnly) { n.how = "lemma"; n.lemma = l; return n; }
      }
    }
    let d = null, numNoun = false;
    // после числа — существительное в начальной форме, ед. ч. (справочник, раздел 8: «ши саг», «кхо шу», «ши ди»):
    // «два дома» — «ши цӀа», а не «цӀагӀа» (дома — «at home»)
    if (ctx.afterNum && !tune.noCases) {
      for (const l of RET.lemmas(w, "ru")) {
        if (l === w || (isVerbLemma(l) && !L.PERSON_CLASS[l]) || !nounBase(l)) continue; // «дочь», «мать» — не глаголы
        const dl = dictWord(l, "ru");
        if (dl) { d = { ...dl, how: "lemma", lemma: l }; numNoun = true; break; }
      }
    }
    if (!d) d = dictWord(w, "ru");
    if (!d) {
      const a0 = aligned(w, "ru", false);
      if (!a0) return null;
      // форма глагола, которой нет в словаре («поел» — «йиай» по парам фраз): это глагол — связку не ставим
      // (морфология «поел» не знает — тогда по окончанию прошедшего времени: -ал, -ел, -ил…)
      const vl = VERBISH.test(w) && (RET.lemmas(w, "ru").find((l) => isVerbLemma(l) && !L.PERSON_CLASS[l]) || (!RET.lemmas(w, "ru").length && w.length >= 4 && /[аеиоуяю]л[аои]?$/.test(w) && V.seen(a0) ? w : null));
      if (vl) return { to: a0, how: "align", verb: true, inf: false, lemma: vl };
      // «брата» — «воша»: класс человека по начальной форме (справочник: мужчина — в, женщина — й)
      const pl = RET.lemmas(w, "ru").find((l) => L.PERSON_CLASS[l]);
      return pl ? { to: a0, how: "align", cls: L.PERSON_CLASS[pl], lemma: pl } : { to: a0, how: "align" };
    }
    const lemma = d.lemma ? low(d.lemma) : w;
    // глагол: время по русской форме, ингушская форма — из строки словаря (наст., прош.)
    const PAST = /(л|ла|ло|ли|лся|лась|лось|лись)$/;
    let vLemma = null;
    if (!d.noun && !L.PERSON_CLASS[lemma] && isVerbLemma(lemma) && (lemma === w || VERBISH.test(w) || /ст$/.test(w))) vLemma = lemma;
    else if (!d.noun && !isVerbLemma(w) && (VERBISH.test(w) || /ст$/.test(w))) vLemma = RET.lemmas(w, "ru").find(isVerbLemma) || null;
    // явно личная форма глагола («работаем», «читаете»), даже если есть похожее существительное («работа»)
    if (!vLemma && lemma !== w && /(ем|ете|ешь|ишь|ют|ут|ят|им|ите)$/.test(w)) vLemma = RET.lemmas(w, "ru").find(isVerbLemma) || null;
    if (vLemma) {
      let tense = vLemma === w ? "inf" : PAST.test(w) ? "past" : "pres";
      if (tense === "past" && OPEN_PAST.has(vLemma)) return null;
      const r = RET.lookupWord(vLemma, "ru", 3);
      const it = r && !r.lemma && bestSense(w, vLemma, r.items.filter((x) => x.prio <= 1));
      const forms = it ? verbForms(it.line || it.inh) : {};
      const ingForms = [...flat(forms.inf), ...flat(forms.pres), ...flat(forms.past), d.to];
      // «сделаю, куплю, пойду» (совершенный вид) и «буду, будет» — будущее время: «дергда», «эцаргда»,
      // «гӀоргва», «хургда» (lib/rules/verbs.js; только формы, которые есть в текстах)
      if (tense === "pres" && (vLemma === "быть" || V.isPerfective(vLemma))) {
        const fut = V.futureOf(vLemma, formsOf);
        if (fut) return { ...futPiece(vLemma, fut, ingForms, it ? it.name : d.src), pn: V.personOf(w) };
      }
      // «пошёл» — прошедшее из записи «идти» (вахар / яхар / дахар / бахар), класс — по подлежащему
      if (tense === "past" && !forms.past && V.PAST_FROM[vLemma]) { const pf = formsOf(V.PAST_FROM[vLemma]); if (pf && pf.past) forms.past = pf.past; }
      let form = forms[tense] || (tense !== "inf" ? null : forms.inf);
      // прошедшего в словаре нет — форма из пар разговорника (ALIGN: «купил» — «ийцай»), если она есть в текстах
      if (tense === "past" && !form && ALIGN) {
        const b = ALIGN.best(w, "ru");
        if (b && b.n >= AL_N && b.p >= AL_P && b.to !== low(w) && V.seen(b.to) && !INH_PRON_SET.has(b.to) && !RET.lookupWord(b.to, "ru", 1)) form = b.to;
      }
      const base = { how: form ? "lexicon" : "lemma", lemma: vLemma, verb: true, inf: tense === "inf", tense, refl: /(ся|сь)$/.test(vLemma), src: it ? it.name : d.src, ingForms };
      const alv = aligned(w, "ru", true);
      if (alv) return { ...base, to: alv, how: "align" };
      if (typeof form === "string") return { ...base, to: form };
      if (form) return { ...base, to: form.в || form.д || Object.values(form)[0], byClass: form, person: 3 };
      // нужной формы в словаре нет — словарная форма (инфинитив), как раньше
      const inf = typeof forms.inf === "string" ? forms.inf : forms.inf ? forms.inf.в || Object.values(forms.inf)[0] : d.to;
      return { ...base, to: inf, how: "lemma" };
    }
    // словарь проекта уступает таблице только при перевесе (p ≥ 0.5): иначе «стол» стал бы «шу»
    const al = !numNoun && aligned(w, "ru", false, tune.alAll ? 0 : d.src === "словарь проекта" ? (tune.alGP || 0.5) : w === lemma ? (tune.alP || 0.3) : 0.3);
    if (al && al !== low(d.to) && (tune.noSense || !SENSE.vetoAlign(w, d.to, al, d.rejected, lemma))) { d.dictTo = d.to; d.to = al; d.how = "align"; }
    if (!d.verb && L.PERSON_CLASS[lemma]) d.cls = L.PERSON_CLASS[lemma];
    else if (!d.verb && L.ATTESTED_CLASS[lemma]) d.cls = L.ATTESTED_CLASS[lemma][1];
    else if (!d.verb && d.noun && d.dictCls && (lemma === w || ctx.afterNum) && !PL_CLS.has(low(d.to))) d.cls = d.dictCls; // класс из словаря — только для начальной формы (им. падеж) и после числа (справочник: «ши саг», ед. ч.)
    // ингушское множественное число из словаря проекта: класс — второй в записи («бер (д/д; мн. бераш)» — бераш: д)
    if (!d.verb && !d.cls && PL_CLS.has(low(d.to))) d.cls = PL_CLS.get(low(d.to));
    return d;
  }

  // ингушские местоимения и связка → русские (из той же таблицы, справочник, разделы 3 и 4)
  const INH_PRON = new Map();
  const RU_BY_CASE = {
    "я": { nom: "я", erg: "я", gen: "мой", dat: "мне", all: "ко мне" }, "ты": { nom: "ты", erg: "ты", gen: "твой", dat: "тебе", all: "к тебе" },
    "он": { nom: "он", erg: "он", gen: "его", dat: "ему" }, "мы": { nom: "мы", erg: "мы", gen: "наш", dat: "нам", all: "к нам" },
    "вы": { nom: "вы", erg: "вы", gen: "ваш", dat: "вам", all: "к вам" }, "они": { nom: "они", erg: "они", gen: "их", dat: "им" },
  };
  for (const [p, forms] of Object.entries(L.PRONOUNS)) {
    if (!RU_BY_CASE[p]) continue;
    for (const c of ["nom", "erg", "gen", "dat", "all"]) if (forms[c] && !INH_PRON.has(low(forms[c]))) INH_PRON.set(low(forms[c]), RU_BY_CASE[p][c]);
  }
  INH_PRON.set("из", "он"); // из — и «он», и «она», и «тот»
  // падеж ингушского местоимения: «со» — кто (им.), «аз» — кто делает (эрг.), «сона» — кому (дат.)
  const INH_PRON_CASE = new Map();
  for (const [p, forms] of Object.entries(L.PRONOUNS)) {
    if (!RU_BY_CASE[p]) continue;
    for (const c of ["nom", "erg", "gen", "dat", "all"]) if (forms[c] && !INH_PRON_CASE.has(low(forms[c]))) INH_PRON_CASE.set(low(forms[c]), { p, case: c });
  }
  // «вай» — мы (вместе с тобой; справочник, раздел 3: вай, вай, вай, вайна): «гӀоргда вай» — пойдём
  for (const [c, f] of Object.entries((L.PRONOUNS["мы"] || {}).alt || {})) {
    if (c === "gen") continue; // «вай» в именительном чаще, чем «наш»
    if (!INH_PRON.has(low(f))) INH_PRON.set(low(f), RU_BY_CASE["мы"][c]);
    if (!INH_PRON_CASE.has(low(f))) INH_PRON_CASE.set(low(f), { p: "мы", case: c });
  }
  const INH_Q = new Set(["мала", "фу", "мича", "мичахьа", "мичара", "маца", "хӏана", "мишта", "мел", "малагӏа"]);
  const COP_BEFORE = new Set(["ер", "ераш", "цига", "укхаза"]);
  const COP = new Map();
  for (const f of Object.values(L.COPULA.pres)) COP.set(low(f), "");
  for (const f of Object.values(L.COPULA.neg)) COP.set(low(f), "не");
  for (const f of Object.values(L.COPULA.past)) COP.set(low(f), "был");
  for (const f of Object.values(L.COPULA.q)) COP.set(low(f), "ли");
  // связка → время и класс (справочник, раздел 4): «вац» — { tense: "neg", cls: "в" }
  const COP_INFO = new Map();
  for (const [tense, set] of Object.entries(L.COPULA)) for (const [cls, f] of Object.entries(set)) COP_INFO.set(low(f), { tense, cls });
  // ингушские формы глаголов из библиотеки слов → русский глагол (лицо выберем по подлежащему)
  const INH_VERB = new Map();
  for (const v of L.VERBS) {
    const put = (x, tense) => { if (typeof x === "string") INH_VERB.has(low(x)) || INH_VERB.set(low(x), { v, tense, cls: null });
      else if (x && typeof x === "object") for (const [c, f] of Object.entries(x)) INH_VERB.has(low(f)) || INH_VERB.set(low(f), { v, tense, cls: c }); };
    put(v.pres, "pres"); put(v.past, "past"); put(v.neg, "neg");
  }
  // причастие на -ш из библиотеки слов («вахаш», «кхеташ») → глагол
  const INH_PART = new Map();
  for (const v of L.VERBS) {
    if (typeof v.part === "string") INH_PART.set(low(v.part), v.id);
    else if (v.part) for (const f of Object.values(v.part)) INH_PART.set(low(f), v.id);
  }
  // Формы глаголов из строк словаря проекта: «деша (наст. деш, прош. дийшар)» → «деш» — настоящее от «читать».
  // Только словарь проекта (справочник) и только однословные формы.
  const INH_FIN = new Map();
  {
    for (const [ru, line] of GUIDE.GLOSSARY || []) {
      const inf = firstSense(ru);
      if (!RUC.isInfinitive(inf) || /\s/.test(inf) || OPEN_PAST.has(inf)) continue;
      const f = verbForms(line);
      const infs = typeof f.inf === "string" ? [f.inf] : f.inf ? Object.values(f.inf) : [];
      for (const tense of ["pres", "past"]) {
        const x = f[tense];
        const add = (form, cls) => {
          const k = low(form);
          if (!/^[а-яӏ]+$/.test(k) || infs.some((i) => low(i) === k) || INH_FIN.has(k)) return;
          INH_FIN.set(k, { inf, tense, cls });
        };
        if (typeof x === "string") add(x, null); else if (x) for (const [c, form] of Object.entries(x)) add(form, c);
      }
    }
  }
  // возвратный глагол словаря проекта по ингушской форме: «учиться — деша / Ӏомаде» → деша: учиться
  const GLOSS_REFL = new Map();
  for (const [ru, line] of GUIDE.GLOSSARY || []) {
    const r = firstSense(ru);
    if (!/(ся|сь)$/.test(r) || !RUC.isInfinitive(r) || /\s/.test(r)) continue;
    for (const p of String(line).split("/")) { const f = low(p.trim().split(/[\s(]/)[0]); if (f && !GLOSS_REFL.has(f)) GLOSS_REFL.set(f, r); }
  }
  const PERSON = { "я": 0, "ты": 1, "он": 2, "она": 2, "мы": 3, "вы": 4, "они": 5 };
  // справочник, раздел 2: хилда, хийла — «пусть будет»
  const INH_EXTRA = { "хилда": "пусть будет", "хийла": "пусть будет" };
  // Русский глагол по ингушской словарной форме: «кхета» → «понимать». Сначала библиотека слов, потом
  // словарь проекта; из PaydaDosh — только если первое значение записи — глагол.
  function inhVerbInf(c) {
    const iv = INH_VERB.get(c);
    if (iv && iv.v.type !== "need") return iv.v.id;
    const r = RET.lookupWord(c, "inh", 6);
    if (!r || r.lemma) return null;
    const g = r.items.find((x) => x.prio === 0 && RUC.isInfinitive(firstSense(x.ru)) && !/\s/.test(firstSense(x.ru)));
    if (g) return firstSense(g.ru);
    const top = r.items[0];
    if (top && top.prio <= 1 && RUC.isInfinitive(firstSense(top.ru)) && !/\s/.test(firstSense(top.ru))) return firstSense(top.ru);
    return null;
  }
  // Причастие на -(а)ш со связкой: «кхеташ вац» — не понимаю, «вахаш ва» — живёт (справочник, разделы 5 и 6).
  // copCls — класс связки после слова: множественное существительное («дешаш» — слова, мн. ч. класса д)
  // со связкой другого класса («Хьо дешаш ва?») — не подлежащее при связке, а причастие: «Ты учишься?»
  function progressive(w, copCls = null) {
    if (!/[аеиоуэюяь]ш$/.test(w) || w.length < 2) return null; // и короткие: «беш», «еш» (де — делать)
    if (INH_PART.has(w)) return INH_PART.get(w);
    if (PL_CLS.has(w) && (!copCls || PL_CLS.get(w) === copCls)) return null; // «бераш» — дети (мн. ч. из словаря проекта), не причастие: «Тха бераш дац»
    const stem = w.slice(0, -1); // «кхета-ш», «вода-ш», «деша-ш»
    for (const c of [stem, ...classSwapInh(stem)]) {
      const inf = inhVerbInf(c);
      // «-ш» со связкой — действие идёт сейчас: несовершенный вид, если он есть в словаре («цӀендеш воал» — убираюсь)
      if (inf) return (V.isPerfective(inf) && Object.keys(makeInhVerbs.PERF).find((k) => makeInhVerbs.PERF[k] === inf && sensesOf(c).includes(k))) || inf;
    }
    return null;
  }
  // Русское прошедшее из инфинитива или причастия: «уйти» → «ушел», «умерший» → «умер», «убитый» → «убит»
  function ruPastOf(w, g) {
    if (RUC.isInfinitive(w)) return RUC.past(w, g);
    const END = { m: "", f: "а", n: "о", pl: "и" };
    let m;
    if ((m = /^(.+[аеиоуыя])вш(ий|ая|ее|ие)$/.exec(w))) return m[1] + "л" + END[g];
    if ((m = /^(.+[бвгджзклмнпрстфхцчшщ])ш(ий|ая|ее|ие)$/.exec(w))) return m[1] + END[g];
    if ((m = /^(.+н)н(ый|ая|ое|ые)$/.exec(w)) || (m = /^(.+[иыуоя]т)(ый|ая|ое|ые)$/.exec(w))) return m[1] + { m: "", f: "а", n: "о", pl: "ы" }[g];
    return null;
  }
  const progTense = (c) => ({ tense: /^past/.test(c.tense) ? "past" : "pres", neg: /neg$|Neg$/.test(c.tense), cls: c.cls });
  function classSwapInh(w) {
    const out = [];
    if ("вйб".includes(w[0]) && /[аеиоуэюяь]/.test(w[1] || "")) out.push("д" + w.slice(1));
    const IOT = { "е": "де", "я": "да", "ю": "ду" };
    if (IOT[w[0]]) out.push(IOT[w[0]] + w.slice(1));
    return out;
  }
  // Формы глагола, которых нет в словаре целиком (lib/rules/inh-verbs.js): «дергдац» — не сделает,
  // «хиннад» — было, «сабардел» — подожди. Глагол — из словаря проекта, библиотеки слов или PaydaDosh.
  function finOf(c) {
    const f = INH_FIN.get(c);
    if (f) return f;
    const iv = INH_VERB.get(c);
    if (iv && iv.v.type !== "need" && (iv.tense === "pres" || iv.tense === "past")) return { inf: iv.v.id, tense: iv.tense, cls: iv.cls, type: iv.v.type, forms: iv.v.ru };
    return null;
  }
  const SENSES = new Map();
  function sensesOf(c) {
    if (SENSES.has(c)) return SENSES.get(c);
    const out = [];
    const add = (x) => { if (x && RUC.isInfinitive(x) && !/\s/.test(x) && !out.includes(x)) out.push(x); };
    const iv = INH_VERB.get(c);
    if (iv && iv.v.type !== "need" && iv.tense === "pres") add(iv.v.id);
    const r = RET.lookupWord(c, "inh", 6);
    if (r && !r.lemma) {
      for (const it of r.items) {
        if (it.prio > 1 || !RUC.isInfinitive(firstSense(it.ru))) continue;
        String(it.ru).split(" — ")[0].replace(/\([^()]*\)/g, " ").split(/[,;]/).forEach((x) => add(x.trim().toLowerCase()));
      }
    }
    SENSES.set(c, out);
    return out;
  }
  const PERF_SET = new Set(Object.values(makeInhVerbs.PERF));
  const IV = makeInhVerbs({ finOf, sensesOf, isPerfective: (x) => V.isPerfective(x) });
  // русская форма по умолчанию (он/она; лицо поправит inhPost по подлежащему)
  const ivDefault = (a) => {
    const f = a.tense === "fut" ? RUC.future(a.inf, 2, V.isPerfective(a.inf) || PERF_SET.has(a.inf) || a.inf === "быть")
      : a.tense === "imp" ? RUC.imperative(a.inf)
      : a.tense === "past" ? RUC.past(a.inf, GENDER_OF_CLS[a.cls] || "m")
      : (a.forms && a.forms.pres && a.forms.pres[2]) || RUC.present(a.inf, 2);
    return f ? (a.neg ? "не " : "") + f : a.inf;
  };
  const ivPiece = (a) => ({ to: ivDefault(a.trans ? { ...a, cls: null } : a), how: a.how, verbRu: { inf: a.inf, tense: a.tense, neg: a.neg, cls: a.trans ? null : a.cls, type: a.type, forms: a.tense === "pres" ? a.forms : null, trans: !!a.trans }, lemma: a.inf, imper: a.tense === "imp" });
  // «воал, йоал, доал, боал» — находится, бывает; после причастия на -ш — как связка: «ЦӀа цӀендеш воал со»
  // (я убираюсь), «Нана локъамаш еш йоал» (мама делает оладьи), «Тика мичахьа йоал?» (где магазин?) — PaydaDosh
  const OAL = { "воал": "в", "йоал": "й", "доал": "д", "боал": "б" };
  // все русские значения ингушского слова в надёжных словарях (строчными)
  const inhSensesOf = (w) => { const r = RET.lookupWord(w, "inh", 6); return r && !r.lemma ? r.items.filter((x) => x.prio <= WORD_PRIO).flatMap((x) => SENSE_INH.sensesOfRu(x.ru)).map(low) : []; };
  function inhWord(w, last, first, next, depth = 0, clauseLast = false, prev = null) {
    if (INH_EXTRA[w]) return { to: INH_EXTRA[w], how: "lexicon" };
    const iv = INH_VERB.get(w);
    if (iv) {
      const ru = iv.tense === "past" ? (iv.v.ru.past || [])[iv.cls === "й" ? 1 : 0] : (iv.v.ru.pres || [])[2];
      if (ru) return { to: iv.tense === "neg" ? "не " + ru : ru, how: "lexicon", inhVerb: iv, verbRu: { inf: iv.v.id, tense: iv.tense === "past" ? "past" : "pres", neg: iv.tense === "neg", cls: iv.cls, type: iv.v.type, forms: iv.v.ru } };
    }
    // связка в конце предложения («Са да лор ва»): в русском настоящем времени её нет
    // и перед местоимением в вопросе («Мишта ва хьо?» — как ты?)
    // и после вопросительного слова или перед «ер, цига, укхаза» («Мала ва цига?» — кто там?, «МалагӀа юрт я ер?» —
    // это какое село?, «Ара ваха моттиг мичай укхаза?» — PaydaDosh; вопросительные слова — справочник, раздел 3)
    if ((!first || (COP_INFO.get(w) || {}).tense === "q") && COP.has(w) && (last || INH_PRON.has(next) || COP_BEFORE.has(next) || INH_Q.has(prev))) return { to: COP.get(w), how: "copula", cop: COP_INFO.get(w) };
    if (INH_PRON.has(w)) return { to: INH_PRON.get(w), how: "lexicon", ruPron: INH_PRON.get(w), pc: INH_PRON_CASE.get(w) };
    const fin = INH_FIN.get(w);
    if (fin) {
      const to = fin.tense === "past" ? RUC.past(fin.inf, fin.cls === "й" ? "f" : "m") : RUC.present(fin.inf, 2);
      if (to) return { to, how: "lexicon", verbRu: { inf: fin.inf, tense: fin.tense, cls: fin.cls } };
    }
    if (!depth && OAL[w] && !first) return { to: "", how: "copula", cop: { tense: "pres", cls: OAL[w] }, oal: true };
    let al = aligned(w, "inh", false);
    const d = dictWord(w, "inh");
    // повелительное на «-л» — в конце предложения или части (до запятой) или когда «начальная форма» слова —
    // глагол («дувцал» → «дувца»); иначе «-ал» — это скорее сравнение («дешал» — чем слово)
    const verbBase = d && d.how === "lemma" && RUC.isInfinitive(String(d.to).split(" ")[0]);
    let an = depth || tune.noInhVerbs ? null : IV.analyze(w, { last: last || clauseLast || verbBase });
    // причастие из словаря + класс — перфект: «ийцай» = «ийца» (взятый) + й → взял (PaydaDosh: «Цо машен
    // ийцай» — он купил машину). Глагол — из самого причастия: «взятый» → «взять», «сделанный» → «сделать»
    if (!an && !depth && !tune.noInhVerbs && d && d.how === "lemma") {
      const pm = /^(.+)([вйдб])(ац)?$/.exec(w), pw = low(String(d.to).split(" ")[0]);
      const pi = pm && low(d.lemma) === pm[1] && (/^(.+[аеиоуыя])т(ый|ая|ое|ые)$/.exec(pw) || /^(.+[ая])нн(ый|ая|ое|ые)$/.exec(pw));
      if (pi) an = { inf: pi[1] + "ть", tense: "past", neg: !!pm[3], cls: pm[2], how: "perfect", trans: true };
    }
    // форма глагола — не русская частица: «хетац», «хиннавац» таблица слов ставит в пару с «не»
    if (an && FUNC_RU.has(al)) al = null;
    // будущее («-рг-») надёжнее таблицы слов: она ставит его в пару с настоящим («эцаргда» — «покупаю»);
    // вежливое повелительное — нет: «Бехк ма баккхалахь» таблица знает целиком (извините)
    if (an && an.strong && (an.tense === "fut" || !al)) return ivPiece(an, w);
    // таблица слов дала прилагательное — кусок значения словаря из нескольких слов («эг» — «точильный» из
    // «брусок, оселок, точильный камень», PaydaDosh): это не перевод, берём значение словаря
    if (al && d && d.how !== "lemma" && /(ый|ий|ой)$/.test(al) && !/\s/.test(d.to) && inhSensesOf(w).some((s) => /\s/.test(s) && s.split(/\s+/).includes(al))) al = null;
    if (al && (!d || al !== low(d.to))) return { ...(d || {}), to: al, how: "align" };
    // словарь знает только «начальную форму» по догадке, а слово — форма глагола: глагол возьмём,
    // если в предложении не окажется другого глагола (решает sentence)
    if (an && d && d.how === "lemma") return { ...d, alt: ivPiece(an, w) };
    if (d || depth) return d;
    // слитная связка: «Миштав хьо?» = «Мишта ва хьо?» — основа без в/й/д/б должна быть известным словом
    const m = /^(.{2,}[аеиоуэюяь])([вйдб])$/.exec(w);
    if (m && !/[вйдб]ий$/.test(w)) {
      const stem = m[1], cls = m[2];
      const base = INH_PRON.has(stem) ? null : inhWord(stem, false, first, next, 1);
      if (base && base.to && !/^\[/.test(base.to) && base.how !== "lemma") {
        // основа — глагол или причастие («дӀаваха-в», «вийна-в», «венна-в»): это прошедшее время —
        // «ушёл», «убит», «умер»; род — по классу связки (в — он, й — она)
        const g = GENDER_OF_CLS[cls];
        const [w1, ...rest] = String(base.to).split(" ");
        const pst = ruPastOf(low(w1), g);
        if (pst) return { ...base, to: [pst, ...rest].join(" "), how: "contracted", cop: { tense: "pres", cls }, contracted: true, perfect: true };
        // не глагол: «Мишта-в хьо?» — только слово из словаря проекта
        if (base.how === "lexicon" || base.src === "словарь проекта") return { ...base, how: "contracted", cop: { tense: "pres", cls }, contracted: true };
      }
    }
    if (an) return ivPiece(an, w);
    // разбор поглубже (lib/morph.js, deep): связка на конце, чередование гласной в падежах («ненаца» → «нана»).
    // Только когда иначе слово осталось бы в [скобках], и только глагол или существительное с классом из словаря
    if (!depth && !tune.noDeep) {
      const r = RET.lookupWord(w, "inh", 6, true);
      const it = r && r.lemma && r.items.find((x) => x.prio <= WORD_PRIO);
      const to = it && firstSense(it.ru);
      if (to && !/[a-z]/i.test(to) && !/^(прош|наст|мн)\./.test(to)) {
        const line = String(it.line || it.inh);
        const noun = /\(\s*[вйдб]\s*[\/,-]/.test(line);
        const verb = RUC.isInfinitive(to) && !/\s/.test(to);
        // глагол с классом на конце — перфект, как «дахад», «хиннад»: «Бераш хьадаьхкад» — дети пришли (PaydaDosh)
        const pm = verb && /[аеиоуэюяь]([вйдб])(ац)?$/.exec(w);
        if (pm) { const a = { inf: to, tense: "past", neg: !!pm[2], cls: pm[1], how: "deep" }; return { ...ivPiece(a), lemma: r.lemma, src: it.name }; }
        if (noun || verb) return { to, how: "deep", lemma: r.lemma, src: it.name, noun };
      }
    }
    return null;
  }

  // Ингушский → русский: лицо и время глагола, подлежащее и порядок слов по-русски.
  const RU_Q = new Set(["что", "кто", "где", "куда", "откуда", "когда", "как", "почему", "зачем", "сколько", "какой", "чей"]);
  const RU_Q_ADJ = /^(как(ой|ая|ое|ие|ую|ого|ому|им|ом|их|ими)|чь(я|е|и|ю|его|ей|их))$/;
  const GENDER_OF_CLS = { в: "m", й: "f", д: "n", б: "pl" };
  // «из» прямо перед существительным, когда подлежащее — другое местоимение: «этот, эта, это»
  // («Цу хана из кинишка дешаш вар хьо?» — ты тогда читал эту книгу?, PaydaDosh; справочник, раздел 3: из — он, она, это)
  const DEM = { nom: { m: "этот", f: "эта", n: "это", pl: "эти" }, acc: { m: "этот", f: "эту", n: "это", pl: "эти" } };
  function demInh(out) {
    const subjOther = (x) => out.some((y) => y !== x && y.pc && low(y.from || "") !== "из" && /^(nom|erg|have)$/.test(y.pc.case));
    for (const x of out) {
      if (low(x.from || "") !== "из" || !x.pc || x.pc.case !== "nom" || !subjOther(x)) continue;
      const n = out.find((y) => y.at === x.at + 1 && y.to);
      if (!n || n.pc || n.verbRu) continue;
      const lemma = low(n.was || n.to);
      if (!isRuNoun(lemma) && !looseNoun(lemma)) continue;
      const kase = n.ruCase || "nom";
      if (!DEM[kase]) continue;
      const g = n.inhPl ? "pl" : D.gender(lemma);
      if (!g) continue;
      x.to = kase === "acc" && D.animate(lemma) ? (g === "f" ? "эту" : g === "pl" ? "этих" : "этого") : DEM[kase][g];
      x.pc = { ...x.pc, case: "dem" }; x.ruPron = null;
    }
  }
  // кому говорят — направительный падеж («сога»), по-русски дательный: «Цо сога аьннад» — он мне сказал, «Цо йишах
  // лаьца гӀулакх дийцар сога» — он рассказал мне о сестре, «Цхьа хӀама алал сога» — скажи мне что-нибудь (PaydaDosh)
  const SPEECH_RU = /^(не )?(сказ|скаж|говор|рассказ|расскаж|сообщ|ответ|объясн|показ|покаж|написа|напиш|пиш|дал|дай|дав|да[мш]ь?|даст)/;
  function speechInh(out) {
    if (!out.some((y) => !y.pc && y.to && (y.verbRu || y.imper || /^(corpus|align|word|lexicon|fut|imper|perfect)$/.test(y.how)) && SPEECH_RU.test(low(y.to)) && (y.verbRu || RUC.isInfinitive(low(y.to)) || /(л|ла|ли|ло|и|ай|ет|ит|ут|ют|ят)$/.test(low(y.to))))) return;
    for (const x of out) if (x.pc && x.pc.case === "all" && R.PRON_DAT[x.pc.p]) { x.to = R.PRON_DAT[x.pc.p]; x.pc = { ...x.pc, case: "dat2" }; }
  }
  function inhPost(out, opts = {}) {
    demInh(out);
    speechInh(out);
    const prons = out.filter((x) => x.pc);
    const verbs = out.filter((x) => x.verbRu);
    const copula = out.find((x) => x.how === "copula" && x.cop) || out.find((x) => x.cop);
    const cls0 = (verbs[0] && verbs[0].verbRu.cls) || (copula && copula.cop.cls) || null;
    // «Из кхалсаг я» — связка или глагол класса й: «из» здесь «она»
    for (const x of prons) if (x.from === "из" && x.pc.case === "nom" && cls0 === "й") { x.to = "она"; x.ruPron = "она"; }
    // «Из вай цӀа да» — это наш дом (PaydaDosh): связка класса д без глагола — «это»
    // и связка внутри куска таблицы слов: «Из са | болх ба» — это моя работа
    const copCls = copula && copula.how === "copula" ? copula.cop.cls : ((COP_INFO.get(low(String((out.filter((y) => y.from).pop() || {}).from || "").split(" ").pop())) || {}).tense === "pres" ? COP_INFO.get(low(String(out.filter((y) => y.from).pop().from).split(" ").pop())).cls : null);
    for (const x of prons) if (x.from === "из" && x.pc.case === "nom" && !verbs.length && /^[дб]$/.test(copCls || "")) { x.to = "это"; x.ruPron = null; }
    const ruOf = (x) => (x.ruPron === "она" ? "она" : x.pc.p);
    let subj = null;
    const v = verbs[0];
    if (v) {
      const type = v.verbRu.type;
      if (type === "need") return orderInh(out, null, opts);
      const byCase = (c) => prons.find((x) => x.pc.case === c);
      if (type === "dat") subj = byCase("dat");
      else if (type === "erg") subj = byCase("erg");
      // кто делает переходное действие — в эргативе («Аз из дергдац»): он и подлежащее, «из» — дополнение
      else subj = (v.verbRu.tense && byCase("erg")) || byCase("nom") || byCase("erg");
      if (subj && (type === "dat" || type === "erg" || subj.pc.case === "erg")) {
        // «Сона хьо веза» → «Я тебя люблю»: кому — подлежащее, кто в именительном — дополнение
        subj.to = ruOf(subj); subj.ruPron = subj.to;
        for (const x of prons) if (x !== subj && x.pc.case === "nom") x.to = R.PRON_ACC[ruOf(x)] || x.to;
      }
      if (type === "dat" && !subj) return orderInh(out, null, opts);
      // местоимение внутри куска таблицы слов («хьо мичахьа» — «где ты»): лицо глагола — по нему
      // («Хьо мичахьа дешаш ва?» — где ты учишься?, PaydaDosh)
      const inPiece = !subj && type !== "dat" && out.filter((y) => y !== v && !y.pc && y.from && /\s/.test(y.from) && y.to)
        .map((y) => { const f = low(y.from).split(/\s+/).find((t) => INH_PRON_CASE.has(t) && /^(nom|erg)$/.test(INH_PRON_CASE.get(t).case)); return f && low(y.to).split(/\s+/).includes(INH_PRON_CASE.get(f).p) ? INH_PRON_CASE.get(f).p : null; })
        .find(Boolean);
      const who = subj ? ruOf(subj) : inPiece || null;
      const person = who ? PERSON[who] : v.verbRu.subjPl ? 5 : 2;
      for (const x of verbs) {
        const r = x.verbRu;
        if (r.type === "need") continue;
        let f = null;
        // «деза» после глагола в будущем — «придётся»: «Сабарде дезаргда» — придётся подождать, «Кхо сахьат даккха
        // дезаргда вай» — нам придётся провести три часа (PaydaDosh)
        const prevTo = (out.slice(0, out.indexOf(x)).reverse().find((y) => y.to) || {}).to;
        if (r.tense === "fut" && r.inf === "любить" && RUC.isInfinitive(String(prevTo || "").split(" ").pop())) f = "придется";
        else if (r.tense === "fut") f = RUC.future(r.inf, person, V.isPerfective(r.inf) || PERF_SET.has(r.inf) || r.inf === "быть");
        else if (r.tense === "imp") f = RUC.imperative(r.inf);
        else if (r.tense === "past") {
          const g = who ? R.pronGender(who, r.cls) : r.subjG || GENDER_OF_CLS[r.cls] || "m";
          const i = { m: 0, f: 1, n: 2, pl: 3 }[g];
          f = (r.forms && r.forms.past && r.forms.past[i]) || RUC.past(r.inf, g);
        } else {
          f = (r.forms && r.forms.pres && r.forms.pres[person]) || RUC.present(r.inf, person);
        }
        if (f) x.to = (r.neg ? "не " : "") + f;
      }
    } else {
      subj = prons.find((x) => x.pc.case === "nom") || null;
      // прошедшее связки — по подлежащему: «Мича дар шо?» — «Где вы были?»
      for (const x of out.filter((y) => y.how === "copula" && y.cop && /^past/.test(y.cop.tense))) {
        const g = subj ? R.pronGender(ruOf(subj), x.cop.cls) : GENDER_OF_CLS[x.cop.cls] || "m";
        x.to = (/Neg$/.test(x.cop.tense) ? "не " : "") + R.COP_PAST[g];
      }
    }
    return orderInh(out, subj, opts);
  }
  // Согласование по-русски: прилагательное и «мой, твой…» — в роде следующего существительного
  // («Мой имя» → «Моё имя», «хороший дорога» → «хорошая дорога»). Род не виден — слово не меняется.
  function agreeInh(out) {
    const live = out.filter((x) => x.to && x.how !== "copula");
    for (let k = 0; k + 1 < live.length; k++) {
      const a = live[k], n = live[k + 1];
      const aw = String(a.to), nw = String(n.to);
      if (/\s/.test(aw) || /\s/.test(nw) || a.verbRu || n.verbRu || n.pc || /^[А-ЯЁ]/.test(nw) && n.how === "name") continue;
      if (n.ruCase || a.ruCase) continue; // падеж уже поставил ruCasesInh вместе с согласованием
      if (/(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/.test(low(nw))) continue; // за прилагательным — прилагательное
      const g = R.gender(low(nw));
      if (!g || g === "m") continue;
      const lw = low(aw);
      let f = null;
      if (["мой", "твой", "наш", "ваш", "свой"].includes(lw)) f = R.poss(lw, g);
      else if (/(ый|ий|ой)$/.test(lw) && lw.length > 3 && !/(щий|вший)$/.test(lw) && !a.pc) f = R.adj(lw, g);
      if (f) a.to = /^[А-ЯЁ]/.test(aw) ? f[0].toUpperCase() + f.slice(1) : f;
    }
  }
  // Порядок слов по-русски: вопросительное слово — первым, подлежащее — перед сказуемым
  // («Мича вах хьо?» → «Где ты живёшь?»), «не» связки — перед сказуемым («Со цӀагӀа вац» → «Я не дома»).
  function orderInh(out, subj, opts) {
    agreeInh(out);
    const live = () => out.filter((x) => x.to);
    const move = (x, k) => { const a = out.indexOf(x); out.splice(a, 1); out.splice(k > a ? k - 1 : k, 0, x); };
    const q = live().find((x) => RU_Q.has(low(x.to)) || RU_Q_ADJ.test(low(x.to)));
    if (q && opts.question && live()[0] !== q) {
      // «какую книгу», «чей дом» — вопрос вместе со словом, к которому он относится
      const L0 = live(), nq = L0[L0.indexOf(q) + 1];
      const withN = RU_Q_ADJ.test(low(q.to)) && nq && !nq.verbRu && !nq.pc && nq.how !== "copula";
      move(q, out.indexOf(L0[0]));
      if (withN) move(nq, out.indexOf(q) + 1);
    }
    if (!subj) subj = out.find((x) => x.pc && x.pc.case === "nom" && x.to);
    const pred = out.find((x) => x.verbRu && x.to) || out.find((x) => x.how === "copula" && x.to && x.to !== "не" && x.to !== "ли");
    // подлежащее после сказуемого: в вопросе — перед сказуемым («Где ты живёшь?»), иначе — в начало («Я иду…»)
    if (subj && pred && out.indexOf(subj) > out.indexOf(pred)) move(subj, q ? out.indexOf(pred) : out.indexOf(live()[0]));
    // кто — что — делает (ингушский порядок, справочник, раздел 8) → по-русски кто — делает — что, если «что» —
    // существительное: «Цо кинишка дийшад» — он прочитал книгу, «Сона нана еза» — я люблю мать (PaydaDosh: «Я люблю
    // маму»). Местоимение остаётся перед глаголом: «Сона хьо веза» — я тебя люблю.
    if (subj && pred && pred.verbRu && !pred.imper && !q && !opts.question && out.indexOf(subj) < out.indexOf(pred) && live()[live().length - 1] === pred) {
      const L2 = live(), from = L2.indexOf(subj), to = L2.indexOf(pred);
      const obj = L2.slice(from + 1, to).find((x) => !x.pc && !x.verbRu && x.how !== "copula" && !/\s/.test(x.to) && (x.ruCase === "acc" || (!x.ruCase && x.inhPl) || (!x.ruCase && /^(word|lemma|align)$/.test(x.how) && isRuNoun(low(x.to)) && pred.verbRu.type === "dat")));
      // вместе с наречием перед глаголом: «Сона лоамаш дукха деза» — я очень люблю горы
      if (obj && L2.slice(L2.indexOf(obj) + 1, to).every((x) => !x.pc)) for (const x of L2.slice(L2.indexOf(obj) + 1, to + 1)) move(x, out.indexOf(obj));
    }
    // повелительное по-русски — в начале, кому — сразу за ним: «Цхьа хӀама алал сога» — скажи мне что-нибудь,
    // «КӀеззига сабардел» — подожди немного (PaydaDosh); запрет «ма» уже слит с глаголом
    if (pred && pred.imper && !q && !subj && live()[0] !== pred) {
      move(pred, out.indexOf(live()[0]));
      const d = out.find((y) => y.pc && /^(dat|dat2)$/.test(y.pc.case) && y.to);
      if (d && out.indexOf(d) > out.indexOf(pred)) move(d, out.indexOf(pred) + 1);
    }
    const neg = out.find((x) => x.how === "copula" && x.to === "не");
    if (neg && !pred) {
      const L2 = live(), k = L2.indexOf(neg);
      const start = L2.findIndex((x) => x !== q && x !== subj);
      if (subj && L2.indexOf(subj) < k && start >= 0 && start < k) move(neg, out.indexOf(L2[start]));
      else if (k > 0 && L2[k - 1] !== subj && L2[k - 1] !== q) move(neg, out.indexOf(L2[k - 1]));
    }
  }

  // Ингушский → русский: падеж русского существительного по окончанию ингушского слова (справочник, раздел 6)
  // и по роли в предложении. Русские формы строит lib/rules/ru-decl.js; ингушских слов здесь не создаётся —
  // только узнаётся окончание у слова из входного текста:
  //   -ца (сагаца, ненаца) — «с» + творительный (транспорт — «на»: «на автобусе»; части тела — без предлога);
  //   -га / -ега / -ка (нанега) — о человеке «к» + дательный; о месте с глаголом движения — «в / на» + винительный;
  //   -ра / -ара (юртара, Москвера) — «из» + родительный (о человеке — «от»);
  //   -х / -ах (сагах) — «о» + предложный, только с глаголом речи или мысли или с послелогом «лаьца(на)»;
  //   -на (нанна, цунна) — дательный; -о / -с (саго, нанас) — эргатив: подлежащее, род прошедшего — по нему;
  //   -а / -н или «аь» (сага, дунен, наьна) перед существительным — родительный, по-русски после него («язык матери»);
  //   город + е (Назране) и формы «куда» из библиотеки слов (ишколе, балха) — «в / на»: с глаголом движения
  //   винительный («иду на работу»), иначе предложный («живёт в Назрани»); «цӀа» с глаголом движения — «домой».
  // Существительное в именительном при переходном глаголе (подлежащее в эргативе: «Цо машен ийцай») —
  // дополнение: винительный («Он машину взял»). У глагола с дательным подлежащим («Сона нана еза» — справочник,
  // раздел 5) дательное существительное — подлежащее, именительное — дополнение.
  // Множественное число по-ингушски (-аш-) не трогаем: русского множественного здесь не строим.
  const MOTION = new Set(["идти", "ходить", "ехать", "ездить", "пойти", "поехать", "прийти", "приехать", "приходить", "уйти", "уехать", "уходить", "вернуться", "возвращаться", "бежать", "лететь", "полететь", "отправиться", "переехать", "зайти", "заходить", "войти", "выйти", "дойти", "доехать", "добраться", "направляться", "спешить", "торопиться"]);
  const ABOUT = new Set(["говорить", "сказать", "рассказывать", "рассказать", "думать", "подумать", "спрашивать", "спросить", "писать", "написать", "слышать", "услышать", "знать", "мечтать", "вспоминать", "вспомнить", "помнить", "забыть", "забывать", "беспокоиться", "заботиться", "петь", "читать", "понимать", "узнать", "узнавать", "обсуждать", "сообщать", "сообщить", "спорить", "плакать", "жалеть", "скучать"]);
  const VEHICLE = new Set(["автобус", "машина", "поезд", "самолет", "такси", "маршрутка", "велосипед", "лошадь", "конь", "трамвай", "троллейбус", "метро", "корабль", "лодка", "арба", "телега"]);
  const BODY = new Set(["рука", "нога", "голова", "глаз", "палец", "язык", "зуб", "ухо", "нос", "рот", "сердце", "плечо", "спина", "кулак", "ладонь", "локоть", "колено"]);
  // послелоги (справочник, раздел 6: «дунен тӀа», «базар тӀа»): падеж перед ними решает сам послелог
  const POSTP = new Set(["кӏал", "тӏа", "чу", "юккъе", "юкъе", "хьалха", "тӏехь", "гонахьа", "тӏера", "чура", "кӏалха", "тӏехьа", "духьа", "дух"]);
  const ABOUT_POSTP = new Set(["лаьца", "лаьцна"]);
  const PLACE_INH = new Map(); // ишколе → школа, балха → работа, назране → назрань
  for (const [ru, inh] of [...Object.entries(L.DESTINATIONS), ...Object.entries(L.LOCATIONS)]) if (!/\s/.test(inh)) PLACE_INH.set(low(inh), ru);
  const PLACE_ON = new Set(["работа", "рынок", "базар", "улица", "площадь", "свадьба", "урок", "море", "юг", "север", "кавказ"]); // «на работу», а не «в работу»
  const RU_NOT_NOUN = new Set(["это", "этот", "то", "тот", "что", "кто", "все", "всё", "весь", "сам", "себя", "один", "ничто", "никто", "что-то", "кто-то"]);
  const isRuNoun = (t) => !!t && !RU_NOT_NOUN.has(t) && !/\s/.test(t) && !(RUC.isInfinitive(t) && !D.gender(t)) && !/(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/.test(t) && !!(L.PERSON_CLASS[t] || L.ATTESTED_CLASS[t] || nounBase(t));
  // падеж ингушского слова w со словарной формой b: что прибавилось к основе (с учётом чередования гласной:
  // «наьна», «ненаца», «нанех» — от «нана»). Основа короче трёх букв — только чередование («даьна»).
  const cpOf = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  function inhCaseOf(w, b, nextNoun) {
    w = low(w); b = low(b);
    if (!b || w === b || w.length < 3 || /\s/.test(b)) return null;
    let w2 = w.replace("аь", "а");
    // «аь» и в словарной форме («кӀаьнк» — «кӀаьнкаш»): это не чередование
    const ab = w2 !== w && !b.includes("аь");
    b = b.replace("аь", "а");
    const i = w2.indexOf("е");
    if (i > 0 && cpOf(w2, b) <= i) { const t = w2.slice(0, i) + "а" + w2.slice(i + 1); if (cpOf(t, b) > cpOf(w2, b)) w2 = t; }
    const cp = cpOf(w2, b);
    if (cp < Math.max(2, b.length - 1)) return null;
    const suf = w2.slice(cp);
    if (!suf) return ab && w2 === b && nextNoun ? "gen" : null; // «наьна мотт» — язык матери (а «даьна» — отцу: -на)
    // множественное число на -аш и его падежи (справочник, раздел 6: «юрташка» — к сёлам; PaydaDosh: «доттагӀашца
    // вӀашагӀкхета» — встречаться с друзьями, «Берашта моттигаш йий укхаза?» — места для детей, «Хоза я лоамашка» —
    // в горах красиво, «хьалхашкара мугӀарах» — на передние ряды): «машенаш» — машины
    const pl = /^аш(|ца|ка|та|кара)$/.exec(suf);
    if (pl && b.length >= 3) return "pl:" + ({ "": "nom", "ца": "ins", "ка": "all", "та": "dat", "кара": "from" })[pl[1]];
    if (b.length < 3 || /^аш/.test(suf)) return null;
    if (/^а?ца$/.test(suf)) return "ins";
    if (/^[еи]?[гк]а$/.test(suf)) return "all";
    if (/^[ае]?ра$/.test(suf)) return w === "тайпара" ? null : "from"; // «кхыча тайпара» — иначе (наречие)
    if (/^[ае]?х$/.test(suf)) return "abl";
    if (/^[ае]?н?на$/.test(suf)) return "dat";
    if ((/^а?с$/.test(suf) && /[аеиоуэюя]$/.test(b)) || (suf === "о" && !/[аеиоуэюя]$/.test(b))) return "erg";
    if ((suf === "а" && !/[аеиоуэюя]$/.test(b)) || (suf === "н" && /[аеиоуэюя]$/.test(b))) return nextNoun ? "gen" : null;
    return null;
  }
  // [падеж по-русски, предлог] по ингушскому падежу
  const RU_OF = { ins: ["ins", "с"], all: ["dat", "к"], from: ["gen", "из"], abl: ["prep", "о"], dat: ["dat", ""], gen: ["gen", ""], erg: ["nom", ""] };
  // словарная ингушская форма, от которой таблица слов дала перевод: её перевод в словаре должен совпасть с
  // переводом таблицы или быть его начальной формой («автобусаца» — таблица: «автобусе», словарь: «автобус»)
  // → { b: ингушская основа, lemma: русская начальная форма }
  function alignBase(w, to) {
    const t = low(to), tl = RET.lemmas(t, "ru") || [];
    for (const c of [w, ...new Set([...(RET.lemmas(w, "inh") || []), ...(RET.lemmas(w, "inh", true) || [])])]) {
      const d = dictWord(c, "inh");
      if (!d || d.how === "lemma") continue;
      if (low(d.to) === t || tl.includes(low(d.to))) return { b: c, lemma: low(d.to) };
    }
    return null;
  }
  // «веза, еза, деза, беза» — и «любить», и «нужно» (lib/rules/lexicon.js). Как решают носители в разговорнике
  // (PaydaDosh, справочник; ингушских слов здесь не создаётся — только смотрим на входной текст):
  //   кого любят — местоимение («Сона хьо веза» — я тебя люблю, «Цунна из чӀоагӀа веза» — он очень любит её)
  //   или есть «дукха / чӀоагӀа» («Сона лоамаш дукха деза» — я люблю горы) → «любить», «дукха» — «очень»;
  //   перед ним инфинитив («Ваха веза са» — мне надо идти, «Мича ваха веза са?» — куда мне надо идти?,
  //   «Телеграмма тоха йеза са» — мне нужно послать телеграмму) → «надо»;
  //   кому — местоимение, а что — существительное или «фу» («Сона лор веза» — мне нужен врач, «Сона талмач
  //   веза» — мне нужен переводчик, «Фу деза шоана?» — что вам нужно?) → «нужен / нужна / нужно / нужны»;
  //   родные («Нанна воӀ веза» — мать любит сына) и всё прочее — «любить», как было.
  const KIN = new Set(["мать", "отец", "сын", "дочь", "брат", "сестра", "ребенок", "дети", "муж", "жена", "родина", "друг", "мама", "папа", "бабушка", "дедушка", "внук", "внучка", "семья", "родители"]);
  const INTENS = new Set(["дукха", "чӏоагӏа"]);
  const NEED_OF = { m: "нужен", f: "нужна", n: "нужно", pl: "нужны" };
  // существительное по-русски, которого нет в словаре проекта («толмач»): род виден, не прилагательное и не глагол
  const looseNoun = (t) => !!t && !/\s/.test(t) && !RU_NOT_NOUN.has(t) && !RU_Q.has(t) && !/(ый|ий|ой|ая|яя|ое|ее|ые|ие|о)$/.test(t) && !RUC.isInfinitive(t) && !!D.gender(t);
  function dezaInh(out, opts = {}) {
    const x = out.find((y) => y.verbRu && y.verbRu.inf === "любить" && y.verbRu.tense === "pres" && !y.verbRu.neg && /^[вйдб]?еза$/.test(low(y.from || "")));
    if (!x) {
      // кусок таблицы слов «ваха веза» — «надо идти»: «са, хьа» в конце — «мне, тебе» («Мича ваха веза хьа?» — куда тебе надо идти?)
      const m = out.find((y) => /[вйдб]?еза$/.test(low(y.from || "")) && /(^|\s)(надо|нужно)(\s|$)/.test(low(y.to || "")));
      const g = m && out.slice(out.indexOf(m) + 1).find((y) => y.to);
      if (g && g.pc && g.pc.case === "gen" && !out.slice(out.indexOf(g) + 1).some((y) => y.to) && RU_BY_CASE[g.pc.p]) {
        g.to = RU_BY_CASE[g.pc.p].dat; g.pc = { ...g.pc, case: "dat" };
        const a = out.indexOf(g); out.splice(a, 1); out.splice(out.indexOf(m), 0, g);
      }
      return;
    }
    const k = out.indexOf(x);
    const datP = out.find((y) => y.pc && y.pc.case === "dat");
    const nomP = out.find((y) => y.pc && y.pc.case === "nom");
    const intens = out.filter((y) => INTENS.has(low(y.from || "")));
    if (nomP || intens.length) { for (const y of intens) if (out.indexOf(y) < k) y.to = "очень"; return; }
    const prev = out.slice(0, k).reverse().find((y) => y.to);
    const last = (s) => low(String(s || "").split(" ").pop());
    const move = (y, at) => { const a = out.indexOf(y); out.splice(a, 1); out.splice(at > a ? at - 1 : at, 0, y); };
    const qFirst = () => { const q = out.find((y) => y.to && RU_Q.has(low(y.to))); return q && out.indexOf(q) === out.findIndex((y) => y.to) ? out.indexOf(q) + 1 : out.findIndex((y) => y.to); };
    // кому: «сона», а в конце предложения и «са, хьа» («Ваха веза са» — мне надо идти)
    let who = datP;
    if (!who) {
      const g = out.slice(k + 1).find((y) => y.to);
      if (g && g.pc && g.pc.case === "gen" && !out.slice(out.indexOf(g) + 1).some((y) => y.to)) { who = g; g.to = RU_BY_CASE[g.pc.p].dat; g.pc = { ...g.pc, case: "dat" }; }
    }
    if (!who) return;
    const modal = prev && !prev.pc && !prev.verbRu && RUC.isInfinitive(last(prev.to)) && !D.gender(last(prev.to));
    let obj = null;
    if (!modal) {
      obj = out.slice(0, k).reverse().find((y) => y.to && y !== who && !y.pc && !y.verbRu && (low(y.to) === "что" || isRuNoun(low(y.to)) || looseNoun(low(y.to))));
      if (!obj || KIN.has(low(obj.to))) return;
    }
    x.verbRu.type = "need";
    x.need = modal ? "modal" : "obj";
    if (modal) x.to = "надо";
    else {
      const t = low(obj.to);
      // «Сона ши кийла еза» — мне нужно два килограмма (PaydaDosh): после числа — «нужно»
      const before = out.slice(0, out.indexOf(obj)).reverse().find((y) => y.to);
      const counted = !!before && (RU_NUM[low(before.to)] || 0) >= 2;
      const g = t === "что" || counted ? "n" : /(аш|ий)$/.test(low(obj.from || "")) ? "pl" : D.gender(t);
      x.to = NEED_OF[g] || "нужно";
    }
    who.to = RU_BY_CASE[who.pc.p].dat;
    // по-русски: [вопрос] кому — нужен — что: «Мне нужен врач», «Что вам нужно?», «Куда мне надо идти?»
    move(who, qFirst());
    move(x, out.indexOf(who) + 1);
  }
  // «хоза хет» — нравится (PaydaDosh: «Сона хоза хет из» — мне это нравится, «Сона хоза хетац из» — мне это не
  // нравится, «Сона хьо хозахет» — ты мне нравишься, «Сон из кинишка хоза хет» — мне нравится эта книга,
  // «ЧӀоагӀа хоза хет» — очень приятно, «хоза хетий хьона…?» — вам нравится…?). Кому — дательный, что
  // нравится — именительный: по-русски оно подлежащее, глагол — в его лице.
  const LIKE_RU = ["нравлюсь", "нравишься", "нравится", "нравимся", "нравитесь", "нравятся"];
  function likeInh(out) {
    let k = out.findIndex((y) => /^хоза ?хет(т|ац|ий|а)?$/.test(low(y.from || "")));
    let h = k >= 0 ? out[k] : null;
    if (!h) {
      // «хоза» — и в куске таблицы слов: «чӀоагӀа хоза | хет» (очень приятно)
      k = out.findIndex((y, j) => /(^| )хоза$/.test(low(y.from || "")) && out[j + 1] && /^хет(т|ац|ий|а)?$/.test(low(out[j + 1].from || "")));
      if (k < 0) return;
      const pre = low(out[k].from).split(" ").slice(0, -1);
      if (pre.length && !pre.every((t) => INTENS.has(t) || t === "геттара")) return;
      out[k].to = pre.length ? "очень" : ""; out[k].how = pre.length ? "word" : "skip";
      h = out[k + 1];
    }
    const form = /хет(т|ац|ий|а)?$/.exec(low(h.from))[1] || "";
    const neg = form === "ац";
    for (const y of out) if (INTENS.has(low(y.from || "")) || low(y.from || "") === "геттара") y.to = "очень";
    const dat = out.find((y) => y.pc && y.pc.case === "dat");
    const nomP = out.find((y) => y.pc && y.pc.case === "nom");
    for (const kk of Object.keys(h)) if (!["from", "at"].includes(kk)) delete h[kk];
    h.how = "like"; h.likeVerb = true;
    if (!dat) { h.to = (neg ? "не " : "") + "приятно"; return; }
    dat.to = RU_BY_CASE[dat.pc.p].dat; dat.pc = { ...dat.pc, case: "dat" };
    let person = 2;
    if (nomP) {
      if (low(nomP.from) === "из") nomP.to = "это";
      else person = PERSON[nomP.pc.p];
      nomP.pc = { ...nomP.pc, case: "likeSubj" };
    } else if (form === "а" || out.some((y) => y !== h && y.to && !y.pc && /(аш|ий)$/.test(low(y.from || "")) && isRuNoun(low(y.to)))) person = 5;
    h.to = (neg ? "не " : "") + LIKE_RU[person];
    // по-русски: [вопрос] кому — [кто] — нравится: «Мне это нравится», «Ты мне нравишься»
    const move = (y, at) => { const a = out.indexOf(y); out.splice(a, 1); out.splice(at > a ? at - 1 : at, 0, y); };
    const firstLive = () => { const L2 = out.filter((y) => y.to); const q = L2[0] && RU_Q.has(low(L2[0].to)) ? 1 : 0; return L2[q] ? out.indexOf(L2[q]) : out.length; };
    if (nomP && nomP.to !== "это") { move(nomP, firstLive()); move(dat, out.indexOf(nomP) + 1); }
    else { move(dat, firstLive()); if (nomP) move(nomP, out.indexOf(dat) + 1); }
    move(h, out.indexOf(nomP && nomP.to === "это" ? nomP : dat) + 1);
  }
  // Прилагательное-сказуемое со связкой — в роде и числе подлежащего (справочник, раздел 4: «Из дика саг ва»;
  // PaydaDosh: «Хий дӀайха да» — вода горячая, «Тахан шийла я» — сегодня холодно): «Вода горячий» → «Вода горячая»
  // русское прилагательное в начальной форме по любой форме им. п. или наречию: «большая» → «большой»,
  // «красиво» → «красивый». Кандидат должен быть словом словаря (lookupWord без разбора).
  const ADJ_L = new Map();
  function ruAdjLemma(t) {
    if (ADJ_L.has(t)) return ADJ_L.get(t);
    let res = null;
    const m = /^(.{3,}?)(ый|ий|ой|ая|яя|ое|ее|ые|ие|о)$/.exec(t);
    if (m && !RU_NOT_NOUN.has(t)) {
      for (const e of ["ый", "ий", "ой"]) {
        const c = m[1] + e;
        if (m[2] !== "о" && ![R.adj(c, "m"), R.adj(c, "f"), R.adj(c, "n"), R.adj(c, "pl")].includes(t)) continue;
        const r = RET.lookupWord(c, "ru", 3);
        if (r && !r.lemma) { res = c; break; }
      }
    }
    ADJ_L.set(t, res);
    return res;
  }
  // Определение перед существительным, которое словарь дал наречием: «дика саг» — «хорошо человек» → «хороший
  // человек» (справочник, раздел 8: «дика саг (good man), хоза йоӀ (beautiful girl)»). Род и падеж поставят
  // ruCasesInh и agreeInh. Количество и время («дукха», «кӀезига») — не определения.
  const NOT_ATTR = new Set(["много", "мало", "немного", "немало", "нужно", "можно", "надо", "давно", "долго", "поздно", "рано", "скоро", "опять", "только", "очень", "слишком", "достаточно", "сколько", "столько", "вместе", "тоже", "также", "зато", "потом", "легко", "трудно", "тяжело", "просто", "почти", "сразу", "часто", "редко", "всегда", "иногда", "снова", "больше", "меньше", "лучше", "хуже"]);
  function advAttrInh(out, clauseEnd) {
    for (let k = 0; k + 1 < out.length; k++) {
      const a = out[k], n = out[k + 1];
      if (!a.to || !n.to || a.pc || a.verbRu || n.pc || n.verbRu || a.at < 0 || n.at !== a.at + 1 || clauseEnd.has(a.at)) continue;
      const t = low(a.to);
      if (/\s/.test(t) || !/о$/.test(t) || NOT_ATTR.has(t) || !/^(word|lemma|align|deep)$/.test(a.how)) continue;
      if (!isRuNoun(low(n.to)) && !n.inhPl) continue;
      const lem = ruAdjLemma(t);
      if (lem) { a.was = a.to; a.to = /^[А-ЯЁ]/.test(a.to) ? lem[0].toUpperCase() + lem.slice(1) : lem; }
    }
  }
  // «вай» — и «мы», и «наш» (справочник, раздел 3: вай — им., эрг. и род. п.). Перед существительным в
  // предложении без глагола — «наш»: «Ер вай цӀа да» — это наш дом, «Могаш хилар да вай хьал» — наше
  // благополучие (PaydaDosh); с глаголом — «мы»: «Вай керда цӀенош деттад» — мы построили новый дом.
  function vaiInh(out) {
    if (out.some((y) => y.verbRu || y.likeVerb)) return;
    for (let k = 0; k + 1 < out.length; k++) {
      const a = out[k], n = out[k + 1];
      if (low(a.from || "") !== "вай" || !a.pc || n.at !== a.at + 1 || n.pc || !n.to) continue;
      if (!isRuNoun(low(n.to)) && !n.inhPl) continue;
      a.to = "наш"; a.ruPron = null; a.pc = { p: "мы", case: "gen" };
    }
  }
  // «виц / йиц … лело» — забыть (PaydaDosh: «Виц ма лелахь» и «Йиц ма лелахь» — не забудь): «виц» — часть
  // глагола, по-русски одно слово
  function forgetInh(out) {
    for (let k = 0; k < out.length; k++) {
      if (!/^[вйдб]иц$/.test(low(out[k].from || ""))) continue;
      const rest = out.slice(k + 1, k + 3);
      const v = rest.find((y) => /^лел/.test(low(y.from || "")));
      if (!v) continue;
      const ma = rest.find((y) => low(y.from || "") === "ма" && out.indexOf(y) < out.indexOf(v));
      out[k].to = ""; out[k].how = "skip";
      if (ma) { ma.to = ""; ma.how = "skip"; }
      // повелительное «лелахь, лелал» (справочник, раздел 7: -алахь, -ал) — «забудь»; иначе — «забыть»
      const imp = /(ахь|ал)$/.test(low(v.from)) || (v.verbRu && v.verbRu.tense === "imp");
      const a = { inf: "забыть", tense: imp ? "imp" : (v.verbRu && v.verbRu.tense) || "inf", neg: !!ma || !!(v.verbRu && v.verbRu.neg), cls: v.verbRu && v.verbRu.cls };
      for (const kk of Object.keys(v)) if (!["from", "at"].includes(kk)) delete v[kk];
      Object.assign(v, a.tense === "inf" ? { to: (a.neg ? "не " : "") + "забыть", how: "forget" } : { ...ivPiece({ ...a, how: "forget" }) });
    }
  }
  const ADV_T = new Set(["сегодня", "завтра", "вчера", "сейчас", "теперь", "здесь", "там", "дома", "утром", "вечером", "ночью", "днем", "зимой", "летом", "весной", "осенью", "тут", "везде"]);
  function predAdjInh(out) {
    const cop = out.find((y) => y.how === "copula" && y.cop && !y.oal);
    if (!cop) return;
    const live = out.filter((y) => y.to);
    for (let k = 0; k < live.length; k++) {
      const a = live[k], t = low(a.to);
      if (a.ruCase || a.pc || a.verbRu || /\s/.test(t) || t.length <= 3 || /(щий|вший)$/.test(t) || isRuNoun(t)) continue;
      const adv = /о$/.test(t);
      const lem = ruAdjLemma(t);
      if (!lem) continue;
      if (live[k + 1] && live[k + 1] !== cop && !live[k + 1].pc && isRuNoun(low(live[k + 1].to))) continue; // определение: «дика саг»
      let g = null;
      const subjP = live.slice(0, k).concat(live.slice(k + 1)).find((y) => y.pc && y.pc.case === "nom");
      if (subjP) g = R.pronGender(subjP.ruPron === "она" ? "она" : subjP.pc.p, cop.cop.cls);
      else {
        const n = live.slice(0, k).reverse().find((y) => !y.pc && !y.verbRu && (!y.ruCase || y.ruCase === "nom") && !ADV_T.has(low(y.to)) && (y.inhPl || isRuNoun(low(y.to)) || looseNoun(low(y.to))));
        if (adv) continue; // «Тахан шийла я» — сегодня холодно: наречие без подлежащего
        if (!n) {
          // без подлежащего — безлично: «холодный» → «холодно», если такое слово есть в словаре
          if (live.length > 1 && /(ый|ий|ой)$/.test(t)) { const o = t.slice(0, -2) + "о", r = RET.lookupWord(o, "ru", 3); if (r && !r.lemma) { a.was = a.to; a.to = /^[А-ЯЁ]/.test(a.to) ? o[0].toUpperCase() + o.slice(1) : o; } }
          continue;
        }
        g = n.inhPl || D.isPlural(low(n.to)) ? "pl" : D.gender(low(n.to));
      }
      if (!g) continue;
      const f = D.adj(lem, g, "nom");
      if (f && f !== t) { a.was = a.to; a.to = /^[А-ЯЁ]/.test(a.to) ? f[0].toUpperCase() + f.slice(1) : f; }
    }
  }
  // Число и существительное по-русски. По-ингушски после числа существительное стоит в единственном числе
  // (справочник, раздел 8: «ши саг» — два человека, «кхо шу» — три года, «ши ди» — два дня), а по-русски
  // форма зависит от числа: 2–4 — родительный ед. ч. («три часа»), 5–20 — родительный мн. ч. («пять кроватей»;
  // PaydaDosh: «ХӀанз кхо сахьат даьннад» — сейчас три часа, «Пхи маьнги» — пять кроватей). «Два» и «один» —
  // в роде существительного («две кровати»). Это правило русского языка; ингушских слов здесь нет.
  const RU_NUM = { "один": 1, "два": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10,
    "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14, "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17,
    "восемнадцать": 18, "девятнадцать": 19, "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50, "сто": 100, "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80, "девяносто": 90, "двести": 200, "триста": 300 };
  const COUNT_GEN_PL = { "человек": "человек" }; // «пять человек», а не «пять людей»
  // «у меня есть / нет»: направительный падеж местоимения со связкой, без глагола (справочник, раздел 3: «Дий
  // хьога из книжка?» — у тебя есть эта книга?; PaydaDosh: «Кхыча тайпара яц шуга?» — у вас нет других видов?).
  // С «са, хьа» рядом («Цхьа хаттар дар са хьога» — у меня к вам вопрос) — это «к тебе», не трогаем.
  function haveInh(out) {
    if (out.some((y) => y.verbRu || y.likeVerb || y.need)) return;
    const a = out.find((y) => y.pc && y.pc.case === "all" && y.to);
    const cop = out.find((y) => y.how === "copula" && y.cop && y.cop.cls && !y.oal);
    if (!a || !cop || out.some((y) => y.pc && (y.pc.case === "gen" || (y.pc.case === "nom" && low(y.from || "") !== "из"))) || !R.PRON_GEN_U[a.pc.p]) return;
    // «моаршал да шуга» — здравствуйте, «Фу хьал да шуга?» — как вы поживаете?, «Хьай лоӀам ба хьога» — как хотите
    // (PaydaDosh): приветствие и обороты со «своим», а не «у вас есть привет»
    if (out.some((y) => /^(моаршал|салам|хьал$|сай$|хьай$|шоай$|ший$|тхай$)/.test(low(y.from || "")))) return;
    a.to = R.PRON_GEN_U[a.pc.p]; a.pc = { ...a.pc, case: "have" }; a.have = true;
    const t = cop.cop.tense;
    if (t === "neg") cop.to = "нет";
    else if (t === "q" || t === "pres") cop.to = "есть";
    else if (t === "past") cop.to = R.COP_PAST[GENDER_OF_CLS[cop.cop.cls] || "m"];
    else if (t === "pastNeg") cop.to = "не было";
    // по-русски: [вопрос] у кого — есть / нет — что: «У вас нет других видов?»
    const move = (y, at) => { const i = out.indexOf(y); out.splice(i, 1); out.splice(at > i ? at - 1 : at, 0, y); };
    const live = out.filter((y) => y.to);
    const q = live[0] && RU_Q.has(low(live[0].to)) ? live[0] : null;
    move(a, q ? out.indexOf(q) + 1 : out.indexOf(live[0]));
    move(cop, out.indexOf(a) + 1);
  }
  function numInh(out) {
    const live = out.filter((y) => y.to);
    for (let k = 0; k + 1 < live.length; k++) {
      const a = live[k], n = live[k + 1];
      const num = RU_NUM[low(a.to)];
      // составные числа («ткъаь цхьайтта» — тридцать один) и «цхьа» (один, некий) не трогаем
      if (!num || num === 1 || a.verbRu || a.pc || n.verbRu || n.pc || n.inhPl || n.at !== a.at + 1 || RU_NUM[low(n.to)] || (live[k - 1] && RU_NUM[low(live[k - 1].to)])) continue;
      const t = low(n.to);
      if (n.ruCase && n.ruCase !== "nom" && !(n.ruCase === "acc" && !D.animate(t))) continue;
      let lemma = n.ruCase ? low(n.was || n.to) : t;
      // словарь дал родительный мн. ч. («эзар» — «тысяч»): начальная форма — «тысяча» («ши эзар» — две тысячи, PaydaDosh)
      { const l = [lemma + "а", lemma + "я", lemma + "о"].find((c) => D.nounPl(c, "gen") === lemma && isRuNoun(c)); if (l) lemma = l; }
      // существительное в начальной форме (не «рублей»: эту форму словарь уже дал после числа)
      if (!(isRuNoun(lemma) || (looseNoun(lemma) && (n.noun || !/(ет|ит|ут|ют|ят|ат|ешь|ишь|ла|ли|ло|е|и|у|ю)$/.test(lemma)))) || /(ов|ев|ей)$/.test(lemma) || D.noun(lemma, "gen") === lemma || n.perfect || n.contracted || n.cop) continue;
      // и не падежная форма другого слова: «тысяч» (тысяча), «брата» (брат) — «ворхӀ веший» — семи братьев
      if (!isRuNoun(lemma) && (RET.lemmas(lemma, "ru") || []).some((l) => l !== lemma && (["gen", "dat", "acc", "ins", "prep"].some((c) => D.noun(l, c) === lemma) || D.nounPl(l, "gen") === lemma || D.nounPl(l, "nom") === lemma))) continue;
      const g = D.gender(lemma);
      if (!g || g === "pl" || D.isPlural(lemma)) continue;
      const big = num % 100 >= 5 && num % 100 <= 20 || num % 10 >= 5 || num % 10 === 0;
      const f = num % 10 === 1 && num !== 11 ? lemma : big ? (COUNT_GEN_PL[lemma] || D.nounPl(lemma, "gen")) : D.noun(lemma, "gen");
      if (!f) continue;
      const cap = (s, like) => (/^[А-ЯЁ]/.test(like) ? s[0].toUpperCase() + s.slice(1) : s);
      if (f !== t) { n.was = n.was || n.to; n.to = cap(f, n.to); n.numAgree = num; }
      if (g === "f" && num === 2) a.to = cap("две", a.to);
    }
  }
  function ruCasesInh(out, clauseEnd = new Set(), orig = null) {
    if (tune.noRuCases) return;
    const verb = out.find((x) => x.verbRu && x.to);
    const vinf = verb && verb.verbRu.inf;
    // глагол движения — и причастие «водаш, йодаш» без связки («Ишколе водаш…» — идя в школу)
    const motion = (!!vinf && MOTION.has(vinf)) || out.some((x) => /^(ца)?[вйдб]од(а|аш)$/.test(low(x.from || "")));
    const vType = verb && verb.verbRu.type;
    const datPron = out.some((x) => x.pc && x.pc.case === "dat");
    const nounAt = (k) => { const y = out[k]; return !!y && !y.verbRu && !y.pc && y.to && isRuNoun(low(y.to)); };
    // определение — слово прямо перед существительным в той же части предложения: «са», «дика»
    const isMod = (y, x) => !!y && !y.verbRu && !y.ruCase && y.to && !/\s/.test(y.to) && y.at >= 0 && y.at === x.at - 1 && !clauseEnd.has(y.at)
      && (y.pc || D.POSS_NOM[low(y.to)] ? !!D.POSS_NOM[low(y.to)] && (!y.pc || y.pc.case === "gen") : /(ый|ий|ой)$/.test(low(y.to)) && low(y.to).length > 3 && !/(щий|вший)$/.test(low(y.to)));
    const found = []; // [кусок, падеж, русская начальная форма места]
    for (let k = 0; k < out.length; k++) {
      const x = out[k];
      if (!x.to || x.verbRu || x.pc || x.at === undefined || x.at < 0) continue;
      const w = low(x.from);
      // «ишколе» в словаре — «в школе»: место берём по библиотеке слов, предлог и падеж — по глаголу
      if (/\s/.test(x.to) && !(PLACE_INH.has(w) && x.how === "word")) continue;
      // «цӀа» с глаголом движения — «домой» («ЦӀа вода» — иду домой)
      if (w === "цӏа" && motion && low(x.to) === "дом") { found.push([x, "home"]); continue; }
      const place = PLACE_INH.get(w);
      if (place && /^(name|word|lemma|align|deep|corpus)$/.test(x.how)) { found.push([x, motion ? "dest" : "loc", place]); continue; }
      // форма на «-ра» («откуда», справочник, раздел 6: юртара, Москвера), которую тексты переводят родительным
      // («москвы»): предлог «из» («от» — о человеке). «Со Москвера ва» — я из Москвы (PaydaDosh)
      // Перед существительным это скорее определение («цӀагӀара хьайба» — домашнее животное, «Москвера ха» —
      // московское время): только со связкой или глаголом движения и не перед существительным
      const fromCtx = !nounAt(k + 1) && (motion || out.some((y) => y.how === "copula" && y.cop && !y.oal));
      if (x.how === "corpus" && fromCtx && /[ае]ра$/.test(w) && w.length > 4 && !/\s/.test(x.to)) {
        const t = low(x.to), l = (RET.lemmas(t, "ru") || []).find((c) => c !== t && D.gender(c) && D.noun(c, "gen") === t);
        if (l) {
          const name = x.at >= 0 && /^[А-ЯЁӀ]/.test((orig || [])[x.at] || "") && x.at > 0;
          x.was = x.to; x.to = (D.animate(l) ? "от " : D.prep("из", t) + " ") + (name ? t[0].toUpperCase() + t.slice(1) : t); x.ruCase = "gen";
        }
        continue;
      }
      if (!/^(word|lemma|deep|align)$/.test(x.how)) continue;
      const ab = x.how === "align" ? alignBase(w, x.to) : null;
      if (x.how === "align" && !ab) continue;
      if (ab) x.ruLemma = ab.lemma;
      if (!isRuNoun(x.ruLemma || low(x.to))) continue;
      const b = x.how === "word" ? w : ab ? ab.b : low(x.lemma || "");
      if (!b) continue;
      let kase = inhCaseOf(w, b, nounAt(k + 1) && !clauseEnd.has(x.at));
      // уже множественное по-русски («бераш» — дети, «лоамаш» — горы): падеж — от формы мн. ч.
      // и мн. ч. из словаря проекта («цӀа (д/д; мн. цӀенош)»): «Доккхий цӀенош» — большие дома (PaydaDosh)
      if (D.isPlural(x.ruLemma || low(x.to)) || PL_CLS.has(w)) x.inhPl = true;
      if (kase && /^pl:/.test(kase)) { kase = kase.slice(3); x.inhPl = true; }
      // мн. ч. на -а — не родительный, а эргатив или дательный: «Наха саг магӀа а воаккх» — люди человека
      // посадят (PaydaDosh); родительный у них — с «аь»: «наьха къахьегам» — чужой труд, «Наьха наха» — чужим людям
      if (x.inhPl && w === b + "а") kase = vType === "dat" ? "dat" : "erg";
      if (kase) found.push([x, kase]);
      // словарная форма — или она же с конечной гласной («кинишка» при словарном «кинишк»): именительный
      else if (b === w || (w.startsWith(b) && w.length === b.length + 1 && /[аи]$/.test(w) && !/[аеиоуэюя]$/.test(b) && !nounAt(k + 1))) found.push([x, "nom"]);
    }
    // переходное действие: подлежащее в эргативе (местоимение «цо, аз…» или существительное «нанас»), глагол с
    // дательным подлежащим или перфект от страдательного причастия («ийцай» — взял) без подлежащего в именительном
    const erg = out.some((x) => x.pc && x.pc.case === "erg") || found.some(([, c]) => c === "erg");
    // глагол с дательным подлежащим — только если оно в предложении есть («Сона…», «Нанна…»); «хета» (казаться):
    // именительное — подлежащее («цӀен пен оагӀора хет» — стена кажется кривой)
    const datVerb = !!verb && vType === "dat" && vinf !== "думать" && vinf !== "казаться" && (datPron || found.some(([, c]) => c === "dat"));
    // глагол не узнан (таблица слов дала «прочитал» без формы глагола): довольно местоимения в эргативе
    // причастие на -ш со связкой: кто делает — в именительном и при переходном глаголе («МалагӀа книжка дешаш я
    // хьо?» — какую книгу ты читаешь?, «Цу хана из кинишка дешаш вар хьо?» — ты тогда читал эту книгу? — PaydaDosh);
    // переходный — по библиотеке слов (тип erg: «Аз книжка деш»)
    const progTrans = !!verb && !!verb.verbRu.prog && L.VERBS.some((v) => v.id === vinf && v.type === "erg") && out.some((x) => x.pc && x.pc.case === "nom");
    const trans = !verb ? out.some((x) => x.pc && x.pc.case === "erg") && !motion && !out.some((x) => x.how === "copula")
      : vType !== "need" && vType !== "intr" && !motion && (erg || datVerb || progTrans || (verb.verbRu.trans && !out.some((x) => x.pc && x.pc.case === "nom")));
    const clauseOf = (at) => [...clauseEnd].filter((e) => e < at).length;
    const anchors = [...out.filter((y) => (y.pc && y.pc.case === "erg") || y.verbRu), ...found.filter(([, c]) => c === "erg").map(([y]) => y)].filter((y) => y.at >= 0);
    const sameClause = (x) => !anchors.length || anchors.some((y) => clauseOf(y.at) === clauseOf(x.at));
    for (const [x, kase, place] of found) {
      const k = out.indexOf(x);
      const next = out.slice(k + 1).find((y) => y.from);
      let ruCase, p = "", lemma = x.ruLemma || low(x.to);
      if (kase === "home") { x.was = x.to; x.to = "домой"; x.ruCase = "adv"; continue; }
      // послелог после слова («ког кӀал» — под ногой): падеж решает послелог — не трогаем
      if (next && POSTP.has(low(next.from)) && kase !== "gen") continue;
      // дополнение — в той же части предложения, что и подлежащее в эргативе или глагол
      if (kase === "nom") {
        // подлежащее во мн. ч. («Бераш хьадаьхкад» — дети пришли): им. мн., и глагол — во мн. ч.
        if (!trans || !sameClause(x)) {
          if (!x.inhPl) continue;
          ruCase = "nom";
          if (verb && !out.some((y) => y.pc && (y.pc.case === "erg" || y.pc.case === "nom"))) { verb.verbRu.subjG = "pl"; verb.verbRu.subjPl = true; }
        } else ruCase = "acc";
      }
      else if (kase === "dest" || kase === "loc") { lemma = place; ruCase = kase === "dest" ? "acc" : "prep"; p = PLACE_ON.has(place) ? "на" : "в"; }
      else if (kase === "dat" && datVerb && !datPron) { x.ruCase = "nom"; continue; } // «Нанна воӀ веза» — мать любит сына
      else if (kase === "abl") {
        const lc = next && ABOUT_POSTP.has(low(next.from));
        if (!lc && !(vinf && ABOUT.has(vinf))) continue;
        if (lc) { next.to = ""; next.how = "skip"; }
        [ruCase, p] = RU_OF.abl;
      } else if (kase === "all") {
        if (D.animate(lemma)) [ruCase, p] = RU_OF.all;
        else if (motion) { ruCase = "acc"; p = PLACE_ON.has(lemma) ? "на" : "в"; }
        else continue;
      } else [ruCase, p] = RU_OF[kase];
      if (kase === "from" && D.animate(lemma)) p = "от";
      if (kase === "ins" && VEHICLE.has(lemma)) { ruCase = "prep"; p = "на"; }
      else if (kase === "ins" && BODY.has(lemma)) p = "";
      const cap = x.how === "name" || /^[А-ЯЁ]/.test(x.to);
      let f = x.inhPl ? D.nounPl(lemma, ruCase) : ruCase === "nom" ? lemma : D.noun(lemma, ruCase, { loc2: p === "в" || p === "на" });
      if (!f) continue;
      if (cap) f = f[0].toUpperCase() + f.slice(1);
      // определения перед существительным: «са» (мой), «дика» (хороший) — в том же роде и падеже
      const g = x.inhPl ? "pl" : D.gender(lemma), anim = D.animate(lemma);
      const mods = [];
      for (let j = k - 1, cur = x; j >= 0 && isMod(out[j], cur); j--) { mods.unshift(out[j]); cur = out[j]; }
      for (const m of mods) {
        const mf = D.POSS_NOM[low(m.to)] ? D.poss(m.to, g, ruCase, anim) : D.adj(m.to, g, ruCase, anim);
        if (mf) { m.was = m.to; m.to = mf; m.ruCase = ruCase; }
      }
      x.was = x.to; x.to = f; x.ruCase = ruCase;
      // подлежащее-существительное в эргативе: род прошедшего времени по нему («Нанас машен ийцай» — мама купила)
      if (kase === "erg" && verb && g && !out.some((y) => y.pc && (y.pc.case === "erg" || y.pc.case === "nom"))) { verb.verbRu.subjG = g; if (g === "pl") verb.verbRu.subjPl = true; }
      if (p) { const first = mods.find((m) => m.ruCase) || x; first.to = D.prep(p, first.to) + " " + first.to; }
      // родительный — после того, к чему относится: «наьна мотт» → «язык матери»
      if (kase === "gen") {
        const chain = [...mods.filter((m) => m.ruCase), x];
        const at = out.indexOf(chain[0]);
        out.splice(at, chain.length);
        out.splice(at + 1, 0, ...chain);
      }
    }
  }

  // Падежи существительных (lib/rules/cases.js): «к маме» → «нанега», «с братом», «из села» → «юртара».
  // Форма берётся, только если она есть в настоящих ингушских текстах или в парах фраз; иначе — словарная.
  let CASES_ = null;
  // словарная форма существительного: в записи словаря есть класс («нана (й)», «юрт (й/й)») или класс известен
  const NOUN_BASE = new Map();
  const nounBase = (lemma) => {
    if (NOUN_BASE.has(lemma)) return NOUN_BASE.get(lemma);
    const d = dictWord(lemma, "ru");
    const ok = d && !d.lemma && (d.noun || /\(\s*[вйдб]\s*[\/,);-]|\(мн\. /.test(d.line) || L.PERSON_CLASS[lemma] || L.ATTESTED_CLASS[lemma]);
    const b = ok ? low(d.to) : null;
    NOUN_BASE.set(lemma, b);
    return b;
  };
  const cases = () => CASES_ || (CASES_ = makeCases({
    words: require("./verbs.js").wordSet(), pairs: EXAMPLES || [], baseOf: nounBase, lemmas: (w) => RET.lemmas(w, "ru"),
    corpus: SEED.filter((p) => p && p.kind === "word" && /GhalghayTools/.test(p.source || "")).map((p) => [p.ru, p.inh, p.count || 1]),
  }));
  // Слово words[at] стоит сразу после глагола или местоимения (через «моего, этого, старого»), а не после
  // предлога («у отца») или существительного («могилу отца» — родительный)
  function accAfterVerb(out, words, at) {
    let j = at - 1;
    while (j >= 0 && (L.POSSESSIVES[words[j]] || L.DEMONSTRATIVES[words[j]] || /(ого|его|ую|юю)$/.test(words[j]))) j--;
    if (j < 0) return false;
    const p = out.find((y) => y.at === j);
    return !!p && (!!p.verb || (!!p.pron && !RU_PREPS.has(words[j - 1] || "") && words[j - 1] !== "у"));
  }
  function nounCases(out, words) {
    if (tune.noCases) return;
    for (let k = 0; k < out.length; k++) {
      const x = out[k];
      if (x.at === undefined || x.at < 0 || x.verb || x.pron || x.how === "name" || x.how === "unknown" || x.how === "lexicon") continue;
      const w = words[x.at];
      if (L.RU_PRONOUN_FORMS[w]) continue; // «тобой», «вами» — местоимения, не существительные
      // родительный — только после существительного («книга отца»), не после числа или «этого»
      const prevNoun = (j) => { const p = out.find((y) => y.at === j); return !!p && !p.verb && !p.pron && /^(word|lemma|align|case)$/.test(p.how) && !L.NUMBERS[words[j]] && [words[j], ...RET.lemmas(words[j], "ru")].some((l) => nounBase(l)); };
      // «села» — и «сесть», и «село»: берётся первая начальная форма-существительное, для которой есть форма падежа
      let f = null, kase = null;
      for (const lemma of RET.lemmas(w, "ru")) {
        const base = nounBase(lemma);
        if (lemma === w || !base) continue;
        // прямое дополнение-человек («Сын любит отца», «Позови брата»): русский винительный совпадает с
        // родительным, и таблица слов даёт родительный («даь»). В ингушском дополнение — в именительном
        // (справочник, раздел 4: «the object of a transitive verb» в им. падеже; «Сона хьо веза»): словарная форма
        if (x.how === "align" && low(x.to) !== base && L.PERSON_CLASS[lemma] && /[бвгджзклмнпрстфхцчшщй]$/.test(lemma) && /[ая]$/.test(w)
          && out.some((y) => y.verb) && accAfterVerb(out, words, x.at)) { f = base; kase = "acc"; break; }
        // таблица слов уже дала форму в контексте («сердцу» — «дога»), а не словарную — ей доверяем больше
        // Если это родительный после существительного («книга отца» — «даь»), форму оставляем, но ставим её
        // перед существительным (справочник, раздел 8: «наьна мотт»)
        if (x.how === "align" && low(x.to) !== base) { if (low(x.to).startsWith(base.slice(0, 2)) && cases().context(words, x.at, lemma, prevNoun) === "gen") { f = low(x.to); kase = "gen"; } break; }
        // само слово есть в словаре («горе» — бала): начальная форма «гора» тут ни при чём; кроме людей («маме»)
        if (x.how === "word" && !L.PERSON_CLASS[lemma]) break;
        kase = cases().context(words, x.at, lemma, prevNoun);
        // «в школу», «на работу», «в Москве» — формы из библиотеки слов (справочник: ишколе, балха, базар тӀа)
        f = kase === "dest" || kase === "on" ? L.DESTINATIONS[lemma] : kase === "loc" ? L.LOCATIONS[lemma] : null;
        if (!f && kase === "on") f = base + " тӀа";
        // множественное число — из словаря: «юрт (й/й; мн. юрташ)»
        if (kase === "pl") { const m = /мн\.\s*([а-яӀӏ1-]+)/i.exec((dictWord(lemma, "ru") || {}).line || ""); f = m ? m[1].replace(/1/g, "Ӏ") : null; if (!f) break; }
        if (!f) f = kase && cases().form(base, kase, w);
        if (f) break;
      }
      // родительный после существительного, формы которого не знаем («Дом брата»): это не подлежащее и
      // сказуемое — связку не ставим («ЦӀа воша да» — «дом — брат»)
      if (!f && kase === "gen") x.genCtx = true;
      if (!f) continue;
      if (kase === "acc") { x.was = x.to; x.wasHow = x.how; x.to = f; x.how = "lemma"; x.lemma = RET.lemmas(w, "ru").find((l) => nounBase(l) === f) || x.lemma; x.cls = x.cls || L.PERSON_CLASS[x.lemma]; continue; }
      x.was = x.to; x.wasHow = x.how; x.to = f; x.how = "case"; x.kase = kase; x.cls = undefined;
      // родительный — перед существительным (справочник, раздел 8: «наьна мотт»)
      if (kase === "gen") { const h = out.findIndex((y) => y.at === x.at - 1); if (h >= 0 && h === k - 1) { out.splice(k, 1); out.splice(h, 0, x); } }
    }
  }

  // Дательный падеж существительного-подлежащего («Мать любит» — «Нанна»). Только с доказательством:
  //   — пары слов корпуса GhalghayTools с русской формой дательного падежа и ингушской на -на («отцу — даьна»);
  //   — правило справочника «нана → нанна» (раздел 6: -а → -на), если форма есть в текстах.
  // Другие окончания (-а, -га), которые модуль падежей иногда выводит из пар, — не дательный: не берём.
  let GT_ = null;
  function datOf(lemma, base) {
    if (!GT_) { GT_ = new Map(); for (const p of SEED) if (p && p.kind === "word" && /GhalghayTools/.test(p.source || "")) { const k = low(p.ru); if (!GT_.has(k) || GT_.get(k)[1] < (p.count || 1)) GT_.set(k, [low(p.inh), p.count || 1]); } }
    const l = low(lemma);
    const ru = /[ая]$/.test(l) ? [l.slice(0, -1) + "е"] : /ец$/.test(l) ? [l.slice(0, -2) + "цу", l + "у"] : /[бвгджзклмнпрстфхцчшщ]$/.test(l) ? [l + "у"] : [];
    for (const r of ru) {
      const c = GT_.get(r);
      if (c && /на$/.test(c[0]) && c[0].slice(0, 1) === base.slice(0, 1) && RET.lemmas(r, "ru").includes(l) && V.attested(c[0])) return c[0];
    }
    const f = /а$/.test(base) && cases().form(base, "dat");
    return f && f === base.slice(0, -1) + "на" ? f : null;
  }

  // Прилагательное перед существительным в косвенном падеже — форма на -ча (PaydaDosh: «Дикача наькъа тӀа»,
  // «доккхача ор чу», «хозача йиӀийна» — красивой девушке, «воккхача сага», «зӀамигача сага», «кердача маькха»).
  // Форма берётся, только если она есть в текстах (lib/ingush-words.js) или в парах фраз; иначе — как было.
  const ADJ_OBL = /(ого|его|ому|ему|ой|ей|ом|ем|ую|юю|ым|им|ых|их|ыми|ими)$/;
  function adjBaseRu(w) {
    const m = ADJ_OBL.exec(w);
    if (!m) return null;
    const stem = w.slice(0, -m[1].length);
    for (const end of ["ой", "ый", "ий"]) {
      const l = stem + end;
      if (l === w && end === "ой") continue; // «большой» сам по себе — не косвенный падеж
      const d = dictWord(l, "ru");
      if (d && !d.lemma && !d.noun && !/\s/.test(d.to)) return { lemma: l, to: d.to, line: d.line };
    }
    return null;
  }
  function obliqueAdjs(out, words) {
    if (tune.noCases) return;
    for (let k = 0; k + 1 < out.length; k++) {
      const x = out[k], y = out[k + 1];
      if (x.verb || x.pron || x.kase || x.at === undefined || x.at < 0 || y.verb || y.pron || y.at === undefined || y.at < 0) continue;
      const w = words[x.at];
      if (!ADJ_OBL.test(w) || /(ый|ий)$/.test(w)) continue;
      const a = adjBaseRu(w);
      if (!a) continue;
      // существительное в косвенном падеже: окончание из модуля падежей, или перед прилагательным предлог
      const prep = out[k - 1] && out[k - 1].how === "skip" && RU_PREPS.has(out[k - 1].from);
      const yl = RET.lemmas(words[y.at], "ru").find((l) => nounBase(l));
      // и сама ингушская форма существительного не словарная: «С новым годом» — «керда шу» не трогаем
      const yw = words[y.at], yl2 = yl || RET.lemmas(yw, "ru").find((l) => l !== yw && dictWord(l, "ru"));
      const yBase = yl2 && (nounBase(yl2) || low((dictWord(yl2, "ru") || {}).to || ""));
      const oblique = (y.kase && y.kase !== "pl" && y.kase !== "acc") || (yBase && yw !== yl2 && y.how === "align" && low(y.to) !== yBase);
      // «большой» о мужском роде («большой дом») — им. падеж; «большой» о женском («к большой реке») — по предлогу
      if (!oblique || (/ой$/.test(w) && !prep && !y.kase)) continue;
      // родительный множественного без предлога («гласных звуков — мукъа оазий», «плохих людей — во нах», PaydaDosh) — без -ча
      if (/(ых|их)$/.test(w) && !prep) continue;
      let base = low(a.to);
      // только прилагательные на -а и «во» (дика — дикача, доккха — доккхача, хоза — хозача, во — воча);
      // «отцовский — даь», «белый — кӀай», «другой — кхы» так не меняются (или пример не найден)
      if (!/а$/.test(base) && base !== "во") continue;
      const g = adjClassGroup(base), cls = yl && (L.PERSON_CLASS[yl] || null);
      if (g && cls && g[cls]) base = low(g[cls]);
      // «старый — къаьна (о вещах) / воккха, йоккха (о людях)»: о человеке — форма его класса
      // («старый друг» — давний: «Къаьна доттагӀа», PaydaDosh)
      const ppl = cls && !/^(друг|товарищ|приятель|знакомый|подруга)$/.test(yl) && /о людях/.test(a.line || "") && String(a.line).split(" / ").find((p) => /о людях/.test(p));
      if (ppl) { const m = low(ppl).match(/[а-яӏ]+/g).find((t) => t[0] === cls && t.length > 2); if (m) base = m; }
      const f = base + "ча";
      if (!V.attested(f) && !V.seen(f)) continue;
      x.was = x.to; x.wasHow = x.how; x.to = f; x.how = "case"; x.kase = "obl"; x.lemma = a.lemma;
    }
  }

  const SPEECH = new Set(["сказать", "говорить", "рассказать", "рассказывать", "передать", "передавать"]);
  function speechAddressee(out, words) {
    if (tune.noCases || !out.some((x) => x.verb && SPEECH.has(low(x.lemma || "")))) return;
    for (let k = 0; k < out.length; k++) {
      const x = out[k];
      if (x.verb || (out[k - 1] && out[k - 1].how === "skip")) continue; // после предлога («о матери») — другое
      if (x.pron && x.case === "dat") { const f = (L.PRONOUNS[x.pron] || {}).all; if (f) { x.to = f; x.case = "all"; } continue; }
      if (x.pron || x.at === undefined || x.at < 0 || (x.kase && x.kase !== "dat")) continue;
      const w = words[x.at];
      for (const l of RET.lemmas(w, "ru")) {
        const base = l !== w && nounBase(l);
        // слово уже переведено как другое слово («матери» — «матёрый»): не трогаем
        if (!base || (x.kase !== "dat" && low(x.to) !== base)) continue;
        // дательный: «матери, дочери» (-ь → -и), «маме, сестре» (-а → -е), «брату, отцу» (→ -у/-ю)
        const dat = x.kase === "dat" || (/ь$/.test(l) && /и$/.test(w) && L.PERSON_CLASS[l]) || (/[ая]$/.test(l) && /е$/.test(w)) || (/[бвгджзклмнпрстфхцчшщ]$/.test(l) && /[ую]$/.test(w));
        // форма на -га/-ка (направительный): у «отцу» пары разговорника дают «даьга» уже как «дательный»
        // («Скажи отцу»), а «к отцу» иногда «даьна» — берём только форму на -га/-ка
        const f = dat && [x.kase === "dat" ? low(x.to) : null, cases().form(base, "all", w), cases().form(base, "dat", w)].find((t) => t && /[гк]а$/.test(t) && t !== base);
        if (f) { x.was = x.was || x.to; x.to = f; x.how = "case"; x.kase = "all"; x.cls = undefined; break; }
      }
    }
  }

  // «ждать» кого — направительный падеж на -га (PaydaDosh: «ждать брата — вешийга хьежа», «Я не буду тебя
  // ждать — Со хьога хьежаргвац», «Я буду вас ждать — Со хьежаргва шуга»). Форма существительного — только
  // если её знает модуль падежей (есть в текстах); иначе — как было.
  // «Это просто», «Это только …» — частицы и наречия времени, а не сказуемое-качество (см. «Это X» в sentence)
  const ETO_NOT_PRED = new Set(["просто", "только", "давно", "недавно", "рано", "поздно", "скоро", "часто", "редко", "много", "мало", "немного", "тоже", "очень", "само", "одно"]);
  // Направительный падеж (-га/-ка) существительного: модуль падежей, а если он не знает — форма, которую пары
  // разговорника дают для дательного этого слова, если она на -га/-ка («Отдай это отцу — Даьга дӀале ер»).
  // Форма должна быть в текстах (lib/ingush-words.js).
  const ALL_PAIRS = new Map();
  function allOf(lemma, base, w) {
    const ok = (g) => g && /[гк]а$/.test(g) && g !== base && g.startsWith(base.slice(0, 2));
    const f = cases().form(base, "all", w);
    if (ok(f)) return f;
    const l = low(lemma);
    const ru = /[ая]$/.test(l) ? [l.slice(0, -1) + "е"] : /ец$/.test(l) ? [l.slice(0, -2) + "цу"] : /ь$/.test(l) ? [l.slice(0, -1) + "и"] : /[бвгджзклмнпрстфхцчшщ]$/.test(l) ? [l + "у"] : [];
    for (const r of ru) {
      if (!RET.lemmas(r, "ru").includes(l)) continue;
      const b = ALIGN && ALIGN.best(r, "ru");
      if (b && b.n >= AL_N && ok(low(b.to)) && V.attested(b.to)) return low(b.to);
      // прямо по парам: в двух и больше парах с этим словом есть одна и та же ингушская форма основы на -га/-ка
      const key = r + "|" + base;
      if (!ALL_PAIRS.has(key)) {
        const cnt = new Map();
        for (const [ru2, inh2] of EXAMPLES || []) {
          if (!String(ru2).toLowerCase().includes(r) || !tk(ru2).includes(r)) continue;
          for (const t of new Set(tk(inh2))) if (ok(t)) cnt.set(t, (cnt.get(t) || 0) + 1);
        }
        const top = [...cnt].sort((a, b2) => b2[1] - a[1])[0];
        ALL_PAIRS.set(key, top && top[1] >= 2 && V.attested(top[0]) ? top[0] : null);
      }
      if (ALL_PAIRS.get(key)) return ALL_PAIRS.get(key);
    }
    return null;
  }
  const WAIT = new Set(["ждать", "подождать", "дождаться", "дожидаться", "ожидать"]);
  function waitAddressee(out, words) {
    if (tune.noCases) return;
    // только «хьежа» (все примеры — с ним); «Подожди немного — КӀеззига сабарде» — другой глагол («потерпи»)
    const v = out.find((x) => x.verb && WAIT.has(low(x.lemma || "")) && [x.to, ...(x.ingForms || [])].some((t) => /^хьеж/.test(low(t || ""))));
    if (!v) return;
    for (let k = 0; k < out.length; k++) {
      const x = out[k];
      if (x.verb || x.at === undefined || x.at < 0 || (out[k - 1] && out[k - 1].how === "skip")) continue;
      const w = words[x.at];
      if (x.pron) {
        const rc = (L.RU_PRONOUN_FORMS[w] || [])[1];
        const f = rc === "acc" && (L.PRONOUNS[x.pron] || {}).all;
        if (f) { x.to = f; x.case = "all"; x.obj = true; }
        continue;
      }
      if (x.kase && x.kase !== "acc") continue;
      for (const l of RET.lemmas(w, "ru")) {
        const base = l !== w && nounBase(l);
        if (!base) continue;
        const f = allOf(l, base, w);
        if (f) { x.was = x.was || x.to; x.to = f; x.how = "case"; x.kase = "all"; x.cls = undefined; break; }
      }
    }
  }

  // Согласование прилагательных с классным показателем и «четыре» (см. sentence).
  function agreeMods(out) {
    const live = out.filter((x) => x.to && x.how !== "skip");
    const cop = live.find((x) => x.how === "cop" && x.copCls);
    for (let k = 0; k < live.length; k++) {
      const x = live[k];
      if (x.verb || x.pron || x.kase || /\s/.test(String(x.to))) continue;
      const num = L.NUMBER_CLASS[x.from];
      const next = live[k + 1];
      // у прилагательного в словаре проекта отдельные формы «о людях»: «старый — къаьна (о вещах…) / воккха,
      // йоккха (о людях: воккха саг — старик)». Подлежащее-человек (класс по полу) — берём форму его класса.
      const ppl = !num && x.line && /о людях/.test(x.line) && String(x.line).split(" / ").find((p) => /о людях/.test(p));
      if (ppl) {
        // только сказуемое («Отец старый» — «Да воккха ва»): перед существительным «старый» бывает и «давний»
        // (справочник: «старый друг — къаьна доттагӀа»)
        const pn = cop && (!next || next === cop) ? live.slice(0, k).reverse().find((y) => !y.verb && !y.pron && y.cls && !y.kase) : null;
        const pc = pn && pn.at >= 0 && [low(pn.from), ...RET.lemmas(low(pn.from), "ru")].map((l) => L.PERSON_CLASS[l]).find(Boolean);
        const pf = pc && ppl.replace(/\([^()]*\)/g, " ").split(/[,\s]+/).find((t) => t && low(t)[0] === pc && V.seen(t));
        if (pf) { x.was = x.to; x.to = pf; x.agreed = pc; continue; }
      }
      const g = num || (/^(word|lemma|align)$/.test(x.how) && adjClassGroup(x.to));
      if (!g) continue;
      let cls = null;
      if (next && !next.verb && !next.pron && next.cls && !next.kase && next.how !== "cop") cls = next.cls;
      else if (!num && cop && (!next || next === cop) && live.slice(0, k).some((y) => (y.cls || y.pron) && !y.verb)) cls = cop.copCls;
      if (cls && g[cls] && low(g[cls]) !== low(x.to)) { x.was = x.to; x.to = g[cls]; x.agreed = cls; }
    }
  }

  // Пометы окончаний из словарей: «Ленивый (-ая, -ые)», «Прим.: -ая, ые» — это не слова, переводить их нечего
  // (раньше в ответе оставались «[ая] [ые]»). Убираем окончание с дефисом и такое же окончание сразу после него.
  const END_NOTE = "(?:ая|яя|ое|ее|ые|ие|ой|ий|ый|ую|ого|ему|ому)";
  const END_NOTE_RE = new RegExp(`(^|[\\s(,;:])-\\s?${END_NOTE}(?:\\s*,\\s*-?\\s?${END_NOTE})*(?![а-яёА-ЯЁ-])`, "g");
  const dropEndingNotes = (raw) => String(raw).replace(END_NOTE_RE, "$1").replace(/\(\s*[,;]?\s*\)/g, " ");
  // Одно предложение: возвращает { text, pieces, known, total }.
  // opts.noWhole — не брать всё предложение одним куском (для замера scripts/eval-chunks.js)
  function sentence(raw, src, opts = {}) {
    const lang = src === "inh" ? "inh" : "ru";
    if (lang === "ru") raw = dropEndingNotes(raw);
    const orig = String(raw).replace(/[̀́]/g, "").match(/[а-яёА-ЯЁӀӏ]+(?:-[а-яёА-ЯЁӀӏ]+)*/g) || [];
    const words = orig.map(low);
    // последние слова частей предложения (перед запятой, точкой с запятой, тире): «Укхаз Ӏохал, дукха яьха»
    const clauseEnd = new Set();
    { let n = 0; for (const part of String(raw).replace(/[̀́]/g, "").split(/[,;:–—]|\s-\s/)) { n += (part.match(/[а-яёА-ЯЁӀӏ]+(?:-[а-яёА-ЯЁӀӏ]+)*/g) || []).length; if (n) clauseEnd.add(n - 1); } }
    const out = []; // { from, to, how, verb? }
    let known = 0, total = 0, syn = null;
    const aCount = lang === "inh" ? words.filter((x, k) => x === "а" && k > 0).length : 0;
    let aSeen = 0;
    for (let i = 0; i < words.length;) {
      const w = words[i];
      // «у меня есть / нет …» — у кого: направительный падеж (сога, хьога, тхога, шуга), справочник, разделы 3 и 6
      if (lang === "ru" && w === "у" && L.RU_PRONOUN_FORMS[words[i + 1]]) {
        const p = L.RU_PRONOUN_FORMS[words[i + 1]][0];
        const all = L.PRONOUNS[p] && L.PRONOUNS[p].all;
        if (all) { out.push({ from: "у " + words[i + 1], to: all, how: "lexicon", have: true }); known += 2; total += 2; i += 2; continue; }
      }
      // «у отца есть …» — и у существительного направительный падеж (справочник, раздел 6: нанега; «Дий хьога
      // из книжка?»): форма — только если её знает модуль падежей (есть в текстах), и только в предложении
      // «у кого есть / нет»
      if (lang === "ru" && w === "у" && !tune.noCases && words[i + 1] && words.slice(i + 2).some((x) => x === "есть" || x === "нет")) {
        const n = words[i + 1];
        const f = RET.lemmas(n, "ru").map((l) => { const b = l !== n && nounBase(l); return b ? allOf(l, b, n) : null; }).find(Boolean);
        if (f) { out.push({ from: "у " + n, to: f, how: "case", kase: "all", have: true, at: -1 }); known += 2; total += 2; i += 2; continue; }
      }
      if (lang === "ru" && out.some((x) => x.have) && (w === "есть" || w === "нет")) { known++; total++; if (w === "нет") out.push({ from: w, to: "ца", how: "neg" }); i++; continue; }
      if (lang === "ru" && w === "такое" && words[i - 1] === "это") { i++; continue; }
      if (lang === "ru" && (RU_PREPS.has(w) || RU_SKIP.has(w))) { out.push({ from: w, to: "", how: "skip" }); i++; continue; }
      // одна согласная буква — не слово: «и т. д.», пометы класса «(й, б, д)» в словарных статьях
      if (lang === "ru" ? /^[бвгджзйклмнпрстфхцчшщ]$/.test(w) && !/^[вкс]$/.test(w) : /^[бвгджзйклмнпрстфхцчшщ]$/.test(w)) { out.push({ from: w, to: "", how: "skip" }); i++; continue; }
      // «кого-либо», «что-либо», «чем-либо» среди других слов — заполнитель из толкования словаря («превзойти
      // кого-либо»): в ингушском переводе носителей его нет, переводить нечего. Одно такое слово — как синоним (ниже).
      if (lang === "ru" && words.length > 1 && /^[а-я]+-либо$/.test(w) && (INDEF[w.split("-")[0]] || INDEF_OBL.has(w.split("-")[0]))) { out.push({ from: w, to: "", how: "skip" }); i++; continue; }
      if (lang === "ru" && (w === "и" || w === "или")) { out.push({ from: w, to: "", how: w === "и" ? "and" : "or" }); i++; continue; }
      // «X а Y а» — «X и Y» (справочник, раздел 8: «да а нана а», «ди а бийса а»): последнее «а» не
      // переводится, предпоследнее — «и»
      if (lang === "inh" && w === "а" && i > 0 && aCount >= 2) {
        const k = aSeen++;
        known++; total++;
        out.push({ from: w, to: k === aCount - 2 ? "и" : "", how: k === aCount - 2 ? "and" : "skip" });
        i++; continue;
      }
      let hit = null, len = 1;
      // причастие на -ш и связка: «Со кхеташ вац» — «Я не понимаю», «Из Назране вахаш ва» — «Он живёт…»
      if (lang === "inh" && (COP_INFO.has(words[i + 1]) || OAL[words[i + 1]])) {
        const ci = COP_INFO.get(words[i + 1]) || { tense: "pres", cls: OAL[words[i + 1]] };
        let inf = progressive(w, ci.cls);
        // «деша» — читать и учиться (словарь проекта): без дополнения — непереходное значение на «-ся»
        // («Со дешаш ва» — я учусь, «Хьо мичахьа дешаш ва?» — где ты учишься?; с книгой — читаю: PaydaDosh)
        if (inf && !/(ся|сь)$/.test(inf)) {
          const alt = GLOSS_REFL.get(w.slice(0, -1));
          const obj = words.some((x, k) => k !== i && k !== i + 1 && !INH_PRON.has(x) && !COP_INFO.has(x) && !OAL[x] && ((d) => !!d && (d.noun || isRuNoun(low(String(d.to)))))(dictWord(x, "inh")));
          if (alt && !obj) inf = alt;
        }
        if (inf) { hit = { to: inf, how: "prog", verbRu: { inf, prog: true, ...progTense(ci) } }; len = 2; }
      }
      for (let n = Math.min(MAX_SPAN, words.length - i); n >= 2 && !hit; n--) {
        if (opts.noWhole && n === words.length) continue;
        // «не знаю», «не понимаю» — глагол из библиотеки слов с «не»: собирают правила («Сона хац», «Со кхетац»)
        if (lang === "ru" && words.slice(i, i + n).some((x, k, a) => x === "не" && VERB_FORMS.has(a[k + 1]))) continue;
        let p = phrase(words.slice(i, i + n), lang);
        // «спасибо большое» = «большое спасибо»: два слова в обратном порядке — та же фраза
        if (!p && n === 2) p = phrase([words[i + 1], words[i]], lang);
        // кусок из 2–4 слов по таблице фраз, выученной из пар разговорника (lib/rules/align.js)
        // местоимение или связку в начале куска оставляем отдельным словом: по ним ставится лицо глагола
        // «не» в конце куска относится к следующему глаголу («я не | буду ждать»): такой кусок не берём;
        // глаголы из библиотеки слов («знаю», «люблю») переводят правила: «Сона хац», а не кусок «хац» без «сона»;
        // одни местоимения («я тебя») — тоже по правилам: от них зависят падеж подлежащего и класс глагола
        const ap = !p && n <= 4 && !(lang === "ru" && (words[i + n - 1] === "не" || words.slice(i, i + n).some((x) => VERB_FORMS.has(x)) || words.slice(i, i + n).every((x) => L.RU_PRONOUN_FORMS[x]))) && !(lang === "inh" && words.slice(i, i + n).every((x) => INH_PRON.has(x) || COP.has(x))) && ALIGN && ALIGN.phrase && ALIGN.phrase(words.slice(i, i + n), lang, tune.phrase);
        // в вопросе «как …» — это «мишта» (кусок «как ты — хьо» теряет вопрос); кусок, который кончается связкой
        // («моя мать — са нана я»), — только в конце предложения: иначе связка встанет посреди
        // и кусок не должен терять вопросительное слово («где ты — хьо»)
        const qLost = ap && lang === "ru" && words.slice(i, i + n).some((x) => L.QUESTION_WORDS[x] && (x !== "как" || opts.question) && !low(ap.to).split(/\s+/).some((t) => t.startsWith(low(L.QUESTION_WORDS[x]).slice(0, 3))));
        const apBad = ap && lang === "ru" && (qLost || (opts.question && words[i] === "как") || (COP_INFO.has(low(String(ap.to).split(/\s+/).pop())) && i + n < words.length));
        if (ap && !apBad) p = { to: ap.to, how: "align-phrase" };
        if (p) { hit = p; len = n; }
      }
      // имя: с большой буквы не в начале предложения и есть в списке имён — раньше словаря («Амина», не «амин»);
      // по-ингушски — и когда словарь знает слово только как «имя» («Ахьмад» — не «Имя»)
      // слово с большой буквы в середине предложения, которого нет в словаре как такового (только «по начальной форме»:
      // «Амина» → «амин»), — тоже имя
      if (!hit && i > 0 && /^[А-ЯЁӀ]/.test(orig[i] || "") && !NAMES().has(w)) {
        const ex = RET.lookupWord(w, lang, 1);
        // но не город и не страна: у их начальной формы в словаре большая буква («Москве» → «Москва» — Моске)
        const place = ex && ex.lemma && ex.items.some((it) => /^[А-ЯЁ]/.test(String(it.ru).trim()));
        if (!ex || (ex.lemma && !place)) hit = { to: orig[i], how: "name" };
      }
      if (!hit && NAMES().has(w) && !(lang === "inh" && (COP.has(w) || INH_PRON.has(w) || INH_VERB.has(w)))) { // «Дий» — связка, не имя
        const g = lang === "inh" ? dictWord(w, "inh") : null;
        if ((i > 0 && /^[А-ЯЁӀ]/.test(orig[i] || "")) || (g && /^(имя|фамилия)$/i.test(String(g.to).trim())) || (lang === "ru" && words.length === 1))
          hit = { to: orig[i][0].toUpperCase() + orig[i].slice(1), how: "name" };
      }
      const ruCtx = () => ({ cap: i === 0 || /^[А-ЯЁӀ]/.test(orig[i] || ""), afterVerb: out.some((x) => x.verb), first: !out.some((x) => x.verb || x.pron || x.have), question: !!opts.question, afterNum: i > 0 && !!L.NUMBERS[words[i - 1]], wantInf: words.some((x) => (VERB_FORMS.get(x) || {}).v?.id === "хотеть") });
      if (!hit) hit = lang === "ru" ? ruWord(w, words[i + 1], ruCtx()) : inhWord(w, i === words.length - 1, i === 0, words[i + 1], 0, clauseEnd.has(i), words[i - 1]);
      // имя собственное (с большой буквы не в начале предложения), которого нет в словаре, — как есть
      // и в начале предложения, если это известное имя («Ахмед», «Абукар» — записи «имя = …» PaydaDosh, имена Википедии)
      // или слово с большой буквы, у которого нет ни записи, ни начальной формы; имя с маленькой буквы — с большой
      if (!hit && NAMES().has(w)) hit = { to: orig[i][0].toUpperCase() + orig[i].slice(1), how: "name" };
      if (!hit && /^[А-ЯЁӀ]/.test(orig[i] || "") && (i > 0 || !RET.lemmas(w, lang).length)) hit = { to: orig[i], how: "name", weak: i === 0 && words.length > 1 }; // «Зарема школе йода»; weak — в начале предложения: может быть и опечаткой, в «известные» не считаем
      if (hit && hit.verb && hit.inf === undefined) hit.inf = (VERB_FORMS.get(w) || {}).tense === "inf";
      total += len;
      if (hit) { known += hit.weak ? 0 : len; if (hit.to || hit.how === "copula" || hit.how === "was" || hit.how === "optative") out.push({ from: words.slice(i, i + len).join(" "), ...hit, at: len === 1 ? i : -1 }); }
      // слово есть в настоящих текстах (таблица корпуса): «погода» — «хаоттам»
      else if (lang === "ru" && corpusWord(w)) { const c = corpusWord(w); known += 1; out.push({ from: w, to: c, how: "corpus" }); }
      // синоним из нашего словаря («поручает» — как «поручить») и запасной поиск ингушского слова (корпус, редкие записи)
      else if ((syn = lang === "ru" ? ruSynonym(w, words[i + 1], ruCtx()) : inhFallback(w))) { known += 1; out.push({ from: w, ...syn, at: i }); }
      else if (lang === "ru" && !RET.lemmas(w, "ru").length && !RET.lookupWord(w, "ru", 1) && /^[а-я]{3,}$/.test(w) && !/(ть|ться|л|ла|ли|ет|ит|ют|ут|ат|ят)$/.test(w) && (i === 0 || isVerbLemma(RET.lemmas(words[i + 1] || "", "ru")[0] || "") || VERB_FORMS.has(words[i + 1] || "")) && !L.FUNCTION_WORDS.has(w))
        // неизвестное слово перед глаголом или в начале — скорее всего имя, даже с маленькой буквы («увейс кушает» → «Увейс»)
        out.push({ from: w, to: w[0].toUpperCase() + w.slice(1), how: "name", weak: true });
      else if (lang === "ru" && !RET.lemmas(w, "ru").length && !RET.lookupWord(w, "ru", 1) && /^[а-я]{3,}$/.test(w) && !/(ть|ться)$/.test(w))
        // новое заимствование («бургер», «смартфон»): в ингушском такие слова пишутся как по-русски — оставляем, с пометкой
        out.push({ from: w, to: w.replace(/([^аеиоуыэюя])у$/, "$1а").replace(/ю$/, "я"), how: "loan" }); // «пиццу» → «пицца»: начальная форма
      else out.push({ from: w, to: `[${w}]`, how: "unknown" });
      i += len;
    }

    if (lang === "ru") { nounCases(out, words); obliqueAdjs(out, words); }
    if (lang === "ru") {
      // «буду ждать», «будем делать» — будущее того глагола, что в инфинитиве: «Со хьежаргва шуга»,
      // «фу дергда вай?» (PaydaDosh). «буду» само по себе не переводится.
      const aux = out.find((x) => x.aux);
      const infV = aux && out.find((x) => x !== aux && x.verb && x.inf && !x.dat);
      if (infV) {
        const fut = V.futureOf(infV.lemma || infV.from, formsOf);
        if (fut) {
          out.splice(out.indexOf(aux), 1);
          Object.assign(infV, { fut, tense: "fut", inf: false, how: "fut", pn: aux.pn, to: fut.pos.д || fut.pos.в || Object.values(fut.pos)[0] || Object.values(fut.neg)[0], ingForms: [...(infV.ingForms || [infV.to]), ...futForms(fut)] });
        }
      }
      // глаголы знания, желания, видения («знать», «хотеть», «видеть»…) — с дательным: «сона хов»
      const v = out.find((x) => x.verb && x.dat);
      if (v) {
        const subj = out.find((x) => x.pron && x.case === "nom");
        if (subj && L.PRONOUNS[subj.pron].dat) { subj.to = L.PRONOUNS[subj.pron].dat; subj.case = "dat"; }
        // подлежащее-существительное («Мать любит детей») — тоже в дательном (справочник, раздел 5; раздел 6:
        // «нанна»): первое существительное перед глаголом в им. падеже. Форма — только если она есть в текстах
        // (lib/rules/cases.js); нет — словарная, но подлежащим оно остаётся (глагол с ним не согласуется).
        const subjN = !subj && out.slice(0, out.indexOf(v)).find((x) => !x.verb && !x.pron && x.at >= 0 && (x.cls || x.noun) && !x.kase && (x.how === "word" || L.PERSON_CLASS[words[x.at]]));
        if (subjN) {
          subjN.datSubj = true;
          const base = !tune.noCases && nounBase(words[subjN.at]);
          const f = base && low(subjN.to) === base && datOf(words[subjN.at], base);
          if (f) { subjN.was = subjN.to; subjN.wasHow = subjN.how; subjN.to = f; subjN.how = "case"; subjN.kase = "dat"; }
        }
      }
      // «сказать, рассказать, передать» кому — направительный падеж на -га, не дательный (PaydaDosh: «Скажи
      // дочери — Ала йоӀага», «Скажите мне — Ала сога», «Я скажу об этом матери — Аз наьнага дӀааргда из»,
      // «Расскажи мне подробно — … дувцал сога», «Ты сказал ему? — … Ӏа цунга»)
      speechAddressee(out, words);
      waitAddressee(out, words);
      // «свой» — по лицу подлежащего (справочник, раздел 3: са, сай; хьа, хьай; шун, шоай; ший — его собственный)
      const OWN = { "я": "сай", "ты": "хьай", "вы": "шоай" };
      const who = out.find((x) => x.pron && (x.case === "nom" || x.case === "dat" || x.case === "erg"));
      for (const x of out.filter((y) => y.own)) if (who && OWN[who.pron]) x.to = OWN[who.pron];
      // «и»: «а» после каждого из соединённых слов; «или»: «е» между ними
      for (let k = 0; k < out.length; k++) {
        const x = out[k];
        if (x.how === "or") { x.to = "е"; continue; }
        if (x.how !== "and") continue;
        const prev = out.slice(0, k).reverse().find((y) => y.to && y.how !== "skip");
        const nextW = out.slice(k + 1).find((y) => y.to && y.how !== "skip");
        if (prev && nextW && !prev.verb && !nextW.verb) { prev.to += " а"; nextW.to += " а"; }
        else x.to = "а";
      }
      // глагол «идти» и т. п. согласуется по классу с тем, кто идёт (справочник, раздел 4: вода, йода…).
      // Класс берём у подлежащего: местоимение (я/ты — пол неизвестен, справочник: тогда в) или
      // существительное-человек из библиотеки слов. Не знаем класса — остаётся словарная форма.
      for (const v of out.filter((x) => x.byClass && x.byObject)) {
        const subj = out.find((x) => x.pron && x.case === "dat");
        const obj = out.find((x) => x !== subj && !x.verb && !x.datSubj && (x.pron ? x.case === "nom" : x.cls));
        if (obj && v.byClass[obj.pron ? obj.cls || "в" : obj.cls]) { v.to = v.byClass[obj.pron ? obj.cls || "в" : obj.cls]; v.how = "lexicon"; }
      }
      for (const v of out.filter((x) => x.byClass && !x.byObject)) {
        const subj = out.find((x) => x.pron && x.case === "nom") || out.find((x) => x.cls && !x.verb);
        let cls = subj ? (subj.pron ? subj.cls || "в" : subj.cls) : null;
        // переходный глагол (по парам разговорника) согласуется не с подлежащим, а с дополнением
        // (справочник, раздел 4: «the object of a transitive verb»); класса дополнения не знаем — словарная форма
        if (!v.imper && transOf(v.ingForms || [v.to]) === true) {
          const obj = out.find((x) => x !== subj && !x.verb && !x.pron && x.cls && !x.kase);
          cls = obj ? obj.cls : null;
        }
        if (!subj && v.person === 3) cls = null;
        if (cls && v.byClass[cls]) { v.to = v.byClass[cls]; v.how = "lexicon"; }
        // «жить» в утверждении — причастие и связка (справочник, раздел 6: «вахаш ва»; PaydaDosh: «Из Назране
        // вахаш ва»), в вопросе — простая форма («Мича вах хьо?»)
        if (cls && v.progPart && v.progPart[cls] && !opts.question) { v.to = v.progPart[cls] + " " + L.COPULA.pres[cls]; v.negForm = v.progPart[cls] + " " + L.COPULA.neg[cls]; v.how = "lexicon"; }
      }
      // нет глагола: «Он мой брат» → «Из са воша ва». Связка по классу подлежащего (справочник, раздел 4):
      // ва, я, да, ба; прошедшее вар, яр…; с «не» — вац, яц…; в вопросе без вопросительного слова — вий, йий…
      // Пол «я/ты» неизвестен — справочник: тогда в. Класс не знаем — связку не ставим.
      const neg = out.find((x) => x.how === "neg");
      const was = out.find((x) => x.how === "was");
      const qWord = out.find((x) => x.how === "lexicon" && Object.values(L.QUESTION_WORDS).includes(x.to));
      const verbLike = out.some((x) => !x.verb && !x.noun && x.lemma && isVerbLemma(low(x.lemma))); // «работаем» → болх: глагол, хоть и найден как слово
      // «Это X»: связка по классу X — «Ер са нана я», «Ер маькх я» (справочник, раздел 4; PaydaDosh); «это» +
      // наречие или краткое прилагательное — «Из … да»: «Из дика да», «Из бакъ да», «Из нийса дац», «Юхе да из»,
      // «Деза да ер» (PaydaDosh), «Ма хоза да!», «Дика да» (справочник, раздел 2). Вопрос — «Гаьна дий из?»
      const liveE = out.filter((x) => x.to && x.how !== "skip" && x.how !== "neg" && x.how !== "was");
      const eto = liveE[0] && liveE[0].from === "это" && liveE[0].how === "lexicon" ? liveE[0] : null;
      let etoDone = false;
      if (eto && liveE.length >= 2 && !out.some((x) => x.verb || x.how === "cop" || x.how === "unknown" || x.have) && !verbLike && !qWord) {
        const rest = liveE.slice(1);
        const lastP = rest[rest.length - 1];
        const head = !lastP.pron && !lastP.kase && (lastP.cls || clsOfRu(lastP.from)) || null;
        const pw = lastP.from;
        // наречие качества: начальная форма — прилагательное («дёшево — дешёвый», «трудно — трудный»), не время
        // («давно») и не частица («просто», «только»)
        // и с «очень» перед ним: «Это очень дорого» (PaydaDosh: «Очень вкусно — ЧӀоагӀа чамболаш я»)
        const advQ = (rest.length === 1 || (rest.length === 2 && rest[0].from === "очень")) && /о$/.test(pw) && !lastP.noun && !lastP.cls && !ETO_NOT_PRED.has(pw)
          && (RET.lemmas(pw, "ru").some((l) => /(ый|ий|ой)$/.test(l)) || ["ый", "ий", "ой"].some((e) => RET.lookupWord(pw.slice(0, -1) + e, "ru", 1))); // «дорого» — «дорогой»
        const cls = head || (advQ ? "д" : null);
        if (cls) {
          const set = was ? (neg ? L.COPULA.pastNeg : L.COPULA.past) : neg ? L.COPULA.neg : opts.question ? L.COPULA.q : L.COPULA.pres;
          if (set[cls] && !(was && advQ)) {
            if (neg) neg.to = "";
            if (advQ) eto.to = "из";
            // прилагательное с показателем класса — в классе д, как связка: «дорого — деза» («Деза да ер», PaydaDosh)
            const g = advQ && adjClassGroup(lastP.to);
            if (g && g.д && low(g.д) !== low(lastP.to)) { lastP.was = lastP.to; lastP.to = g.д; }
            const cop = { from: "", to: set[cls], how: "cop", cls: undefined, copCls: cls };
            // вопрос «да / нет»: сказуемое, связка, потом «это» — «Гаьна дий из?», «Бакъдий из?» (PaydaDosh),
            // как в правиле связки (lib/rules/grammar.js: «Могаш вий хьо?»)
            if (opts.question && !neg && !was) { out.splice(out.indexOf(eto), 1); out.push(cop, eto); }
            else out.push(cop);
            etoDone = true;
          }
        }
      }
      if (!etoDone && !out.some((x) => x.verb) && !out.some((x) => x.how === "unknown" || x.genCtx) && !verbLike && out.filter((x) => x.to && x.how !== "neg").length >= 2) {
        const have = out.some((x) => x.have);
        const subj = have ? out.find((x) => x.cls && !x.have) : out.find((x) => x.pron && x.case === "nom") || out.find((x) => x.cls);
        const cls = subj ? (subj.pron ? subj.cls || "в" : subj.cls) : null;
        // после подлежащего должно быть сказуемое («дом большой»); «старый друг», «мой брат» — просто сочетания слов
        const afterSubj = subj ? out.slice(out.indexOf(subj) + 1).some((x) => x.to && x.how !== "neg" && x.how !== "was") : false;
        const first = out.find((x) => x.to);
        const firstAdj = first && (first.how === "word" || first.how === "lemma") && /(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/.test(first.from) && !(subj && subj.pron);
        if (cls && (afterSubj || qWord || have) && !firstAdj) {
          const set = was ? (neg ? L.COPULA.pastNeg : L.COPULA.past) : neg ? L.COPULA.neg : opts.question && !qWord ? L.COPULA.q : L.COPULA.pres;
          const cop = { from: "", to: set[cls], how: "cop", cls: undefined, copCls: cls };
          if (neg) neg.to = "";
          // в вопросе с вопросительным словом связка идёт сразу за ним: «Мичара ва хьо?»
          if (qWord && !neg && !was) out.splice(out.indexOf(qWord) + 1, 0, cop); else out.push(cop);
        }
      }
      // «Спасибо большое» — прилагательное после существительного, но это не сказуемое (связки нет, глагола нет):
      // в ингушском прилагательное перед существительным (справочник, раздел 8; PaydaDosh: «доккха баркал»)
      {
        const live = out.filter((x) => x.to && x.how !== "skip");
        if (live.length === 2 && !out.some((x) => x.verb || x.how === "cop" || x.how === "neg" || x.how === "was") && !live[0].pron && !L.RU_PRONOUN_FORMS[live[0].from]
          && /^(word|lemma)$/.test(live[1].how) && !live[1].noun && posRu(live[1].from) === "adj" && posRu(live[0].from) === "other" && !isVerbLemma(live[0].from)
          // «Погода хорошая», «Девушка красивая» — сказуемое: существительное с классом (или неизвестное) не трогаем;
          // «спасибо» в словаре без класса — не подлежащее
          && live[0].how === "word" && live[0].noun === false && !live[0].cls && !live[0].dictCls
          // существительное мужского или женского рода с прилагательным после — сказуемое («Школа большая»)
          && !/^[mf]$/.test(D.gender(live[0].from) || "")) {
          out.splice(out.indexOf(live[1]), 1); out.splice(out.indexOf(live[0]), 0, live[1]);
        }
      }
      // «не» перед глаголом: «ца» (справочник, раздел 7)
      const vNeg = out.find((x) => x.verb);
      // будущее с «не» — своя форма на -ц: «Со гӀоргвац» (я не пойду, PaydaDosh); класс выберем ниже
      if (neg && neg.to && vNeg && vNeg.fut) { out.splice(out.indexOf(neg), 1); vNeg.neg = true; }
      else if (neg && neg.to && vNeg && vNeg.negForm && !vNeg.imper) { out.splice(out.indexOf(neg), 1); vNeg.to = vNeg.negForm; }
      else if (neg && neg.to && vNeg) { out.splice(out.indexOf(neg), 1); vNeg.to = (vNeg.imper ? "ма " : "ца ") + vNeg.to; } // запрет — ма (справочник, раздел 7)
      // кто делает переходное действие — в эргативе (справочник, раздел 5: аз, Ӏа, цо, оаха, оаша, цар):
      // глагол из словаря, не возвратный, и есть прямое дополнение (существительное не после предлога)
      const tv = out.find((x) => x.verb && x.tense && !x.refl && !x.imper && !x.dat);
      // переходность — по парам разговорника (transOf): «Со хьежаргва» — не эргатив, «Аз эцаргда из» — эргатив
      // если по самим формам не ясно — по формам будущего того же глагола («жду — хьежа»: «Со хьежаргва шуга»,
      // «Со хьога хьежаргвац» — с именительным, значит, не эргатив)
      const transFut = (v) => { const f = !v.fut && v.lemma && V.futureOf(v.lemma, formsOf); return f ? (f.intr ? false : transOf(futForms(f))) : null; };
      let trans = tv ? (tv.fut && tv.fut.intr ? false : transOf(tv.ingForms || [tv.to])) : null;
      if (tv && trans === null) trans = transFut(tv);
      // кого ждут — в направительном («даьга», «хьога»): это не прямое дополнение
      if (tv && WAIT.has(low(tv.lemma || "")) && out.some((x) => x.case === "all" || x.kase === "all")) trans = false;
      if (tv && trans !== false) {
        const subjP = out.find((x) => x.pron && x.case === "nom" && !x.obj);
        // «утром, вечером, летом» — когда, а не что: не дополнение
        const objN = out.find((x, k) => x !== subjP && !x.verb && !x.pron && !RU_WHEN.has(x.from) && (x.noun || x.how === "word" || x.how === "lemma") && (k === 0 || out[k - 1].how !== "skip"));
        // «Я куплю это» — «Аз эцаргда из»: указательное слово после подлежащего — тоже дополнение (у будущего)
        const objD = tv.fut && subjP && out.find((x, k) => k > out.indexOf(subjP) && x.how === "lexicon" && Object.values(L.DEMONSTRATIVES).includes(x.to) && out[k - 1].how !== "skip");
        if (subjP && (objN || objD || trans) && L.PRONOUNS[subjP.pron].erg) { subjP.to = L.PRONOUNS[subjP.pron].erg; subjP.case = "erg"; }
        // подлежащее-существительное («Отец купил машину» — «Дас машен ийцай»): эргатив по окончаниям справочника
        // (саго, нанас), только если такая форма есть в текстах (lib/rules/cases.js)
        // Только человек-подлежащее и дополнение в явном винительном («машину», «книгу»): иначе глагол
        // может быть и непереходным («Отец пришёл домой»)
        const subjN = !subjP && out.find((x) => x.cls && !x.verb && !x.pron && x.at >= 0 && L.PERSON_CLASS[words[x.at]]);
        const objN2 = subjN && out.find((x) => x !== subjN && !x.verb && !x.pron && x.at > subjN.at && /[ую]$/.test(words[x.at]) && RET.lemmas(words[x.at], "ru").some((l) => /[ая]$/.test(l) && nounBase(l)) && (out[out.indexOf(x) - 1] || {}).how !== "skip");
        if (subjN && objN2 && out.indexOf(subjN) < out.indexOf(tv) && !tune.noCases) {
          const base = nounBase(words[subjN.at]);
          const f = base && low(subjN.to) === base && cases().form(base, "erg");
          if (f) { subjN.was = subjN.to; subjN.wasHow = subjN.how; subjN.to = f; subjN.how = "case"; subjN.kase = "erg"; }
        }
      }
      // будущее согласуется по классу (справочник, раздел 4): непереходный глагол — с подлежащим
      // («Со гӀоргва», «КӀаьнк школе гӀоргва», «гӀоргда вай»), переходный — с тем, что делают
      // («Аз эцаргда из», «Аз каьхат яьздергда»). Я/ты — пол неизвестен: в. Предмет без класса — д.
      for (const v of out.filter((x) => x.fut)) {
        // подлежащего нет («Когда придёшь?», «Пойдём завтра») — в ингушском местоимение нужно: «Маца
        // воагӀаргва хьо?», «гӀоргда вай» (PaydaDosh). Лицо — по окончанию русского глагола; «мы» — вай.
        const IMPLIED = { 0: "я", 1: "ты", 3: "мы", 4: "вы" };
        const hasSubj = out.some((x) => (x.pron && (x.case === "nom" || x.case === "erg")) || (x.cls && !x.verb));
        if (!hasSubj && IMPLIED[v.pn] && !v.aux) {
          const p = IMPLIED[v.pn], P = L.PRONOUNS[p], tr = !v.fut.intr && transOf(v.ingForms || [v.to]) === true;
          const f = p === "мы" ? P.alt.nom : tr ? P.erg : P.nom;
          out.push({ from: "", to: f, how: "lexicon", pron: p, case: tr ? "erg" : "nom", cls: P.cls, implied: true });
        }
        const erg = out.some((x) => x.case === "erg" || x.kase === "erg");
        let cls;
        if (!v.fut.intr && (erg || transOf(v.ingForms || [v.to]) === true)) {
          const obj = out.find((x) => x !== v && !x.verb && x.case !== "erg" && x.kase !== "erg" && x.case !== "dat" && (x.pron ? x.case === "nom" : x.cls));
          cls = obj ? (obj.pron ? obj.cls || "в" : obj.cls) : "д";
        } else {
          const subj = out.find((x) => x.pron && x.case === "nom") || out.find((x) => x.cls && !x.verb && !x.kase);
          cls = subj ? (subj.pron ? subj.cls || "в" : subj.cls) : "д";
        }
        // «Пусть будет …» — не будущее, а пожелание: «Массаза беркат хилда шун цӀагӀа!» (справочник)
        if (v.aux && out.some((x) => x.how === "optative") && !v.neg && V.OPTATIVE_BE[cls]) { v.to = V.OPTATIVE_BE[cls]; continue; }
        if (v.fut.fixed) cls = v.fut.fixed;
        const set = v.neg ? v.fut.neg : v.fut.pos;
        let f = set[cls] || (v.neg && v.fut.pos[cls] ? "ца " + v.fut.pos[cls] : null);
        if (!f) { const any = set.д || set.в || Object.values(set)[0]; f = any || (v.neg ? "ца " + (v.fut.pos.д || Object.values(v.fut.pos)[0]) : null); }
        if (f) v.to = f;
      }
      // Прилагательное с классным показателем и «четыре» согласуются с существительным (справочник, раздел 4):
      // «доккха цӀа», «боккха дезал», «йоккха машен»; «виъ новкъост», «биъ Ӏаж» (PaydaDosh). Перед
      // существительным — по его классу (только им. падеж: у падежных форм окончания другие); после подлежащего
      // в предложении со связкой («Семья большая») — по классу связки. Класса не знаем — словарная форма.
      agreeMods(out);
      // глаголы — в конец предложения (справочник, раздел 8: подлежащее, дополнение, глагол);
      // инфинитив перед спрягаемым глаголом: «Сона ала лов» (я хочу сказать)
      const verbs = out.filter((x) => x.verb);
      if (verbs.length && verbs.length <= 2) {
        const rest = out.filter((x) => !x.verb);
        verbs.sort((a, b) => (b.inf ? 1 : 0) - (a.inf ? 1 : 0));
        out.length = 0; out.push(...rest, ...verbs);
      }
      // вопрос «вопросительное слово + местоимение + глагол»: глагол сразу за вопросительным словом, кто — после
      // (справочник, раздел 7: «Мича вода хьо?», «Мича вах хьо?», «Фу аьлар Ӏа?», «Мишта дах шо?»)
      const liveQ = out.filter((x) => x.to);
      if (opts.question && liveQ.length === 3 && liveQ[0] === qWord && liveQ[1].pron && (liveQ[1].case === "nom" || liveQ[1].case === "erg") && liveQ[2].verb) {
        out.splice(out.indexOf(liveQ[1]), 1); out.push(liveQ[1]);
      }
    }
    if (lang === "inh") {
      // форма глагола вместо редкого значения из словаря («воал» — не «опекунство»): если другого глагола нет
      if (!out.some((x) => x.verbRu)) { const x = out.find((y) => y.alt); if (x) { const a = x.alt; for (const k of Object.keys(x)) if (k !== "from" && k !== "at") delete x[k]; Object.assign(x, a); } }
      // «ма» перед повелительным — запрет: «Виц ма лелахь» — не забудь (справочник, раздел 7: Ма де!)
      for (let k = 1; k < out.length; k++) {
        if (!out[k].imper || !out[k].verbRu) continue;
        const pm = out[k - 1];
        if (pm && pm.from === "ма") { out[k].verbRu.neg = true; pm.to = ""; pm.how = "skip"; }
      }
      likeInh(out);
      forgetInh(out);
      dezaInh(out, opts);
      advAttrInh(out, clauseEnd);
      vaiInh(out);
      ruCasesInh(out, clauseEnd, orig);
      numInh(out);
      haveInh(out);
      inhPost(out, opts);
      predAdjInh(out);
    }
    const text = out.map((x) => x.to).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { text, pieces: out.filter((x) => x.how !== "skip"), known, total };
  }

  // Шаблоны из разговорника: «Меня зовут … — Са цӀи … я» (одно «…» с обеих сторон). Слово на месте «…»
  // переводится отдельно (имя остаётся как есть).
  const TEMPLATES = { ru: [], inh: [] };
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const DOTS = /…|\.\.\./;
  for (const p of SEED) {
    if (!p || p.rare || !/^(PaydaDosh|Справочник)/.test(p.source || "")) continue;
    const ru = String(p.ru || ""), inh = String(p.inh || "");
    if (ru.split(DOTS).length !== 2 || inh.split(DOTS).length !== 2 || /[()]/.test(inh)) continue;
    const key = (t) => low(t).replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
    const [a, b] = ru.split(DOTS).map(key), [c, d] = inh.split(DOTS).map(key);
    if (!a && !b) continue;
    TEMPLATES.ru.push({ re: new RegExp("^" + esc(a) + (a ? " " : "") + "(.+?)" + (b ? " " : "") + esc(b) + "$"), out: [c, d] });
    if (c || d) TEMPLATES.inh.push({ re: new RegExp("^" + esc(c) + (c ? " " : "") + "(.+?)" + (d ? " " : "") + esc(d) + "$"), out: [a, b] });
  }
  // Целая фраза из разговорника (PaydaDosh, справочник) с поправкой на то, как люди пишут: без знаков, ё/е,
  // «тебе спасибо» = «спасибо тебе» (два слова в другом порядке), «С днём рождения» = «Поздравляю (тебя)
  // с днём рождения» (поздравление без «поздравляю»). Точное совпадение ищет сервер раньше (resolveExact).
  // Варианты пишутся в ответ как есть из разговорника — это перевод носителя, а не сборка по словам.
  const PB_NORM = (s) => low(String(s)).replace(/\([^()]*\)/g, " ").replace(/[^а-яӏ\s-]/g, " ").replace(/\s+-\s+|\s+/g, " ").trim();
  let PB_ = null;
  function phrasebookWhole(raw, src, opts) {
    if (opts.noWhole || src !== "ru") return null;
    if (!PB_) {
      PB_ = new Map();
      const add = (ru, inh, prio) => {
        if (!ru || !inh || /…|\.\.\./.test(ru + inh)) return;
        const k = PB_NORM(String(ru).split(/\s—\s/)[0]);
        const to = String(inh).split(/\s\/\s|\s\|\|\s/)[0].replace(/\s*\([^()]*\)\s*/g, " ").replace(/\s+([.!?,])/g, "$1").replace(/\s+/g, " ").trim();
        if (!k || !to || (PB_.has(k) && PB_.get(k).prio <= prio)) return;
        PB_.set(k, { to, prio });
      };
      for (const [ru, inh] of GUIDE.EXAMPLES || []) add(ru, inh, 0);
      for (const p of SEED) if (p && p.kind === "phrase" && /^Справочник/.test(p.source || "")) add(p.ru, p.inh, 0);
      for (const p of SEED) if (p && p.kind === "phrase" && /^PaydaDosh/.test(p.source || "")) add(p.ru, p.inh, 1);
    }
    const k = PB_NORM(raw), ws = k.split(" ");
    if (!k || ws.length > 8) return null;
    const keys = []; // точное совпадение — дело сервера (resolveExact); здесь только варианты
    // два слова в другом порядке — только если одно из них не существительное («спасибо большое»): «брат отца»
    // и «отца брат» — разное
    // и не прилагательное: «работа трудная» (сказуемое) ≠ «трудная работа» (сочетание)
    if (ws.length === 2 && ws.some((w) => posRu(w) !== "other") && !ws.some((w) => posRu(w) === "adj")) keys.push(ws[1] + " " + ws[0]);
    if (ws[0] === "с" && ws.length >= 2) for (const pre of ["поздравляю тебя", "поздравляю", "поздравляю вас"]) keys.push(pre + " " + k);
    for (const key of keys) {
      const hit = PB_.get(key);
      if (hit) { const text = hit.to.replace(/[.!?]+$/, "").replace(/ӏ/g, "Ӏ"); return { text, pieces: [{ from: k, to: text, how: "phrase", like: key }], known: ws.length, total: ws.length }; }
    }
    return null;
  }

  function template(raw, src, opts) {
    if (opts.noWhole) return null;
    const lang = src === "inh" ? "inh" : "ru";
    const k = low(raw).replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
    for (const t of TEMPLATES[lang]) {
      const m = t.re.exec(k);
      if (!m) continue;
      const slotOrig = (String(raw).replace(/[.!?,]/g, " ").match(new RegExp(esc(m[1]).replace(/ /g, "\\s+"), "i")) || [m[1]])[0];
      let fill;
      if (/^[А-ЯЁӀ]/.test(slotOrig.trim()) || slotOrig.trim().split(/\s+/).length === 1 && !dictWord(m[1], lang)) fill = slotOrig.trim();
      else { const s = sentence(m[1], src); if (!s.text || s.known < s.total) continue; fill = s.text; }
      const text = [t.out[0], fill, t.out[1]].filter(Boolean).join(" ");
      return { text, pieces: [{ from: k, to: text, how: "template" }], known: 1, total: 1 };
    }
    return null;
  }

  // Перевод по аналогии (example-based): готовая фраза разговорника, которая отличается от текста ровно
  // одним словом. «Где моя сестра?» по образцу «Где мой брат? — Мичахьа ва са воша?»: слово «брат» в
  // переводе — то, что таблица слов (ALIGN) считает его переводом, его заменяем на перевод нового слова;
  // если у слов разный класс, связка меняется тоже (ва → я).
  const EX = { ru: new Map(), inh: new Map() };
  const tk = (x) => low(String(x).replace(/\([^()]*\)/g, " ").split(" — ")[0]).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];
  for (const [ru, inh] of EXAMPLES || []) {
    const r = tk(ru), i = tk(inh);
    if (r.length < 2 || r.length > 8 || !i.length || /…|\.\.\./.test(ru)) continue;
    // имена в русском переводе образца (с большой буквы не в начале: «Я из Назрани») — чтобы вернуть им заглавную
    const names = new Set((String(ru).split(" — ")[0].match(/(?<=[а-яёА-ЯЁ,]\s+)[А-ЯЁ][а-яё]+/g) || []).map(low));
    for (const [lang, a, b] of [["ru", r, i], ["inh", i, r]]) {
      if (a.length < 2 || a.length > 8) continue;
      a.forEach((_, k) => {
        const key = a.map((w, n) => (n === k ? "*" : w)).join(" ");
        let l = EX[lang].get(key); if (!l) EX[lang].set(key, (l = []));
        if (l.length < 20) l.push({ a, b, k, names });
      });
    }
  }
  const COP_ALL = Object.values(L.COPULA).map((set) => Object.fromEntries(Object.entries(set).map(([c, f]) => [low(f), c])));
  function clsOfRu(w) {
    for (const l of [w, ...RET.lemmas(w, "ru")]) { if (L.PERSON_CLASS[l]) return L.PERSON_CLASS[l]; if (L.ATTESTED_CLASS[l]) return L.ATTESTED_CLASS[l][1]; }
    // класс из словаря проекта — для начальной формы («работа — болх (б/д)», «родители — да-нана (д/д…)»)
    const d = dictWord(w, "ru");
    if (d && d.noun && !d.lemma && d.dictCls) return PL_CLS.get(low(d.to)) || d.dictCls;
    return null;
  }
  // грубая часть речи русского слова для перевода по аналогии: заменять можно только слово того же рода
  // («сын брата» → «два брата» — нет: число на месте существительного)
  const RU_ADV = new Set(["очень", "сегодня", "завтра", "вчера", "сейчас", "теперь", "здесь", "там", "тут", "уже", "еще", "тоже", "также", "всегда", "никогда",
    "много", "мало", "немного", "быстро", "медленно", "хорошо", "плохо", "холодно", "тепло", "жарко", "далеко", "близко", "рано", "поздно", "давно", "скоро",
    "часто", "редко", "вместе", "опять", "снова", "потом", "утром", "вечером", "днем", "ночью", "летом", "зимой", "весной", "осенью", "так", "сюда", "туда", "домой", "лучше", "хуже", "больше", "меньше"]);
  function posRu(w) {
    if (L.NUMBERS[w]) return "num";
    if (L.RU_PRONOUN_FORMS[w]) return "pron";
    if (L.DEMONSTRATIVES[w]) return "dem"; // «где это — мичад из» не образец для «где ты»
    if (L.POSSESSIVES[w]) return "poss";
    if (L.QUESTION_WORDS[w]) return "q";
    if (/(ый|ий|ой)$/.test(w) || (/(ая|яя|ое|ее|ые|ие|ую|юю)$/.test(w) && RET.lemmas(w, "ru").some((l) => /(ый|ий|ой)$/.test(l)))) return "adj";
    // наречие — только на место наречия («очень хороший» не образец для «день хороший»)
    if (RU_ADV.has(w) || (w.length > 5 && /е[ей]$/.test(w))) return "adv"; // и сравнительная степень: «помедленнее», «лучше»
    return "other";
  }
  // Замена одного слова образца ex (место k) словом ws[k] со всеми проверками и согласованием (класс, падеж).
  // out — перевод образца, меняется на месте. → { e, pe, sc } или null. Общая для analog() и construction().
  function subst(ex, k, ws, opts, lang, out) {
    const o = ex.a[k], n = ws[k];
    if (o === n) return null;
    // ингушское местоимение меняет лицо русского глагола («Со … воагӀаргва» — я приеду, «Хьо …» — ты
    // приедешь): такую замену делает sentence(), образец её не согласует
    const subjP = (x) => x !== "вай" && x !== "из" && INH_PRON_CASE.has(x) && /^(nom|erg|dat)$/.test(INH_PRON_CASE.get(x).case);
    const hasVerb = (a) => a.some((x, j) => INH_FIN.has(x) || INH_VERB.has(x) || IV.analyze(x) || (COP_INFO.has(a[j + 1]) && progressive(x, COP_INFO.get(a[j + 1]).cls)));
    const ruVerb = (b) => b.some((x) => V.personOf(x) !== null && !L.RU_PRONOUN_FORMS[x] && RET.lemmas(x, "ru").some(isVerbLemma));
    if (lang === "inh" && (subjP(o) || subjP(n)) && (hasVerb(ex.a) || ruVerb(ex.b))) return null;
    // глагол на месте не-глагола («Со дешаш ва» по образцу «Со цамогаш ва») — образец не подходит
    if (lang === "inh" && hasVerb(ws) && !hasVerb(ex.a)) return null;
    let e = -1, pe = 0;
    ex.b.forEach((t, j) => { const q = ALIGN.prob(o, t, lang); if (q > pe) { pe = q; e = j; } });
    if (e < 0 || pe < (tune.ap || (lang === "ru" ? 0.3 : 0.5))) return null;
    if (lang === "ru" && !tune.noJunk) {
      // заменяемое ингушское слово — то же, что русское слово образца («выключи свет — свет дӀайоае»):
      // это заимствование, а не перевод заменяемого слова
      if (ex.b[e] !== o && ex.a.includes(ex.b[e])) return null;
      // образец — перечень наречий, а не предложение («сегодня завтра — тахан кхоана»)
      if (ex.a.every((x) => RU_ADV.has(x))) return null;
      // в переводе образца два и больше слов, которых нет ни в одном слове русского образца
      // («это удивительно — тамаш йолаш хӀама да»): замена одного слова такую фразу не переводит
      const lost = ex.b.filter((t, j) => j !== e && !COP.has(t) && !INH_PRON.has(t) && !FUNC_INH.has(t) && !ex.a.some((x, i) => i !== k && ALIGN.prob(x, t, "ru") >= 0.05));
      if ((lost.length >= 2 && ex.b.length > ex.a.length) || (lost.length && ex.b.length >= ex.a.length + 2)) return null;
      // заменяемое слово переведено в образце двумя словами («сын брата — веший воӀ кӀаьнк»: «сын» — «воӀ
      // кӀаьнк»): второе слово осталось бы от старого («Дом брата» → «веший цӀа кӀаьнк»)
      if (ex.b.length > ex.a.length && ex.b.some((t, j) => j !== e && !COP.has(t) && !INH_PRON.has(t) && !FUNC_INH.has(t) && ALIGN.prob(o, t, "ru") >= 0.1 && !ex.a.some((x, i) => i !== k && ALIGN.prob(x, t, "ru") >= 0.05))) return null;
    }
    if (lang === "ru" && (OPEN_RU(n) || ws.some(OPEN_RU))) return null;
    // слово образца, которого не знают ни словарь, ни морфология («евши»), — непонятно, что заменяем
    if (lang === "ru" && !RET.lemmas(o, "ru").length && !RET.lookupWord(o, "ru", 1) && !L.RU_PRONOUN_FORMS[o] && !L.QUESTION_WORDS[o] && !L.NUMBERS[o]) return null;
    // «это» может стоять на месте существительного или наречия («напиши это» → «напиши письмо», «кто там» →
    // «кто это»), но не на месте «ты»
    // но не на месте сказуемого-качества или слова меры: «трудно легко — хала атта», «очень вкусно —
    // чӀоагӀа чамболаш я» — не образцы для «это легко», «это вкусно» (там нужна связка: «Из … да»)
    if (lang === "ru" && posRu(n) === "dem" && posRu(o) !== "dem" && (ETO_NOT_PRED.has(o) || (/о$/.test(o) && RET.lemmas(o, "ru").some((l) => /(ый|ий|ой)$/.test(l))))) return null;
    if (lang === "ru" && posRu(o) !== posRu(n) && !((posRu(o) === "dem" && /^(other|adv)$/.test(posRu(n))) || (posRu(n) === "dem" && /^(other|adv)$/.test(posRu(o))))) return null;
    // «как» в вопросе — «мишта», а не сравнение «санна» («как червь — нӀана санна» не образец для «Как дела?»)
    // («как красиво — ма хоза да» — восклицание, не образец для «Как дела?»)
    if (lang === "ru" && opts.question && ex.a.includes("как") && o !== "как" && !ex.b.some((t) => /^(мишта|фу|мала|мича|маца|хӏана|мел)/.test(t))) return null;
    // связь в обе стороны: слово перевода тоже лучше всего переводится обратно этим словом
    const back = ALIGN.best(ex.b[e], lang === "ru" ? "inh" : "ru");
    if (!tune.noBack && (!back || back.to !== o)) return null;
    const hit = lang === "ru" ? ruWord(n, ws[k + 1], { afterVerb: k > 0, first: ws.slice(0, k).every((x) => x === "не" || RU_SKIP.has(x)), question: !!opts.question, afterNum: k > 0 && !!L.NUMBERS[ws[k - 1]] }) : inhWord(n, k === ws.length - 1, k === 0, ws[k + 1]);
    if (!hit || !hit.to || /^\[/.test(hit.to)) return null;
    if (low(hit.to) === n && hit.how !== "word") return null; // русское слово, оставшееся без перевода («маме»), — не перевод
    // глагол заменяем только глаголом, не-глагол — не-глаголом
    const oVerb = lang === "ru" && (RET.lemmas(o, "ru").some(isVerbLemma) || (isVerbLemma(o) && !L.PERSON_CLASS[o])) && !dictWord(o, "ru")?.noun;
    if (lang === "ru" && !!hit.verb !== !!oVerb) return null;
    // повелительное — только на место повелительного («не евши — хӀама а ца дуаш» не образец для «не уходи»)
    if (lang === "ru" && hit.verb && !!hit.imper !== !!imperative(o)) return null;
    // и время то же: «он жалуется — латкъаш ва из» не образец для «он поел»
    const PASTF = /(л|ла|ло|ли|лся|лась|лось|лись)$/;
    if (lang === "ru" && hit.verb && PASTF.test(o) !== PASTF.test(n)) return null;
    // глагол встаёт только на место глагола: не на место местоимения или связки («Со гӀоргвац» —
    // «пойду» не «со»); и не в отрицании — там глагол слит с «не» («гӀоргвац», «хац»), простая форма его потеряет
    if (lang === "ru" && hit.verb && (INH_PRON.has(ex.b[e]) || COP.has(ex.b[e]) || ex.a.includes("не"))) return null;
    // будущее и формы с классом согласуются с предложением — их собирает sentence(), а не образец
    if (lang === "ru" && hit.verb && (hit.fut || hit.byClass)) return null;
    // глагол на месте причастия со связкой («я учусь — со дешаш ва»): связка относится к причастию — не образец
    if (lang === "ru" && hit.verb && (COP.has(ex.b[e + 1]) || COP.has(ex.b[e - 1]))) return null;
    // переходность глагола (по парам разговорника) — как у образца: «он сказал — цо аьлар» (эргатив) не образец
    // для «он ушёл» (справочник, раздел 5: эргатив — только у переходного действия)
    if (lang === "ru" && hit.verb) {
      const tr = transOf(hit.ingForms || [hit.to]);
      const pc = ex.b.map((t) => INH_PRON_CASE.get(t)).find(Boolean);
      if (pc && ((pc.case === "erg" && tr === false) || (pc.case === "nom" && tr === true))) return null;
      // «знаю, вижу, люблю» — кто знает, в дательном («Сона хов»): образец с другим падежом не годится
      if (hit.dat && (!pc || pc.case !== "dat")) return null;
    }
          out[e] = low(hit.to);
    // ингушский → русский: новое слово — в падеже старого («Ишколе вода со» — иду в школу → «Балха вода
    // со» — иду на работу), предлог «в / на» — по новому месту
    if (lang === "inh" && !tune.noRuCases) {
      const oldLem = (RET.lemmas(ex.b[e], "ru") || []).find((l) => D.gender(l)) || null;
      const newLem = PLACE_INH.get(n) || low(hit.to);
      const kase = oldLem && oldLem !== ex.b[e] ? ["acc", "dat", "gen", "ins", "prep"].find((c) => D.noun(oldLem, c) === ex.b[e]) : null;
      // новое слово — в косвенном падеже («москвы» — из «Москвера»), старое — в именительном («Со турист ва»
      // — я турист): предлога в образце нет, «Я москвы» — не перевод
      const f = kase && isRuNoun(newLem) || (kase && PLACE_INH.has(n)) ? D.noun(newLem, kase, { loc2: /^(в|на)$/.test(out[e - 1] || "") }) : null;
      const newL = !f && (RET.lemmas(low(hit.to), "ru") || []).find((l) => l !== low(hit.to) && D.gender(l));
      if (newL && ["gen", "dat", "ins", "prep"].some((c) => D.noun(newL, c) === low(hit.to))) return null;
      if (f) { out[e] = f; if (/^(в|во|на)$/.test(out[e - 1] || "")) out[e - 1] = PLACE_ON.has(newLem) ? "на" : D.prep("в", f); }
      // прилагательное перед новым словом — в его роде: «Сайре дика хийла хьа» (добрый вечер) → «Ӏуйре дика
      // хийла хьа» — доброе утро (справочник). Только именительный: слово стоит в начальной форме.
      const prevA = out[e - 1] || "", g = out[e] === newLem && isRuNoun(newLem) ? D.gender(newLem) : null;
      if (g && /(ый|ий|ой)$/.test(prevA) && prevA.length > 3 && !/(щий|вший)$/.test(prevA) && (!oldLem || oldLem === ex.b[e]) && D.gender(ex.b[e]) !== g) { const af = D.adj(prevA, g, "nom"); if (af) out[e - 1] = af; }
    }
    // местоимение — в том же падеже, что в образце: «Как его зовут? — Фуй цун цӀи?» → «Как тебя зовут?» — «хьа»
    if (lang === "ru" && hit.pron && INH_PRON_CASE.has(ex.b[e])) { const f = (L.PRONOUNS[hit.pron] || {})[INH_PRON_CASE.get(ex.b[e]).case]; if (f) out[e] = low(f); }
    // «четыре» — по классу следующего существительного (PaydaDosh: «виъ новкъост», «биъ Ӏаж»)
    if (lang === "ru" && L.NUMBER_CLASS[n] && ws[k + 1]) { const c = clsOfRu(ws[k + 1]); if (c && L.NUMBER_CLASS[n][c]) out[e] = L.NUMBER_CLASS[n][c]; }
    if (lang === "ru") {
      let co = clsOfRu(o) || (L.RU_PRONOUN_FORMS[o] && (L.PRONOUNS[L.RU_PRONOUN_FORMS[o][0]] || {}).cls) || null;
      const cn = hit.cls || clsOfRu(n);
      // «я дома — со цӀагӀа ва»: у «я, ты» класс — по полу, его показывает связка образца; «мы дома» — «да»
      if (!co && cn && L.RU_PRONOUN_FORMS[o]) { const c = out.map((t) => COP_ALL.map((set) => set[t]).find(Boolean)).find(Boolean); if (c) co = c; }
      // класс нового слова неизвестен, а в образце прилагательное с показателем класса старого слова
      // («большое село — йоккха юрт» не образец для «большое спасибо»): согласовать нечем — образец не берём
      if (co && !cn && out.some((t, j) => j !== e && adjClassGroup(t))) return null;
      if (co && cn && co !== cn) for (let j = 0; j < out.length; j++) {
        for (const set of COP_ALL) if (set[out[j]] === co) { const f = Object.entries(set).find(([, c]) => c === cn); if (f) out[j] = f[0]; }
        // прилагательное с классным показателем — тоже («большой мальчик — воккха кӀаьнк» → «большой дом — доккха цӀа»)
        const g = j !== e && adjClassGroup(out[j]);
        if (g && low(g[co] || "") === out[j] && g[cn]) out[j] = low(g[cn]);
      }
    }
    return { e, pe, sc: pe + (lang === "ru" && posRu(o) === posRu(n) ? 1 : 0) };
  }

  function analog(raw, src, opts) {
    if (!ALIGN || opts.noAnalog) return null;
    const lang = src === "inh" ? "inh" : "ru";
    const ws = tk(raw);
    if (ws.length < (tune.minLen || (lang === "ru" ? 2 : 3)) || ws.length > 8) return null;
    let bestR = null, bestS = 0, bestEx = null;
    const lm = lmOf(lang);
    for (let k = 0; k < ws.length; k++) {
      // «не» — не слово для замены: в ингушском отрицание стоит при глаголе («ца», «вац», «хац»), а не на месте
      // другого слова: «Мне очень нравится» не образец для «Мне не нравится» («Сона хоза хет ца»)
      if (ws[k] === "не") continue;
      const key = ws.map((w, n) => (n === k ? "*" : w)).join(" ");
      for (const ex of EX[lang].get(key) || []) {
        if (ex.a[k] === "не") continue; // и наоборот: «не» образца не заменяем другим словом
        const out = ex.b.slice();
        const r = subst(ex, k, ws, opts, lang, out);
        if (!r) continue;
        const e = r.e;
        if (new Set(out).size < out.length) continue; // «Мича вода вода» — замена не туда
        // «а» в начале русского перевода образца («Хьо мичахьара ва? — А ты откуда?») — из диалога, во входной фразе его нет
        if (lang === "inh" && out[0] === "а" && ws[0] !== "а") continue;
        // при прочих равных — образец, где заменённое слово той же части речи (существительное на месте
        // существительного: «где магазин — тика мичахьа я» лучше, чем «где это — мичад из»)
        if (!(r.sc > 0)) continue;
        const sc = r.sc + (lm && LM_W ? LM_W * lm.score(out) : 0);
        if (bestR === null || sc > bestS) { bestS = sc; bestR = out.map((t, j) => (lang === "inh" && j !== e && ex.names && ex.names.has(t) && t === ex.b[j] ? t[0].toUpperCase() + t.slice(1) : t)).join(" "); bestEx = ex.a.join(" ") + " — " + ex.b.join(" "); }
      }
    }
    // палочка — всегда Ӏ (справочник, раздел 1); слова образца разобраны в нижнем регистре (ӏ)
    if (bestR) bestR = bestR.replace(/ӏ/g, "Ӏ");
    // «Из студент я» — она: «из» со связкой или глаголом класса й (справочник, раздел 4), как в inhPost
    if (bestR && lang === "inh" && ws.includes("из") && ws.some((w) => (COP_INFO.get(w) || {}).cls === "й") && !ws.some((w) => (COP_INFO.get(w) || {}).cls && (COP_INFO.get(w) || {}).cls !== "й")) bestR = bestR.replace(/(^|\s)он(?=\s|$)/, "$1она");
    return bestR ? { text: bestR, pieces: [{ from: ws.join(" "), to: bestR, how: "analog", like: bestEx }], known: ws.length, total: ws.length } : null;
  }

  // Конструкции с несколькими местами (шаблоны предложений). Из пар разговорника автоматически выписываются
  // образцы, где 2–3 слова можно заменить: слово с местом — то, которое таблица слов (ALIGN) связывает ровно
  // с одним ингушским словом в обе стороны («куда — мича», «отвезти — дӀадига», «еду — даар»). Так фраза
  // «Куда отвезти еду? — Мича даар дӀадига?» становится конструкцией «[куда] [отвезти] [еду] — [куда] [еду]
  // [отвезти]»: порядок слов и неизменные слова — из перевода носителя, а слова на местах переводятся по
  // одному теми же средствами, что в analog(): тип места (часть речи, глагол — время, повелительное,
  // переходность; местоимение — падеж; существительное — класс со связкой и прилагательными; число — класс)
  // проверяется так же. Чем больше пар разговорника дают одну и ту же конструкцию (ингушская часть совпадает
  // вне мест), тем она надёжнее. Сначала — самые конкретные (одно место — analog(), потом два, потом три);
  // если ни одна не подходит — перевод по словам (sentence()).
  let CONS_ = null;
  function consIndex() {
    if (CONS_) return CONS_;
    CONS_ = { ru: new Map(), inh: new Map() };
    const seen = new Set();
    for (const [ru, inh] of EXAMPLES || []) {
      const r = tk(ru), i = tk(inh);
      if (r.length < 3 || r.length > 8 || i.length < 2 || i.length > 10 || /…|\.\.\./.test(ru)) continue;
      const names = new Set((String(ru).split(" — ")[0].match(/(?<=[а-яёА-ЯЁ,]\s+)[А-ЯЁ][а-яё]+/g) || []).map(low));
      for (const [lang, a, b] of [["ru", r, i], ["inh", i, r]]) {
        if (a.length < 3 || a.length > 8) continue;
        const id = lang + a.join(" ") + "|" + b.join(" ");
        if (seen.has(id)) continue;
        seen.add(id);
        // места: слово связано с одним словом перевода в обе стороны
        const slot = [], used = new Set();
        a.forEach((w, k) => {
          if (w === "не" || RU_SKIP.has(w)) return;
          let e = -1, pe = 0;
          b.forEach((t, j) => { const q = ALIGN.prob(w, t, lang); if (q > pe) { pe = q; e = j; } });
          if (e < 0 || pe < (tune.ap || (lang === "ru" ? 0.3 : 0.5))) return;
          const back = ALIGN.best(b[e], lang === "ru" ? "inh" : "ru");
          if (!back || back.to !== w) return;
          if (used.has(e)) return; // два слова на одно ингушское — не места
          used.add(e); slot.push(k);
        });
        const maxS = Math.min(tune.consSlots || 2, a.length - 1);
        const add = (ks) => {
          const key = a.map((w, n) => (ks.includes(n) ? "*" : w)).join(" ");
          let l = CONS_[lang].get(key); if (!l) CONS_[lang].set(key, (l = []));
          if (l.length < 20) l.push({ a, b, ks, names, q: /\?/.test(ru + inh) });
        };
        for (let x = 0; x < slot.length; x++) for (let y = x + 1; y < slot.length; y++) {
          if (maxS >= 2) add([slot[x], slot[y]]);
          if (maxS >= 3 && a.length >= 5) for (let z = y + 1; z < slot.length; z++) add([slot[x], slot[y], slot[z]]);
        }
      }
    }
    return CONS_;
  }
  const combos = (n, s) => { const out = []; const go = (from, acc) => { if (acc.length === s) { out.push(acc.slice()); return; } for (let i = from; i < n; i++) { acc.push(i); go(i + 1, acc); acc.pop(); } }; go(0, []); return out; };
  // Тип места: слово образца и новое слово должны быть одного рода, иначе рамка не подходит.
  //   ru: вопросительное слово — только обстоятельство на место обстоятельства (где, куда, когда…: «какой» →
  //   «сколько» меняет строй фразы); существительное — в том же падеже («ночь на субботу» не образец для «ключ
  //   на столе»); и пословный перевод старого слова в этом месте даёт ровно слово перевода образца — значит,
  //   тем же способом переведённое новое слово встанет в нужной форме.
  //   inh: глагол на месте не меняется (время, лицо и класс в русском переводе так не согласовать); проверка
  //   пословного перевода старого слова — та же.
  const ADV_Q = new Set(["где", "куда", "когда", "откуда", "почему", "зачем"]);
  const RU_CASES = ["nom", "acc", "gen", "dat", "ins", "prep"];
  const casesRu = (w) => { const s = new Set(); for (const l of (RET.lemmas(w, "ru").length ? RET.lemmas(w, "ru") : [w])) if (D.gender(l)) for (const c of RU_CASES) if (D.noun(l, c) === w) s.add(c); return s; };
  const inhIsVerb = (w) => INH_FIN.has(w) || INH_VERB.has(w) || !!IV.analyze(w);
  function consSlotOk(ex, k, ws, lang, opts) {
    const o = ex.a[k], n = ws[k];
    if (lang === "ru") {
      const po = posRu(o), pn = posRu(n);
      if (po === "q" || pn === "q") return ADV_Q.has(o) && ADV_Q.has(n);
      const co = casesRu(o), cn = casesRu(n);
      if (co.size && cn.size && ![...co].some((c) => cn.has(c))) return false;
      const h = ruWord(o, ex.a[k + 1], { afterVerb: k > 0, first: ex.a.slice(0, k).every((x) => x === "не" || RU_SKIP.has(x)), question: !!opts.question, afterNum: k > 0 && !!L.NUMBERS[ex.a[k - 1]] });
      return !!tune.consNoRT || (!!(h && h.to) && ex.b.includes(low(h.to)));
    }
    if (inhIsVerb(o) || inhIsVerb(n)) return false;
    const h = inhWord(o, k === ex.a.length - 1, k === 0, ex.a[k + 1]);
    if (!(h && h.to) || !ex.b.includes(low(h.to))) return false;
    // и по русскому переводу: глагол или причастие («хьаийцад — взял», «ийцай — взятый»)
    const ruV = (x) => low(x).split(/\s+/).some((t) => isVerbLemma(t) || RET.lemmas(t, "ru").some(isVerbLemma));
    const hn = inhWord(n, k === ws.length - 1, k === 0, ws[k + 1]);
    return !ruV(h.to) && !(hn && hn.to && ruV(hn.to));
  }
  function construction(raw, src, opts) {
    if (!ALIGN || !EXAMPLES || opts.noAnalog || tune.noCons) return null;
    const lang = src === "inh" ? "inh" : "ru";
    const ws = tk(raw);
    if (ws.length < 3 || ws.length > 8) return null;
    const idx = consIndex()[lang];
    // ингушская часть образца вне мест — «рамка» конструкции
    const frameOf = (ex) => ex.b.map((t) => (ex.ks.some((k) => ALIGN.prob(ex.a[k], t, lang) >= 0.3) ? "*" : t)).join(" ");
    // tune.consStats — для замеров: до какой проверки дошла фраза (scripts/eval-chunks.js --cons-stats)
    let stage = 0;
    const STAGES = ["none", "key", "q", "slot", "subst", "sup", "ok"];
    const reach = (n) => { if (n > stage) stage = n; };
    const done = (r) => { if (tune.consStats) tune.consStats[STAGES[stage]] = (tune.consStats[STAGES[stage]] || 0) + 1; return r; };
    for (let s = 2; s <= Math.min(tune.consSlots || 2, ws.length - 1); s++) {
      let best = null;
      for (const ks of combos(ws.length, s)) {
        const key = ws.map((w, n) => (ks.includes(n) ? "*" : w)).join(" ");
        const list = idx.get(key);
        if (!list) continue;
        reach(1);
        // сколько пар дают одну и ту же конструкцию (рамки совпадают)
        const frames = new Map();
        for (const ex of list) { const f = frameOf(ex); frames.set(f, (frames.get(f) || 0) + 1); }
        for (const ex of list) {
          if (ex.q !== !!opts.question) continue; // вопрос — по образцу вопроса, утверждение — утверждения
          reach(2);
          if (!ks.every((k) => consSlotOk(ex, k, ws, lang, opts))) continue;
          reach(3);
          const out = ex.b.slice(), es = [];
          let sc = 0, ok = true;
          for (const k of ks) {
            const r = subst(ex, k, ws, opts, lang, out);
            if (!r || es.includes(r.e)) { ok = false; break; }
            es.push(r.e); sc += r.sc;
          }
          if (!ok) continue;
          if (new Set(out).size < out.length) continue;
          if (lang === "inh" && out[0] === "а" && ws[0] !== "а") continue;
          reach(4);
          const support = frames.get(frameOf(ex)) || 1;
          if (support < (tune.consMinSup || 2) && ws.length - s < (tune.consFixed || 2)) continue; // конструкция из одного образца — только с двумя и больше неизменными словами
          reach(5);
          sc = sc / s + (tune.consSupW ?? 0.2) * Math.log2(support);
          const lm = lmOf(lang);
          if (lm && LM_W) sc += LM_W * lm.score(out);
          if (!best || sc > best.sc) best = { sc, out, es, ex, support };
        }
      }
      if (best) {
        const { out, es, ex } = best;
        let text = out.map((t, j) => (lang === "inh" && !es.includes(j) && ex.names && ex.names.has(t) && t === ex.b[j] ? t[0].toUpperCase() + t.slice(1) : t)).join(" ").replace(/ӏ/g, "Ӏ");
        if (lang === "inh" && ws.includes("из") && ws.some((w) => (COP_INFO.get(w) || {}).cls === "й") && !ws.some((w) => (COP_INFO.get(w) || {}).cls && (COP_INFO.get(w) || {}).cls !== "й")) text = text.replace(/(^|\s)он(?=\s|$)/, "$1она");
        reach(6);
        return done({ text, pieces: [{ from: ws.join(" "), to: text, how: "construction", like: ex.a.join(" ") + " — " + ex.b.join(" "), slots: ex.ks.length, support: best.support }], known: ws.length, total: ws.length });
      }
    }
    return done(null);
  }

  // «Передай привет маме» — по фразе разговорника «Передай привет семье — ЦӀагӀарчарга салам-моаршал лелахь»
  // (PaydaDosh; и «Мои приветы и пожелания родным — Салам-моаршал ле цӀагӀарчарга»): кому — направительный
  // падеж (-га), как в образце. Форма — только известная (местоимение или модуль падежей / пары фраз).
  function greeting(raw, src) {
    if (src !== "ru") return null;
    const ws = tk(raw);
    if (ws.length !== 3 || ws[0] !== "передай" || !ws.includes("привет")) return null;
    const n = ws[1] === "привет" ? ws[2] : ws[1];
    let f = null;
    const pf = L.RU_PRONOUN_FORMS[n];
    if (pf && pf[1] === "dat") f = (L.PRONOUNS[pf[0]] || {}).all || null;
    else if (!pf) for (const l of RET.lemmas(n, "ru")) { const b = l !== n && nounBase(l); f = b && allOf(l, b, n); if (f) break; }
    if (!f) return null;
    const text = (f + " салам-моаршал лелахь").replace(/ӏ/g, "Ӏ");
    return { text, pieces: [{ from: ws.join(" "), to: text, how: "template", like: "передай привет семье — цӏагӏарчарга салам-моаршал лелахь" }], known: 3, total: 3 };
  }

  // Перевод по образцу (analog, construction) или по словам (sentence): все варианты собраны правилами и
  // таблицами, языковая модель (lib/rules/lm.js) только выбирает. Образцу — надбавка (tune.lmPrior): он
  // взят из настоящей фразы носителя, поэтому по словам выбирается, только если он заметно лучше по модели.
  function pickLM(raw, src, o2) {
    const a = analog(raw, src, o2) || construction(raw, src, o2);
    const lm = lmOf(src === "inh" ? "inh" : "ru");
    if (!a || !lm) return a || sentence(raw, src, o2);
    const w = sentence(raw, src, o2);
    if (!w || !w.text || w.known < w.total) return a;
    return lm.score(w.text) > lm.score(a.text) + LM_PRIOR ? { ...w, lmPick: true } : a;
  }

  // Весь текст. null — если почти ничего не известно (меньше половины слов).
  function translate(text, src, opts = {}) {
    if (src !== "ru" && src !== "inh") return null;
    const parts = String(text).match(/[^.!?…\n]+[.!?…]*/g) || [];
    const done = [];
    let known = 0, total = 0;
    const pieces = [];
    for (const raw of parts) {
      // и без знака вопроса, если предложение начинается с вопросительного слова («Как дела», «Где ты»)
      const w0 = low((String(raw).match(/[а-яёА-ЯЁӀӏ]+/) || [""])[0]);
      const o2 = { ...opts, question: /\?\s*$/.test(raw) || (src === "ru" && !/[.!]\s*$/.test(raw) && !!L.QUESTION_WORDS[w0] && w0 !== "как" && !/,/.test(raw)) };
      const s = phrasebookWhole(raw, src, opts) || template(raw, src, opts) || (!opts.noWhole && greeting(raw, src)) || pickLM(raw, src, o2);
      if (!s.text) continue;
      known += s.known; total += s.total;
      pieces.push(...s.pieces);
      const end = (/[.!?…]+\s*$/.exec(raw) || [""])[0].trim();
      done.push(s.text[0].toUpperCase() + s.text.slice(1) + end);
    }
    // хотя бы одно известное слово — собираем перевод; имена и заимствования остаются как есть
    if (!total || !known || (known / total < 0.5 && !pieces.some((p) => p.how === "name" || p.how === "loan"))) return null;
    return { translation: done.join(" "), pieces, known, total };
  }

  // Одно ингушское слово, которое есть в библиотеке слов (форма глагола или местоимение): «вода» → «идёт (о мужчине)».
  function inhLexicon(text) {
    const w = low(String(text).trim());
    if (!/^[а-яӏ]+$/.test(w)) return null;
    const iv = INH_VERB.get(w);
    if (iv) {
      const ru = iv.tense === "past" ? (iv.v.ru.past || [])[iv.cls === "й" ? 1 : 0] : (iv.v.ru.pres || [])[2];
      const who = { в: "о мужчине", й: "о женщине", д: "класс д", б: "класс б" }[iv.cls];
      if (ru) return { translation: ru, note: who ? `Форма глагола «${iv.v.id}»: ${who}.` : `Форма глагола «${iv.v.id}».` };
    }
    if (INH_PRON.has(w)) return { translation: INH_PRON.get(w), note: "Местоимение (справочник, раздел 3)." };
    return null;
  }

  // для отладки: очки всех значений слова (scripts, тесты)
  const explainSense = (w) => { const r = RET.lookupWord(low(w), "ru", 6); const dbg = []; if (r) SENSE.pick(low(w), senseCands(low(w), r, () => true), dbg); return dbg; };
  return { translate, sentence, firstSense, inhLexicon, explainSense };
};
module.exports.firstSense = firstSense;
