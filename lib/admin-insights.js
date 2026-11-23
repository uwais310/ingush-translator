// Подсчёты для админки /admin по журналу переводов (lib/activity-log.js):
//   popular — самые частые запросы; missed — слова, которых нет в словаре (их чаще всего не находят).
// Только чтение журнала, ничего не придумывает и не переводит.

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[1lI|]/g, "ӏ").replace(/[«»"“”„.,!?;:()…—–-]+/g, " ").replace(/\s+/g, " ").trim();

// самые частые тексты (в одну сторону): сколько раз, последний перевод и откуда он
function popular(log, max = 40) {
  const by = new Map();
  for (const e of log || []) {
    const k = e.source + ">" + e.target + ">" + norm(e.text);
    if (!norm(e.text)) continue;
    const g = by.get(k) || { text: e.text, source: e.source, target: e.target, count: 0, translation: "", how: "", last: "" };
    g.count++;
    if (!g.last || e.at >= g.last) Object.assign(g, { last: e.at, translation: e.translation || "", how: e.how || "", text: e.text });
    by.set(k, g);
  }
  return [...by.values()].filter((g) => g.count > 1).sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1)).slice(0, max);
}

// слова без перевода: [слово] в переводе «по словам» и короткие запросы (1–3 слова), где перевода не нашлось
function missed(log, max = 60) {
  const by = new Map();
  const add = (word, e) => {
    const w = norm(word);
    if (!w || w.length < 2 || /^\d+$/.test(w)) return;
    const k = e.source + ">" + w;
    const g = by.get(k) || { word: w, source: e.source, target: e.target, count: 0, example: "", last: "" };
    g.count++;
    if (!g.last || e.at >= g.last) { g.last = e.at; g.example = String(e.text || "").slice(0, 160); }
    by.set(k, g);
  };
  for (const e of log || []) {
    const t = String(e.translation || "");
    if (t) for (const m of t.matchAll(/\[([^\[\]]{1,60})\]/g)) add(m[1], e);
    else if (norm(e.text).split(" ").length <= 3) add(e.text, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1)).slice(0, max);
}

module.exports = { popular, missed, norm };
