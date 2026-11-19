// Выбор значения слова при переводе «по словам» (русский → ингушский).
//
// У русского слова в словарях часто несколько записей: словарь проекта, PaydaDosh (иногда несколько
// разных записей — «интересный — Земе / куцах дола»), открытые словари. Раньше бралась первая запись
// по надёжности источника, и в ответ попадали редкие слова, описания («обед — делкъийга дуа хӀама»)
// или запись другой начальной формы («матери» → «матёрый — гила»).
//
// Здесь каждая запись получает очки (ничего нового не придумывается — выбирается одна из записей словаря):
//   + надёжность источника (словарь проекта > PaydaDosh > Викисловарь > прочие);
//   + как часто ингушское слово встречается в настоящих текстах (lib/corpus-lexicon.js, ингушская сторона)
//     и есть ли оно в списке словоформ (lib/ingush-words.js);
//   + совпадение с тем, как это русское слово переводится в настоящих текстах (corpus-lexicon, русская
//     сторона) и в парах фраз разговорника (таблица слов ALIGN);
//   + часть речи: у русского прилагательного — ингушское слово, которое в текстах переводится прилагательным;
//   − описание из нескольких слов, запись-пояснение, запись с заглавной буквы и точкой (другой словарь
//     внутри PaydaDosh: «Ребёнок, дитя, младенец.»), запись другой начальной формы.
// Множественное число: у записи словаря проекта «бер (д/д; мн. бераш)» форма «бераш» — тоже кандидат, но
// только для формы слова (не для начальной) и побеждает, только если её подтверждают тексты или пары фраз.
//
// pick(w, cands) → лучший кандидат; cands: [{ it, to, lemma, rank, plural }].
//   it — запись словаря (lookupWord), to — ингушское значение, rank — 0 для начальной формы, найденной
//   словарём первой, 1 — для других начальных форм.

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const SRC = [4.5, 2, 1.2, 0.6, 0.3, 0, 0];
const ADJ_LEMMA = /(ый|ий|ой)$/;
const ADJ_FORM = /(ый|ий|ой|ая|яя|ое|ее|ую|юю|ые|ие|ых|их|ого|его|ому|ему|ым|ыми|ими)$/;

