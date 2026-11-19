// Выбор русского значения ингушского слова при переводе «по словам» (ингушский → русский).
//
// У ингушского слова в словарях часто несколько записей, а в одной записи — несколько значений:
// «хабар — от хаба» (PaydaDosh, падежная форма другого слова), «хабар — слух, молва; 2) известие, весть;
// новость; 3) разговор» (PaydaDosh), «хабар — известие» (Викисловарь), «хабар — разговор» (PanLex).
// Раньше бралось первое значение первой записи, и в ответ попадали описания («от хаба»), редкие слова
// («сурташ» → «картинный», «дешаш» → «пойло») или значение, которое носители не имеют в виду
// («моаршал» → «здоровье» вместо «привет»).
//
// Ингушских слов здесь не создаётся: выбирается одно из русских значений из словарей. Каждое значение
// получает очки:
//   + надёжность источника (словарь проекта > PaydaDosh > Викисловарь > прочие) и место в записи
//     (первое значение — главное);
//   + сколько разных записей дают это значение;
//   + насколько русское слово обычное (как часто встречается в русской части корпуса, lib/corpus-lexicon.js);
//   + как эту самую ингушскую форму переводят настоящие тексты (corpus-lexicon, ингушская сторона)
//     и пары фраз разговорника (таблица слов ALIGN);
//   + часть речи: у существительного (класс в словаре: «(д/д)») — не прилагательное и не глагол;
//     прилагательное — только если тексты переводят слово прилагательным;
//   − описание из нескольких слов, «от …» / «в …» (описание падежной формы), запись с заглавной буквы и
//     точкой.
// Кроме значений словаря кандидат — перевод этой формы в корпусе, если его подтверждают печатные словари
// (пометка * в corpus-lexicon) и примеров не меньше 5: «хана» — «время» (53*), «дешаш» — «слова» (61*),
// «сурташ» — «фотографии» (19*). Он побеждает, только когда словарь знает слово лишь по догадке о начальной
// форме или его значения ни тексты, ни пары фраз не подтверждают. Это русское слово в той форме, в какой оно
// стоит в текстах, поэтому дальше его не склоняют (how: "corpus").
//
// make({ ALIGN, LEX }) → { cands(w, r, ok), pick(w, cands, debug) }
//   r — ответ RET.lookupWord(w, "inh"), ok(item) — можно ли брать запись.

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const SRC = [3, 2, 1.2, 0.6, 0.3, 0, 0];
const ADJ = /(ый|ий|ой)$/;
const ADJ_FORM = /(ый|ий|ой|ая|яя|ое|ее|ую|юю|ые|ие|ых|их|ого|его|ому|ему|ым|ыми|ими)$/;
const INF_RE = /(ть|ти|чь|ться|тись|чься)$/;
// существительные и числительные на -ть, -чь: «совесть», «часть», «ночь», «мать», «пять»
const NOT_INF = /(сть|пять|девять|десять|дцать|ночь|речь|дочь|мать|кровать|печать|тетрадь|сеть|нить|треть|смерть|суть|путь|грудь|плоть|медь|степь|цепь)$/;
const INF = { test: (t) => INF_RE.test(t) && !NOT_INF.test(t) };
const VERB_FORM = /(ть|ти|чь|ться|тись|чься|л|ла|ло|ли|лся|лась|лись|ет|ит|ют|ят|ут|ет|ется|ится|ются|ятся|ешь|ишь|ем|им|ете|ите)$/;
// описание падежной формы другого слова: «от хаба», «в доме», «к нему»
const PREP = /^(от|из|в|во|на|с|со|к|ко|у|для|по|о|об|при|до|за|под|над|без)\s/;
// служебные слова и пометы, которые не бывают переводом сами по себе
const NOT_SENSE = /^(прош|наст|мн|ед|букв|см|разг|устар|перен|тж|род|дат|твор)\.?$/;

// грамматическое пояснение вместо перевода
const GRAMMAR = /(частица|суффикс|окончание|падеж|форма от|мн\. ч|ед\. ч|деепричастие|причастие|союз|междометие|предлог)/;

