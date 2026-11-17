// Проверка настоящего ИИ на живом сайте: скорость и качество — одной командой.
//
//   node scripts/check-ai.js https://stalwart-paletas-57ff72.netlify.app        — 20 фраз
//   node scripts/check-ai.js https://stalwart-paletas-57ff72.netlify.app 50 inh — 50 фраз, с ингушского
//
// Берёт фразы из разговорника PaydaDosh (переводы носителей) и для каждой:
//   1. обычный перевод, как на сайте (test: true — без ответа из базы и правил, и ИИ не видит эту фразу
//      в примерах): сколько секунд ждёт человек и какая модель ответила;
//   2. «Сравнить ИИ» по всем моделям сразу: время и ответ каждой модели.
// Ответ ИИ сравнивается с переводом носителя: «совпало» — те же слова; «слова» — доля слов перевода
// носителя, которые есть в ответе (с другим окончанием тоже засчитывается).
// Итог печатается и сохраняется в ai-check-ГГГГ-ММ-ДД.md: таблица «фраза → ответ ИИ → как правильно».
// Нужен Node 18+ (встроенный fetch). Ключи не нужны: запросы идут через сайт.

const fs = require("fs"), path = require("path");
const SEED = require("../data/phrases.json");

const [url, nArg, dirArg] = process.argv.slice(2);
if (!url) { console.log("Укажите адрес сайта: node scripts/check-ai.js https://…netlify.app [20] [ru|inh]"); process.exit(1); }
const N = Number(nArg) || 20, SRC = dirArg === "inh" ? "inh" : "ru", TGT = SRC === "ru" ? "inh" : "ru";
const API = url.replace(/\/+$/, "") + "/api/translate";

const norm = (s) => String(s || "").replace(/\([^()]*\)/g, " ").toLowerCase().replace(/ё/g, "е").replace(/[1lI|ӏ]/g, "Ӏ").replace(/Ӏ/g, "ӏ")
  .replace(/[.,!?;:«»"—–…-]/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter((w) => w.length > 1);
// доля слов эталона, которые есть в ответе (то же слово или то же начало из 4+ букв)
function overlap(ans, ref) {
  const a = words(ans), r = words(ref);
  if (!r.length) return 0;
  const hit = r.filter((w) => a.some((x) => x === w || (w.length >= 4 && x.length >= 4 && x.slice(0, 4) === w.slice(0, 4))));
  return hit.length / r.length;
}
const same = (a, b) => words(a).sort().join(" ") === words(b).sort().join(" ");

// фразы: переводы носителей и уроки разговорника, 3–9 слов
let seed = 17;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pool = SEED.filter((p) => p.kind === "phrase" && /^PaydaDosh/.test(p.source) && /переводы носителей|уроки/.test(p.note || ""))
  .filter((p) => { const n = words(p.ru).length; return n >= 3 && n <= 9 && !/[\/()]/.test(p.ru + p.inh); });
const refs = new Map();
for (const p of pool) { const k = norm(SRC === "ru" ? p.ru : p.inh); if (!refs.has(k)) refs.set(k, { text: SRC === "ru" ? p.ru : p.inh, ref: [] }); refs.get(k).ref.push(SRC === "ru" ? p.inh : p.ru); }
const all = [...refs.values()];
const sample = [];
while (sample.length < Math.min(N, all.length)) { const x = all[Math.floor(rnd() * all.length)]; if (!sample.includes(x)) sample.push(x); }

async function post(body) {
  const t0 = Date.now();
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, ms: Date.now() - t0 };
}
const sec = (ms) => (ms / 1000).toFixed(1) + " с";
const pct = (x) => Math.round(x * 100) + "%";
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const p90 = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : 0; };

