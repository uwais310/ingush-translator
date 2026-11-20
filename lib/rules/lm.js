// Языковая модель (n-граммы слов) — классическая часть статистического перевода: из нескольких вариантов
// перевода, которые уже собрали правила, словари и таблица слов, она выбирает тот, что больше похож на
// настоящие фразы носителей. Сама модель слов не придумывает: она только сравнивает готовые варианты.
//
// Модель: триграммы слов с интерполированным сглаживанием Кнезера — Нея (Kneser, Ney 1995; Chen, Goodman 1998).
// Учится на целевой стороне пар (ингушская сторона — для ru→inh, русская — для inh→ru). В замере
// (scripts/eval-chunks.js) — только на обучающих частях, как и таблица слов.
//
//   const lm = makeLM(["Со цӀа вода", …]);
//   lm.score("со цӏа вода")  → средний log2 p на слово (больше — лучше; 0 — максимум)

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ");
const toks = (s) => low(String(s).replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];

module.exports = function makeLM(sentences, { D = 0.75, extraUnigrams = null } = {}) {
  const S = "\u0001";
  const c3 = new Map(), c2ctx = new Map(), n3ctx = new Map(); // c(uvw), c(uv•), N1+(uv•)
  const n2 = new Map(), n2ctx = new Map(), n2types = new Map(); // N1+(•vw), N1+(•v•), N1+(v•) (по продолжениям)
  const n1 = new Map(); let n1all = 0; // N1+(•w), N1+(••)
  const inc = (m, k, d = 1) => m.set(k, (m.get(k) || 0) + d);
  for (const s of sentences) {
    const w = toks(s);
    if (!w.length) continue;
    const t = ["<s>", "<s>", ...w, "</s>"];
    for (let i = 2; i < t.length; i++) {
      const k = t[i - 2] + S + t[i - 1] + S + t[i];
      if (!c3.has(k)) {
        // новая триграмма: продолжение для биграммы (v,w)
        const bg = t[i - 1] + S + t[i];
        if (!n2.has(bg)) { n1all++; inc(n1, t[i]); inc(n2types, t[i - 1]); }
        inc(n2, bg); inc(n2ctx, t[i - 1]);
        inc(n3ctx, t[i - 2] + S + t[i - 1]);
      }
      inc(c3, k); inc(c2ctx, t[i - 2] + S + t[i - 1]);
    }
  }
  const V = n1.size + 1;
  // слово, которое есть в других текстах (например, корпус), но не в парах — чуть вероятнее совсем нового
  const extra = extraUnigrams || (() => 0);
  function p1(w) {
    const base = (n1.get(w) || 0) / (n1all || 1);
    return 0.97 * base + 0.03 * (extra(w) ? 0.5 : 0.05) / V;
  }
  function p2(w, v) {
    const ctx = n2ctx.get(v);
    if (!ctx) return p1(w);
    const c = n2.get(v + S + w) || 0;
    return Math.max(c - D, 0) / ctx + (D * n2types.get(v) / ctx) * p1(w);
  }
  function p3(w, u, v) {
    const ctx = c2ctx.get(u + S + v);
    if (!ctx) return p2(w, v);
    const c = c3.get(u + S + v + S + w) || 0;
    return Math.max(c - D, 0) / ctx + (D * n3ctx.get(u + S + v) / ctx) * p2(w, v);
  }
  // сумма log2 p по словам предложения (с концом предложения) и число слов
  function logprob(s) {
    const w = Array.isArray(s) ? s : toks(s);
    const t = ["<s>", "<s>", ...w, "</s>"];
    let lp = 0;
    for (let i = 2; i < t.length; i++) lp += Math.log2(p3(t[i], t[i - 2], t[i - 1]));
    return { lp, n: t.length - 2 };
  }
  // средний log2 p на слово: варианты разной длины сравнимы
  const score = (s) => { const w = Array.isArray(s) ? s : toks(s); if (!w.length) return -Infinity; const { lp, n } = logprob(w); return lp / n; };
  const known = (w) => n1.has(low(w));
  return { logprob, score, known, size: c3.size, toks };
};
module.exports.toks = toks;
