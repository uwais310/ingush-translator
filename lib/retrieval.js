// Подбор подсказок для ИИ под конкретный текст и ответы по словам без ИИ.
//
// Что делает:
//   1. normalize() — приводит текст к одному виду: строчные буквы, ё → е, палочка 1 / I / l / | → Ӏ,
//      знаки ударения убираются.
//   2. Словарь: словарик проекта (lib/ingush-guide.js) + слова из базы пар (data/phrases.json: PaydaDosh,
//      Викисловарь, Википедия, PanLex…). У записи вроде «носить, поносить; эксплуатировать» каждое значение
//      ищется отдельно, поэтому слово «носить» её находит.
//   3. Начальные формы (lib/morph.js): «люблю» находит «любить», «маму» — «мама», «веза» — «деза».
//      Если слово или его начальная форма есть в словаре, «похожие по началу» слова уже не подмешиваются
//      (раньше «поедем» находило «поедание» и «поединок»).
//   4. pickFewShots() — самые полезные пары «фраза — перевод» для ИИ: редкие слова текста весят больше
//      частых, и примеры подбираются так, чтобы вместе покрыть как можно больше слов текста.
//   5. lookupWord() — готовый ответ из словаря для слова или короткого выражения (в том числе по
//      начальной форме); breakdown() — разбор текста по словам.
//
// Модуль ничего не скачивает и не вызывает ИИ — его можно проверить на своём компьютере:
//   node scripts/try-retrieval.js "Я люблю свою маму"

const makeMorph = require("./morph.js");
const { stripStress } = makeMorph;

const LOOK = "1Il|ІіΙⅠǀӀӏ";
const PAL = new RegExp(`([\\u0400-\\u04FF])[${LOOK}]|[${LOOK}](?=[\\u0400-\\u04FF])`, "g");

// «к1ант», «кIант», «кlант», «кӀант» → «кӏант» (для сравнения; в ответе палочка остаётся Ӏ).
function normalize(s) {
  return stripStress(s)
    .replace(PAL, (m, a) => (a ? a + "ӏ" : "ӏ"))
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/Ӏ/g, "ӏ");
}
const wordsOf = (s) => normalize(s).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];
const noParens = (s) => String(s).replace(/\([^()]*\)/g, " ");

// Частые служебные слова: по ним похожие фразы не ищем (иначе «и», «в», «не» совпадут со всем).
const STOP = new Set([
  "и", "в", "во", "на", "не", "с", "со", "к", "ко", "по", "за", "из", "у", "о", "об", "от", "до", "а", "но", "же",
  "ли", "бы", "что", "как", "это", "то", "так", "для", "мы", "вы", "он", "она", "они", "оно", "я", "ты", "его", "ее",
  "их", "мне", "тебе", "меня", "тебя", "нас", "вас", "есть", "был", "была", "было", "были", "уже", "еще", "очень",
  // ингушские служебные — только самые короткие и частые
  "а", "я", "ва", "да", "ба", "ца", "ма", "из", "уж", "хьо", "со",
]);

// Длина общего начала двух слов.
function prefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Насколько слово текста похоже на слово записи: 1 — то же слово, 0.6–0.9 — то же начало
// (другое окончание), 0 — не похоже. Окончание — не длиннее трёх букв у каждого слова:
// «мамой» и «мама» похожи, «поедем» и «поединок» — нет.
function wordSim(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0; // короткие слова — только точное совпадение
  const p = prefixLen(a, b);
  const short = Math.min(a.length, b.length), long = Math.max(a.length, b.length);
  // нужно общее начало хотя бы из 4 букв (у коротких слов — из 3 и короткое окончание)
  if (p < 4 && !(p === 3 && short <= 4 && long <= 6)) return 0;
  if (long - p > 3) return 0;
  const s = p / long;
  return s >= 0.5 ? 0.5 + 0.4 * s : 0;
}