module.exports = function makeSense({ ALIGN = null, LEX = null, attested = () => false, tune = {} } = {}) {
  const W = { freq: 0.5, agree: 2, align: 2, pos: 0.5, multi: 1, ...tune };
  // корпус: { ингушское слово → [{ text: русское, n }] } и наоборот; только точное совпадение ключа
  const lex = (w, lang) => { if (!LEX) return null; const e = LEX.entry(w, lang); return e && e.exact ? e.list : null; };
  // слово корпуса t — это ингушское слово x или его падежная форма: «истол» → «истол, истола»
  // (только окончание после x; «сом» не считается формой «сомал»)
  const formOf = (t, x) => t === x || (x.length >= 3 && t.startsWith(x) && t.length - x.length <= 3);
  // доля переводов русского слова в корпусе, которые совпадают с ингушским словом
  // not — форма, которая сюда не считается: у «бер» не считаем «бераш, берашта» (это мн. число)
  function corpusShare(ru, inh, not) {
    const list = lex(ru, "ru");
    if (!list) return 0;
    const tot = list.reduce((s, c) => s + c.n, 0) || 1;
    // доверие по числу примеров: «домой — цӀенгахьа» по двум примерам — слабый довод
    return tot / (tot + 5) * list.filter((c) => { const t = low(c.text); return formOf(t, inh) && !(not && t.startsWith(not)); }).reduce((s, c) => s + c.n, 0) / tot;
  }
  // обратно: доля переводов ингушского слова в корпусе, которые — это русское слово («безаме» — «интересным»)
  function backShare(inh, w, lemma) {
    const list = lex(inh, "inh");
    if (!list) return 0;
    const tot = list.reduce((s, c) => s + c.n, 0) || 1;
    const stem = (x) => (x.length > 5 ? x.slice(0, x.length - 2) : x);
    const ok = (t) => t === w || t === lemma || (lemma.length > 5 && t.startsWith(stem(lemma)) && t.length - stem(lemma).length <= 4);
    return tot / (tot + 5) * list.filter((c) => ok(low(c.text))).reduce((s, c) => s + c.n, 0) / tot;
  }
  function freq(inh) {
    const list = lex(inh, "inh");
    return list ? list.reduce((s, c) => s + c.n, 0) : 0;
  }
  // доля переводов ингушского слова в корпусе, которые — русские прилагательные
  function adjShare(inh) {
    const list = lex(inh, "inh");
    if (!list) return null;
    const tot = list.reduce((s, c) => s + c.n, 0);
    if (tot < 3) return null;
    return list.filter((c) => ADJ_FORM.test(low(c.text))).reduce((s, c) => s + c.n, 0) / tot;
  }

  function score(w, c) {
    const to = low(c.to), ws = to.split(/\s+/).filter(Boolean);
    const lemma = c.lemma || w;
    const it = c.it;
    let s = SRC[it.prio] ?? 0;
    const why = [`src ${s}`];
    if (c.rank) { s -= 1.5; why.push("other-lemma -1.5"); }
    if (c.plural) { s -= 0.5; why.push("plural -0.5"); }
    if (it.alone === 0) { s += 0.3; why.push("alone +0.3"); }
    // запись из другого словаря внутри PaydaDosh: «Интересный — Земе», «Ребёнок, дитя, младенец. — гака»
    if (it.prio > 0 && (/^[А-ЯЁӀ]/.test(String(it.inh)) || /\.\s*$/.test(String(it.ru)))) { s -= 0.7; why.push("caps -0.7"); }
    // описание из нескольких слов («делкъийга дуа хӀама»); у глаголов «болх бе», «наб е» — норма
    if (ws.length > 1) { const p = (/(ть|ться|ти|чь)$/.test(lemma) ? 0.3 : W.multi) * (ws.length - 1); s -= p; why.push(`multi -${p.toFixed(1)}`); }
    if (ws.length > 2) { s -= 1; why.push("long -1"); }
    // слово встречается в настоящих текстах
    const f = Math.max(...ws.map(freq));
    if (f) { const b = Math.min(1.5, W.freq * Math.log10(1 + f)); s += b; why.push(`freq ${f} +${b.toFixed(2)}`); }
    // пишется как русское слово («школа»), а в ингушских текстах не встречается — скорее русское
    if (!f && (to === low(lemma) || to === low(w))) { s -= 1; why.push("russian-spelling -1"); }
    const unatt = ws.filter((x) => !attested(x)).length;
    if (unatt) { s -= 0.4 * unatt; why.push(`unattested -${0.4 * unatt}`); }
    // так же переводят это русское слово настоящие тексты и пары фраз
    let ag = 0;
    const not = c.pl ? low(c.pl) : null;
    for (const x of ws) ag = Math.max(ag, corpusShare(w, x, not), lemma !== w && !c.plural ? corpusShare(lemma, x, not) * 0.5 : 0, ws.length === 1 && ADJ_LEMMA.test(lemma) ? backShare(x, w, lemma) : 0);
    if (ag) { s += W.agree * ag; why.push(`corpus +${(W.agree * ag).toFixed(2)}`); }
    if (ALIGN) {
      let al = 0;
      for (const x of ws) al = Math.max(al, ALIGN.prob(w, x, "ru"), lemma !== w && !c.plural ? ALIGN.prob(lemma, x, "ru") * 0.5 : 0);
      if (al) { s += W.align * al; why.push(`align +${(W.align * al).toFixed(2)}`); }
    }
    // прилагательное → прилагательное
    if (ADJ_LEMMA.test(lemma) && (lemma !== w || /(ый|ий)$/.test(w)) && ws.length === 1) {
      const a = adjShare(ws[0]);
      if (a !== null && a >= 0.3) { s += W.pos; why.push(`adj +${W.pos}`); }
    }
    return { s, why };
  }

  function pick(w, cands, debug) {
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    let best = null, bs = -Infinity;
    for (const c of cands) {
      const r = score(w, c);
      if (debug) debug.push({ to: c.to, src: c.it.name, lemma: c.lemma, ...r });
      if (r.s > bs + 1e-9) { bs = r.s; best = c; }
    }
    return best;
  }

  // Таблица слов (ALIGN) хочет заменить слово из словаря своим. Отказ, если
  //   — её слово — кусок описания из словаря («обед — делкъийга дуа хӀама» → «делкъийга»);
  //   — настоящие тексты переводят это русское слово словарным словом, а её слово — нет
  //     («стол» — в текстах «истол / истола», таблица: «шу»).
  //   — её слово — другое значение из словаря, которое выбор уже отверг («интересный — Земе»),
  //     а поддержка таблицы слабая (≤ 4 пар): таблица учится и на самих словарных записях;
  // Слово словаря, которое пишется как русское («школа»), корпусом не проверяется: в текстах «школе» —
  // это русское слово в соседнем предложении, а не ингушское (справочник: «ишколе»).
  function vetoAlign(w, dictTo, al, rejected = [], lemma = w) {
    const d = low(dictTo).split(/\s+/), a = low(al);
    const b = ALIGN && ALIGN.best(w, "ru");
    if (rejected.includes(a) && (!b || b.n < 5)) return true;
    // кусок описания — только при слабой поддержке таблицы (≤ 4 пар): «обед» — «делкъийга» (в полдень)
    if (d.length > 1 && d.includes(a) && (!b || b.n < 5)) return true;
    const list = lex(w, "ru");
    if (!list) return false;
    const tot = list.reduce((s, c) => s + c.n, 0);
    const share = (x) => list.filter((c) => formOf(low(c.text), x)).reduce((s, c) => s + c.n, 0) / (tot || 1);
    return tot >= 5 && d.length === 1 && d[0] !== low(w) && d[0] !== low(lemma) && share(d[0]) >= 0.3 && share(a) === 0;
  }

  return { pick, score, vetoAlign };
};
