// БИБЛИОТЕКА ПРАВИЛ: как из русского предложения собрать ингушское (без ИИ).
//
// Каждое правило — один тип предложения. У правила есть:
//   name     — что за предложения оно переводит;
//   examples — образцы из источников (справочник проекта, разговорник PaydaDosh): по ним правило написано
//              и по ним же проверяется (test/rules.test.js);
//   match    — узнаёт предложение: проходит по разобранным русским словам и запоминает части;
//   build    — собирает ингушское предложение из частей. ctx — пол говорящего и собеседника
//              ({ я: "в" | "й", ты: "в" | "й" }): от него зависят классы «ва / я», «вода / йода».
//
// Слова и формы берутся из библиотеки слов (lib/rules/lexicon.js) и словаря. Если для предложения не нашлось
// правила, или нужной формы нет в источниках, правило молчит, и перевод идёт дальше (ИИ или «нет в базе»).
//
// Помощники (G), которыми пользуются правила, описаны в lib/rules/index.js:
//   G.np(tokens, i, opts)  — разбирает группу «(этот) (мой) (два) (хороший) дом» или местоимение;
//   G.pron(p, case)         — местоимение в нужном падеже (со, аз, сона, сога…);
//   G.cls(x, ctx)           — класс местоимения или группы (в, й, д, б);
//   G.cop(cls, kind)        — связка: ва / вац / вар / вий…;
//   G.verb(v, tense, cls)   — форма глагола для класса;
//   G.words(x, ctx)         — ингушские слова группы.

const L = require("./lexicon.js");

// Небольшие помощники для разбора: t — разобранные слова, i — позиция.
const is = (t, i, k) => t[i] && t[i].k === k;
const end = (t, i) => i >= t.length;

