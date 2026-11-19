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

// IBM Model 1 на целочисленных номерах слов и типизированных массивах (так первый перевод на сайте
// заметно быстрее и легче, чем на Map строк). Вероятности — те же самые числа, что при счёте на Map:
// все суммы складываются в том же порядке, поэтому таблица совпадает до последнего бита.
//   pairs: [[srcTokens, tgtTokens]] → { prob(w, e), best(w), list(w), viterbi(k), done() }
// Ячейка — пара (src-слово, tgt-слово), встреченная хотя бы в одной паре фраз; t[ячейка] = p(tgt | src).
const NULL = "\u0000";
function model1(pairs, iters) {
  const src = new Map([[NULL, 0]]), tgt = new Map(), tgtW = [];
  const sid = (w) => { let i = src.get(w); if (i === undefined) src.set(w, (i = src.size)); return i; };
  const tid = (w) => { let i = tgt.get(w); if (i === undefined) { tgt.set(w, (i = tgtW.length)); tgtW.push(w); } return i; };
  const P = pairs.length, F = new Array(P), E = new Array(P);
  let nOcc = 0;
  for (let k = 0; k < P; k++) {
    const [f, e] = pairs[k];
    F[k] = f.map(sid); E[k] = e.map(tid);
    nOcc += (f.length + 1) * e.length;
  }
  const nS = src.size, nT = tgtW.length;
  // occ: для каждой пары, каждого tgt-слова j и каждого src-слова (сначала NULL) — номер ячейки
  const off = new Int32Array(P + 1), occ = new Int32Array(nOcc);
  const cellOf = new Map(); // s * nT + t → ячейка
  const rowL = [];
  let o = 0;
  for (let k = 0; k < P; k++) {
    off[k] = o;
    const f = F[k], e = E[k];
    for (let j = 0; j < e.length; j++) for (let x = -1; x < f.length; x++) {
      const s = x < 0 ? 0 : f[x], key = s * nT + e[j];
      let c = cellOf.get(key);
      if (c === undefined) { cellOf.set(key, (c = rowL.length)); rowL.push(s); }
      occ[o++] = c;
    }
  }
  off[P] = o;
  const nC = rowL.length, row = Int32Array.from(rowL);
  const col = new Int32Array(nC);
  for (const [key, c] of cellOf) col[c] = key % nT;
  cellOf.clear();
  // порядок ячеек в строке — как порядок вставки в Map при счёте на строках (от него зависит выбор при равных p)
  const stamp = new Int32Array(nC);
  for (let c = 0; c < nC; c++) stamp[c] = c;
  // равномерное начало по словам, встреченным вместе
  const size = new Int32Array(nS);
  for (let c = 0; c < nC; c++) size[row[c]]++;
  const t = new Float64Array(nC);
  for (let c = 0; c < nC; c++) t[c] = 1 / size[row[c]];
  const count = new Float64Array(nC), total = new Float64Array(nS);
  for (let it = 0; it < iters; it++) {
    count.fill(0); total.fill(0);
    const last = it === iters - 1;
    let seq = 0;
    if (last) stamp.fill(-1);
    for (let k = 0; k < P; k++) {
      const n1 = F[k].length + 1, ne = E[k].length;
      for (let j = 0, b = off[k]; j < ne; j++, b += n1) {
        let z = 0;
        for (let x = 0; x < n1; x++) z += t[occ[b + x]];
        if (!z) continue;
        for (let x = 0; x < n1; x++) {
          const c = occ[b + x], q = t[c] / z;
          if (!q) continue;
          if (last && stamp[c] < 0) stamp[c] = seq++;
          count[c] += q;
          total[row[c]] += q;
        }
      }
    }
    for (let c = 0; c < nC; c++) {
      const z = total[row[c]];
      if (!z) continue; // слова не было в счёте — его строка остаётся прежней
      const q = count[c] / z;
      t[c] = q > 1e-4 ? q : 0;
    }
  }
  // Строки таблицы: ненулевые ячейки, по номеру tgt-слова (для поиска делением пополам)
  const start = new Int32Array(nS + 1);
  for (let c = 0; c < nC; c++) if (t[c]) start[row[c] + 1]++;
  for (let s = 0; s < nS; s++) start[s + 1] += start[s];
  const n = start[nS], RC = new Int32Array(n), RP = new Float64Array(n), RS = new Int32Array(n);
  const fill = start.slice(0, nS);
  for (let c = 0; c < nC; c++) if (t[c]) { const i = fill[row[c]]++; RC[i] = col[c]; RP[i] = t[c]; RS[i] = stamp[c]; }
  for (let s = 0; s < nS; s++) { // сортировка вставками: строки короткие и почти упорядочены
    for (let i = start[s] + 1; i < start[s + 1]; i++) {
      const c = RC[i], p = RP[i], st = RS[i];
      let j = i - 1;
      while (j >= start[s] && RC[j] > c) { RC[j + 1] = RC[j]; RP[j + 1] = RP[j]; RS[j + 1] = RS[j]; j--; }
      RC[j + 1] = c; RP[j + 1] = p; RS[j + 1] = st;
    }
  }
  let T = t, OCC = occ;
  return {
    // p(e | w) или 0
    prob(w, e) {
      const s = src.get(w), c = tgt.get(e);
      if (s === undefined || c === undefined) return 0;
      let lo = start[s], hi = start[s + 1] - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (RC[m] < c) lo = m + 1; else if (RC[m] > c) hi = m - 1; else return RP[m]; }
      return 0;
    },
    // лучший перевод: наибольшее p, при равных — раньше вставленный (как при обходе Map)
    best(w) {
      const s = src.get(w);
      if (s === undefined) return null;
      let bi = -1;
      for (let i = start[s]; i < start[s + 1]; i++) if (bi < 0 || RP[i] > RP[bi] || (RP[i] === RP[bi] && RS[i] < RS[bi])) bi = i;
      return bi < 0 || !(RP[bi] > 0) ? null : { to: tgtW[RC[bi]], p: RP[bi] };
    },
    // все переводы [[e, p], …] в порядке вставки или null
    list(w) {
      const s = src.get(w);
      if (s === undefined) return null;
      const ix = [];
      for (let i = start[s]; i < start[s + 1]; i++) ix.push(i);
      ix.sort((a, b) => RS[a] - RS[b]);
      return ix.map((i) => [tgtW[RC[i]], RP[i]]);
    },
    // для пары k: для каждого tgt-слова — номер лучшего src-слова (−1 — никакое, NULL)
    viterbi(k) {
      const n1 = F[k].length + 1, ne = E[k].length, out = [];
      for (let j = 0, b = off[k]; j < ne; j++, b += n1) {
        let bi = -1, bp = T[OCC[b]];
        for (let x = 1; x < n1; x++) { const q = T[OCC[b + x]]; if (q > bp) { bp = q; bi = x - 1; } }
        out.push(bi);
      }
      return out;
    },
    done() { T = OCC = null; F.length = E.length = 0; },
  };
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
    const k = low(w), b = T[lang].best(k);
    return b ? { to: b.to, p: b.p, n: freq[lang].get(k) || 0 } : null;
  }
  // p(e | w): насколько слово e — перевод слова w
  const prob = (w, e, lang = "ru") => T[lang].prob(low(w), low(e));
  // все переводы слова w с вероятностями: [[e, p(e | w)], …] и сколько пар с ним (для выбора значения, lib/rules/sense-inh.js)
  const dist = (w, lang = "ru") => { const l = T[lang].list(low(w)); return l ? { list: l, n: freq[lang].get(low(w)) || 0 } : null; };

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
  for (let k = 0; k < ru2inh.length; k++) {
    const [r, i] = ru2inh[k], a = symmetrize(k);
    aligns.push(a);
    for (const [x, y] of a) {
      bump2(LINK.ru, r[x], i[y]); bump(LINKN.ru, r[x]);
      bump2(LINK.inh, i[y], r[x]); bump(LINKN.inh, i[y]);
    }
  }
  ru2inh.forEach(([r, i], k) => extract(r, i, aligns[k]));
  T.ru.done(); T.inh.done(); // рабочие массивы обучения больше не нужны

  function symmetrize(k) { // viterbi: для каждого слова одной стороны пары k — лучшее слово другой (или никакое)
    const a1 = T.ru.viterbi(k), a2 = T.inh.viterbi(k); // a1[inh] = ru, a2[ru] = inh
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