(async () => {
  console.log(`Проверяю ${sample.length} фраз (${SRC} → ${TGT}) на ${url}\n`);
  const rows = [], site = [], models = new Map();
  for (const [i, ph] of sample.entries()) {
    const best = (ans) => Math.max(...ph.ref.map((r) => overlap(ans, r)));
    const exact = (ans) => ph.ref.some((r) => same(ans, r));
    // 1. как на сайте
    const s = await post({ text: ph.text, source: SRC, target: TGT, mode: "text", test: true });
    const sAns = s.ok ? s.data.translation || "" : "";
    site.push({ ms: s.ms, ok: s.ok && !!sAns, model: s.data.model || s.data.error || `HTTP ${s.status}`, ov: sAns ? best(sAns) : 0, exact: sAns && exact(sAns) });
    // 2. все модели
    const c = await post({ action: "compare", text: ph.text, source: SRC, target: TGT, test: true });
    const per = [];
    for (const r of (c.ok && c.data.results) || []) {
      const m = models.get(r.by) || { ms: [], ov: [], exact: 0, fail: 0, n: 0 };
      m.n++;
      if (r.text) { m.ms.push(r.ms || 0); m.ov.push(best(r.text)); if (exact(r.text)) m.exact++; }
      else m.fail++;
      models.set(r.by, m);
      per.push(r);
    }
    rows.push({ ph, site: { ans: sAns, ms: s.ms, model: s.data.model || "" }, per });
    console.log(`${i + 1}. ${ph.text}\n   сайт: ${sAns || "—"}  [${s.data.model || s.data.error || s.status}, ${sec(s.ms)}]\n   носитель: ${ph.ref.join(" | ")}`);
  }

  const ok = site.filter((x) => x.ok);
  const lines = [];
  lines.push(`# Проверка ИИ — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "", `Сайт: ${url}. Фраз: ${sample.length}, направление: ${SRC} → ${TGT}.`, "");
  lines.push("## Как на сайте (сколько ждёт человек)", "");
  lines.push(`- ответили: ${ok.length} из ${site.length}`);
  lines.push(`- время: обычно ${sec(median(site.map((x) => x.ms)))}, в 9 случаях из 10 не дольше ${sec(p90(site.map((x) => x.ms)))}`);
  lines.push(`- совпало с носителем: ${ok.filter((x) => x.exact).length} из ${ok.length}; слов носителя в ответе: ${pct(ok.reduce((a, x) => a + x.ov, 0) / (ok.length || 1))}`);
  const byModel = {};
  for (const x of ok) byModel[x.model] = (byModel[x.model] || 0) + 1;
  lines.push(`- какая модель ответила: ${Object.entries(byModel).map(([k, v]) => `${k} — ${v}`).join(", ") || "—"}`, "");
  lines.push("## Каждая модель («Сравнить ИИ»)", "", "| Модель | Ответила | Время (обычно / 90%) | Совпало с носителем | Слов носителя в ответе |", "|---|---|---|---|---|");
  for (const [by, m] of models) lines.push(`| ${by} | ${m.n - m.fail} из ${m.n} | ${sec(median(m.ms))} / ${sec(p90(m.ms))} | ${m.exact} | ${pct(m.ov.reduce((a, x) => a + x, 0) / (m.ov.length || 1))} |`);
  lines.push("", "## Фраза → ответ ИИ → как правильно", "");
  for (const r of rows) {
    lines.push(`**${r.ph.text}**`, `- сайт (${r.site.model}, ${sec(r.site.ms)}): ${r.site.ans || "—"}`);
    for (const p of r.per) lines.push(`- ${p.by}${p.ms ? `, ${sec(p.ms)}` : ""}: ${p.text || p.error || "—"}`);
    lines.push(`- **как у носителя:** ${r.ph.ref.join(" | ")}`, "");
  }
  const file = path.join(process.cwd(), `ai-check-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join("\n"));
  console.log("\n" + lines.slice(0, 12 + models.size).join("\n") + `\n\nПолный отчёт: ${file}`);
})().catch((e) => { console.error("Не получилось:", e.message); process.exit(1); });
