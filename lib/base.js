// «База»: ответы без ИИ. Работает только для пары русский ↔ ингушский.
//   1. готовые фразы (проверенные, из справочника);
//   2. словарик частых слов;
//   3. таблица «как слово переводят в настоящих текстах» — только пары, которые подтверждают словари.
// Ещё: разбор текста по словам и замена чеченских форм на ингушские.
// Модуль — функция от справочника (lib/ingush-guide.js) и таблицы слов (lib/corpus-lexicon.js),
// чтобы один и тот же код работал и на сайте, и в версии для Claude.

module.exports = function makeBase(KB, LEX) {
  const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/Ӏ/g, "ӏ");
  const key = (s) => norm(s).replace(/\([^()]*\)/g, " ").replace(/[^а-яӏa-z0-9]+/g, " ").trim();
  const lastNote = (s) => { const m = /\(([^()]*)\)\s*[.!?]*\s*$/.exec(String(s).trim()); return m ? m[1] : ""; };
  const noParens = (s) => String(s).replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const push = (map, k, v) => { if (!k) return; const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };

  let IDX = null;
  function index() {
    if (IDX) return IDX;
    const phRu = new Map(), phInh = new Map(), glRu = new Map(), glInh = new Map();

    for (const [ru, inh] of KB.EXAMPLES) {
      const rs = ru.split(" / "), is = inh.split(" / ");
      const pairs = rs.length > 1 && rs.length === is.length ? rs.map((r, i) => [r, [is[i]]]) : rs.map((r) => [r, is]);
      for (const [r, list] of pairs) {
        for (const i of list) {
          push(phRu, key(r), { text: i.trim(), meaning: lastNote(r) });
          push(phInh, key(i), { text: r.trim(), meaning: "" });
        }
      }
    }
    for (const [ru, inh] of KB.GLOSSARY) {
      const g = gloss(inh);
      push(glRu, key(ru), { ...g, sense: lastNote(ru) });
      if (g.raw) continue;
      for (const h of [g.translation, ...g.alternatives.map((a) => a.text)]) {
        for (const form of h.split("/")) push(glInh, key(form), { text: noParens(ru), meaning: lastNote(ru), line: `${ru} — ${inh}` });
      }
    }
    return (IDX = { phRu, phInh, glRu, glInh });
  }

  // Строка словарика → перевод, варианты, пояснение.
  function gloss(inh) {
    const main = noParens(inh).split(" — ")[0].trim();
    if (!main || /^(наст|прош|отдельного)/.test(main) || main.includes(";")) return { translation: inh, alternatives: [], note: "", raw: true };
    const parts = main.split(" / ").map((p) => p.trim()).filter(Boolean);
    return { translation: parts[0], alternatives: parts.slice(1).map((text) => ({ text, meaning: "" })), note: inh === main ? "" : inh, raw: false };
  }

  // Самый надёжный кандидат из таблицы текстов: только подтверждённые словарями.
  function fromTexts(word, lang) {
    const e = LEX.entry(word, lang);
    if (!e) return null;
    const sure = e.list.filter((c) => c.sure);
    if (!sure.length) return null;
    // «нанас» и «нана»: берём короткую форму, если длинная — она же с окончанием
    let best = sure[0];
    for (const c of sure) if (c !== best && norm(best.text).startsWith(norm(c.text)) && c.n * 4 >= best.n) best = c;
    return { key: e.key, exact: e.exact, best, rest: sure.filter((c) => c !== best) };
  }

  const pairOk = (src, tgt) => (src === "ru" && tgt === "inh") || (src === "inh" && tgt === "ru");
  const times = (n) => `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "раза" : "раз"}`;

  // Готовый ответ из базы или null. { translation, alternatives, note, kind, label }
  function lookup(text, src, tgt) {
    if (!pairOk(src, tgt)) return null;
    const k = key(text);
    if (!k || k.length > 120) return null;
    const { phRu, phInh, glRu, glInh } = index();

    const ph = (src === "ru" ? phRu : phInh).get(k);
    if (ph) {
      return {
        translation: ph[0].text,
        alternatives: ph.slice(1, 4),
        note: ph[0].meaning && ph.length > 1 ? `Первый вариант — ${ph[0].meaning}.` : "",
        kind: "phrase", label: "Из базы: проверенная фраза",
      };
    }

    const single = !k.includes(" ");
    const t = single ? fromTexts(k, src) : null;
    const extra = (skip) => !t ? [] : [t.best, ...t.rest]
      .filter((c) => !skip.has(norm(c.text)))
      .slice(0, 2)
      .map((c) => ({ text: c.text, meaning: `в текстах: ${times(c.n)}` }));

    if (src === "ru") {
      const g = glRu.get(k);
      if (g) {
        const alts = [...g[0].alternatives, ...g.slice(1).map((x) => ({ text: x.translation, meaning: x.sense }))];
        const seen = new Set([g[0].translation, ...alts.map((a) => a.text)].map(norm));
        return {
          translation: g[0].translation,
          alternatives: [...alts, ...(g[0].raw ? [] : extra(seen))].slice(0, 4),
          note: [g[0].sense && g.length > 1 ? `Первый вариант — «${g[0].sense}».` : "", g[0].note].filter(Boolean).join(" "),
          kind: "glossary", label: "Из базы: словарь",
        };
      }
    } else {
      const g = glInh.get(k);
      if (g) {
        const uniq = [...new Map(g.map((x) => [x.text, x])).values()];
        const seen = new Set(uniq.map((x) => norm(x.text)));
        return {
          translation: uniq[0].text,
          alternatives: [...uniq.slice(1).map((x) => ({ text: x.text, meaning: x.meaning })), ...extra(seen)].slice(0, 4),
          note: uniq[0].line,
          kind: "glossary", label: "Из базы: словарь",
        };
      }
    }

    if (t && t.exact) {
      return {
        translation: t.best.text,
        alternatives: t.rest.slice(0, 3).map((c) => ({ text: c.text, meaning: `в текстах: ${times(c.n)}` })),
        note: `Так слово «${t.key}» переведено в настоящих текстах (${times(t.best.n)}); пару подтверждают словари. Форма слова может быть с окончанием.`,
        kind: "texts", label: "Из базы: слова из настоящих текстов",
      };
    }
    return null;
  }

  // Разбор текста по словам: [{ word, text, from }] ; text === null — слова в базе нет.
  function breakdown(text, src, max = 40) {
    if (src !== "ru" && src !== "inh") return [];
    const { glRu, glInh } = index();
    const out = [], seen = new Set();
    for (const w of LEX.wordsOf(text)) {
      const k = key(w);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      let item = null;
      const g = (src === "ru" ? glRu : glInh).get(k);
      if (g) {
        // у ингушского слова может быть несколько значений («да» — отец; есть): показываем до трёх
        const text = src === "ru" ? g[0].translation : [...new Set(g.map((x) => x.text))].slice(0, 3).join(" / ");
        item = { text, from: "словарь" };
      }
      if (!item) {
        const e = LEX.entry(k, src);
        const c = e && (e.list.find((x) => x.sure) || (e.list[0].n >= 5 ? e.list[0] : null));
        if (c) item = { text: c.text, from: c.sure ? "тексты и словари" : "тексты" };
      }
      if (!item && k.length < 3) continue; // предлоги и частицы без перевода не показываем
      out.push({ word: w.replace(/ӏ/g, "Ӏ"), text: item ? item.text : null, from: item ? item.from : "" });
      if (out.length >= max) break;
    }
    return out;
  }

  // Чеченские формы, которых в ингушских текстах нет (проверено по корпусу), → ингушские.
  const CHECHEN = {
    "суна": "сона", "хӏинца": "хӏанз", "хӏун": "фу", "муха": "мишта", "стаг": "саг", "хӏума": "хӏама",
    "баркалла": "баркал", "дуьне": "дуне", "ӏуьйре": "ӏуйре", "суьйре": "сайре", "буьйса": "бийса",
    "хуьлда": "хилда", "маршалла": "моаршал", "накъост": "новкъост", "гӏуллакх": "гӏулакх",
    "кхузахь": "укхаза", "цигахь": "цига", "мичахь": "мича", "хӏокху": "укх", "хӏорш": "ераш",
    "оха": "оаха", "аша": "оаша", "тхуна": "тхона", "хаьа": "хов", "лаьа": "лов", "массо": "масса", "шен": "ший",
  };
  function chechenFix(text) {
    const fixed = [];
    const out = String(text || "").replace(/[А-Яа-яЁёӀӏ]+/g, (w) => {
      const to = CHECHEN[w.toLowerCase().replace(/Ӏ/g, "ӏ")];
      if (!to) return w;
      let r = to.replace(/ӏ/g, "Ӏ");
      if (/^[А-ЯЁ]/.test(w)) r = r[0].toUpperCase() + r.slice(1); // «Суна» → «Сона», «ХӀинца» → «ХӀанз»
      fixed.push([w, r]);
      return r;
    });
    return { text: out, fixed };
  }

  // Текст по предложениям: если каждое предложение есть в базе, ответ собирается из них.
  // resolve(часть) → { translation, verified? } или null. Возвращает { translation, verified, parts } или null.
  function compose(text, resolve) {
    const parts = String(text).match(/[^.!?…\n]+[.!?…]*/g);
    if (!parts || parts.length < 2 || parts.length > 8) return null;
    const out = [];
    let verified = true;
    for (const raw of parts) {
      const part = raw.trim();
      if (!key(part)) continue;
      const r = resolve(part);
      if (!r || !r.translation) return null;
      let t = String(r.translation).trim();
      const end = (/[.!?…]+$/.exec(part) || [""])[0];
      if (end && !/[.!?…]$/.test(t)) t += end;
      out.push(t[0].toUpperCase() + t.slice(1));
      if (!r.verified) verified = false;
    }
    return out.length >= 2 ? { translation: out.join(" "), verified, parts: out.length } : null;
  }

  return { lookup, breakdown, chechenFix, compose, gloss, key, CHECHEN };
};