// одно и то же русское слово в разных формах: «разговор — разговоры», «слух — слуха», «сказал — сказала»;
// но «согласие» — не «согласился», «одиноко» — не «один»
const END = /(ться|тся|ть|ла|ло|ли|л|ся|ого|его|ому|ему|ыми|ими|ами|ями|ий|ый|ой|ая|яя|ое|ее|ые|ие|ых|их|ым|им|ом|ем|ам|ям|ах|ях|ов|ев|ей|а|я|о|е|и|ы|у|ю|ь)$/;
const stemOf = (x) => (x.length > 4 ? x.replace(END, "") : x);
function sameWord(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  let x = stemOf(a), y = stemOf(b);
  if (x.length > y.length) [x, y] = [y, x];
  return x.length >= 3 && y.startsWith(x) && y.length - x.length <= 1;
}

// «слух, молва; 2) известие, весть; новость; 3) разговор» → [«слух», «молва», «известие», …]
function sensesOfRu(s) {
  const t = String(s || "").split(" — ")[0].replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  // «послелог о, относительно…» → «о»: помета части речи — не перевод
  return t.split(/[,;/?!]|\s\d+\)\s*|^\d+\)\s*/).map((x) => x.replace(/^\s*(послелог|предлог|союз|частица|нареч\.?)\s+(?=\S)/i, "").replace(/~/g, "").replace(/[.!?…:]+$/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

module.exports = function makeSenseInh({ ALIGN = null, LEX = null, tune = {} } = {}) {
  const W = { pos: 0.4, alTop: 0.8, multi: 1.2, prep: 2.5, prepPlain: 0.8, freq: 0.35, agree: 3, align: 2.5, votes: 0.4, corpus: 1, ...tune };
  const lexList = (w, lang) => { if (!LEX) return null; const e = LEX.entry(w, lang); return e && e.exact ? e.list : null; };
  // Как часто русское слово встречается (во всех формах): русская часть корпуса (lib/corpus-lexicon.js) и
  // русская часть пар фраз, на которых учится таблица слов. Обычное слово («разговор») — частое, редкое
  // («мзда», «пойло») — нет.
  const byPrefix = (words) => {
    const m = new Map();
    for (const [w, n] of words) { if (w.length < 4) continue; const k = w.slice(0, 4); if (!m.has(k)) m.set(k, []); m.get(k).push([w, n]); }
    return m;
  };
  let IDX = null;
  function index() {
    if (IDX) return IDX;
    const lexW = [];
    if (LEX && LEX.keys) for (const k of LEX.keys("ru")) { const e = LEX.entry(k, "ru"); if (e && e.exact) lexW.push([low(k), e.list.reduce((s, c) => s + c.n, 0)]); }
    const alW = ALIGN && ALIGN.freq ? [...ALIGN.freq.ru].map(([w, n]) => [low(w), n]) : [];
    return (IDX = { lex: byPrefix(lexW), al: byPrefix(alW), lexExact: new Map(lexW), alExact: new Map(alW) });
  }
  const ruFreq = new Map();
  function freq(ru) {
    if (ruFreq.has(ru)) return ruFreq.get(ru);
    const I = index();
    const sum = (pre, exact) => (ru.length < 4 ? exact.get(ru) || 0 : (pre.get(ru.slice(0, 4)) || []).filter(([w]) => sameWord(w, ru)).reduce((s, [, n]) => s + n, 0));
    // пары фраз — бытовая речь, как в разговорнике: одно их употребление весит как 5 в газетном корпусе
    const f = sum(I.lex, I.lexExact) + 5 * sum(I.al, I.alExact);
    ruFreq.set(ru, f);
    return f;
  }
  // только русская часть корпуса (в парах фраз по-русски бывают и ингушские слова: «от дагалатта»)
  const lexFreq = (ru) => { const I = index(); return ru.length < 4 ? I.lexExact.get(ru) || 0 : (I.lex.get(ru.slice(0, 4)) || []).filter(([w]) => sameWord(w, ru)).reduce((s, [, n]) => s + n, 0); };
  // доля переводов ингушской формы в корпусе, совпадающих с русским словом (с доверием по числу примеров)
  function corpusShare(inh, ru) {
    const list = lexList(inh, "inh");
    if (!list) return 0;
    const tot = list.reduce((s, c) => s + c.n, 0) || 1;
    if (tot < 3) return 0; // «кхаъ — взятки» по двум примерам — не довод
    return tot / (tot + 8) * list.filter((c) => sameWord(low(c.text), ru)).reduce((s, c) => s + c.n, 0) / tot;
  }
  function alignShare(inh, ru) {
    if (!ALIGN || !ALIGN.dist) return 0;
    const d = ALIGN.dist(inh, "inh");
    if (!d) return 0;
    let p = 0;
    for (const [e, q] of d.list) if (sameWord(low(e), ru)) p += q;
    return Math.min(1, p) * d.n / (d.n + 2);
  }
  // доля прилагательных и глаголов среди переводов формы в корпусе
  function posShare(inh) {
    const list = lexList(inh, "inh");
    if (!list) return null;
    const tot = list.reduce((s, c) => s + c.n, 0);
    if (tot < 3) return null;
    const sh = (re) => list.filter((c) => re.test(low(c.text))).reduce((s, c) => s + c.n, 0) / tot;
    return { adj: sh(ADJ_FORM), verb: sh(VERB_FORM) };
  }

  // Кандидаты из всех записей словаря (и перевод формы в корпусе — см. выше).
  function cands(w, r, ok = () => true, maxPrio = 4) {
    const out = new Map();
    const lemma = r.lemma || w;
    r.items.forEach((it, n) => {
      if (it.prio > maxPrio || !ok(it)) return;
      sensesOfRu(it.ru).forEach((to, k) => {
        if (/[a-z0-9^]/i.test(to) || NOT_SENSE.test(low(to)) || /^(прош|наст|мн)\./.test(to)) return;
        // кусок предложения («Какова ваша жизнь») или ингушские слова внутри русской записи («шун вахар»)
        if (/[а-яё]\s+[А-ЯЁ]/.test(to) || /[ӀӏӀ]|хь|кх|къ|гӏ|аь/i.test(to)) return;
        if (/\s/.test(to) && low(to).split(/\s+/).every((x) => !freq(x))) return;
        // хвост описания: «по поводу кого-либо, чего-либо» → «чего-либо»
        if (/^(кого|чего|кому|чему|кем|чем|ком|чём)-(либо|нибудь)$/.test(low(to))) return;
        const key = low(to);
        const c = out.get(key);
        if (c) { c.votes++; if (it.prio < c.it.prio || (it.prio === c.it.prio && k < c.k)) Object.assign(c, { it, k, n }); return; }
        out.set(key, { it, to, k, n, lemma, votes: 1 });
      });
    });
    // перевод этой же формы в корпусе, подтверждённый словарями
    const list = lexList(w, "inh");
    if (list && !tune.noCorpus) {
      const tot = list.reduce((s, c) => s + c.n, 0);
      for (const c of list.slice(0, 2)) {
        const key = low(c.text);
        if (!c.sure || c.n < 5 || c.n / tot < 0.3 || !/^[а-я-]+$/.test(key) || key.length < 3) continue;
        // глагольная форма («сообщается») у слова, которое словарь даёт не глаголом («хоам» — сообщение), —
        // слово из соседнего сочетания («хоам бира» — сообщил), а не перевод
        // (если словарь знает само слово, а не догадку о начальной форме: «аьннад» — «сказал» берём)
        if (VERB_FORM.test(key) && !INF.test(key) && !r.lemma && out.size && ![...out.keys()].some((k) => INF.test(k))) continue;
        if ([...out.keys()].some((k) => sameWord(k, key))) continue; // уже есть в словаре — его и возьмём
        out.set(key, { it: { prio: 5, name: "настоящие тексты", ru: c.text, inh: w }, to: key, k: 0, n: 99, lemma: w, votes: 1, corpus: true, cn: c.n });
      }
    }
    return [...out.values()];
  }

  function score(w, c, ctx) {
    const to = low(c.to), ws = to.split(/\s+/).filter(Boolean);
    const it = c.it;
    let s, why;
    if (c.corpus) {
      // словарь знает слово только по догадке о начальной форме или не подтверждён — корпус надёжнее
      s = W.corpus + Math.min(1.5, 0.5 * Math.log10(1 + c.cn)) + (ctx.lemmaGuess ? 1.5 : 0);
      why = [`corpus-form ${s.toFixed(2)}`];
    } else {
      s = SRC[it.prio] ?? 0;
      why = [`src ${s}`];
      if (c.k) { const p = 0.35 * Math.min(c.k, 3); s -= p; why.push(`k${c.k} -${p.toFixed(2)}`); }
      if (c.n) { const p = 0.1 * Math.min(c.n, 5); s -= p; why.push(`entry${c.n} -${p.toFixed(1)}`); }
      if (c.votes > 1) { const b = W.votes * Math.min(c.votes - 1, 3); s += b; why.push(`votes +${b.toFixed(1)}`); }
      // «добрая, радостная весть»: «добрая» — кусок описания, а не значение
      if (ws.length === 1 && /(ая|яя|ое|ее)$/.test(to) && to.length > 4) { s -= 1.5; why.push("adj-fragment -1.5"); }
      if (it.prio > 0 && (/^[А-ЯЁӀ]/.test(String(it.inh)) || /\.\s*$/.test(String(it.ru)))) { s -= 0.5; why.push("caps -0.5"); }
    }
    // описание, а не слово: «Цитирующая частица», «от хаба»
    if (GRAMMAR.test(to)) { s -= 3; why.push("grammar -3"); }
    // «от хаба» (ингушское слово после предлога) — описание падежной формы; «на той стороне» («дехьа»,
    // PaydaDosh) — обычные русские слова: это перевод наречия, штраф меньше
    // (если только надёжный источник не даёт и значения без предлога: «бетта» — месяц, а не «в месяц»)
    if (PREP.test(to)) {
      const plain = !c.corpus && ws.length > 1 && c.it.prio < ctx.nonPrepPrio && ((xs) => xs.length > 0 && xs.every((x) => lexFreq(x) > 0))(ws.slice(1).filter((x) => x.length > 3));
      const p = plain ? W.prepPlain : W.prep;
      s -= p; why.push(`prep -${p}`);
    }
    if (ws.length > 1) {
      // у глаголов «давать слово», «ходить в гости» — норма
      const p = (INF.test(ws[0]) ? 0.4 : W.multi) * (ws.length - 1);
      s -= p; why.push(`multi -${p.toFixed(1)}`);
    }
    // обычное ли это русское слово
    const f = Math.max(...ws.filter((x) => x.length > 2).map(freq), 0);
    if (f) { const b = Math.min(1.2, W.freq * Math.log10(1 + f)); s += b; why.push(`ru-freq ${f} +${b.toFixed(2)}`); }
    else if (ws.length === 1) { s -= 0.4; why.push("ru-rare -0.4"); }
    // так переводят эту форму тексты и пары фраз
    let ag = 0;
    if (!c.corpus) {
      let al = 0;
      for (const x of ws) {
        ag = Math.max(ag, corpusShare(w, x), c.lemma !== w ? 0.5 * corpusShare(c.lemma, x) : 0);
        al = Math.max(al, alignShare(w, x), c.lemma !== w ? 0.5 * alignShare(c.lemma, x) : 0);
      }
      if (ag) { s += W.agree * ag; why.push(`corpus +${(W.agree * ag).toFixed(2)}`); }
      // тексты часто переводят эту форму, но никогда так: «шера» — в текстах «году, года» (1187 раз),
      // а в словаре проекта — «широкий»
      else if (ctx.corpusTot >= 20) { const p = Math.min(1.5, 0.5 * Math.log10(ctx.corpusTot)); s -= p; why.push(`corpus-never -${p.toFixed(2)}`); }
      if (al) { s += W.align * al; why.push(`align +${(W.align * al).toFixed(2)}`); }
      // в парах фраз это значение заметно чаще других: «хабар» — «разговор» (0.21), а «весть» — 0.15
      if (ctx.alTop === c) { s += W.alTop; why.push(`align-top +${W.alTop}`); }
    }
    // часть речи
    const isAdj = ws.length === 1 && ADJ.test(to) && to.length > 3;
    const isVerb = INF.test(ws[0]);
    if (ctx.noun && (isAdj || isVerb)) { s -= 2 * W.pos; why.push(`noun-pos -${2 * W.pos}`); }
    if (ctx.pos && !ag) { // часть речи по текстам — только если тексты не подтверждают само значение («дика» — «хорошо»)
      if (isAdj && ctx.pos.adj < 0.15) { s -= 2 * W.pos; why.push(`adj? -${2 * W.pos}`); }
      if (isAdj && ctx.pos.adj >= 0.5) { s += W.pos; why.push(`adj +${W.pos}`); }
      if (!isAdj && !isVerb && ctx.pos.adj >= 0.7) { s -= W.pos; why.push(`not-adj -${W.pos}`); }
      if (isVerb && ctx.pos.verb < 0.1 && ctx.pos.adj + ctx.pos.verb < 0.5) { s -= W.pos; why.push(`verb? -${W.pos}`); }
    }
    return { s, why };
  }

  function pick(w, cs, debug) {
    if (!cs.length) return null;
    const dictC = cs.filter((c) => !c.corpus);
    const ctx = {
      // у существительного в словаре есть класс: «дешар (д)», «нана (й/б; мн. ноаной)»
      noun: dictC.length > 0 && dictC.some((c) => /\(\s*[вйдб]\s*[\/,);-]/.test(String(c.it.line || c.it.inh))) && !dictC.some((c) => /наст\./.test(String(c.it.line || ""))),
      pos: posShare(w),
      lemmaGuess: dictC.length > 0 && dictC.every((c) => c.lemma !== w),
      // лучший источник, у которого есть значение без предлога: при нём предложное описание — не перевод
      nonPrepPrio: Math.min(9, ...dictC.filter((c) => !PREP.test(low(c.to))).map((c) => c.it.prio)),
      corpusTot: (lexList(w, "inh") || []).filter((c) => c.sure).reduce((s, c) => s + c.n, 0),
    };
    // Слово есть в словаре проекта (не по догадке о начальной форме): его первое значение. Словарь составлен
    // вручную для бытовой речи; тексты (газеты, книги) тянут к другим значениям: «гӀала» — «башня» вместо
    // «город», «сом» — «рубль» вместо «фрукт», «шера» — «году» вместо «широкий».
    // Так же для начальной формы («дикача» → «дика» — «хороший»), если только тексты не переводят саму форму
    // иначе (тогда догадка о начальной форме может быть неверной — решают очки).
    const gl = dictC.filter((c) => c.it.prio === 0 && !c.k).sort((a, b) => a.n - b.n)[0];
    if (gl && !tune.noGlossaryFirst && !(ctx.lemmaGuess && cs.some((c) => c.corpus))) { if (debug) debug.push({ to: gl.to, src: gl.it.name, s: 99, why: ["glossary-first"] }); return gl; }
    // значение, которое пары фраз заметно предпочитают остальным («бравый молодец» и «молодец» — одно и то же:
    // берём короткое)
    if (ALIGN && ALIGN.dist && dictC.length > 1) {
      const al = dictC.map((c) => [c, Math.max(...low(c.to).split(/\s+/).map((x) => alignShare(w, x)))])
        .sort((a, b) => b[1] - a[1] || a[0].to.split(" ").length - b[0].to.split(" ").length);
      const next = al.find(([, p]) => p < al[0][1] - 1e-9);
      if (al[0][1] >= 0.1 && (!next || al[0][1] >= 1.4 * next[1])) ctx.alTop = al[0][0];
    }
    let best = null, bs = -Infinity;
    for (const c of cs) {
      const r = score(w, c, ctx);
      if (debug) debug.push({ to: c.to, src: c.it.name, ...r });
      if (r.s > bs + 1e-9) { bs = r.s; best = c; }
    }
    return best;
  }

  return { cands, pick, score, sensesOfRu, sameWord };
};
