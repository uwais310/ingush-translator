// Таблица переводов слов, выученная из пар «русская фраза — ингушская фраза» (статистический перевод без ИИ).
//
// Классический метод IBM Model 1 (1993): по тысячам пар фраз разговорника и словаря считается, какое ингушское
// слово чаще всего стоит в паре с русским словом. Так находится нужная форма слова в контексте: «маме» —
// «нанна», «домой» — «цӀа», а не только начальная форма из словаря. Каждое слово ответа взято из настоящих
// пар (PaydaDosh, словарь проекта), ничего не придумывается.
//
//   const A = makeAlign(pairs);         pairs: [[ru, inh], …]
//   A.best("маме", "ru") → { to: "нанна", p: 0.62, n: 5 } или null
//   A.phrase(["доброе", "утро"], "ru") → { to: "…", p, n, lex } или null — кусок из 2–4 слов по таблице фраз
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
  // все переводы слова w с вероятностями: [[e, p(e | w)], …] и сколько пар с ним (для выбора значения, lib/rules/sense-inh.js)
  const dist = (w, lang = "ru") => { const m = T[lang].get(low(w)); return m ? { list: [...m], n: freq[lang].get(low(w)) || 0 } : null; };

  // Таблица фраз (phrase-based SMT, Koehn и др. 2003): в каждой паре слова связываются в обе стороны
  // (лучшее слово по таблице), берутся связи, на которых сходятся оба направления, и к ним
  // добавляются соседние связи из любого направления (grow-diag). Затем из пары выписываются все
  // куски до 4 слов, слова которых связаны только между собой («согласованные» пары кусков).
  const PH = { ru: new Map(), inh: new Map() }; // src-кусок → Map(tgt-кусок → число пар)
  const PHN = { ru: new Map(), inh: new Map() }; // src-кусок → сколько раз выписан
  const LINK = { ru: new Map(), inh: new Map() }; // связи слов после симметризации: w(e|f)
  const LINKN = { ru: new Map(), inh: new Map() };
  const MAXP = 4;
  const aligns = [];
  for (const [r, i] of ru2inh) {
    const a = symmetrize(r, i);
    aligns.push(a);
    for (const [x, y] of a) {
      bump2(LINK.ru, r[x], i[y]); bump(LINKN.ru, r[x]);
      bump2(LINK.inh, i[y], r[x]); bump(LINKN.inh, i[y]);
    }
  }
  ru2inh.forEach(([r, i], k) => extract(r, i, aligns[k]));

  function viterbi(f, e, t) { // для каждого слова e — лучшее слово f (или никакое)
    const out = [];
    for (let j = 0; j < e.length; j++) {
      let bi = -1, bp = (t.get("\u0000") || new Map()).get(e[j]) || 0;
      for (let k = 0; k < f.length; k++) { const q = (t.get(f[k]) || new Map()).get(e[j]) || 0; if (q > bp) { bp = q; bi = k; } }
      out.push(bi);
    }
    return out;
  }
  function symmetrize(r, i) {
    const a1 = viterbi(r, i, T.ru), a2 = viterbi(i, r, T.inh); // a1[inh] = ru, a2[ru] = inh
    const uni = new Set(), A = new Set();
    a1.forEach((x, y) => { if (x >= 0) uni.add(x * 64 + y); });
    a2.forEach((y, x) => { if (y >= 0) { const k = x * 64 + y; if (uni.has(k)) A.add(k); uni.add(k); } });
    const rowOk = new Set(), colOk = new Set();
    for (const k of A) { rowOk.add(k >> 6); colOk.add(k & 63); }
    for (let grew = true; grew;) {
      grew = false;
      for (const k of [...A]) {
        const x = k >> 6, y = k & 63;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx, ny = y + dy, nk = nx * 64 + ny;
          if ((dx || dy) && nx >= 0 && ny >= 0 && uni.has(nk) && !A.has(nk) && (!rowOk.has(nx) || !colOk.has(ny))) {
            A.add(nk); rowOk.add(nx); colOk.add(ny); grew = true;
          }
        }
      }
    }
    return [...A].map((k) => [k >> 6, k & 63]);
  }
  function extract(r, i, a) {
    if (!a.length) return;
    const rAl = r.map(() => []), iAl = i.map(() => []);
    for (const [x, y] of a) { rAl[x].push(y); iAl[y].push(x); }
    for (let r1 = 0; r1 < r.length; r1++) for (let r2 = r1; r2 < Math.min(r.length, r1 + MAXP); r2++) {
      let i1 = 99, i2 = -1;
      for (let x = r1; x <= r2; x++) for (const y of rAl[x]) { if (y < i1) i1 = y; if (y > i2) i2 = y; }
      if (i2 < 0 || i2 - i1 >= MAXP) continue;
      let ok = true;
      for (let y = i1; y <= i2 && ok; y++) for (const x of iAl[y]) if (x < r1 || x > r2) { ok = false; break; }
      if (!ok) continue;
      // края кусков — только связанные слова (без расширения на несвязанные: так меньше мусора)
      const rs = r.slice(r1, r2 + 1).join(" "), is = i.slice(i1, i2 + 1).join(" ");
      if (r2 > r1) { bump2(PH.ru, rs, is); bump(PHN.ru, rs); }
      if (i2 > i1) { bump2(PH.inh, is, rs); bump(PHN.inh, is); }
    }
  }
  // лексический вес lex(e|f): каждое слово e объясняется связанными с ним словами f (Koehn и др. 2003)
  function lexw(f, e, lang) {
    const F = f.split(" "), E = e.split(" ");
    let w = 1;
    for (const ew of E) {
      let s = 0, n = 0;
      for (const fw of F) { const c = (LINK[lang].get(fw) || new Map()).get(ew); if (c) { s += c / LINKN[lang].get(fw); n++; } }
      w *= n ? s / n : 1e-3;
    }
    return w;
  }
  // Лучший перевод куска из 2–4 слов: { to, p, n, lex } или null.
  //   p = p(e|f) — доля выписанных пар, где у куска такой перевод; n — сколько раз; lex — лексический вес.
  //   minN — сколько раз пара должна встретиться (по умолчанию 2), minP — нижний порог p.
  function phrase(src, lang = "ru", { minN = 2, minP = 0.3 } = {}) {
    const f = (Array.isArray(src) ? src : String(src).split(/\s+/)).map(low).join(" ");
    const m = PH[lang].get(f);
    if (!m) return null;
    const z = PHN[lang].get(f);
    let bestE = null, bs = 0, bn = 0;
    for (const [e, c] of m) { const s = c * lexw(f, e, lang); if (c > bn || (c === bn && s > bs)) { bs = s; bn = c; bestE = e; } }
    if (!bestE || bn < minN || bn / z < minP) return null;
    return { to: bestE, p: bn / z, n: bn, lex: lexw(f, bestE, lang) };
  }
  return { best, prob, dist, freq, phrase, size: ru2inh.length, phrases: PH.ru.size + PH.inh.size };
};
function bump(m, k) { m.set(k, (m.get(k) || 0) + 1); }
function bump2(m, k, v) { let x = m.get(k); if (!x) m.set(k, (x = new Map())); x.set(v, (x.get(v) || 0) + 1); }
module.exports.toks = toks;