// Откуда запись и насколько ей можно верить (0 — самая надёжная).
function sourceOf(p) {
  const n = String(p.source || "");
  // rare — форма есть в словаре, но не в собранных текстах (scripts/build-phrases.js): ниже остальных словарей
  if (/^PaydaDosh/.test(n)) return { from: "paydadosh", prio: p.rare ? 6 : 1, name: "PaydaDosh" };
  if (/^Корпус/.test(n)) return { from: "corpus", prio: 5, name: "настоящие тексты" };
  if (/^translatewiki/i.test(n)) return { from: "open", prio: 6, name: "translatewiki" };
  if (/^Викислов/.test(n)) return { from: "open", prio: p.rare ? 6 : 2, name: "Викисловарь" };
  if (/^(Ингушская Википедия|Викиданные)/.test(n)) return { from: "open", prio: 3, name: n.replace(/\s*\(.*$/, "") };
  if (p.license) return { from: "open", prio: 4, name: n.replace(/\s*\(.*$/, "") };
  return { from: "glossary", prio: 0, name: "словарь проекта" };
}
const BONUS_BY_PRIO = [0.08, 0.06, 0.04, 0.02, 0.01, 0.03, 0];

module.exports = function makeRetrieval({ KB, SEED, LEX }) {
  // ---------- словарь: записи «русское — ингушское» ----------
  let DICT = null;
  const HEAD = { ru: new Set(), inh: new Set() };
  const morph = makeMorph((lang, w) => HEAD[lang === "inh" ? "inh" : "ru"].has(w));

  // Значения записи: «казак, казачка» → [[казак], [казачка]]; «вода (питьевая)» → [[вода]].
  // Обрывки в одну-две буквы («в, я, -аш» — пометы, попавшие в перевод) значением не считаются,
  // если в записи есть что-то ещё.
  const senses = (parts) => {
    const all = parts.map((s) => wordsOf(s)).filter((a) => a.length && a.length <= 8);
    const good = all.filter((a) => a.length > 1 || a[0].length > 2);
    return all.length > 1 && good.length ? good : all;
  };
  const sensesRu = (ru) => senses(noParens(ru).split(/[,;]|\s\/\s/));
  const sensesInh = (inh) => senses(noParens(String(inh).split(" — ")[0]).split(/[,;]|\s*\/\s*/));

  function buildSide(items, sensesFn, head) {
    const exact = new Map(), pre = new Map(), whole = new Map(), senses = [];
    const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
    items.forEach((it, i) => {
      const ss = sensesFn(it);
      senses.push(ss);
      ss.forEach((ws, s) => {
        push(whole, ws.join(" "), i);
        // начальные формы — только из словарей: в таблице текстов слова стоят в разных падежах
        if (ws.length === 1 && it.kind !== "name" && it.from !== "corpus") head.add(ws[0]);
        for (const w of new Set(ws)) {
          push(exact, w, [i, s]);
          if (w.length >= 3) push(pre, w.slice(0, 3), [i, s, w]);
        }
      });
    });
    return { exact, pre, whole, senses };
  }

  const isNameEntry = (it) => /^(имя|фамилия)$/.test(normalize(String(it.ru).trim()))
    && /мужск|женск|фамилия/i.test(String((it.seed && it.seed.note) || it.line || "") + " " + String(it.inh));
  function dict() {
    if (DICT) return DICT;
    const items = [];
    const seen = new Set();
    for (const [ru, inh] of KB.GLOSSARY) {
      items.push({ ru, inh: stripStress(inh), line: inh, from: "glossary", prio: 0, name: "словарь проекта", kind: "word" });
      seen.add(normalize(ru));
    }
    for (const p of SEED) {
      if (p.kind !== "word" && p.kind !== "name") continue;
      const src = sourceOf(p);
      if (src.from === "glossary" && seen.has(normalize(p.ru))) continue; // это та же строка словарика
      const inh = stripStress(p.inh);
      // у открытых словарей note — помета («зоол.», класс), у словаря проекта — полная строка словаря
      const line = p.license ? (p.note ? `${inh} (${p.note})` : inh) : stripStress(p.note || p.inh);
      items.push({ ru: p.ru, inh, line, ...src, kind: p.kind, seed: p });
    }
    DICT = {
      items,
      // «имя = абукар {мужское}»: имена — не перевод слова «имя» / «фамилия» (по-ингушски их ищут, а по-русски — нет)
      ru: buildSide(items, (it) => (isNameEntry(it) ? [] : sensesRu(it.ru)), HEAD.ru),
      inh: buildSide(items, (it) => sensesInh(it.inh), HEAD.inh),
    };
    return DICT;
  }

  // Какие записи подходят слову текста: Map «номер записи:номер значения» → { i, s, sim, via }.
  // Сначала точное слово, потом начальная форма; «похожие по началу» — только если ничего не нашлось.
  function matchWord(tw, side, lang) {
    const out = new Map();
    const put = (i, s, sim, via) => {
      const k = i + ":" + s, old = out.get(k);
      if (!old || sim > old.sim) out.set(k, { i, s, sim, via });
    };
    for (const [i, s] of side.exact.get(tw) || []) put(i, s, 1, "");
    // первые две начальные формы равноправны («стали» — «стать» и «сталь»), следующие — слабее
    morph.lemmas(tw, lang).forEach((l, n) => { for (const [i, s] of side.exact.get(l) || []) put(i, s, n < 2 ? 0.92 : 0.8, l); });
    if (!out.size && tw.length >= 3) {
      for (const [i, s, w] of side.pre.get(tw.slice(0, 3)) || []) {
        const sim = wordSim(tw, w);
        if (sim > 0) put(i, s, sim * 0.9, w);
      }
    }
    return out;
  }

  // Записи словаря для слов текста. source — язык текста ("ru" или "inh").
  // Возвращает [{ ru, inh, from, score, hits }], сначала точные совпадения и надёжные источники.
  function pickDictionary(text, source, max = 40, perWord = 4) {
    const d = dict();
    const lang = source === "inh" ? "inh" : "ru";
    const side = d[lang];
    const acc = new Map(); // «i:s» → { i, s, sum, hits }
    // слово через дефис («дика-дикагӏа», «кое-что») ищется целиком и по частям
    const tokens = new Set();
    for (const tw of wordsOf(text)) { tokens.add(tw); if (tw.includes("-")) for (const p of tw.split("-")) if (p.length >= 2) tokens.add(p); }
    for (const tw of tokens) {
      if (tw.length < 2) continue;
      for (const [k, m] of matchWord(tw, side, lang)) {
        const o = acc.get(k) || { i: m.i, s: m.s, sum: 0, hits: [] };
        o.sum += m.sim; o.hits.push(tw);
        acc.set(k, o);
      }
    }
    const best = new Map(); // лучшая оценка записи по всем её значениям
    for (const o of acc.values()) {
      const it = d.items[o.i];
      const n = side.senses[o.i][o.s].length || 1;
      // запись из нескольких слов засчитываем по доле совпавших слов (длинная запись не должна побеждать)
      let score = Math.min(o.sum, n) / Math.sqrt(n);
      if (it.kind === "name" && o.sum < n) score = 0; // имена и названия — только целиком
      if (score < 0.55) continue;
      score += BONUS_BY_PRIO[it.prio] || 0;
      const old = best.get(o.i);
      if (!old || score > old.score) best.set(o.i, { ru: it.ru, inh: it.line, from: it.from, source: it.name, score, hits: o.hits, i: o.i });
    }
    const list = [...best.values()].sort((a, b) => b.score - a.score || a.i - b.i);
    // на каждое слово текста — не больше perWord записей (иначе «свою» займёт все места формами «свой, свои, своей…»)
    const used = new Map(), out = [], lines = new Set();
    for (const x of list) {
      if (x.hits.every((h) => (used.get(h) || 0) >= perWord)) continue;
      const k = normalize(x.ru) + "|" + normalize(x.inh);
      if (lines.has(k)) continue;
      lines.add(k);
      for (const h of x.hits) used.set(h, (used.get(h) || 0) + 1);
      out.push(x);
      if (out.length >= max) break;
    }
    return out;
  }

  // Готовые ответы из словаря для слова или короткого выражения: { items: [запись…], lemma } или null.
  // Сначала ищется сам текст; если его нет и это одно слово — его начальная форма (lemma — какая).
  function lookupWord(text, source, max = 6, deep = false) {
    const d = dict();
    const lang = source === "inh" ? "inh" : "ru";
    const side = d[lang];
    const ws = wordsOf(noParens(text));
    if (!ws.length || ws.length > 6) return null;
    // надёжный источник первым; при равных — запись, где это слово единственное значение
    const take = (key) => (side.whole.get(key) || [])
      .map((i) => ({ ...d.items[i], i, alone: side.senses[i].length === 1 ? 0 : 1 }))
      .sort((a, b) => a.prio - b.prio || a.alone - b.alone || a.i - b.i);
    // Слова из таблицы текстов («воду — хий») стоят в какой-то форме и выровнены автоматически,
    // поэтому сначала словари, потом начальная форма по словарям, и только потом таблица текстов.
    const all = take(ws.join(" "));
    let items = all.filter((it) => it.from !== "corpus"), lemma = "";
    if (!items.length && ws.length === 1) {
      for (const l of morph.lemmas(ws[0], lang)) {
        const found = take(l).filter((it) => it.from !== "corpus");
        if (found.length && (found[0].prio <= 1 || !all.length)) { items = found; lemma = l.replace(/ӏ/g, "Ӏ"); break; }
      }
      // разбор поглубже (ингушский: «миштав» → «мишта», «ненаца» → «нана») — только если больше ничего нет:
      // «венав» в таблице текстов — «пришёл», это лучше словарного «вена» (приезжий)
      if (deep && !items.length && !all.length && lang === "inh") {
        for (const l of morph.lemmas(ws[0], lang, 3, true, true)) {
          const found = take(l).filter((it) => it.from !== "corpus");
          if (found.length) { items = found; lemma = l.replace(/ӏ/g, "Ӏ"); break; }
        }
      }
    }
    if (!items.length) items = all;
    if (!items.length) return null;
    const seen = new Set(), out = [];
    for (const it of items) {
      const k = normalize(lang === "inh" ? it.ru : it.inh);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
      if (out.length >= max) break;
    }
    return { items: out, lemma };
  }

  // Разбор текста по словам: [{ word, text, from, lemma }] ; text === null — слова в базе нет.
  function breakdown(text, source, max = 40) {
    if (source !== "ru" && source !== "inh") return [];
    const lang = source === "inh" ? "inh" : "ru";
    const out = [], seen = new Set();
    for (const w of wordsOf(text)) {
      if (seen.has(w)) continue;
      seen.add(w);
      let item = null;
      const hit = lookupWord(w, lang, 3, true);
      if (hit && STOP.has(w) && hit.items[0].prio > 0) continue; // предлоги и местоимения — только из словарика проекта
      if (hit) {
        const top = hit.items.filter((it) => it.prio <= hit.items[0].prio + 1);
        const texts = top.slice(0, lang === "inh" ? 3 : 2).map((it) => (lang === "inh" ? noParens(it.ru).replace(/\s+/g, " ").trim() : noParens(it.inh.split(" — ")[0]).replace(/\s+/g, " ").trim()));
        item = { text: [...new Set(texts)].join(" / "), from: hit.items[0].name, lemma: hit.lemma };
      }
      if (!item && LEX) {
        const e = LEX.entry(w, lang);
        const c = e && (e.list.find((x) => x.sure) || (e.list[0].n >= 5 ? e.list[0] : null));
        if (c) item = { text: c.text, from: c.sure ? "тексты и словари" : "тексты", lemma: "" };
      }
      if (!item && (w.length < 3 || STOP.has(w))) continue; // предлоги и частицы без перевода не показываем
      out.push({ word: w.replace(/ӏ/g, "Ӏ"), text: item ? item.text : null, from: item ? item.from : "", lemma: item ? item.lemma : "" });
      if (out.length >= max) break;
    }
    return out;
  }

  // Слова текста, для которых нет ни записи словаря, ни строки в таблице корпуса.
  // shots — выбранные примеры: слово, которое есть в похожей фразе, тоже считается известным.
  function missingWords(text, source, dictHits, shots = []) {
    const lang = source === "inh" ? "inh" : "ru";
    const found = new Set();
    for (const h of dictHits) for (const w of h.hits || wordsOf(lang === "inh" ? h.inh : h.ru)) found.add(w);
    const covered = new Set();
    for (const h of shots) for (const w of wordsOf(lang === "inh" ? h.inh : h.ru)) covered.add(w);
    const out = [];
    for (const w of new Set(wordsOf(text))) {
      if (w.length < 3 || STOP.has(w) || found.has(w)) continue;
      let ok = covered.has(w) || morph.lemmas(w, lang).some((l) => covered.has(l));
      if (!ok) for (const c of covered) if (wordSim(w, c) > 0) { ok = true; break; }
      if (!ok && LEX && LEX.entry(w, lang)) ok = true;
      if (!ok) out.push(w.replace(/ӏ/g, "Ӏ"));
    }
    return out;
  }

  // ---------- примеры: пары «фраза — перевод» ----------
  // Постоянная часть (фразы справочника и базы) индексируется один раз; исправления носителей — на каждый запрос.
  const SHOT_BONUS = { native: 1.5, guide: 1, paydadosh: 0.95, open: 0.8, wiki: 0.5, distilled: 0.8 };
  // в примерах ингушские окончания не отрезаем: общие основы («бер-», «да-») тянут слишком много лишних фраз
  const keysOf = (w, lang) => [w, ...morph.lemmas(w, lang, 3, lang !== "inh")];
  function indexShots(items, lang) {
    const idx = new Map(), pre = new Map(), len = [];
    const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
    items.forEach((it, i) => {
      const ws = [...new Set(wordsOf(noParens(lang === "inh" ? it.inh : it.ru)))];
      len.push(Math.max(1, ws.filter((w) => !STOP.has(w)).length));
      const done = new Set();
      for (const w of ws) {
        if (w.length < 2 || STOP.has(w)) continue;
        keysOf(w, lang).forEach((k, n) => { if (!done.has(k)) { done.add(k); push(idx, k, [i, n === 0 ? 1 : 0.9]); } });
        if (w.length >= 3) push(pre, w.slice(0, 3), [i, w]);
      }
    });
    return { idx, pre, len, items };
  }
  let STATIC = null;
  function staticShots(lang) {
    if (!STATIC) {
      dict(); // начальные формы проверяются по словарю — он должен быть собран
      const items = [];
      for (const [ru, inh] of KB.EXAMPLES) items.push({ ru, inh, from: "guide" });
      for (const p of SEED) {
        if (p.kind !== "phrase") continue;
        const src = sourceOf(p);
        const from = src.from === "glossary" ? "guide" : src.from === "paydadosh" ? "paydadosh" : src.prio === 6 ? "wiki" : "open";
        items.push({ ru: p.ru, inh: stripStress(p.inh), from });
      }
      STATIC = { items };
    }
    if (!STATIC[lang]) STATIC[lang] = indexShots(STATIC.items, lang);
    return STATIC[lang];
  }

  // pool — исправления носителей и пары, проверенные на /review: [{ source, target, text, translation }].
  // extra — например, переводы сильной модели: [{ ru, inh, from: "distilled" }].
  // Возвращает [{ ru, inh, from }] — самые полезные первыми, не больше max.
  function pickFewShots(text, source, target, pool = [], extra = [], max = 16) {
    if (!((source === "ru" && target === "inh") || (source === "inh" && target === "ru"))) return [];
    const lang = source === "inh" ? "inh" : "ru";
    dict(); // начальные формы проверяются по словарю
    const dyn = [];
    for (const p of pool) {
      if (p.source === "ru" && p.target === "inh") dyn.push({ ru: p.text, inh: p.translation, from: "native" });
      else if (p.source === "inh" && p.target === "ru") dyn.push({ ru: p.translation, inh: p.text, from: "native" });
    }
    for (const e of extra) dyn.push({ ru: e.ru, inh: e.inh, from: e.from || "distilled" });
    const parts = [indexShots(dyn, lang), staticShots(lang)];
    const total = parts[0].items.length + parts[1].items.length;

    const tw = [...new Set(wordsOf(text))].filter((w) => w.length >= 2 && !STOP.has(w));
    // вес слова: редкое слово («сфотографировать») важнее частого («хочу»)
    const weight = new Map();
    const cands = new Map(); // «часть:номер» → { part, i, sims: Map<слово текста, сходство> }
    for (const w of tw) {
      const keys = keysOf(w, lang);
      let df = 0;
      const local = new Map();
      parts.forEach((part, pi) => {
        keys.forEach((k, n) => {
          for (const [i, s] of part.idx.get(k) || []) {
            const id = pi + ":" + i, sim = n === 0 ? s : Math.min(s, 0.9);
            if (sim > (local.get(id) || 0)) local.set(id, sim);
          }
        });
      });
      // то же слово с другим окончанием («нанас», «нанага» для «нана») — тоже пример, но слабее точного
      if (w.length >= 4 || (!local.size && w.length >= 3)) {
        const k = local.size ? 0.75 : 0.9;
        parts.forEach((part, pi) => {
          for (const [i, pw] of part.pre.get(w.slice(0, 3)) || []) {
            const sim = wordSim(w, pw) * k;
            if (sim > (local.get(pi + ":" + i) || 0)) local.set(pi + ":" + i, sim);
          }
        });
      }
      df = local.size;
      weight.set(w, Math.log(1 + total / (1 + df)));
      for (const [id, sim] of local) {
        let c = cands.get(id);
        if (!c) { const [pi, i] = id.split(":").map(Number); cands.set(id, (c = { part: parts[pi], i, order: pi * 1e6 + i, sims: new Map() })); }
        c.sims.set(w, sim);
      }
    }
    const top = Math.max(...weight.values(), 1);
    for (const [w, v] of weight) weight.set(w, 0.25 + 0.75 * (v / top));

    const scoreOf = (c, covered) => {
      let sum = 0;
      for (const [w, sim] of c.sims) sum += weight.get(w) * sim * (covered ? Math.pow(0.5, covered.get(w) || 0) : 1);
      const it = c.part.items[c.i];
      return (sum / Math.sqrt(c.part.len[c.i])) * (SHOT_BONUS[it.from] || 1);
    };
    const ranked = [...cands.values()].map((c) => ({ c, base: scoreOf(c) })).sort((a, b) => b.base - a.base || a.c.order - b.c.order).slice(0, 200);

    // жадный выбор: каждый следующий пример должен добавлять слова, которых ещё нет в выбранных
    const out = [], seen = new Set(), covered = new Map();
    while (out.length < max && ranked.length) {
      let bi = -1, bs = 0;
      for (let k = 0; k < ranked.length; k++) {
        const s = scoreOf(ranked[k].c, covered);
        if (s > bs) { bs = s; bi = k; }
      }
      if (bi < 0 || bs <= 0) break;
      const { c } = ranked.splice(bi, 1)[0];
      const it = c.part.items[c.i];
      const key = normalize(it.ru) + "|" + normalize(it.inh);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ru: it.ru, inh: it.inh, from: it.from });
      for (const w of c.sims.keys()) covered.set(w, (covered.get(w) || 0) + 1);
    }
    // совпадений мало — добавим несколько свежих исправлений носителей, чтобы ИИ видел их стиль
    for (let i = dyn.length - 1; i >= 0 && out.length < Math.min(4, max); i--) {
      const it = dyn[i];
      if (it.from !== "native") continue;
      const k = normalize(it.ru) + "|" + normalize(it.inh);
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
    return out;
  }

  return { normalize, wordsOf, wordSim, sourceOf, pickDictionary, pickFewShots, missingWords, lookupWord, breakdown, lemmas: (w, lang, deep = false) => { dict(); return morph.lemmas(w, lang, 3, true, deep); } };
};
module.exports.normalize = normalize;
module.exports.wordSim = wordSim;
module.exports.sourceOf = sourceOf;
