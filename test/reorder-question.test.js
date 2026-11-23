// Короткий вопрос с другим порядком слов берётся из разговорника: «как зовут тебя», «тебя как зовут» —
// это «Как тебя зовут?». Раньше сайт собирал их по словам: «Санна хьо дех», «Хьо мишта дех?» (жалоба Uwaus, 23.11).
// Правильные ответы — из базы проекта (Справочник: «ЦӀи фу я хьа?», PaydaDosh: «ЦӀи мишта я хьа?»),
// носитель языка подтвердил оба варианта.
//   node test/reorder-question.test.js
const assert = require("assert");
process.env.NO_WARMUP = "1";
delete process.env.USE_AI;
process.env.ADMIN_LOG = "0";
const h = require("../api/translate.js");
const call = (b) => new Promise((r) => h({ method: "POST", body: b }, { status() { return this; }, json: r }));

(async () => {
  for (const t of ["как зовут тебя", "тебя как зовут?", "Зовут тебя как"]) {
    const o = await call({ text: t, source: "ru", target: "inh", mode: "text", noAi: true });
    const all = [o.translation, ...(o.variants || []).map((v) => v.text)];
    assert.strictEqual(o.translation, "ЦӀи фу я хьа?", t + " → " + o.translation);
    assert.ok(all.includes("ЦӀи мишта я хьа?"), t + ": вариант с «мишта»: " + JSON.stringify(all));
    assert.ok(!o.chunks, t + ": не по словам");
  }
  const o = await call({ text: "ты где живешь", source: "ru", target: "inh", mode: "text", noAi: true });
  const same = await call({ text: "Где ты живёшь?", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.strictEqual(o.translation, same.translation, "«ты где живешь» = «Где ты живёшь?»");
  // без вопросительного слова порядок не трогаем
  const st = await call({ text: "тебя зовут", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.notStrictEqual(st.translation, "ЦӀи фу я хьа?", "«тебя зовут» — не вопрос");
  console.log("ok: вопрос с другим порядком слов — из разговорника");
})().catch((e) => { console.error(e); process.exit(1); });
