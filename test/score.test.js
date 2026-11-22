// scripts/score.js: числа берутся из вывода замеров правильно (сами замеры здесь не запускаются — они долгие).
//   node test/score.test.js
const assert = require("assert");
const S = require("../scripts/score.js");
const rules = "Фраз в базе: 8226. Правила перевели: 77 (0.9%).\n  совпало с переводом носителя:          53 (68.8%)\n";
assert.strictEqual(S.pick(rules, S.PARTS[0].line), 68.8, "не путает с первой строкой (0.9%)");
assert.strictEqual(S.pick("Фраз (от 2 слов): 9. Переведено по кускам: 8 (88.9%).\n  слова на месте (есть в переводе носителя): 25.0%\n", /слова на месте/), 25);
assert.strictEqual(S.pick("\nПредложений: 94 (без перевода: 0). Смысл вернулся: 55 (58.5%), потерян: 39 (41.5%).", /Смысл вернулся/), 58.5);
assert.strictEqual(S.pick("ничего", /Смысл вернулся/), null);
for (const p of S.PARTS) assert.ok(require("fs").existsSync(require("path").join(__dirname, "../scripts", p.script)), p.script);
console.log("ok: score.js читает числа замеров");
