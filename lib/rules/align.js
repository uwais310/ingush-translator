// Таблица переводов слов, выученная из пар «русская фраза — ингушская фраза» (статистический перевод без ИИ).
//
// Классический метод IBM Model 1 (1993): по тысячам пар фраз разговорника и словаря считается, какое ингушское
// слово чаще всего стоит в паре с русским словом. Так находится нужная форма слова в контексте: «маме» —
// «нанна», «домой» — «цӀа», а не только начальная форма из словаря. Каждое слово ответа взято из настоящих
// пар (PaydaDosh, словарь проекта), ничего не придумывается.
//
//   const A = makeAlign(pairs);         pairs: [[ru, inh], …]
//   A.best("маме", "ru") → { to: "нанна", p: 0.62, n: 5 } или null
//
// Направление "ru" — русское слово → ингушское, "inh" — наоборот.

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ").replace(/[̀́]/g, "");
const toks = (s) => low(String(s).replace(/\([^()]*\)/g, " ").split(" — ")[0]).match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || [];

function model1(pairs, iters) {
  // pairs: [[srcTokens, tgtTokens]]; returns Map src -> Map tgt -> p(tgt|src)
  const t = new Map();
  const NULL = "\u0000";
  for (const [f] of pairs) for (const w of f) if (!t.has(w)) t.set(w, new Map());
  t.set(NULL, new Map());
  // uniform init over co-occurring words
  for (const [f, e] of pairs) for (const fw of [NULL, ...f]) { const m = t.get(fw); for (const ew of e) m.set(ew, 1); }
  for (const m of t.values()) { const z = m.size; for (const k of m.keys()) m.set(k, 1 / z); }
  for (let it = 0; it < iters; it++) {
    const count = new Map(), total = new Map();
    for (const [f, e] of pairs) {
      const fs = [NULL, ...f];
      for (const ew of e) {
        let z = 0;
        for (const fw of fs) z += t.get(fw).get(ew) || 0;
        if (!z) continue;
        for (const fw of fs) {
          const c = (t.get(fw).get(ew) || 0) / z;
          if (!c) continue;
          let m = count.get(fw); if (!m) count.set(fw, (m = new Map()));
          m.set(ew, (m.get(ew) || 0) + c);
          total.set(fw, (total.get(fw) || 0) + c);
        }
      }
    }
    for (const [fw, m] of count) {
      const z = total.get(fw), tm = new Map();
      for (const [ew, c] of m) if (c / z > 1e-4) tm.set(ew, c / z);
      t.set(fw, tm);
    }
  }
  return t;
}

module.exports = function makeAlign(pairs, { iters = 6 } = {}) {
  const ru2inh = [], inh2ru = [];
  const freq = { ru: new Map(), inh: new Map() };
  for (const [ru, inh] of pairs) {
    const r = toks(ru), i = toks(inh);
    if (!r.length || !i.length || r.length > 12 || i.length > 12) continue;
    ru2inh.push([r, i]); inh2ru.push([i, r]);
    for (const w of new Set(r)) freq.ru.set(w, (freq.ru.get(w) || 0) + 1);
    for (const w of new Set(i)) freq.inh.set(w, (freq.inh.get(w) || 0) + 1);
  }
  const T = { ru: model1(ru2inh, iters), inh: model1(inh2ru, iters) };
  function best(w, lang = "ru") {
    const k = low(w), m = T[lang].get(k);
    if (!m) return null;
    let to = null, p = 0;
    for (const [e, q] of m) if (q > p) { p = q; to = e; }
    return to ? { to, p, n: freq[lang].get(k) || 0 } : null;
  }
  // p(e | w): насколько слово e — перевод слова w
  const prob = (w, e, lang = "ru") => { const m = T[lang].get(low(w)); return (m && m.get(low(e))) || 0; };
  return { best, prob, size: ru2inh.length };
};
module.exports.toks = toks;
