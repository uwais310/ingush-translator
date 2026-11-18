// Перевод «по кускам» — запасной шаг без ИИ, когда нет готовой фразы и не подошло ни одно правило.
//
// Так работали классические переводчики до ИИ (таблица фраз + словарь + морфология):
//   1. Текст делится на предложения, предложение — на слова.
//   2. Слева направо ищется самый длинный кусок (до 6 слов), который целиком есть в словаре или
//      разговорнике (словарь проекта, PaydaDosh, Викисловарь — без автоматически выровненных текстов).
//   3. Остальное — по одному слову: местоимения, вопросительные и указательные слова — из библиотеки
//      слов (lib/rules/lexicon.js), остальные — из словаря, при необходимости по начальной форме
//      (lib/morph.js: «маму» → «мама»).
//   4. Русские предлоги в ингушском — это падежные окончания и послелоги: отдельно не переводятся.
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

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const MAX_SPAN = 6;
// русские предлоги: в ингушском их роль играют окончания и послелоги
const RU_PREPS = new Set(["в", "во", "на", "к", "ко", "с", "со", "из", "от", "до", "по", "за", "о", "об", "обо", "у", "при", "под", "над", "про", "для", "без", "через", "перед"]);
// частицы, у которых нет отдельного слова в ингушском
const RU_SKIP = new Set(["же", "ли", "бы", "вот", "ведь", "-то"]);
// надёжность записей словаря (retrieval.sourceOf): 0 — словарь проекта, 1 — PaydaDosh, 2 — Викисловарь,
// 3 — Википедия и Викиданные, 4 — PanLex и др.; 5 — выровненные тексты, 6 — translatewiki
const PHRASE_PRIO = 2; // кусок из нескольких слов — только из самых надёжных источников
const WORD_PRIO = 4;

// «цӀа (д/д; мн. цӀенош) / фусам (й/й)» → «цӀа»; «пойти, прийти, посетить» → «пойти»
function firstSense(s) {
  const t = String(s || "").split(" — ")[0].split(" / ")[0].replace(/\([^()]*\)/g, " ").split(/[,;(]|\s\d\)/)[0];
  return t.replace(/~/g, "").replace(/\s+/g, " ").trim();
}

module.exports = function makeChunks({ RET }) {
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
    const to = firstSense(lang === "ru" ? it.inh : it.ru);
    if (!to || /[a-z]/i.test(to)) return null;
    // у существительного в словаре есть класс: «нана (й/б; мн. ноаной)», «да (в/б…)»
    const noun = /\(\s*[вйдб]\s*[\/,-]/.test(String(it.line || it.inh)) || /^[вйдб](\s*[-,/]\s*[вйдб])?$/.test(String((it.seed && it.seed.note) || "").trim());
    return { to, how: r.lemma ? "lemma" : "word", lemma: r.lemma || "", src: it.name, noun };
  }

  // Русское слово → { to, how, verb?, dat?, pron? } или null.
  function ruWord(w, next) {
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
    const d = dictWord(w, "ru");
    if (!d) return null;
    const lemma = d.lemma ? low(d.lemma) : w;
    if (!d.noun && !L.PERSON_CLASS[lemma] && isVerbLemma(lemma) && (lemma === w || VERBISH.test(w))) { d.verb = true; d.inf = lemma === w; }
    if (!d.verb && L.PERSON_CLASS[lemma]) d.cls = L.PERSON_CLASS[lemma];
    else if (!d.verb && L.ATTESTED_CLASS[lemma]) d.cls = L.ATTESTED_CLASS[lemma][1];
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
  function inhWord(w, last) {
    const iv = INH_VERB.get(w);
    if (iv) {
      const ru = iv.tense === "past" ? (iv.v.ru.past || [])[iv.cls === "й" ? 1 : 0] : (iv.v.ru.pres || [])[2];
      if (ru) return { to: ru, how: "lexicon", inhVerb: iv };
    }
    // связка в конце предложения («Са да лор ва»): в русском настоящем времени её нет
    if (last && COP.has(w)) return { to: COP.get(w), how: "copula" };
    if (INH_PRON.has(w)) return { to: INH_PRON.get(w), how: "lexicon", ruPron: INH_PRON.get(w) };
    return dictWord(w, "inh");
  }

  // Одно предложение: возвращает { text, pieces, known, total }.
  // opts.noWhole — не брать всё предложение одним куском (для замера scripts/eval-chunks.js)
  function sentence(raw, src, opts = {}) {
    const lang = src === "inh" ? "inh" : "ru";
    const words = (low(raw).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || []);
    const out = []; // { from, to, how, verb? }
    let known = 0, total = 0;
    for (let i = 0; i < words.length;) {
      const w = words[i];
      if (lang === "ru" && (RU_PREPS.has(w) || RU_SKIP.has(w))) { out.push({ from: w, to: "", how: "skip" }); i++; continue; }
      if (lang === "ru" && (w === "и" || w === "или")) { out.push({ from: w, to: "", how: w === "и" ? "and" : "or" }); i++; continue; }
      let hit = null, len = 1;
      for (let n = Math.min(MAX_SPAN, words.length - i); n >= 2 && !hit; n--) {
        if (opts.noWhole && n === words.length) continue;
        const p = phrase(words.slice(i, i + n), lang);
        if (p) { hit = p; len = n; }
      }
      if (!hit) hit = lang === "ru" ? ruWord(w, words[i + 1]) : inhWord(w, i === words.length - 1);
      if (hit && hit.verb && hit.inf === undefined) hit.inf = (VERB_FORMS.get(w) || {}).tense === "inf";
      total += len;
      if (hit) { known += len; if (hit.to || hit.how === "copula") out.push({ from: words.slice(i, i + len).join(" "), ...hit }); }
      else out.push({ from: w, to: `[${w}]`, how: "unknown" });
      i += len;
    }

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

  // Весь текст. null — если почти ничего не известно (меньше половины слов).
  function translate(text, src, opts = {}) {
    if (src !== "ru" && src !== "inh") return null;
    const parts = String(text).match(/[^.!?…\n]+[.!?…]*/g) || [];
    const done = [];
    let known = 0, total = 0;
    const pieces = [];
    for (const raw of parts) {
      const s = sentence(raw, src, opts);
      if (!s.text) continue;
      known += s.known; total += s.total;
      pieces.push(...s.pieces);
      const end = (/[.!?…]+\s*$/.exec(raw) || [""])[0].trim();
      done.push(s.text[0].toUpperCase() + s.text.slice(1) + end);
    }
    if (!total || known / total < 0.5) return null;
    return { translation: done.join(" "), pieces, known, total };
  }

  return { translate, sentence, firstSense };
};
module.exports.firstSense = firstSense;
