// Показывает, какие подсказки получит ИИ для текста — без ключей и без вызова ИИ.
//   node scripts/try-retrieval.js "Я люблю свою маму"          (русский → ингушский)
//   node scripts/try-retrieval.js inh "Сона хьо веза"           (ингушский → русский)
//   node scripts/try-retrieval.js --prompt "Я люблю свою маму"  (весь промпт целиком)
const args = process.argv.slice(2);
const showPrompt = args[0] === "--prompt" && args.shift();
const source = args[0] === "inh" || args[0] === "ru" ? args.shift() : "ru";
const text = args.join(" ") || "Завтра мы с братом поедем к бабушке в горы";
const target = source === "ru" ? "inh" : "ru";

const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });

const shots = RET.pickFewShots(text, source, target, [], [], 16);
const dict = RET.pickDictionary(text, source, 40);
console.log(`Текст (${source} → ${target}): ${text}\n`);
console.log(`Слова словаря (${dict.length}):`);
for (const d of dict) console.log(`  ${d.ru} — ${d.inh}`);
console.log(`\nНет в словаре: ${RET.missingWords(text, source, dict, shots).join(", ") || "—"}`);
console.log(`\nПохожие фразы (${shots.length}):`);
for (const s of shots) console.log(`  ${s.ru}  →  ${s.inh}`);
if (showPrompt) {
  const T = require("../api/translate.js");
  const p = T._prompts.textPrompt(text, source, target, shots, "full", []);
  console.log("\n===== SYSTEM =====\n" + p.system + "\n\n===== USER =====\n" + p.user);
  console.log(`\nДлина: system ${p.system.length} знаков, user ${p.user.length} знаков`);
}
