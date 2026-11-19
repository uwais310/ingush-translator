// Выбор русского значения ингушского слова (lib/rules/sense-inh.js) и перевод «по словам» ингушский → русский.
//   node test/sense-inh.test.js
// Ингушские слова и фразы — из разговорника PaydaDosh и словаря проекта (data/phrases.json, lib/ingush-guide.js);
// здесь ничего ингушского не придумано, проверяется только, какое русское значение выбрано.
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const E = require("../scripts/eval-chunks.js");
const phrases = E.phrasePairs();
// как на сайте (api/translate.js): таблица слов из пар фраз и словарных записей
const ALIGN = require("../lib/rules/align.js")([...phrases, ...E.wordPairs()]);
const S = require("../lib/rules/sense-inh.js")({ ALIGN, LEX });
const C = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN, EXAMPLES: phrases });
const tr = (t) => (C.translate(t, "inh", { noWhole: true }) || {}).translation || "";
const sense = (w) => { const r = RET.lookupWord(w, "inh", 6); const c = r && S.pick(w, S.cands(w, r)); return c ? c.to.toLowerCase() : null; };

// 1. разбор записи словаря на значения
assert.deepStrictEqual(S.sensesOfRu("слух, молва; 2) известие, весть; новость; 3) разговор"), ["слух", "молва", "известие", "весть", "новость", "разговор"]);
assert.deepStrictEqual(S.sensesOfRu("послелог о, относительно"), ["о", "относительно"]);
// одно слово в разных формах — да; разные слова с общим началом — нет
assert.ok(S.sameWord("разговор", "разговоры") && S.sameWord("сказал", "сказала") && S.sameWord("фотография", "фотографии"));
assert.ok(!S.sameWord("согласие", "согласился") && !S.sameWord("одиноко", "один"));
console.log("ok 1: значения записи и формы слова");

// 2. значения отдельных слов
// «хабар» — PaydaDosh: «от хаба» (падежная форма другого слова) и «слух, молва; известие…; разговор»
assert.ok(sense("хабар") && !/^от /.test(sense("хабар")), sense("хабар"));
// «моаршал» — PaydaDosh: «здоровье», «привет, приветствие»; в разговорнике: «Моаршал хилда хьона!» — Привет! Мир тебе!
assert.strictEqual(sense("моаршал"), "привет");
// «миштад» — PaydaDosh: «как? каков? …; шун вахар? Какова ваша жизнь?» — не ингушские слова внутри записи
assert.strictEqual(sense("миштад"), "как");
// «кхо» — PaydaDosh: «три» и «навоз»; «ХӀанз кхо сахьат даьннад» — сейчас три часа
assert.strictEqual(sense("кхо"), "три");
// «хана» — словарь знает только «возрастной»; тексты (подтверждено словарями): «время»; «Цу хана» — в это время
assert.strictEqual(sense("хана"), "время");
// «сурташ» — словарь знает только «сурта — картинный»; тексты: «фотографии» («сурташка хьажа» — посмотреть фотографии)
assert.strictEqual(sense("сурташ"), "фотографии");
// «аьннад» — не «Цитирующая частица»; «Цо сога аьннад» — он мне сказал
assert.strictEqual(sense("аьннад"), "сказал");
// слово из словаря проекта — его первое значение, тексты (газеты) не перебивают: «гӀала» — город (не «башня»),
// «сом» — фрукт (не «рубль»), «ший» — свой, «дика» — хороший
assert.strictEqual(sense("гӏала"), "город");
assert.strictEqual(sense("сом"), "фрукт");
assert.strictEqual(sense("ший"), "свой");
assert.strictEqual(sense("дика"), "хороший");
console.log("ok 2: значения слов —", ["хабар", "моаршал", "хана", "сурташ"].map((w) => w + ": " + sense(w)).join(", "));

// 3. фразы разговорника PaydaDosh целиком (перевод по словам, без готовой фразы)
// «Дукха хабар дувц цо» — он много говорит
assert.ok(!/от хаба/i.test(tr("Дукха хабар дувц цо.")), tr("Дукха хабар дувц цо."));
assert.ok(!/от хаба/i.test(tr("Хабар ма дувца!")), tr("Хабар ма дувца!"));
assert.ok(/сказал/.test(tr("Цо сога аьннад")), tr("Цо сога аьннад"));
assert.ok(/время/.test(tr("Цу хана")), tr("Цу хана"));
assert.ok(/три/.test(tr("ХӀанз кхо сахьат даьннад.")) && !/навоз/.test(tr("ХӀанз кхо сахьат даьннад.")), tr("ХӀанз кхо сахьат даьннад."));
assert.ok(/ложь/.test(tr("Хоарцо езац сона.")), tr("Хоарцо езац сона."));
console.log("ok 3: фразы —", tr("Дукха хабар дувц цо."), "|", tr("Цо сога аьннад"), "|", tr("ХӀанз кхо сахьат даьннад."));

console.log("Все проверки выбора значения прошли.");
