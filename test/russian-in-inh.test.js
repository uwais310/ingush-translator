// Русский текст при направлении «ингушский → русский» переводится с русского (и страница переключает языки),
// а не «переводится» как ингушский. Жалоба 23.11: «Доброе утро! Как у тебя дела?» → «Доброе Утро! Как чума [тебя] смеяться?».
//   node test/russian-in-inh.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
process.env.NO_WARMUP = "1";
process.env.ADMIN_LOG = "0";
delete process.env.USE_AI;
const h = require("../api/translate.js");
const call = (b) => new Promise((r) => h({ method: "POST", body: b }, { status() { return this; }, json: r }));
const SEED = require("../data/phrases.json");
const POST = require("../lib/postcheck.js")({ SEED, KB: require("../lib/ingush-guide.js"), L: require("../lib/rules/lexicon.js") });
const looksRussian = require("../lib/lang-detect.js")({ POST });

(async () => {
  const ru = await call({ text: "Доброе утро! Как у тебя дела?", source: "ru", target: "inh", mode: "text", noAi: true });
  const wrong = await call({ text: "Доброе утро! Как у тебя дела?", source: "inh", target: "ru", mode: "text", noAi: true });
  assert.ok(ru.translation && ru.base, "рус → инг из базы: " + ru.translation);
  assert.deepStrictEqual(wrong.switched, { source: "ru", target: "inh" }, "переключено на рус → инг");
  assert.strictEqual(wrong.translation, ru.translation, "тот же перевод, что и в правильном направлении");
  for (const t of ["Я иду домой", "Как тебя зовут", "привет"]) assert.ok(looksRussian(t), "русский: " + t);
  // ингушские тексты остаются ингушскими
  for (const t of ["Сона хьо веза", "нана", "Со цӀа вода", "Со ца вода", "Дика ди хьа", "Из мала ва?", "Маршал хьа"]) {
    assert.ok(!looksRussian(t), "ингушский: " + t);
    const o = await call({ text: t, source: "inh", target: "ru", mode: "text", noAi: true });
    assert.ok(!o.switched, "без переключения: " + t);
  }
  // почти все короткие фразы разговорника по-ингушски не считаются русскими (остаются записи, где в поле
  // ингушского русские слова: «Таджик», «Путнику» — их база всё равно знает, поэтому переключения нет)
  const inh = SEED.filter((p) => p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source || "") && p.inh);
  const flagged = inh.filter((p) => looksRussian(p.inh));
  assert.ok(flagged.length <= 20, "ложных срабатываний мало: " + flagged.length + " из " + inh.length);
  // страница переключает языки по ответу switched
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.ok(/data\.switched/.test(html) && /перевёл с русского на ингушский/.test(html), "index.html показывает переключение");
  console.log("ok: русский текст в «инг → рус» переводится с русского (" + flagged.length + " ложных из " + inh.length + ")");
})().catch((e) => { console.error(e); process.exit(1); });
