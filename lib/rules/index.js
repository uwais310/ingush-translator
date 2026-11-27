// Перевод по правилам: русское предложение → ингушское без ИИ.
//
//   1. Разбор: каждое русское слово получает пометку — местоимение (и падеж), глагол из библиотеки слов
//      (и время, лицо, род), «не», «есть», «где», слово-состояние, число, указательное, притяжательное
//      или просто слово (существительное или прилагательное — их ищем в словаре).
//   2. Правила (lib/rules/grammar.js) пробуются по очереди; первое подошедшее собирает ингушское предложение.
//   3. Если пол говорящего или собеседника неизвестен («я», «ты»), собираются варианты: для мужчины
//      и для женщины. Если в русском пол виден («я была», «готова»), берётся нужный.
//   4. Проверка: каждое ингушское слово должно быть в словаре, в разговорнике, в справочнике
//      или в списке из 155 000 словоформ настоящих ингушских текстов. Иначе перевода по правилам нет.
//
// translate(text) → { translation, variants: [{ text, note }], rule, ruleName } или null.
// why(text) — то же, но с причиной, если не получилось (для отладки и замера).

const L = require("./lexicon.js");
const { RULES } = require("./grammar.js");

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const noParens = (s) => String(s).replace(/\([^()]*\)/g, " ");
const CLASS_RE = /^[вйдб]$/;