const RULES = [
  {
    id: "have",
    name: "«У меня есть / нет …»",
    examples: [["У меня есть машина", "Сога машен я"], ["У меня нет денег", "Сога ахча дац"], ["У тебя есть деньги?", "Ахча дий хьога?"]],
    match(t, G) {
      let i = 0;
      if (!is(t, i, "u")) return null; i++;
      if (!is(t, i, "pron")) return null;
      const who = t[i].p; i++;
      if (!L.PRONOUNS[who].all) return null; // у него / у них — формы «у кого» нет в источниках
      let neg = false;
      if (is(t, i, "est")) i++;
      else if (is(t, i, "net")) { neg = true; i++; }
      else return null;
      const np = G.np(t, i, { gen: neg });
      if (!np || !end(t, np.next)) return null;
      // о людях («у нас нет детей») говорят иначе: «Тха бераш дац» (PaydaDosh) — это правило только для вещей
      if (np.person) return null;
      return { who, neg, np };
    },
    build(b, ctx, G, q) {
      const cls = G.cls(b.np, ctx);
      if (!cls) return null;
      const all = G.pron(b.who, "all", ctx);
      if (q) return [...G.words(b.np, ctx), G.cop(cls, b.neg ? "neg" : "q"), all];
      return [all, ...G.words(b.np, ctx), G.cop(cls, b.neg ? "neg" : "pres")];
    },
  },
  {
    id: "where",
    name: "«Где …?»",
    examples: [["Где ты?", "Мичахьа ва хьо?"], ["Где магазин?", "Тика мичахьа я?"], ["Где вы были?", "Мича дар шо?"]],
    match(t, G) {
      let i = 0;
      if (!is(t, i, "q") || t[i].w !== "где") return null; i++;
      const np = G.np(t, i, { nom: true });
      if (!np) return null;
      i = np.next;
      let past = false;
      if (is(t, i, "cop")) { past = true; i++; }
      if (!end(t, i)) return null;
      return { np, past };
    },
    build(b, ctx, G) {
      const cls = G.cls(b.np, ctx);
      if (!cls) return null;
      if (b.past) return ["мича", G.cop(cls, "past"), ...G.words(b.np, ctx)];
      if (b.np.pron) return ["мичахьа", G.cop(cls, "pres"), ...G.words(b.np, ctx)];
      return [...G.words(b.np, ctx), "мичахьа", G.cop(cls, "pres")];
    },
  },
  {
    id: "need",
    name: "«Мне нужен / нужна / нужно …»",
    examples: [["Мне нужен переводчик", "Сона талмач веза"], ["Мне нужно два килограмма", "Сона ши кийла еза"]],
    match(t, G) {
      let i = 0;
      if (!is(t, i, "pron") || t[i].case !== "dat") return null;
      const who = t[i].p; i++;
      if (!is(t, i, "verb") || t[i].v.id !== "нужен") return null; i++;
      const np = G.np(t, i, {});
      if (!np || !end(t, np.next)) return null;
      return { who, np };
    },
    build(b, ctx, G) {
      const cls = G.cls(b.np, ctx);
      const v = cls && G.verb(G.VERB("нужен"), "pres", cls);
      if (!v) return null;
      return [G.pron(b.who, "dat", ctx), ...G.words(b.np, ctx), v];
    },
  },
  {
    id: "dative",
    name: "Знать, любить, видеть, слышать, хотеть, думать (кто — в дательном падеже: сона, хьона)",
    examples: [["Я знаю", "Сона хов"], ["Я не знаю", "Сона хац"], ["Я тебя люблю", "Сона хьо веза"], ["Ты знаешь ингушский язык?", "ГӀалгӀай мотт хов хьона?"]],
    match(t, G) {
      let i = 0;
      if (!is(t, i, "pron") || t[i].case !== "nom") return null;
      const who = t[i].p; i++;
      // дополнение может стоять до глагола: «я тебя люблю»
      let obj = null;
      if (is(t, i, "pron") && t[i].case === "acc") { obj = { pron: t[i].p, next: i + 1 }; i++; }
      let neg = false;
      if (is(t, i, "neg")) { neg = true; i++; }
      if (!is(t, i, "verb") || t[i].v.type !== "dat") return null;
      const verb = t[i]; i++;
      let inf = null;
      if (!obj && !end(t, i)) {
        if (verb.v.id === "хотеть" && is(t, i, "verb") && t[i].tense === "inf" && t[i].v.inf) { inf = t[i].v; i++; }
        else {
          obj = is(t, i, "pron") && t[i].case === "acc" ? { pron: t[i].p, next: i + 1 } : G.np(t, i, { acc: true });
          if (!obj) return null;
          i = obj.next;
        }
      }
      if (!end(t, i)) return null;
      // «знать человека» — другой глагол («Сона вовза из саг», PaydaDosh); здесь только «знать что-то»
      if (verb.v.id === "знать" && obj && (obj.pron || obj.person)) return null;
      return { who, obj, neg, verb, inf };
    },
    build(b, ctx, G, q) {
      const v = b.verb.v;
      const objCls = b.obj ? G.cls(b.obj, ctx) : "д";
      if (!objCls) return null;
      let form;
      if (b.neg && v.neg) form = [v.neg];
      else {
        const f = G.verb(v, b.verb.tense === "past" ? "past" : "pres", objCls);
        if (!f) return null;
        form = b.neg ? ["ца", f] : [f];
      }
      const obj = b.obj ? G.words(b.obj, ctx) : b.inf ? [b.inf.inf] : [];
      const who = G.pron(b.who, "dat", ctx);
      // вопрос к собеседнику: «ГӀалгӀай мотт хов хьона?»
      if (q && obj.length) return [...obj, ...form, who];
      return [who, ...obj, ...form];
    },
  },
  {
    id: "understand",
    name: "«Я (не) понимаю»",
    examples: [["Ты не понимаешь", "Хьо кхетац"], ["Они не понимают", "Уж кхетац"]],
    match(t) {
      let i = 0;
      if (!is(t, i, "pron") || t[i].case !== "nom") return null;
      const who = t[i].p; i++;
      let neg = false;
      if (is(t, i, "neg")) { neg = true; i++; }
      if (!is(t, i, "verb") || t[i].v.type !== "prog") return null;
      const verb = t[i]; i++;
      if (!end(t, i)) return null;
      return { who, neg, verb, fem: verb.fem };
    },
    build(b, ctx, G) {
      // «Хьо кхетац», «Со кхетац» — как чаще всего у носителей в разговорнике
      return [G.pron(b.who, "nom", ctx), b.neg ? b.verb.v.neg : b.verb.v.pres];
    },
  },
  {
    id: "motion",
    name: "Идти, жить, прийти (кто — в именительном: со, хьо; глагол по классу: вода / йода)",
    examples: [["Я иду на работу", "Со балха вода"], ["Он живёт в Назрани", "Из Назране вахаш ва"], ["Куда ты идёшь?", "Мича вода хьо?"], ["Где ты живёшь?", "Мича вах хьо?"]],
    match(t, G) {
      let i = 0, qw = null;
      if (is(t, i, "q") && (t[i].w === "куда" || t[i].w === "где")) { qw = t[i].w; i++; }
      const subj = G.np(t, i, { nom: true });
      if (!subj) return null;
      i = subj.next;
      let neg = false;
      if (is(t, i, "neg")) { neg = true; i++; }
      if (!is(t, i, "verb") || t[i].v.type !== "intr" || t[i].tense === "inf") return null;
      // «идти», «приходить» — только про людей («снег идёт» — другой глагол)
      if (t[i].v.person && !(subj.pron || subj.person)) return null;
      const verb = t[i]; i++;
      let place = null;
      if (!qw && !end(t, i)) {
        place = G.place(t, i, verb.v.id === "жить" ? "where" : "to");
        if (!place) return null;
        i = place.next;
      }
      if (!end(t, i)) return null;
      if (qw === "где" && verb.v.id !== "жить") return null;
      if (qw === "куда" && verb.v.id === "жить") return null;
      return { qw, subj, neg, verb, place };
    },
    build(b, ctx, G) {
      const cls = G.cls(b.subj, ctx);
      if (!cls) return null;
      const v = b.verb.v, past = b.verb.tense === "past";
      const subj = G.words(b.subj, ctx);
      if (b.qw) {
        const f = G.verb(v, past ? "past" : "pres", cls);
        return f ? ["мича", ...(b.neg ? ["ца"] : []), f, ...subj] : null;
      }
      const place = b.place ? b.place.words : [];
      // «жить» в настоящем — длительная форма: «Со укхаза вахаш ва», «Из Назране вахаш ва»
      if (v.prog && !past) return [...subj, ...place, v.part[cls], G.cop(cls, b.neg ? "neg" : "pres")];
      const f = G.verb(v, past ? "past" : "pres", cls);
      if (!f) return null;
      return [...subj, ...place, ...(b.neg ? ["ца"] : []), f];
    },
  },
  {
    id: "transitive",
    name: "Писать, пить, говорить, делать (кто — в эргативе: аз, Ӏа, цо)",
    examples: [["Я пишу", "Аз язду"], ["Что ты делаешь?", "Фу ду Ӏа?"]],
    match(t, G) {
      let i = 0, what = false;
      if (is(t, i, "q") && t[i].w === "что") { what = true; i++; }
      if (!is(t, i, "pron") || t[i].case !== "nom") return null;
      const who = t[i].p; i++;
      let neg = false;
      if (is(t, i, "neg")) { neg = true; i++; }
      if (!is(t, i, "verb") || t[i].v.type !== "erg" || t[i].tense === "inf") return null;
      const verb = t[i]; i++;
      let obj = null;
      if (!what && !end(t, i)) {
        obj = G.np(t, i, { acc: true });
        if (!obj) return null;
        i = obj.next;
      }
      if (!end(t, i)) return null;
      return { what, who, neg, verb, obj };
    },
    build(b, ctx, G) {
      const objCls = b.obj ? G.cls(b.obj, ctx) : "д";
      const f = objCls && G.verb(b.verb.v, b.verb.tense === "past" ? "past" : "pres", objCls);
      if (!f) return null;
      const who = G.pron(b.who, "erg", ctx);
      if (b.what) return ["фу", f, who];
      return [who, ...(b.obj ? G.words(b.obj, ctx) : []), ...(b.neg ? ["ца"] : []), f];
    },
  },
  {
    id: "name",
    name: "«Меня зовут Увайс», «Как тебя зовут?» (са цӀи … я)",
    // PaydaDosh: «Меня зовут Увайс. — Са цӀи Увайс я.», «Меня зовут Яха — Са цӀи яха я», «Меня зовут … — Са цӀи … я.»,
    // «Как тебя (вас) зовут? — Хьа цӀи мишта я?»; цӀи — класс й (связка «я»). Имя не переводится и не склоняется.
    examples: [["Меня зовут Увайс", "Са цӀи Увайс я"], ["Меня зовут Яха", "Са цӀи Яха я"], ["Как тебя зовут?", "Хьа цӀи мишта я?"]],
    match(t) {
      let i = 0, how = false;
      if (is(t, i, "q") && t[i].w === "как") { how = true; i++; }
      if (!is(t, i, "pron") || t[i].case !== "acc") return null;
      const who = t[i].p; i++;
      if (!t[i] || t[i].w !== "зовут") return null; i++;
      if (how) return end(t, i) ? { who, how } : null;
      // имя — одно слово, в тексте с большой буквы (как его написали — так и остаётся)
      if (!t[i] || !t[i].o || !/^[А-ЯЁ]/.test(t[i].o) || !end(t, i + 1)) return null;
      return { who, name: t[i].o };
    },
    build(b, ctx, G) {
      const gen = G.pron(b.who, "gen", ctx);
      if (!gen) return null;
      return b.how ? [gen, "цӀи", "мишта", "я"] : [gen, "цӀи", b.name, "я"];
    },
  },
  {
    // последним: «кто/что — какой / где / кто» подходит ко многому, поэтому сначала пробуются правила выше
    id: "copula",
    name: "«Это моя мать», «Он хороший человек», «Я дома» (связка ва / я / да / ба)",
    examples: [["Это моя мать", "Ер са нана я"], ["Он хороший человек", "Из дика саг ва"], ["Я дома", "Со цӀагӀа ва"], ["Ты здоров?", "Могаш вий хьо?"], ["Я готов", "Со кийча ва"]],
    match(t, G) {
      let i = 0, subj;
      if (is(t, i, "eto")) { subj = { eto: true, next: i + 1 }; }
      else subj = G.np(t, i, { nom: true });
      if (!subj) return null;
      i = subj.next;
      if (is(t, i, "dash") || (!subj.eto && is(t, i, "eto"))) i++;
      let neg = false, past = false, fem = false;
      if (is(t, i, "neg")) { neg = true; i++; }
      if (is(t, i, "cop")) { past = true; fem = t[i].fem; i++; }
      if (end(t, i)) return null;
      let pred;
      if (is(t, i, "state")) { pred = { state: t[i].inh, next: i + 1 }; fem = fem || t[i].fem; }
      else {
        // сначала целая группа («хороший человек»), потом одно прилагательное («хороший»)
        const full = G.np(t, i, { nom: true });
        pred = full && end(t, full.next) ? full : G.np(t, i, { adjOnly: true });
      }
      if (!pred || !end(t, pred.next)) return null;
      if (pred.pron) return null; // «он — я» и т.п. не переводим
      // «Мать сын», «Масло подсолнечное» — подписи, а не предложения. Существительное-подлежащее берём,
      // только если при нём «мой / этот» или после него тире, или сказуемое — слово-состояние («Мама дома»).
      if (subj.noun && !subj.det && !pred.state && !t.some((x) => x.k === "dash")) return null;
      if (pred.noun && !pred.cls) return null;
      return { subj, pred, neg, past, fem };
    },
    build(b, ctx, G, q) {
      // класс: у «это» — по сказуемому («Ер са нана я»), иначе — по подлежащему («Из дика саг ва»)
      const cls = b.subj.eto ? (b.pred.noun ? G.cls(b.pred, ctx) : "д") : G.cls(b.subj, ctx);
      if (!cls) return null;
      const pred = b.pred.state ? [b.pred.state] : G.words(b.pred, ctx, b.pred.adjOnly ? cls : undefined);
      if (!pred) return null;
      // «Это хорошо → Из дика да», «Это моя мать → Ер са нана я» (PaydaDosh)
      const subj = b.subj.eto ? [b.pred.noun ? "ер" : "из"] : G.words(b.subj, ctx);
      const kind = b.past ? (b.neg ? "pastNeg" : "past") : b.neg ? "neg" : q ? "q" : "pres";
      const cop = G.cop(cls, kind);
      if (!cop) return null;
      // вопрос «да / нет»: сначала сказуемое и связка — «Могаш вий хьо?»
      if (q && !b.neg && !b.past) return [...pred, cop, ...subj];
      return [...subj, ...pred, cop];
    },
  },
  {
    // самым последним: фраза — одна группа слов без сказуемого («Мой брат», «Хорошая весть», «Эта книга»)
    id: "np",
    name: "Чей-то родственник или вещь без сказуемого: «Мой сын», «Твой брат» (са воӀ, хьа воша)",
    // PaydaDosh: «Мой сын — Са воӀ.», «Твой брат — Хьа воша», «мой дом — са цӀа», «моя мама — са нана».
    // Только «мой/твой/наш… + одно слово»: с прилагательными («быстрый конь — кадай говр») носители часто берут
    // другое слово, чем словарь, и точность падала ниже остальных правил.
    examples: [["Мой сын", "Са воӀ"], ["Твой брат", "Хьа воша"], ["мой дом", "Са цӀа"]],
    match(t, G, q, text) {
      // восклицание («Доброе утро!», «Счастливого пути!») — пожелание, у носителей это целая фраза («Ӏуйре дика хийла»)
      if (/[!?…]\s*$|\.\.\.\s*$/.test(text || "")) return null;
      // прилагательное — только в именительном («счастливого пути» — родительный: так не собрать)
      if (t.some((x) => x.k === "word" && /(ого|его|ому|ему|ым|им|ых|их|ую|юю|ой)$/.test(x.w) && !/(ый|ий)$/.test(x.w))) return null;
      if (!t[0] || t[0].k !== "poss" || t[0].p === "свой") return null;
      const np = G.np(t, 0, { nom: true });
      if (!np || np.pron || !end(t, np.next) || np.next !== 2) return null;
      return { np, text };
    },
    build(b, ctx, G) {
      const w = G.words(b.np, ctx);
      // только слова словаря проекта и библиотеки слов: у редких записей значения часто другие («весть — бӀил»)
      if (!w || !w.every((x) => G.core(x))) return null;
      // обратно должно получиться то же русское: «Моя девушка» → «Са йоӀ» — это «моя дочь», такое не даём
      const nrm = (x) => String(x).toLowerCase().replace(/ё/g, "е").replace(/[.,!?…]/g, "").replace(/\s+/g, " ").trim();
      const r = G.back(w.join(" "));
      return r && r.variants.some((v) => nrm(v.text) === nrm(b.text)) ? w : null;
    },
  },
];

module.exports = { RULES };
