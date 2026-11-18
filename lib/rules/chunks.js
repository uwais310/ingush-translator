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

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const MAX_SPAN = 6;
// русские предлоги: в ингушском их роль играют окончания и послелоги
const RU_PREPS = new Set(["в", "во", "на", "к", "ко", "с", "со", "из", "от", "до", "по", "за", "о", "об", "обо", "у", "при", "под", "над", "про", "для", "без", "через", "перед"]);
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
  // ALIGN — таблица слов, выученная из пар фраз (lib/rules/align.js): форма слова в контексте («маме» — «нанна»)
  const AL_N = tune.n || 2, AL_P = tune.p || 0.3, AL_MODE = tune.mode === undefined ? 1 : tune.mode;
  function aligned(w, lang, isVerb) {
    if (!ALIGN || !AL_MODE || (isVerb && AL_MODE < 2)) return null;
    const b = ALIGN.best(w, lang);
    // слово, которое «переводится» само в себя («маме» — «маме»), — ошибка пары, а не перевод
    return b && b.n >= AL_N && b.p >= AL_P && b.to !== low(w) ? b.to : null;
  }
  const RU_POSS = L.POSSESSIVES, RU_POSS_INV = L.POSSESSIVE_INVARIABLE;
  const VERB_FORMS = new Map();
  for (const v of L.VERBS) {
    (v.ru.pres || []).forEach((f, n) => VERB_FORMS.set(f, { v, tense: "pres", person: (n % 3) + 1 }));
    (v.ru.past || []).forEach((f) => VERB_FORMS.has(f) || VERB_FORMS.set(f, { v, tense: "past" }));
    (v.ru.inf || []).forEach((f) => VERB_FORMS.has(f) || VERB_FORMS.set(f, { v, tense: "inf" }));
  }
  const isVerbLemma = (l) => /(ть|ться|ти|чь|чься)$/.test(l);
  const VERBISH = /(ю|у|ешь|ишь|ет|ит|ем|им|ете|ите|ут|ют|ат|ят|л|ла|ло|ли|ся|сь)$/;

  // Кусок из нескольких слов целиком: «доброе утро», «как дела».
  function phrase(words, lang) {
    const r = RET.lookupWord(words.join(" "), lang, 3);
    if (!r || r.lemma) return null;
    const it = r.items.find((x) => x.prio <= PHRASE_PRIO);
    if (!it) return null;
    const to = firstSense(lang === "ru" ? it.inh : it.ru);
    return to ? { to, how: "phrase", src: it.name } : null;
  }

  // Одно слово из словаря (или по начальной форме).
  function dictWord(w, lang) {
    const r = RET.lookupWord(w, lang, 6);
    if (!r) return null;
    const it = r.items.find((x) => x.prio <= WORD_PRIO);
    if (!it) return null;
    const line = String(it.line || it.inh);
    const to = firstSense(lang === "ru" ? it.inh : it.ru);
    if (!to || /[a-z]/i.test(to) || /^(прош|наст|мн)\./.test(to)) return null;
    const cm = /\(\s*([вйдб])\s*[\/,-]/.exec(line);
    // у существительного в словаре есть класс: «нана (й/б; мн. ноаной)», «да (в/б…)»
    const noun = /\(\s*[вйдб]\s*[\/,-]/.test(String(it.line || it.inh)) || /^[вйдб](\s*[-,/]\s*[вйдб])?$/.test(String((it.seed && it.seed.note) || "").trim());
    return { to, how: r.lemma ? "lemma" : "word", lemma: r.lemma || "", src: it.name, noun, dictCls: cm ? cm[1] : null, line };
  }

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

  // Русское слово → { to, how, verb?, dat?, pron? } или null.
  const RU_WAS = { "был": "в", "была": "й", "было": "д", "были": "б" };
  const IMP_IRREGULAR = { "дай": "дать", "дайте": "дать", "возьми": "взять", "возьмите": "взять", "ешь": "есть", "ешьте": "есть", "пей": "пить", "пейте": "пить",
    "иди": "идти", "идите": "идти", "сядь": "сесть", "сядьте": "сесть", "встань": "встать", "вставай": "вставать", "давай": "давать", "ляг": "лечь", "лягте": "лечь", "лей": "лить" };
  const IMP_END = /(и|ите|ай|айте|яй|яйте|ей|ейте|ой|ойте|уй|уйте|ь|ьте)$/;
  function imperative(w) {
    if (!IMP_END.test(w) && !IMP_IRREGULAR[w]) return null;
    if (/л[аои]?$/.test(w) || isVerbLemma(w) || L.RU_PRONOUN_FORMS[w] || L.QUESTION_WORDS[w]) return null;
    const own = RET.lookupWord(w, "ru", 3);
    if (own && !own.lemma) {
      const it = own.items.find((x) => x.prio <= 1);
      const to = it && firstSense(it.inh);
      if (to && !/^(прош|наст|мн)\./.test(to)) return { to, how: "word", verb: true, inf: false, imper: true };
    }
    const lemmas = IMP_IRREGULAR[w] ? [IMP_IRREGULAR[w]] : RET.lemmas(w, "ru").filter(isVerbLemma);
    for (const l of lemmas) {
      const r = RET.lookupWord(l, "ru", 3);
      const it = r && !r.lemma && r.items.find((x) => x.prio <= 1);
      const vf = it && verbForms(it.line || it.inh).inf;
      const to = typeof vf === "string" ? vf : vf ? vf.в || vf.д || Object.values(vf)[0] : "";
      if (to && !/^(прош|наст|мн)\./.test(to)) return { to, how: "lemma", lemma: l, verb: true, inf: false, imper: true, byClass: vf && typeof vf === "object" ? vf : null };
    }
    return lemmas.length ? false : null; // false — повелительное, но формы не знаем: лучше [скобки], чем чужое слово
  }
  function ruWord(w, next, ctx = {}) {
    if (w === "не") return { to: "ца", how: "neg" };
    if (RU_WAS[w]) return { to: "", how: "was", known: true };
    if (L.QUESTION_WORDS[w] && w !== "что" && w !== "как") return { to: L.QUESTION_WORDS[w], how: "lexicon" };
    if (L.RU_PRONOUN_FORMS[w]) {
      const [p, c] = L.RU_PRONOUN_FORMS[w];
      // «его, её, их» перед существительным — «чей»: родительный (цун, цар)
      if (RU_POSS_INV[w] && next && !VERB_FORMS.has(next) && !L.RU_PRONOUN_FORMS[next]) return { to: L.PRONOUNS[RU_POSS_INV[w]].gen, how: "lexicon" };
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
    if (L.NUMBERS && L.NUMBERS[w]) return { to: typeof L.NUMBERS[w] === "string" ? L.NUMBERS[w] : Object.values(L.NUMBERS[w])[0], how: "lexicon" };
    const vf = VERB_FORMS.get(w);
    if (vf) {
      const v = vf.v;
      const form = vf.tense === "past" ? v.past : vf.tense === "pres" ? v.pres : null;
      // форма, которая не зависит от класса («хов», «гу»), — сразу; иначе — словарная форма ниже
      const inf = typeof v.inf === "string" ? v.inf : "";
      if (typeof form === "string") return { to: form, how: "lexicon", verb: true, dat: v.type === "dat" };
      // форма по классу («вода / йода»): класс выберем по подлежащему, иначе — словарная форма
      if (form && typeof form === "object" && v.type !== "dat" && v.type !== "erg") return { to: inf || Object.values(form)[0], how: inf ? "lemma" : "lexicon", verb: true, byClass: form, person: vf.person };
      // «люблю»: класс — по тому, кого любят (справочник: «Сона хьо еза» о женщине, «веза» о мужчине)
      if (form && typeof form === "object" && v.type === "dat") return { to: inf || form.д || Object.values(form)[0], how: inf ? "lemma" : "lexicon", verb: true, dat: true, byClass: form, byObject: true };
      if (inf) return { to: inf, how: "lemma", verb: true, dat: v.type === "dat" };
    }
    // повелительное наклонение («отвези», «приходи», «сделай»): в ингушском это словарная форма глагола
    // (справочник, раздел 7: «Ма де!» — не делай, «Хабар ма дувца!» — не болтай; де, дувца — словарные формы).
    // Если у самой формы есть запись в словаре («дай — хьа», «возьми — хӀа», PaydaDosh) — берём её.
    // повелительное обычно в начале: «Купи хлеб», «Не уходи», «Пожалуйста, подожди» («чай» в «пей чай» — не глагол)
    const imp = ctx.first ? imperative(w) : null;
    if (imp) return imp;
    if (imp === false) return null;
    // после глагола «еду», «воду» — скорее существительное (еда, вода), чем «ехать», «водить»
    const exact = RET.lookupWord(w, "ru", 1);
    if (ctx.afterVerb && !(exact && !exact.lemma) && RET.lemmas(w, "ru").some(isVerbLemma)) {
      for (const l of RET.lemmas(w, "ru")) {
        if (isVerbLemma(l)) continue;
        const n = dictWord(l, "ru");
        if (n && !n.presOnly) { n.how = "lemma"; n.lemma = l; return n; }
      }
    }
    const d = dictWord(w, "ru");
    if (!d) { const a0 = aligned(w, "ru", false); return a0 ? { to: a0, how: "align" } : null; }
    const lemma = d.lemma ? low(d.lemma) : w;
    // глагол: время по русской форме, ингушская форма — из строки словаря (наст., прош.)
    const PAST = /(л|ла|ло|ли|лся|лась|лось|лись)$/;
    let vLemma = null;
    if (!d.noun && !L.PERSON_CLASS[lemma] && isVerbLemma(lemma) && (lemma === w || VERBISH.test(w) || /ст$/.test(w))) vLemma = lemma;
    else if (!d.noun && !isVerbLemma(w) && (VERBISH.test(w) || /ст$/.test(w))) vLemma = RET.lemmas(w, "ru").find(isVerbLemma) || null;
    if (vLemma) {
      const tense = vLemma === w ? "inf" : PAST.test(w) ? "past" : "pres";
      if (tense === "past" && OPEN_PAST.has(vLemma)) return null;
      const r = RET.lookupWord(vLemma, "ru", 3);
      const it = r && !r.lemma && r.items.find((x) => x.prio <= 1);
      const forms = it ? verbForms(it.line || it.inh) : {};
      const form = forms[tense] || (tense !== "inf" ? null : forms.inf);
      const base = { how: form ? "lexicon" : "lemma", lemma: vLemma, verb: true, inf: tense === "inf", tense, refl: /(ся|сь)$/.test(vLemma), src: it ? it.name : d.src };
      const alv = aligned(w, "ru", true);
      if (alv) return { ...base, to: alv, how: "align" };
      if (typeof form === "string") return { ...base, to: form };
      if (form) return { ...base, to: form.в || form.д || Object.values(form)[0], byClass: form, person: 3 };
      // нужной формы в словаре нет — словарная форма (инфинитив), как раньше
      const inf = typeof forms.inf === "string" ? forms.inf : forms.inf ? forms.inf.в || Object.values(forms.inf)[0] : d.to;
      return { ...base, to: inf, how: "lemma" };
    }
    const al = aligned(w, "ru", false);
    if (al && al !== low(d.to)) { d.dictTo = d.to; d.to = al; d.how = "align"; }
    if (!d.verb && L.PERSON_CLASS[lemma]) d.cls = L.PERSON_CLASS[lemma];
    else if (!d.verb && L.ATTESTED_CLASS[lemma]) d.cls = L.ATTESTED_CLASS[lemma][1];
    else if (!d.verb && d.noun && d.dictCls && lemma === w) d.cls = d.dictCls; // класс из словаря — только для начальной формы (им. падеж)
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
  const COP = new Map();
  for (const f of Object.values(L.COPULA.pres)) COP.set(low(f), "");
  for (const f of Object.values(L.COPULA.neg)) COP.set(low(f), "не");
  for (const f of Object.values(L.COPULA.past)) COP.set(low(f), "был");
  for (const f of Object.values(L.COPULA.q)) COP.set(low(f), "ли");
  // ингушские формы глаголов из библиотеки слов → русский глагол (лицо выберем по подлежащему)
  const INH_VERB = new Map();
  for (const v of L.VERBS) {
    const put = (x, tense) => { if (typeof x === "string") INH_VERB.has(low(x)) || INH_VERB.set(low(x), { v, tense, cls: null });
      else if (x && typeof x === "object") for (const [c, f] of Object.entries(x)) INH_VERB.has(low(f)) || INH_VERB.set(low(f), { v, tense, cls: c }); };
    put(v.pres, "pres"); put(v.past, "past");
  }
  const PERSON = { "я": 0, "ты": 1, "он": 2, "мы": 3, "вы": 4, "они": 5 };
  // справочник, раздел 2: хилда, хийла — «пусть будет»
  const INH_EXTRA = { "хилда": "пусть будет", "хийла": "пусть будет" };
  function inhWord(w, last, first, next) {
    if (INH_EXTRA[w]) return { to: INH_EXTRA[w], how: "lexicon" };
    const iv = INH_VERB.get(w);
    if (iv) {
      const ru = iv.tense === "past" ? (iv.v.ru.past || [])[iv.cls === "й" ? 1 : 0] : (iv.v.ru.pres || [])[2];
      if (ru) return { to: ru, how: "lexicon", inhVerb: iv };
    }
    // связка в конце предложения («Са да лор ва»): в русском настоящем времени её нет
    // и перед местоимением в вопросе («Мишта ва хьо?» — как ты?)
    if (!first && COP.has(w) && (last || INH_PRON.has(next))) return { to: COP.get(w), how: "copula" };
    if (INH_PRON.has(w)) return { to: INH_PRON.get(w), how: "lexicon", ruPron: INH_PRON.get(w) };
    const al = aligned(w, "inh", false);
    const d = dictWord(w, "inh");
    if (al && (!d || al !== low(d.to))) return { ...(d || {}), to: al, how: "align" };
    return d;
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
    words: require("../ingush-words.js"), pairs: EXAMPLES || [], baseOf: nounBase, lemmas: (w) => RET.lemmas(w, "ru"),
    corpus: SEED.filter((p) => p && p.kind === "word" && /GhalghayTools/.test(p.source || "")).map((p) => [p.ru, p.inh, p.count || 1]),
  }));
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
        // таблица слов уже дала форму в контексте («сердцу» — «дога»), а не словарную — ей доверяем больше
        if (x.how === "align" && low(x.to) !== base) break;
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
      if (!f) continue;
      x.was = x.to; x.wasHow = x.how; x.to = f; x.how = "case"; x.kase = kase; x.cls = undefined;
      // родительный — перед существительным (справочник, раздел 8: «наьна мотт»)
      if (kase === "gen") { const h = out.findIndex((y) => y.at === x.at - 1); if (h >= 0 && h === k - 1) { out.splice(k, 1); out.splice(h, 0, x); } }
    }
  }

  // Одно предложение: возвращает { text, pieces, known, total }.
  // opts.noWhole — не брать всё предложение одним куском (для замера scripts/eval-chunks.js)
  function sentence(raw, src, opts = {}) {
    const lang = src === "inh" ? "inh" : "ru";
    const orig = String(raw).replace(/[̀́]/g, "").match(/[а-яёА-ЯЁӀӏ]+(?:-[а-яёА-ЯЁӀӏ]+)*/g) || [];
    const words = orig.map(low);
    const out = []; // { from, to, how, verb? }
    let known = 0, total = 0;
    for (let i = 0; i < words.length;) {
      const w = words[i];
      // «у меня есть / нет …» — у кого: направительный падеж (сога, хьога, тхога, шуга), справочник, разделы 3 и 6
      if (lang === "ru" && w === "у" && L.RU_PRONOUN_FORMS[words[i + 1]]) {
        const p = L.RU_PRONOUN_FORMS[words[i + 1]][0];
        const all = L.PRONOUNS[p] && L.PRONOUNS[p].all;
        if (all) { out.push({ from: "у " + words[i + 1], to: all, how: "lexicon", have: true }); known += 2; total += 2; i += 2; continue; }
      }
      if (lang === "ru" && out.some((x) => x.have) && (w === "есть" || w === "нет")) { known++; total++; if (w === "нет") out.push({ from: w, to: "ца", how: "neg" }); i++; continue; }
      if (lang === "ru" && w === "такое" && words[i - 1] === "это") { i++; continue; }
      if (lang === "ru" && (RU_PREPS.has(w) || RU_SKIP.has(w))) { out.push({ from: w, to: "", how: "skip" }); i++; continue; }
      if (lang === "ru" && (w === "и" || w === "или")) { out.push({ from: w, to: "", how: w === "и" ? "and" : "or" }); i++; continue; }
      let hit = null, len = 1;
      for (let n = Math.min(MAX_SPAN, words.length - i); n >= 2 && !hit; n--) {
        if (opts.noWhole && n === words.length) continue;
        let p = phrase(words.slice(i, i + n), lang);
        // «спасибо большое» = «большое спасибо»: два слова в обратном порядке — та же фраза
        if (!p && n === 2) p = phrase([words[i + 1], words[i]], lang);
        if (p) { hit = p; len = n; }
      }
      if (!hit) hit = lang === "ru" ? ruWord(w, words[i + 1], { afterVerb: out.some((x) => x.verb), first: !out.some((x) => x.verb || x.pron || x.have) }) : inhWord(w, i === words.length - 1, i === 0, words[i + 1]);
      // имя собственное (с большой буквы не в начале предложения), которого нет в словаре, — как есть
      if (!hit && i > 0 && /^[А-ЯЁӀ]/.test(orig[i] || "")) hit = { to: orig[i], how: "name" };
      if (hit && hit.verb && hit.inf === undefined) hit.inf = (VERB_FORMS.get(w) || {}).tense === "inf";
      total += len;
      if (hit) { known += len; if (hit.to || hit.how === "copula" || hit.how === "was") out.push({ from: words.slice(i, i + len).join(" "), ...hit, at: len === 1 ? i : -1 }); }
      else out.push({ from: w, to: `[${w}]`, how: "unknown" });
      i += len;
    }

    if (lang === "ru") nounCases(out, words);
    if (lang === "ru") {
      // глаголы знания, желания, видения («знать», «хотеть», «видеть»…) — с дательным: «сона хов»
      const v = out.find((x) => x.verb && x.dat);
      if (v) {
        const subj = out.find((x) => x.pron && x.case === "nom");
        if (subj && L.PRONOUNS[subj.pron].dat) { subj.to = L.PRONOUNS[subj.pron].dat; subj.case = "dat"; }
      }
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
        const obj = out.find((x) => x !== subj && !x.verb && (x.pron ? x.case === "nom" : x.cls));
        if (obj && v.byClass[obj.pron ? obj.cls || "в" : obj.cls]) { v.to = v.byClass[obj.pron ? obj.cls || "в" : obj.cls]; v.how = "lexicon"; }
      }
      for (const v of out.filter((x) => x.byClass && !x.byObject)) {
        const subj = out.find((x) => x.pron && x.case === "nom") || out.find((x) => x.cls && !x.verb);
        let cls = subj ? (subj.pron ? subj.cls || "в" : subj.cls) : null;
        if (!subj && v.person === 3) cls = null;
        if (cls && v.byClass[cls]) { v.to = v.byClass[cls]; v.how = "lexicon"; }
      }
      // нет глагола: «Он мой брат» → «Из са воша ва». Связка по классу подлежащего (справочник, раздел 4):
      // ва, я, да, ба; прошедшее вар, яр…; с «не» — вац, яц…; в вопросе без вопросительного слова — вий, йий…
      // Пол «я/ты» неизвестен — справочник: тогда в. Класс не знаем — связку не ставим.
      const neg = out.find((x) => x.how === "neg");
      const was = out.find((x) => x.how === "was");
      const qWord = out.find((x) => x.how === "lexicon" && Object.values(L.QUESTION_WORDS).includes(x.to));
      if (!out.some((x) => x.verb) && out.filter((x) => x.to && x.how !== "neg").length >= 2) {
        const have = out.some((x) => x.have);
        const subj = have ? out.find((x) => x.cls && !x.have) : out.find((x) => x.pron && x.case === "nom") || out.find((x) => x.cls);
        const cls = subj ? (subj.pron ? subj.cls || "в" : subj.cls) : null;
        // после подлежащего должно быть сказуемое («дом большой»); «старый друг», «мой брат» — просто сочетания слов
        const afterSubj = subj ? out.slice(out.indexOf(subj) + 1).some((x) => x.to && x.how !== "neg" && x.how !== "was") : false;
        const first = out.find((x) => x.to);
        const firstAdj = first && (first.how === "word" || first.how === "lemma") && /(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/.test(first.from) && !(subj && subj.pron);
        if (cls && (afterSubj || qWord || have) && !firstAdj) {
          const set = was ? (neg ? L.COPULA.pastNeg : L.COPULA.past) : neg ? L.COPULA.neg : opts.question && !qWord ? L.COPULA.q : L.COPULA.pres;
          const cop = { from: "", to: set[cls], how: "cop" };
          if (neg) neg.to = "";
          // в вопросе с вопросительным словом связка идёт сразу за ним: «Мичара ва хьо?»
          if (qWord && !neg && !was) out.splice(out.indexOf(qWord) + 1, 0, cop); else out.push(cop);
        }
      }
      // «не» перед глаголом: «ца» (справочник, раздел 7)
      const vNeg = out.find((x) => x.verb);
      if (neg && neg.to && vNeg) { out.splice(out.indexOf(neg), 1); vNeg.to = (vNeg.imper ? "ма " : "ца ") + vNeg.to; } // запрет — ма (справочник, раздел 7)
      // кто делает переходное действие — в эргативе (справочник, раздел 5: аз, Ӏа, цо, оаха, оаша, цар):
      // глагол из словаря, не возвратный, и есть прямое дополнение (существительное не после предлога)
      const tv = out.find((x) => x.verb && x.tense && !x.refl && !x.imper && !x.dat);
      if (tv) {
        const subjP = out.find((x) => x.pron && x.case === "nom" && !x.obj);
        const objN = out.find((x, k) => x !== subjP && !x.verb && !x.pron && (x.noun || x.how === "word" || x.how === "lemma") && (k === 0 || out[k - 1].how !== "skip"));
        if (subjP && objN && L.PRONOUNS[subjP.pron].erg) { subjP.to = L.PRONOUNS[subjP.pron].erg; subjP.case = "erg"; }
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
      // глаголы — в конец предложения (справочник, раздел 8: подлежащее, дополнение, глагол);
      // инфинитив перед спрягаемым глаголом: «Сона ала лов» (я хочу сказать)
      const verbs = out.filter((x) => x.verb);
      if (verbs.length && verbs.length <= 2) {
        const rest = out.filter((x) => !x.verb);
        verbs.sort((a, b) => (b.inf ? 1 : 0) - (a.inf ? 1 : 0));
        out.length = 0; out.push(...rest, ...verbs);
      }
    }
    if (lang === "inh") {
      // «Хьо мича вода?» → «ты … идёшь»: лицо русского глагола — по местоимению-подлежащему
      const subj = out.find((x) => x.ruPron && PERSON[x.ruPron] !== undefined);
      for (const x of out.filter((y) => y.inhVerb && y.inhVerb.tense === "pres")) {
        if (subj && x.inhVerb.v.type !== "dat" && x.inhVerb.v.type !== "erg") x.to = x.inhVerb.v.ru.pres[PERSON[subj.ruPron]] || x.to;
      }
      // «Из кхалсаг я» — связка класса й: «из» здесь «она»
      const cop = out.find((x) => x.how === "copula");
      const iz = out.find((x) => x.ruPron === "он" && x.from === "из");
      if (iz && cop && L.COPULA.pres.й === cop.from) iz.to = "она";
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
    if (!p || !/^(PaydaDosh|Справочник)/.test(p.source || "")) continue;
    const ru = String(p.ru || ""), inh = String(p.inh || "");
    if (ru.split(DOTS).length !== 2 || inh.split(DOTS).length !== 2 || /[()]/.test(inh)) continue;
    const key = (t) => low(t).replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
    const [a, b] = ru.split(DOTS).map(key), [c, d] = inh.split(DOTS).map(key);
    if (!a && !b) continue;
    TEMPLATES.ru.push({ re: new RegExp("^" + esc(a) + (a ? " " : "") + "(.+?)" + (b ? " " : "") + esc(b) + "$"), out: [c, d] });
    if (c || d) TEMPLATES.inh.push({ re: new RegExp("^" + esc(c) + (c ? " " : "") + "(.+?)" + (d ? " " : "") + esc(d) + "$"), out: [a, b] });
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
    for (const [lang, a, b] of [["ru", r, i], ["inh", i, r]]) {
      if (a.length < 2 || a.length > 8) continue;
      a.forEach((_, k) => {
        const key = a.map((w, n) => (n === k ? "*" : w)).join(" ");
        let l = EX[lang].get(key); if (!l) EX[lang].set(key, (l = []));
        if (l.length < 20) l.push({ a, b, k });
      });
    }
  }
  const COP_ALL = Object.values(L.COPULA).map((set) => Object.fromEntries(Object.entries(set).map(([c, f]) => [low(f), c])));
  function clsOfRu(w) {
    for (const l of [w, ...RET.lemmas(w, "ru")]) { if (L.PERSON_CLASS[l]) return L.PERSON_CLASS[l]; if (L.ATTESTED_CLASS[l]) return L.ATTESTED_CLASS[l][1]; }
    return null;
  }
  function analog(raw, src, opts) {
    if (!ALIGN || opts.noAnalog) return null;
    const lang = src === "inh" ? "inh" : "ru";
    const ws = tk(raw);
    if (ws.length < 2 || ws.length > 8) return null;
    let bestR = null, bestS = 0;
    for (let k = 0; k < ws.length; k++) {
      const key = ws.map((w, n) => (n === k ? "*" : w)).join(" ");
      for (const ex of EX[lang].get(key) || []) {
        const o = ex.a[k], n = ws[k];
        if (o === n) continue;
        let e = -1, pe = 0;
        ex.b.forEach((t, j) => { const q = ALIGN.prob(o, t, lang); if (q > pe) { pe = q; e = j; } });
        if (e < 0 || pe < (tune.ap || 0.2)) continue;
        const hit = lang === "ru" ? ruWord(n, ws[k + 1], { afterVerb: k > 0, first: k === 0 }) : inhWord(n, k === ws.length - 1, k === 0, ws[k + 1]);
        if (!hit || !hit.to || /^\[/.test(hit.to)) continue;
        // глагол заменяем только глаголом, не-глагол — не-глаголом
        const oVerb = lang === "ru" && RET.lemmas(o, "ru").some(isVerbLemma) && !dictWord(o, "ru")?.noun;
        if (lang === "ru" && !!hit.verb !== !!oVerb) continue;
        const out = ex.b.slice();
        out[e] = low(hit.to);
        if (lang === "ru") {
          const co = clsOfRu(o), cn = hit.cls || clsOfRu(n);
          if (co && cn && co !== cn) for (let j = 0; j < out.length; j++) for (const set of COP_ALL) if (set[out[j]] === co) { const f = Object.entries(set).find(([, c]) => c === cn); if (f) out[j] = f[0]; }
        }
        if (pe > bestS) { bestS = pe; bestR = out.join(" "); }
      }
    }
    return bestR ? { text: bestR, pieces: [{ from: ws.join(" "), to: bestR, how: "analog" }], known: ws.length, total: ws.length } : null;
  }

  // Весь текст. null — если почти ничего не известно (меньше половины слов).
  function translate(text, src, opts = {}) {
    if (src !== "ru" && src !== "inh") return null;
    const parts = String(text).match(/[^.!?…\n]+[.!?…]*/g) || [];
    const done = [];
    let known = 0, total = 0;
    const pieces = [];
    for (const raw of parts) {
      const s = template(raw, src, opts) || analog(raw, src, opts) || sentence(raw, src, { ...opts, question: /\?\s*$/.test(raw) });
      if (!s.text) continue;
      known += s.known; total += s.total;
      pieces.push(...s.pieces);
      const end = (/[.!?…]+\s*$/.exec(raw) || [""])[0].trim();
      done.push(s.text[0].toUpperCase() + s.text.slice(1) + end);
    }
    if (!total || known / total < 0.5) return null;
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

  return { translate, sentence, firstSense, inhLexicon };
};
module.exports.firstSense = firstSense;