module.exports = function makeRules({ RET, KB, SEED, WORDS }) {
  // ---------- какие ингушские слова считаются настоящими ----------
  let ATTESTED = null;
  function attested() {
    if (ATTESTED) return ATTESTED;
    const set = new Set(String(WORDS || "").split("\n"));
    const add = (s) => { for (const w of low(s).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || []) set.add(w); };
    // rare — формы, которых нет в ингушских текстах: «настоящими» для правил их не считаем
    for (const p of SEED) if (p.source && !p.rare && /^(PaydaDosh|Справочник|Викислов)/.test(p.source)) add(noParens(p.inh));
    for (const [, inh] of KB.GLOSSARY) add(noParens(inh));
    for (const [, inh] of KB.EXAMPLES) add(inh);
    add(KB.GUIDE.replace(/[a-z]/gi, " "));
    // всё, что записано в библиотеке слов, — из источников
    const walk = (x) => { if (typeof x === "string") add(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
    walk(L.PRONOUNS); walk(L.COPULA); walk(L.STATES); walk(L.DESTINATIONS); walk(L.LOCATIONS); walk(L.QUESTION_WORDS);
    walk(L.DEMONSTRATIVES); walk(L.NUMBERS); walk(L.ATTESTED_CLASS); walk(L.ADJECTIVES); walk(L.OWN_BY_PERSON);
    for (const v of L.VERBS) { walk(v.pres); walk(v.past); walk(v.part); walk(v.neg); walk(v.inf); }
    add("ца ший");
    return (ATTESTED = set);
  }

  // ---------- русские формы глаголов ----------
  const VERB_FORMS = new Map();
  for (const v of L.VERBS) {
    const put = (form, info) => { if (!VERB_FORMS.has(form)) VERB_FORMS.set(form, { k: "verb", v, ...info }); };
    (v.ru.pres || []).forEach((f, n) => put(f, { tense: "pres", person: (n % 3) + 1, plural: n >= 3 }));
    (v.ru.past || []).forEach((f, n) => put(f, { tense: "past", fem: n === 1, plural: n === 3 }));
    (v.ru.inf || []).forEach((f) => put(f, { tense: "inf" }));
  }
  const VERB_BY_ID = new Map(L.VERBS.map((v) => [v.id, v]));

  // ---------- разбор русского предложения ----------
  const COP_PAST = { "был": { fem: false }, "была": { fem: true }, "было": { fem: false }, "были": { fem: false, plural: true } };
  function tag(w) {
    if (w === "—") return { k: "dash", w };
    if (w === "не") return { k: "neg", w };
    if (w === "есть") return { k: "est", w };
    if (w === "нет") return { k: "net", w };
    if (w === "у") return { k: "u", w };
    if (w === "в" || w === "во" || w === "на") return { k: "prep", w };
    if (w === "это") return { k: "eto", w };
    if (COP_PAST[w]) return { k: "cop", w, ...COP_PAST[w] };
    if (L.QUESTION_WORDS[w]) return { k: "q", w, inh: L.QUESTION_WORDS[w] };
    if (VERB_FORMS.has(w)) return { ...VERB_FORMS.get(w), w };
    if (L.RU_PRONOUN_FORMS[w]) { const [p, c] = L.RU_PRONOUN_FORMS[w]; return { k: "pron", w, p, case: c }; }
    if (L.STATES[w]) return { k: "state", w, inh: L.STATES[w], fem: L.FEMININE_STATES.has(w) };
    if (L.FUNCTION_WORDS.has(w)) return { k: "x", w };
    if (L.NUMBERS[w]) return { k: "num", w, inh: L.NUMBERS[w] };
    if (L.DEMONSTRATIVES[w]) return { k: "dem", w, inh: L.DEMONSTRATIVES[w] };
    for (const l of [w, ...RET.lemmas(w, "ru")]) {
      if (L.POSSESSIVES[l]) return { k: "poss", w, p: L.POSSESSIVES[l] };
      if (L.DEMONSTRATIVES[l] && l !== "то") return { k: "dem", w, inh: L.DEMONSTRATIVES[l] };
    }
    return { k: "word", w };
  }
  function analyze(text) {
    const s = low(text).replace(/\s[-–—]\s/g, " — ");
    const q = /\?\s*$/.test(s);
    const words = s.match(/[а-я]+(?:-[а-я]+)*|—/g) || [];
    // как слово написано в тексте (с большой буквы — имя: «Меня зовут Увайс»)
    const orig = String(text).replace(/[̀́]/g, "").replace(/\s[-–—]\s/g, " — ").match(/[а-яёА-ЯЁ]+(?:-[а-яёА-ЯЁ]+)*|—/g) || [];
    const tokens = words.map(tag);
    if (orig.length === words.length) tokens.forEach((x, i) => { x.o = orig[i]; });
    return { tokens, q };
  }

  // ---------- существительные и прилагательные из словаря ----------
  // Строка словаря: «нана (й/б; мн. ноаной)», «къонах (в/б; мн. къонахий) / маӀа саг…», у PaydaDosh класс — в пометке («й-й»).
  function parseEntry(it) {
    const text = String(it.line || it.inh);
    const alt = text.split(" / ")[0];
    const word = alt.replace(/\(.*$/, "").split(/[,;]/)[0].replace(/[̀́]/g, "").trim();
    if (!word || /[a-z]/i.test(word)) return null;
    let cls = null, pcls = null, plural = null;
    const par = /\(([^)]*)\)/.exec(alt);
    if (par) {
      const m = /^\s*([вйдб])(?:\s*\/\s*([вйдб]))?/.exec(par[1]);
      if (m) { cls = m[1]; pcls = m[2] || null; }
      const pm = /мн\.\s*([^;)]+)/.exec(par[1]);
      if (pm) plural = pm[1].trim().split(/[\s,]/)[0];
    }
    const note = it.seed && it.seed.license ? String(it.seed.note || "").trim() : "";
    const nm = /^([вйдб])(?:\s*[-,/]\s*([вйдб]))?$/.exec(note);
    if (!cls && nm) { cls = nm[1]; pcls = nm[2] || null; }
    return { word, cls, pcls, plural };
  }
  const ADJ_FORM = /(ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ую|юю|ым|им|ых|их|ыми|ими)$/;
  const ADJ_LEMMA = /(ый|ий|ой)$/;
  const lemmasOf = (w) => [w, ...RET.lemmas(w, "ru", 4)];
  // Надёжные записи: словарик проекта и PaydaDosh (у открытых словарей бывают ошибки).
  const reliable = (lemma) => {
    const r = RET.lookupWord(lemma, "ru", 6);
    return r && !r.lemma ? r.items.filter((it) => it.prio <= 1) : [];
  };
  // похоже на глагол: «болею», «пришла» — если у слова есть начальная форма-глагол
  const VERBISH = /(ю|ешь|ишь|ет|ит|ем|ете|ите|ут|ют|ат|ят|л|ла|ло|ли|ся|сь)$/;
  function nounOf(w, opts = {}) {
    if (VERB_FORMS.has(w) || L.STATES[w]) return null;
    // «брат» (брать), «село» (сесть) похожи на глагол, но у самого слова в надёжном словаре есть
    // существительное с классом («брат — воша (в/б…)», «село — юрт (й/й…)») — значит, это существительное
    const selfNoun = () => !!L.PERSON_CLASS[w] || reliable(w).some((it) => { const e = parseEntry(it); return e && e.cls && !/\s/.test(e.word); });
    if (VERBISH.test(w) && !L.RU_PLURALS[w] && RET.lemmas(w, "ru", 4).some((l) => /(ть|ться|ти|чь)$/.test(l)) && !selfNoun()) return null;
    const irregular = !opts.gen && L.RU_PLURALS[w];
    for (const l of irregular ? [irregular] : lemmasOf(w)) {
      if (ADJ_LEMMA.test(l) && !L.PERSON_CLASS[l]) continue;
      const plural = !!irregular || (!opts.gen && l !== w && /[ыи]$/.test(w) && !/[ыи]$/.test(l));
      // подлежащее и сказуемое — в именительном: слово равно начальной форме или это множественное число
      // («Это дорого» — не «это дорога», «отец детей» — не «отец — дети»)
      if (opts.nomOnly && l !== w && !plural) continue;
      let base = null;
      if (L.ATTESTED_CLASS[l]) base = { word: L.ATTESTED_CLASS[l][0], cls: L.ATTESTED_CLASS[l][1] };
      else {
        for (const it of reliable(l)) {
          // имя собственное по начальной форме — не то слово: «карта» → «карт» → «Карт» (имя, «Кхарт»)
          if (l !== w && /^[А-ЯЁӀ]/.test(String(it.ru).trim()) && /^[А-ЯЁӀ]/.test(String(it.inh).trim())) continue;
          const e = parseEntry(it); if (e) { base = e; break; }
        }
      }
      if (!base) continue;
      // слово на -ть/-ти может быть глаголом («читать»): берём его, только если в словаре у него есть класс
      // (у существительных он есть: «мать — нана (й/б…)», у глаголов — нет)
      if (/(ть|ться|ти|чь)$/.test(l) && !base.cls && !L.PERSON_CLASS[l]) continue;
      const person = L.PERSON_CLASS[l];
      const cls = person || base.cls;
      // только одно слово и с известным классом: так точно существительное, а не описание или глагол
      if (!cls || /\s/.test(base.word)) continue;
      if (plural) {
        // «люди» — «нах» (класс б: справочник «Many people (уж, нах) take б»)
        if (!base.plural) return null;
        return { noun: true, words: [base.plural], cls: base.pcls || (person ? "б" : null), plural: true, ru: l };
      }
      return { noun: true, words: [base.word], cls, ru: l };
    }
    return null;
  }
  // Прилагательные, которые не меняются по классам, хотя начинаются с «д» (дика — хороший)
  const INVARIABLE = new Set(["дика"]);
  function adjOf(w) {
    if (!ADJ_FORM.test(w)) return null;
    for (const l of lemmasOf(w)) {
      if (!ADJ_LEMMA.test(l)) continue;
      if (L.ADJECTIVES[l]) return { adj: L.ADJECTIVES[l], variable: false };
      for (const it of reliable(l)) {
        const e = parseEntry(it);
        if (!e) continue;
        // начинается с показателя класса: известна только форма класса д (так записано в словаре)
        if (/\s/.test(e.word)) continue;
        const variable = /^[вйдб]ӏ?[аеиоуэюяь]/.test(low(e.word)) && !INVARIABLE.has(low(e.word));
        return { adj: e.word, variable };
      }
    }
    return null;
  }
  const agreeAdj = (a, cls) => (!a.variable ? a.adj : cls === "д" && /^д/.test(a.adj) ? a.adj : null);

  // ---------- помощники для правил ----------
  // ядро: слова словаря проекта и библиотеки слов (самые проверенные) — для правил, которым нужна осторожность
  let CORE = null;
  const core = (w) => {
    if (!CORE) {
      CORE = new Set();
      const add = (x) => { for (const y of low(noParens(String(x || "")).split(" / ")[0]).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || []) CORE.add(y); };
      for (const [, inh] of KB.GLOSSARY) add(String(inh).split(/[(;,]/)[0]);
      for (const [w0] of Object.values(L.ATTESTED_CLASS)) add(w0);
      Object.values(L.ADJECTIVES).forEach(add);
      Object.values(L.PRONOUNS).forEach((P) => { add(P.gen); if (P.alt) add(P.alt.gen); });
      Object.values(L.DEMONSTRATIVES).forEach(add);
    }
    return CORE.has(low(w));
  };
  const G = {
    core,
    VERB: (id) => VERB_BY_ID.get(id),
    pron(p, c, ctx) {
      const P = L.PRONOUNS[p];
      if (!P) return null;
      if (ctx && ctx.we === "incl" && P.alt && P.alt[c]) return P.alt[c];
      return P[c];
    },
    // Группа слов: местоимение или «(этот) (мой) (два) (хороший…) дом». opts: gen — после «нет»;
    // acc — дополнение; adjOnly — только прилагательное (сказуемое «он хороший»).
    np(t, i, opts = {}) {
      const tk = t[i];
      if (!tk) return null;
      if (tk.k === "pron" && opts.nom && tk.case !== "nom") return null; // «мне холодно» — не «я холодный»
      if (tk.k === "pron" && !opts.adjOnly) {
        const nextWord = t[i + 1] && t[i + 1].k === "word";
        const possForm = L.POSSESSIVE_INVARIABLE[tk.w === "него" || tk.w === "нее" || tk.w === "них" ? "" : tk.w];
        if (!(possForm && nextWord && tk.case === "acc")) return { pron: tk.p, next: i + 1 };
      }
      const out = { words: [], adjs: [], next: i };
      let j = i;
      if (t[j] && t[j].k === "dem" && !opts.adjOnly) { out.words.push(t[j].inh); j++; }
      if (t[j] && t[j].k === "poss" && !opts.adjOnly) { out.words.push(t[j].p === "свой" ? { own: true } : { gen: t[j].p }); j++; }
      else if (t[j] && t[j].k === "pron" && L.POSSESSIVE_INVARIABLE[t[j].w] && !opts.adjOnly) { out.words.push(L.PRONOUNS[L.POSSESSIVE_INVARIABLE[t[j].w]].gen); j++; }
      if (t[j] && t[j].k === "num" && !opts.adjOnly) { out.words.push(t[j].inh); out.num = true; j++; }
      while (t[j] && t[j].k === "word") {
        const a = adjOf(t[j].w);
        if (!a) break;
        out.adjs.push({ at: out.words.length, a }); out.words.push(null); j++;
      }
      if (opts.adjOnly) {
        if (!out.adjs.length || out.words.length !== out.adjs.length) return null;
        return { adjOnly: true, adjs: out.adjs, words: out.words, next: j };
      }
      if (!t[j] || t[j].k !== "word") return null;
      const n = nounOf(t[j].w, { gen: opts.gen || out.num, nomOnly: opts.nom });
      if (!n) return null;
      if (n.plural && out.num) return null;
      return { noun: true, words: [...out.words, ...n.words], adjs: out.adjs, cls: n.cls, plural: n.plural, person: !!(L.PERSON_CLASS[n.ru] || L.PEOPLE.has(n.ru)), det: j > i + out.adjs.length, next: j + 1 };
    },
    // Куда / где: «на работу» → балха, «в Назрани» → Назране, «здесь» → укхаза.
    place(t, i, kind) {
      const tk = t[i];
      if (!tk) return null;
      if (tk.k === "state" && ["укхаза", "цига"].includes(tk.inh)) return { words: [tk.inh], next: i + 1 };
      if (tk.k !== "prep" || !t[i + 1] || t[i + 1].k !== "word") return null;
      const table = kind === "to" ? L.DESTINATIONS : L.LOCATIONS;
      for (const l of [L.CITY_FORMS[t[i + 1].w], ...lemmasOf(t[i + 1].w)]) if (l && table[l]) return { words: table[l].split(" "), next: i + 2 };
      return null;
    },
    cls(x, ctx) {
      if (x.pron) return L.PRONOUNS[x.pron].cls || ctx[x.pron] || "в";
      return x.cls || null;
    },
    cop(cls, kind) { return (L.COPULA[kind] || {})[cls] || null; },
    verb(v, tense, cls) {
      const f = v[tense];
      if (!f) return null;
      if (typeof f !== "string") return f[cls] || null;
      // одна форма, начинается с показателя класса «д» («ду», «дувц», «деш»): так она звучит с предметом
      // класса д («фу ду», «хабар дувц»). Для других классов формы в источниках нет — не выдумываем.
      if (v.type === "erg" && /^д[аеиоуэюяь]/.test(f) && cls !== "д") return null;
      return f;
    },
    words(x, ctx, cls) {
      if (x.pron) return [G.pron(x.pron, "nom", ctx)];
      const c = cls || x.cls;
      // «свой»: сай / хьай / ший — по тому, кто говорит (ctx.subj)
      const out = x.words.map((w) => (w && w.own ? L.OWN_BY_PERSON[ctx.subj] || null : w && w.gen ? G.pron(w.gen, "gen", ctx) : w));
      if (out.some((w) => w === null && !(x.adjs || []).length)) return null;
      for (const { at, a } of x.adjs || []) {
        const f = agreeAdj(a, c);
        if (!f) return null;
        out[at] = f;
      }
      return out;
    },
  };

  // ---------- сборка ----------
  const CTXS = [{ я: "в", ты: "в" }, { я: "й", ты: "в" }, { я: "в", ты: "й" }, { я: "й", ты: "й" }];
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function finish(words, text) {
    const end = (/[.!?…]+\s*$/.exec(text.trim()) || [""])[0].trim();
    return capitalize(words.join(" ").replace(/ӏ/g, "Ӏ")) + end;
  }
  function badWord(words) {
    const set = attested();
    for (const w of words) for (const part of low(w).split(/\s+/)) if (part && !set.has(part)) return part;
    return null;
  }

  function why(text) {
    const s = String(text || "").trim();
    if (!s || s.length > 160 || /[.!?…]\s+\S/.test(s)) return { fail: "не одно короткое предложение" };
    if (/[,;:/()«»"]/.test(s)) return { fail: "сложное предложение (запятые, скобки, варианты через /)" };
    const { tokens, q } = analyze(s);
    if (!tokens.length || tokens.length > 10) return { fail: "слишком длинное предложение" };
    // пол, если он виден из русского: «я была», «я готова»
    const fem = tokens.some((t) => t.fem);
    const firstPron = (tokens.find((t) => t.k === "pron" && t.case === "nom") || {}).p;
    for (const rule of RULES) {
      const b = rule.match(tokens, G, q, s);
      if (!b) continue;
      const outs = [];
      let bad = null;
      // «мы / наш»: тхо (без собеседника) и вай (вместе с собеседником) — оба варианта
      const hasWe = tokens.some((t) => t.p === "мы");
      const ctxs = hasWe ? CTXS.flatMap((c) => [{ ...c, we: "excl" }, { ...c, we: "incl" }]) : CTXS;
      for (const ctx of ctxs) {
        if (fem && firstPron === "я" && ctx.я !== "й") continue;
        if (fem && firstPron === "ты" && ctx.ты !== "й") continue;
        if (fem && firstPron !== "я" && firstPron !== "ты" && (ctx.я !== "в" || ctx.ты !== "в")) continue;
        const subj = b.who || (b.subj && b.subj.pron) || null;
        let words = null;
        try { words = rule.build(b, { ...ctx, subj }, G, q); } catch (e) { words = null; } // нужной формы нет — правило молчит
        if (!words || words.some((w) => !w)) { bad = bad || "нет нужной формы в источниках"; continue; }
        const miss = badWord(words.filter((w) => w !== b.name)); // имя не переводится — его в словаре и не ищем
        if (miss) { bad = `слова «${miss}» нет в источниках`; continue; }
        outs.push({ text: finish(words, s), ctx });
      }
      if (!outs.length) return { fail: bad || "нет формы", rule: rule.id };
      // варианты: разные тексты для разного пола
      const uniq = [];
      for (const o of outs) if (!uniq.some((u) => u.text === o.text)) uniq.push(o);
      // «это …» — у носителей и «Ер са нана я», и «Из са нана я»
      if (rule.id === "copula" && b.subj.eto && /^Ер /.test(uniq[0].text)) uniq.push({ text: uniq[0].text.replace(/^Ер /, "Из "), ctx: uniq[0].ctx, alt: "или «из» вместо «ер»" });
      const main = uniq[0];
      const note = (o) => {
        if (uniq.length < 2) return "";
        const parts = [];
        if (uniq.some((u) => u.ctx.я !== o.ctx.я && u.text !== o.text) && !fem) parts.push(o.ctx.я === "й" ? "говорит женщина" : "говорит мужчина");
        if (uniq.some((u) => u.ctx.ты !== o.ctx.ты && u.text !== o.text)) parts.push(o.ctx.ты === "й" ? "к женщине" : "к мужчине");
        if (o.ctx.we && uniq.some((u) => u.ctx.we !== o.ctx.we && u.text !== o.text)) parts.push(o.ctx.we === "incl" ? "мы — вместе с тем, к кому обращаемся" : "мы — без того, к кому обращаемся");
        return parts.join(", ");
      };
      // сокращаем до различающихся по смыслу вариантов
      const variants = uniq.map((o) => ({ text: o.text, note: o.alt || note(o) }));
      return { translation: main.text, variants, rule: rule.id, ruleName: rule.name };
    }
    return { fail: "нет подходящего правила" };
  }
  function translate(text) {
    const r = why(text);
    return r && r.translation ? r : null;
  }
  // ингушский → русский: те же правила, прочитанные наоборот (lib/rules/reverse.js)
  const REV = require("./reverse.js")({ RET });
  return { translate, why, analyze, RULES, G, translateInh: REV.translate, REVERSE_RULES: REV.RULES };
};
