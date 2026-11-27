// Русское имя → ингушское написание и форма на -а (Ахмед → Ахьмад, Ахьмада). Ничего не придумывается: пары
// берутся из подписей Википедии к людям (data/sources/wikidata.json):
//   «Матиев Ахмет Хасанович | Матенаькъан Хьасана Ахьмад» — ингушский порядок: тайп, имя отца (на -а), имя.
// Имя человека — последнее ингушское слово; имя отца — предпоследнее, это форма на -а («Хьасана» — Хасанович).
// Разговорник PaydaDosh подтверждает форму на -а у того, кто делает: «Магомед узнал друга — ДоттагӀа вайзар
// мохьмада». Слова должны быть похожи (та же первая буква, почти те же согласные), иначе пара не берётся.
//
//   const N = makeNamesInh(pairs);   pairs: [{ ru, inh }]
//   N.nom("Ахмед") → "Ахьмад"        N.erg("Ахмед") → "Ахьмада"   (или null)

const low = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ");
const cap = (s) => s[0].toUpperCase() + s.slice(1).replace(/ӏ/g, "Ӏ");
// согласные без «ь», «ъ», палочки: «ахьмад» → «хмд», «ахмед» → «хмд»
const skel = (s) => low(s).replace(/[ьъӏ]/g, "").replace(/[аеиоуыэюя]/g, "");
function lev(a, b) {
  const d = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let p = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; }
  }
  return d[b.length];
}
const alike = (ru, inh) => low(ru)[0] === low(inh)[0] && lev(skel(ru), skel(inh)) <= 1;
const PATR = /^(.+?)(ович|евич|ич|овна|евна|ична|инична)$/;
const WORD = /^[А-ЯЁ][а-яё]+$/;
const IWORD = /^[А-ЯЁӀ][а-яёӀӏ]+$/;

module.exports = function makeNamesInh(pairs) {
  const nomC = new Map(), genC = new Map();
  const bump = (m, ru, inh) => { const k = low(ru); if (!m.has(k)) m.set(k, new Map()); const c = m.get(k); c.set(low(inh), (c.get(low(inh)) || 0) + 1); };
  for (const p of pairs || []) {
    if (!p || p.kind !== "name") continue;
    const ru = String(p.ru || "").trim().split(/\s+/), inh = String(p.inh || "").trim().split(/\s+/);
    if (ru.length !== 3 || inh.length !== 3 || !ru.every((w) => WORD.test(w)) || !inh.every((w) => IWORD.test(w))) continue;
    const pi = ru.findIndex((w) => PATR.test(low(w)));
    if (pi < 1) continue;
    const given = ru[pi - 1], father = PATR.exec(low(ru[pi]))[1];
    const iGiven = inh[2], iFather = inh[1];
    if (alike(given, iGiven)) bump(nomC, given, iGiven);
    // отчество «Ахмедович» → «ахмед»; у ингушской формы отца окончание -а: «Ахьмада»
    if (/а$/.test(low(iFather)) && alike(father, iFather.slice(0, -1))) bump(genC, father, iFather);
  }
  // одна форма — самая частая; ничья — нет ответа
  const top = (c) => {
    if (!c) return null;
    const e = [...c.entries()].sort((a, b) => b[1] - a[1]);
    return e.length > 1 && e[0][1] === e[1][1] ? null : e[0][0];
  };
  const NOM = new Map([...nomC].map(([k, c]) => [k, top(c)]).filter(([, v]) => v));
  const GEN = new Map([...genC].map(([k, c]) => [k, top(c)]).filter(([, v]) => v));
  // обратно: «Ахьмад» → «Ахмед» (самое частое русское написание; ничья — нет ответа), «Ахьмада» → тоже «Ахмед»
  const back = new Map();
  for (const m of [nomC, genC]) for (const [ru, c] of m) for (const [inh, n] of c) {
    const k = m === genC ? inh.replace(/а$/, "") : inh;
    if (!back.has(k)) back.set(k, new Map());
    back.get(k).set(ru, (back.get(k).get(ru) || 0) + n);
  }
  const RU = new Map([...back].map(([k, c]) => [k, top(c)]).filter(([, v]) => v));
  // «Ахмет» и «Ахмед» — одно имя: отчество «Ахмедович» даёт форму на -а и для имени, записанного иначе,
  // если ингушское имя то же самое («Ахьмад» — «Ахьмада»)
  return {
    nom: (ru) => { const n = NOM.get(low(ru)); return n ? cap(n) : null; },
    // форма на -а: та, что у отчества этого имени, или ингушское имя + -а, если такая форма есть у другого
    // русского написания того же имени
    erg: (ru) => {
      const g = GEN.get(low(ru)), n = NOM.get(low(ru));
      if (g && (!n || g === n + "а")) return cap(g);
      if (n && [...GEN.values()].includes(n + "а")) return cap(n + "а");
      return null;
    },
    // ингушское имя или его форма на -а → русское имя: «Ахьмад», «Ахьмада» → «Ахмед»
    ru: (inh) => {
      const w = low(inh);
      const r = RU.get(w) || (/а$/.test(w) && [...GEN.values()].includes(w) ? RU.get(w.slice(0, -1)) : null);
      return r ? cap(r) : null;
    },
    size: () => NOM.size,
  };
};
