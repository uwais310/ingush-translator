// «Ингушский → русский» смотрит в пары «русский → ингушский»: ингушская фраза из тех же слов в другом порядке
// берётся из разговорника (идея Uwaus 23.11). Ответы — только из базы проекта (Справочник, PaydaDosh).
//   node test/reverse-ru-inh.test.js
const assert = require("assert");
process.env.NO_WARMUP = "1";
process.env.ADMIN_LOG = "0";
delete process.env.USE_AI;
const h = require("../api/translate.js");
const call = (b) => new Promise((r) => h({ method: "POST", body: b }, { status() { return this; }, json: r }));
const inh = (text) => call({ text, source: "inh", target: "ru", mode: "text", noAi: true });

(async () => {
  // тот же порядок — как было (из базы), другой порядок — теперь тоже из базы, а не по словам
  for (const [a, b] of [["Сона хьо веза", "Хьо сона веза"], ["Мича вах хьо", "хьо мича вах"], ["ЦӀи фу я хьа", "Фу я хьа цӀи?"]]) {
    const x = await inh(a), y = await inh(b);
    assert.ok(x.base && !x.chunks, a + ": из базы");
    assert.strictEqual(y.translation, x.translation, b + " → " + y.translation + " (ожидалось " + x.translation + ")");
    assert.ok(!y.chunks, b + ": не по словам");
  }
  // исправление носителя (рус → инг) работает и в обратную сторону при другом порядке слов:
  // берём ингушскую фразу из базы и порядок слов, которого в базе нет
  const mem = {};
  const store = { async get(k) { return mem[k] || null; }, async setJSON(k, v) { mem[k] = v; } };
  h._setStore(store);
  const SEED = require("../data/phrases.json");
  let reordered = null, source = null;
  for (const p of SEED) {
    if (p.kind !== "phrase" || !/^PaydaDosh/.test(p.source || "") || /[()\/]/.test(p.inh)) continue;
    const ws = p.inh.replace(/[.!?,]/g, "").trim().split(/\s+/);
    if (ws.length !== 3) continue;
    const r = [ws[2], ws[0], ws[1]].join(" ");
    const before = await inh(r);
    if (before.chunks) { reordered = r; source = p.inh; break; }
  }
  assert.ok(reordered, "нашлась фраза для проверки");
  mem.all = [{ source: "ru", target: "inh", text: "тестовая фраза носителя", translation: source, at: new Date().toISOString() }];
  h._setStore(store);
  const back = await inh(reordered);
  assert.strictEqual(back.translation, "тестовая фраза носителя", reordered + ": исправление носителя найдено по тем же словам: " + back.translation);
  assert.ok(back.verified);
  console.log("ok: инг → рус находит фразу из пар рус → инг по тем же словам");
})().catch((e) => { console.error(e); process.exit(1); });
