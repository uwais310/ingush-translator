// Перевод по правилам с ингушского на русский (без ИИ). Те же типы предложений, что и в обратную сторону
// (lib/rules/grammar.js), и та же библиотека слов (lib/rules/lexicon.js), только прочитанная наоборот:
//   «Ер са нана я» → «Это моя мать», «Сога машен я» → «У меня есть машина», «Тика мичахьа я?» → «Где магазин?»,
//   «Сона хьо веза» → «Я тебя люблю», «Со балха вода» → «Я иду на работу», «Аз хий мол» → «Я пью воду».
// Ингушские слова, которых нет в библиотеке, ищутся в словаре (словарик проекта и PaydaDosh).
// Русские окончания — lib/rules/russian.js. Если слово или форма не нашлись, правило молчит.

const L = require("./lexicon.js");
const R = require("./russian.js");

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ").replace(/[̀́]/g, "");
const noParens = (s) => String(s).replace(/\([^()]*\)/g, " ");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = function makeReverse({ RET }) {
  // ---------- библиотека слов, прочитанная наоборот ----------
  const PRON = new Map(); // форма → [{ p, case }]
  const addP = (f, p, c) => { if (!f) return; const k = low(f); if (!PRON.has(k)) PRON.set(k, []); PRON.get(k).push({ p, case: c }); };
  for (const [p, P] of Object.entries(L.PRONOUNS)) {
    for (const c of ["nom", "erg", "gen", "dat", "all"]) addP(P[c], p, c);
    if (P.alt) for (const c of Object.keys(P.alt)) addP(P.alt[c], p, c);
  }
  const pron = (w, c) => (PRON.get(w) || []).filter((x) => x.case === c);
  const COP = new Map();
  for (const [kind, t] of Object.entries(L.COPULA)) for (const [cls, f] of Object.entries(t)) COP.set(low(f), { kind, cls });
  const VERB = new Map(); // форма → [{ v, tense, cls }]
  const addV = (f, info) => { const k = low(f); if (!VERB.has(k)) VERB.set(k, []); VERB.get(k).push(info); };
  for (const v of L.VERBS) {
    for (const tense of ["pres", "past", "part", "neg", "inf"]) {
      const f = v[tense];
      if (!f) continue;
      if (typeof f === "string") addV(f, { v, tense, cls: null });
      else for (const [cls, form] of Object.entries(f)) addV(form, { v, tense, cls });
    }
  }
  const verbsOf = (w, test) => (VERB.get(w) || []).filter(test);
  // слова-состояния: «цӀагӀа» → «дома», «кийча» → готов / готова / готовы
  const STATE = new Map();
  for (const [ru, inh] of Object.entries(L.STATES)) {
    const k = low(inh);
    const e = STATE.get(k) || {};
    if (L.FEMININE_STATES.has(ru)) e.f = ru;
    else if (/ы$/.test(ru) && e.m) e.pl = ru;
    else if (!e.m) e.m = ru;
    STATE.set(k, e);
  }
  const stateRu = (inh, g) => { const e = STATE.get(inh); if (!e) return null; return (g === "f" && e.f) || (g === "pl" && e.pl) || e.m; };
  const Q = {};
  for (const [ru, inh] of Object.entries(L.QUESTION_WORDS)) if (!Q[low(inh)]) Q[low(inh)] = ru;
  const POSS = { "са": "мой", "хьа": "твой", "тха": "наш", "вай": "наш", "шун": "ваш", "цун": "его", "цар": "их", "сай": "свой", "хьай": "свой", "шоай": "свой", "ший": "свой" };
  const DEM = { "ер": "этот", "из": "этот" };
  // места: «балха» → «на работу», «Назране» → «в Назрани» (где) / «в Назрань» (куда)
  const PLACE = {
    "балха": { to: "на работу" }, "ишколе": { to: "в школу" }, "школе": { to: "в школу" },
    "москве": { to: "в Москву", at: "в Москве" }, "назране": { to: "в Назрань", at: "в Назрани" }, "казане": { to: "в Казань", at: "в Казани" },
    "соче": { to: "в Сочи", at: "в Сочи" }, "самаре": { to: "в Самару", at: "в Самаре" },
    "укхаза": { at: "здесь" }, "цига": { at: "там" },
  };
  const REV_ADJ = {};
  for (const [ru, inh] of Object.entries(L.ADJECTIVES)) REV_ADJ[low(inh)] = ru;
  const REV_ATTESTED = {};
  for (const [ru, [inh, cls]] of Object.entries(L.ATTESTED_CLASS)) if (!REV_ATTESTED[low(inh)]) REV_ATTESTED[low(inh)] = { ru, cls };
  // «да» — и связка, и «отец»: связку узнаём по месту в предложении, поэтому здесь её нет
  const CLOSED = new Set([...PRON.keys(), ...VERB.keys(), ...Object.keys(Q), "ца", "ма", "а", "е"]);
  // числа перед существительным: «ши кийла» — два килограмма (2–4: существительное в родительном падеже)
  const NUM = { "цхьа": 1, "ши": 2, "кхо": 3, "ди": 4 };

  // ---------- существительные и прилагательные из словаря ----------
  const firstSense = (ru) => noParens(ru).split(/[,;]|\s\/\s|\d\)/)[0].replace(/[.!?]/g, "").trim().toLowerCase();
  const entryClass = (it) => {
    // только первое слово записи: «саг (мн. нах) / адам (д/д…)» — класс «д» относится к «адам»
    const m = /\(\s*([вйдб])\s*(?:\/|;|\)|,)/.exec(String(it.line || it.inh).split(" / ")[0]);
    if (m) return m[1];
    const n = it.seed && it.seed.license ? /^([вйдб])(?:\s*[-,/]\s*[вйдб])?$/.exec(String(it.seed.note || "").trim()) : null;
    return n ? n[1] : null;
  };
  function nounOf(w) {
    if (CLOSED.has(w) || STATE.has(w) || PLACE[w]) return null;
    if (REV_ATTESTED[w]) return { ru: REV_ATTESTED[w].ru, cls: REV_ATTESTED[w].cls };
    const r = RET.lookupWord(w, "inh", 6);
    if (!r || r.lemma) return null; // только та же форма слова: «нанас» — уже другой падеж
    for (const it of r.items) {
      if (it.prio > 1) continue;
      const ru = firstSense(it.ru);
      // глаголы («делать», «идти») отсеиваются сами: у них нет рода; «выбраться» — по -ся
      if (!ru || /\s/.test(ru) || /(ый|ий|ой|ся|сь)$/.test(ru) || /[a-z]/.test(ru)) continue;
      if (!R.gender(ru)) continue;
      // только слово с классом в словаре: так это точно существительное («духьала» — не «напротив»)
      const cls = L.PERSON_CLASS[ru] || entryClass(it);
      if (!cls && !L.PEOPLE.has(ru) && !R.gender(ru).startsWith("pl")) continue;
      return { ru, cls };
    }
    return null;
  }
  function adjOf(w) {
    if (REV_ADJ[w]) return REV_ADJ[w];
    if (CLOSED.has(w)) return null;
    const r = RET.lookupWord(w, "inh", 6);
    if (!r || r.lemma) return null;
    for (const it of r.items) {
      if (it.prio > 1) continue;
      const ru = firstSense(it.ru);
      if (ru && !/\s/.test(ru) && /(ый|ий|ой)$/.test(ru)) return ru;
    }
    return null;
  }

  // Группа слов t[i..j): «(ер) (са) (хоза) нана» → { noun, g, anim, render(kase) }
  function np(t, i, j) {
    if (j - i < 1) return null;
    let k = i;
    const dem = DEM[t[k]] && j - i > 1 ? DEM[t[k++]] : null;
    const pos = POSS[t[k]] && j - k > 1 ? { lemma: POSS[t[k]], of: t[k++] } : null;
    const num = NUM[t[k]] && j - k > 1 ? NUM[t[k++]] : null;
    const adjs = [];
    while (k < j - 1) { const a = adjOf(t[k]); if (!a) return null; adjs.push(a); k++; }
    if (k !== j - 1) return null;
    const n = nounOf(t[k]);
    if (!n) return null;
    const g = R.gender(n.ru);
    if (!g) return null;
    const anim = R.animate(n.ru);
    if (num && (g === "pl" || adjs.length || dem || pos || (num > 1 && anim))) return null;
    const render = (kase = "nom") => {
      if (num) {
        // «два килограмма», «одна книга»; винительный у неодушевлённых тот же
        const one = { m: "один", f: "одна", n: "одно" }[g];
        if (num === 1) return kase === "gen" ? null : `${one} ${kase === "acc" ? R.acc(n.ru) : n.ru}`;
        const word = num === 2 ? (g === "f" ? "две" : "два") : num === 3 ? "три" : "четыре";
        const gs = R.gen(n.ru);
        return kase === "gen" || !gs ? null : `${word} ${gs}`;
      }
      const noun = kase === "acc" ? R.acc(n.ru) : kase === "gen" ? R.gen(n.ru) : n.ru;
      if (!noun) return null;
      const out = [];
      if (dem) out.push(R.poss(dem, g, kase === "gen" ? "nom" : kase, anim));
      if (pos) out.push(R.poss(pos.lemma, g, kase === "gen" ? "nom" : kase, anim));
      for (const a of adjs) out.push(R.adj(a, g, kase === "gen" ? "nom" : kase, anim));
      if (kase === "gen" && (dem || pos || adjs.length)) return null; // «нет моей машины» — пока не собираем
      out.push(noun);
      return out.some((x) => !x) ? null : out.join(" ");
    };
    return { noun: n.ru, cls: n.cls, g: num > 1 ? "n" : g, anim, det: !!(dem || pos), pos, num, render };
  }

  // местоимение-подлежащее (со, хьо, из, тхо, вай, шо, уж) и его род по классу связки или глагола
  function subjPron(w, cls) {
    const c = pron(w, "nom");
    if (!c.length) return null;
    let p = c[0].p;
    if (w === "из") {
      if (cls === "д" || cls === "б") return null; // «Из дика да» — «это», а не «он»
      p = cls === "й" ? "она" : "он";
    }
    return { p, g: R.pronGender(p, cls) };
  }
  const PRON_NOM_RU = (p) => p;

  // ---------- правила ----------
  const RULES = [
    {
      id: "have", name: "«У меня есть / нет …»",
      run(t, q) {
        // Сога машен я / Сога ахча дац / Ахча дий хьога? / Дий хьога из книжка?
        const last = COP.get(t[t.length - 1]);
        if (pron(t[0], "all").length && last && (last.kind === "pres" || last.kind === "neg")) {
          const who = pron(t[0], "all")[0].p, n = np(t, 1, t.length - 1);
          if (!n || n.anim) return null;
          const thing = n.render(last.kind === "neg" ? "gen" : "nom");
          if (!thing) return null;
          return [`${R.PRON_GEN_U[who]} ${last.kind === "neg" ? "нет" : "есть"} ${thing}`];
        }
        if (q && t.length >= 3) {
          const a = pron(t[t.length - 1], "all"), c = COP.get(t[t.length - 2]);
          if (a.length && c && c.kind === "q") { const n = np(t, 0, t.length - 2); if (n && !n.anim) return [`${R.PRON_GEN_U[a[0].p]} есть ${n.render("nom")}`]; }
          const c0 = COP.get(t[0]), a1 = pron(t[1], "all");
          if (c0 && c0.kind === "q" && a1.length) { const n = np(t, 2, t.length); if (n && !n.anim) return [`${R.PRON_GEN_U[a1[0].p]} есть ${n.render("nom")}`]; }
        }
        return null;
      },
    },
    {
      id: "where", name: "«Где …?»",
      run(t) {
        // Мичахьа ва хьо? / Тика мичахьа я? / Мича дар шо?
        if (t.length === 3 && (t[0] === "мичахьа" || t[0] === "мича") && COP.get(t[1])) {
          const c = COP.get(t[1]), s = subjPron(t[2], c.cls);
          if (!s) return null;
          if (c.kind === "pres") return [`где ${s.p}`];
          if (c.kind === "past") return [`где ${s.p} ${R.COP_PAST[s.g]}`];
          return null;
        }
        if (t.length >= 3 && t[t.length - 2] === "мичахьа" && COP.get(t[t.length - 1]) && COP.get(t[t.length - 1]).kind === "pres") {
          const n = np(t, 0, t.length - 2);
          return n ? [`где ${n.render("nom")}`] : null;
        }
        return null;
      },
    },
    {
      id: "dative", name: "Знать, любить, нужно, видеть, слышать, хотеть, думать (сона, хьона…)",
      run(t, q) {
        // Сона хов / Сона хац / Сона хьо веза / Сона талмач веза / ГӀалгӀай мотт хов хьона? / Сона мала лов
        let who, rest, verbAt;
        const d0 = pron(t[0], "dat"), dl = pron(t[t.length - 1], "dat");
        if (d0.length) { who = d0; rest = [1, t.length - 1]; verbAt = t.length - 1; }
        else if (q && dl.length) { who = dl; rest = [0, t.length - 2]; verbAt = t.length - 2; }
        else return null;
        let neg = false, [a, b] = rest;
        const vs = verbsOf(t[verbAt], (x) => ["dat", "need"].includes(x.v.type) && (x.tense === "pres" || x.tense === "neg"));
        if (!vs.length) return null;
        if (t[b - 1] === "ца") { neg = true; b--; }
        const subjs = who.map((x) => x.p); // цунна — он или она
        const outs = [];
        for (const p of subjs) {
          for (const vf of vs) {
            const v = vf.v, isNeg = neg || vf.tense === "neg";
            const objPron = b - a === 1 ? subjPron(t[a], vf.cls) : null;
            if (v.id === "любить" || v.id === "нужен") {
              if (objPron) { // Сона хьо веза → Я тебя люблю
                const love = L.VERBS.find((x) => x.id === "любить");
                outs.push(`${p} ${R.PRON_ACC[objPron.p]} ${isNeg ? "не " : ""}${R.verbPres(love, p)}`);
                continue;
              }
              const n = np(t, a, b);
              if (!n || (n.cls && n.cls !== vf.cls)) continue;
              const need = `${R.PRON_DAT[p]} ${isNeg ? "не " : ""}${{ m: "нужен", f: "нужна", n: "нужно", pl: "нужны" }[n.g]} ${n.render("nom")}`;
              const loveV = L.VERBS.find((x) => x.id === "любить"), acc = n.render("acc");
              const love = acc ? `${p} ${isNeg ? "не " : ""}${R.verbPres(loveV, p)} ${acc}` : null;
              // со «своим»: «Сона сай нана еза» — люблю; без него чаще «нужен» («Сона талмач веза», PaydaDosh)
              // «свою маму» с «нужна» звучит неправильно — со «своим» только «люблю»
              if (n.pos && n.pos.lemma === "свой") { if (love) outs.push(love); }
              else if (n.pos) { if (love) outs.push(love); outs.push(need); } else { outs.push(need); if (love) outs.push(love); }
              continue;
            }
            const form = R.verbPres(v, p);
            if (!form) continue;
            let obj = "";
            if (b > a) {
              const inf = b - a === 1 ? verbsOf(t[a], (x) => x.tense === "inf") : [];
              if (v.id === "хотеть" && inf.length && inf[0].v.ru.inf) obj = inf[0].v.ru.inf[0];
              else if (objPron && v.id !== "знать") obj = R.PRON_ACC[objPron.p];
              else { const n = np(t, a, b); if (!n || (v.id === "знать" && n.anim)) continue; obj = n.render("acc"); if (!obj) continue; }
            }
            outs.push(`${p} ${isNeg ? "не " : ""}${form}${obj ? " " + obj : ""}`);
          }
        }
        return outs.length ? outs : null;
      },
    },
    {
      id: "understand", name: "«Я (не) понимаю»",
      run(t) {
        // Хьо кхетац / Со кхета / Со кхеташ вац
        const v = L.VERBS.find((x) => x.id === "понимать");
        if (t.length === 2 && (t[1] === low(v.pres) || t[1] === low(v.neg))) {
          const s = subjPron(t[0], null);
          if (!s) return null;
          const tail = `${t[1] === low(v.neg) ? "не " : ""}${R.verbPres(v, s.p)}`;
          return t[0] === "из" ? [`он ${tail}`, `она ${tail}`] : [`${s.p} ${tail}`];
        }
        if (t.length === 3 && t[1] === low(v.part) && COP.get(t[2])) {
          const c = COP.get(t[2]), s = subjPron(t[0], c.cls);
          if (!s || (c.kind !== "pres" && c.kind !== "neg")) return null;
          return [`${s.p} ${c.kind === "neg" ? "не " : ""}${R.verbPres(v, s.p)}`];
        }
        return null;
      },
    },
    {
      id: "motion", name: "Идти, жить, приходить (со вода, вахаш ва)",
      run(t, q) {
        // Мича вода хьо? / Мича вах хьо?
        if (q && t.length === 3 && t[0] === "мича") {
          const vs = verbsOf(t[1], (x) => x.v.type === "intr" && x.tense === "pres");
          for (const vf of vs) {
            const s = subjPron(t[2], vf.cls);
            if (!s || (vf.cls && R.pronGender(s.p, vf.cls) !== s.g)) continue;
            const form = R.verbPres(vf.v, s.p);
            if (form) return [`${vf.v.id === "жить" ? "где" : "куда"} ${s.p} ${form}`];
          }
          return null;
        }
        // Со балха вода / Ишколе вода со / Со укхаза вахаш ва / Из Назране вахаш ва / КӀаьнк ишколе вода
        let words = t.slice(), copc = null;
        if (COP.get(words[words.length - 1]) && words.length >= 3) { copc = COP.get(words.pop()); }
        // глагол — последний или предпоследний (если подлежащее в конце)
        const tryOrder = (subjFirst) => {
          const ws = words.slice();
          let subjTok;
          if (subjFirst) subjTok = ws.shift(); else subjTok = ws.pop();
          const vTok = ws.pop();
          if (!vTok) return null;
          const vs = verbsOf(vTok, (x) => x.v.type === "intr" && (copc ? x.tense === "part" : x.tense === "pres" || x.tense === "past"));
          if (!vs.length) return null;
          let neg = false;
          if (ws[ws.length - 1] === "ца") { neg = true; ws.pop(); }
          if (ws.length > 1) return null;
          for (const vf of vs) {
            const cls = copc ? copc.cls : vf.cls;
            if (copc && vf.cls && vf.cls !== copc.cls) continue;
            let s = subjPron(subjTok, cls), subjRu, p;
            if (s) { subjRu = s.p; p = s.p; }
            else if (subjFirst) { const n = np([subjTok], 0, 1); if (!n || !n.anim) continue; subjRu = n.render("nom"); p = n.g === "pl" ? "они" : n.g === "f" ? "она" : "он"; s = { g: n.g }; }
            else continue;
            const isNeg = neg || (copc && copc.kind === "neg");
            let place = "";
            if (ws.length) {
              const pl = PLACE[ws[0]];
              const want = vf.v.id === "жить" ? "at" : "to";
              if (!pl || !pl[want]) continue;
              place = pl[want];
            }
            const past = vf.tense === "past";
            const form = past ? R.verbPast(vf.v, s.g) : R.verbPres(vf.v, p);
            if (!form) continue;
            return [`${subjRu} ${isNeg ? "не " : ""}${form}${place ? " " + place : ""}`];
          }
          return null;
        };
        return tryOrder(true) || tryOrder(false);
      },
    },
    {
      id: "transitive", name: "Писать, пить, читать, говорить, делать (аз, Ӏа, цо…)",
      run(t, q) {
        // Фу ду Ӏа? / Аз язду / Аз хий мол
        if (q && t.length === 3 && t[0] === "фу") {
          const e = pron(t[2], "erg"), vs = verbsOf(t[1], (x) => x.v.type === "erg" && x.tense === "pres");
          if (e.length && vs.length) return [`что ${e[0].p} ${R.verbPres(vs[0].v, e[0].p)}`];
          return null;
        }
        const e = pron(t[0], "erg");
        if (!e.length) return null;
        const vs = verbsOf(t[t.length - 1], (x) => x.v.type === "erg" && x.tense === "pres");
        if (!vs.length) return null;
        let b = t.length - 1, neg = false;
        if (t[b - 1] === "ца") { neg = true; b--; }
        const p = e[0].p, form = R.verbPres(vs[0].v, p);
        if (!form) return null;
        let obj = "";
        if (b > 1) { const n = np(t, 1, b); if (!n) return null; obj = n.render("acc"); if (!obj) return null; }
        return [`${p} ${neg ? "не " : ""}${form}${obj ? " " + obj : ""}`];
      },
    },
    {
      id: "copula", name: "«Это моя мать», «Он хороший человек», «Я дома» (ва / я / да / ба)",
      run(t, q) {
        const outs = [];
        // вопрос: «Могаш вий хьо?», «ЦӀагӀа дий шо?» — сказуемое, связка-вопрос, подлежащее
        if (q && t.length >= 3 && COP.get(t[t.length - 2]) && COP.get(t[t.length - 2]).kind === "q") {
          const c = COP.get(t[t.length - 2]), s = subjPron(t[t.length - 1], c.cls);
          if (s) {
            const pred = predicate(t, 0, t.length - 2, s.g, c, true, false, ["я", "ты", "мы", "вы"].includes(s.p));
            if (pred) outs.push(`${s.p} ${pred}`);
          } else if (t[t.length - 1] === "ер" || t[t.length - 1] === "из") {
            const st = t.length === 3 ? stateRu(t[0], "n") : null;
            if (st && c.cls === "д") outs.push(`это ${st}`);
          }
          return outs.length ? outs : null;
        }
        const c = COP.get(t[t.length - 1]);
        if (!c || c.kind === "q" || t.length < 3) return null;
        const neg = c.kind === "neg" || c.kind === "pastNeg", past = c.kind === "past" || c.kind === "pastNeg";
        const end = t.length - 1;
        // подлежащее — местоимение: «Со цӀагӀа ва», «Из дика саг ва», «Хьо са доттагӀа ва»
        const s = subjPron(t[0], c.cls);
        // «Да цӀагӀа вац» — «Отца нет дома» (так в разговорнике), а не «Отец не дома»
        if (c.kind === "neg" && end - 1 >= 1 && LOCATION_STATES.has(stateRu(t[end - 1], "m") || "")) {
          const place = stateRu(t[end - 1], "m");
          if (s && end === 2) return [`${R.PRON_ACC[s.p]} нет ${place}`];
          const n = np(t, 0, end - 1);
          if (n && !n.num) { const g2 = n.render("gen"); if (g2) return [`${g2} нет ${place}`]; }
        }
        if (s && t[0] !== "из") {
          const pred = predicate(t, 1, end, s.g, c, false, false, ["я", "ты", "мы", "вы"].includes(s.p));
          if (pred) outs.push(`${s.p} ${pred}`);
        }
        // «ер / из» — «это»: «Ер са нана я», «Из дика да»; «из» с классом в / й — ещё и «он / она»
        if (t[0] === "ер" || t[0] === "из") {
          const n = np(t, 1, end);
          if (n && (!n.cls || n.cls === c.cls)) {
            const cop = past ? R.COP_PAST[n.g] + " " : "";
            outs.push(`это ${neg ? "не " : ""}${cop}${n.render("nom")}`);
            if (t[0] === "из" && (c.cls === "в" || c.cls === "й")) outs.push(`${c.cls === "й" ? "она" : "он"} ${neg ? "не " : ""}${past ? R.COP_PAST[c.cls === "й" ? "f" : "m"] + " " : ""}${n.render("nom")}`);
          } else if (end === 2) {
            const st = stateRu(t[1], "n");
            if (st && c.cls === "д") outs.push(`это ${neg ? "не " : ""}${past ? "было " : ""}${st}`);
            else if (t[0] === "из" && (c.cls === "в" || c.cls === "й")) {
              const g = c.cls === "й" ? "f" : "m";
              const pred = predicate(t, 1, end, g, c);
              if (pred) outs.push(`${g === "f" ? "она" : "он"} ${pred}`);
            }
          }
        }
        // подлежащее — группа слов: «Са да лор ва», «Нана цӀагӀа я», «Са нана хоза я»
        if (!outs.length) {
          for (let k = end - 1; k >= 1; k--) {
            const n = np(t, 0, k);
            if (!n || (n.cls && n.cls !== c.cls)) continue;
            const pred = predicate(t, k, end, n.g, c, false, true);
            if (pred) { outs.push(`${n.render("nom")}${pred.startsWith("—") ? " " : " "}${pred}`); break; }
          }
        }
        return outs.length ? outs : null;
      },
    },
  ];

  const LOCATION_STATES = new Set(["дома", "здесь", "тут", "там"]);
  // Сказуемое t[a..b): состояние («цӀагӀа» → «дома»), прилагательное («хоза» → «красивая»), группа слов.
  function predicate(t, a, b, g, c, question = false, nounSubj = false, firstSecond = false) {
    const neg = c.kind === "neg" || c.kind === "pastNeg", past = c.kind === "past" || c.kind === "pastNeg";
    const pre = `${neg ? "не " : ""}${past ? R.COP_PAST[g] + " " : ""}`;
    if (b - a === 1) {
      const st = stateRu(t[a], g);
      const adj = adjOf(t[a]);
      // «хоза»: о вещи «это» — «красиво», о человеке или предмете — «красивая / красивый»
      const adverb = st && !LOCATION_STATES.has(st) && !STATE.get(t[a]).f && !STATE.get(t[a]).pl;
      if (st && (!adverb || g === "n")) return pre + st;
      // «Со меца ва» — по-русски «я голоден» (краткая форма), а не «я голодный»: для «я, ты, мы, вы» не собираем
      if (adj && !firstSecond) { const f = R.adj(adj, g); return f ? pre + f : null; }
      if (st) return null; // «Хьо бакъ ва» — не «ты правда»; наречие подходит только к «это»
      if (adj) return null;
    }
    const n = np(t, a, b);
    if (!n) return null;
    // «Мой отец — врач»: между двумя существительными — тире
    return `${nounSubj && !neg && !past ? "— " : ""}${pre}${n.render("nom")}`;
  }

  function translate(text) {
    const s = String(text || "").trim();
    if (!s || s.length > 160 || /[.!?…]\s+\S/.test(s) || /[,;:/()«»"]/.test(s)) return null;
    const q = /\?\s*$/.test(s);
    const t = low(s).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];
    if (t.length < 2 || t.length > 8) return null;
    if (t.some((w) => L.INH_FUNCTION_WORDS.has(w))) return null; // наречия — правил для них пока нет
    // имена и названия с большой буквы («Ер Эса да» — река Асса) правила не переводят
    const words = s.match(/[А-ЯЁӀа-яёӏ]+(?:-[А-ЯЁӀа-яёӏ]+)*/g) || [];
    if (words.slice(1).some((w) => /^[А-ЯЁ]/.test(w) && !PLACE[low(w)])) return null; // кроме известных городов
    const end = (/[.!?…]+\s*$/.exec(s) || [""])[0].trim();
    for (const rule of RULES) {
      let outs = null;
      try { outs = rule.run(t, q); } catch (e) { outs = null; }
      if (!outs || !outs.length) continue;
      // «цун» — и «его», и «её»
      if (t.includes("цун")) outs = outs.flatMap((o) => [o, o.replace(/(^|\s)его(\s|$)/, "$1ее$2")]);
      const uniq = [...new Set(outs.filter(Boolean).map((o) => cap(o.replace(/\s+/g, " ").trim()) + (end || (q ? "?" : ""))))];
      if (!uniq.length) continue;
      return { translation: uniq[0], variants: uniq.map((x, i) => ({ text: x, note: i ? "или так" : "" })), rule: rule.id, ruleName: rule.name };
    }
    return null;
  }
  return { translate, RULES };
};
