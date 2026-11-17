// Чистит готовую базу data/phrases.json: пометки из текста фраз («(говорит мужчина)», «(к женщине)», «(й, б, д)»)
// переносятся в поле note. Записи и их id не меняются (по id хранятся проверки носителей с /review).
// Запуск: node scripts/clean-notes.js
const fs = require("fs"), path = require("path");
const { cleanPair } = require("../lib/notes.js");
const file = path.join(__dirname, "..", "data", "phrases.json");
const list = JSON.parse(fs.readFileSync(file, "utf8"));
let n = 0;
for (const p of list) {
  if (p.kind !== "phrase") continue;
  const c = cleanPair(p.ru, p.inh, p.note);
  if (c.ru === p.ru && c.inh === p.inh) continue;
  p.ru = c.ru; p.inh = c.inh;
  if (c.note) p.note = c.note;
  n++;
}
fs.writeFileSync(file, "[\n" + list.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n");
console.log(`записей: ${list.length}, почищено: ${n}`);
