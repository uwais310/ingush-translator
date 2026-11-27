// Неизвестные слова в переводе по словам (lib/rules/chunks.js): запасной поиск ингушского слова и русские синонимы.
//   node test/unknown-words.test.js
// Ингушские слова здесь — только из данных проекта (источник — в комментарии у каждой проверки), не придуманы.
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
// как на сайте (api/translate.js): с таблицей слов из пар фраз
const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "") && !p.rare;
const phrases = SEED.filter((p) => p.kind === "phrase" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES.map(([ru, inh]) => [ru, inh]));
const words = SEED.filter((p) => p.kind === "word" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.GLOSSARY.map(([ru, inh]) => [ru, inh]));
const ALIGN = require("../lib/rules/align.js")([...phrases, ...words]);
const C = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN, EXAMPLES: phrases });
const C0 = require("../lib/rules/chunks.js")({ RET, SEED });
const piece = (r, from) => r && r.pieces.find((p) => p.from === from);

// 1. ингушская форма из таблицы корпуса, перевод подтверждён словарями: «эггара» — самых / самым / самые / самый
// (corpus-lexicon; строки корпуса GhalghayTools в базе) → словарная форма «самый».
// Фраза — PaydaDosh: «Сага эггара халагӀдар – ше вовзар» — для человека самое сложное – познать себя (по словам)
{
  const r = C.translate("Сага эггара халагӀдар – ше вовзар", "inh", { noWhole: true });
  const p = piece(r, "эггара");
  assert.ok(p && p.how === "corpus" && p.to === "самый", JSON.stringify(r && r.pieces));
  console.log("ok 1: «Сага эггара халагӀдар – ше вовзар» →", r.translation);
  // и в начале предложения — не имя: «Эггара хозача йоӀах фоарт йӀаьха я аьннад» (PaydaDosh)
  const r2 = C.translate("Эггара хозача йоӀах фоарт йӀаьха я аьннад", "inh", { noWhole: true });
  assert.strictEqual(piece(r2, "эггара").how, "corpus", JSON.stringify(r2.pieces));
  console.log("   ", r2.translation);
  // отрицание не теряется: «венавац» (корпус: «пришёл») — не «пришёл»; часть составного числа — не число всей
  // связки (PaydaDosh: «Тридцать — Ткъаь итт», «Двести тридцать рублей — Ши бӀаь ткъаь итт сом»)
  for (const t of ["Саг венавац", "Ткъаь итт", "Ши бӀаь ткъаь итт сом"]) {
    const q = C0.translate(t, "inh");
    assert.ok(!q || !q.pieces.some((p) => p.how === "corpus" && !/^не/.test(p.to) && /ц$/.test(p.from)) && !q.pieces.some((p) => p.how === "corpus" && /тридцать|пятьдесят|четверт/.test(p.to)), JSON.stringify(q && q.pieces));
  }
  // простое число таблица знает верно: «шийтта» — двенадцать (PaydaDosh: «Ӏай шийтта дийнахьа меца лийннав» —
  // зимой двенадцать дней голодным ходил); русское «двенадцать» — не «две…»
  const n12 = C0.translate("Аьхки цхьа ди доадаьр, Ӏай шийтта дийнахьа меца лийннав", "inh");
  assert.strictEqual(piece(n12, "шийтта").to, "двенадцать", JSON.stringify(n12.pieces));
  // «Ӏай» (корпус: «зимой») — наречие, не прилагательное: не «зимая»
  assert.ok(!/зимая/.test(n12.translation), n12.translation);
  console.log("   ", n12.translation);
}

// 1б. формы одного русского слова — одна группа, даже если у каждой своя строка в таблице корпуса: «программа» —
// программа 76, программы 67, программу 31 (одна форма меньше половины). Фраза — Википедия в базе
// («уж я шоай гӀонца, пайда эцачар программа урхал ду кечалаш»)
{
  const r = C0.translate("уж я шоай гӀонца, пайда эцачар программа урхал ду кечалаш", "inh");
  assert.strictEqual(piece(r, "программа").to, "программа", JSON.stringify(r.pieces));
  // глагол — самая частая форма группы, без начальной формы: «ладийгӀар» — «выслушал» (PaydaDosh:
  // «Даь хьехамашка ладийгӀар атта гӀалата варгвац»)
  const v = C0.translate("Даь хьехамашка ладийгӀар атта гӀалата варгвац.", "inh");
  assert.strictEqual(piece(v, "ладийгӏар").to, "выслушал", JSON.stringify(v.pieces));
  console.log("ok 1б: «программа», «ладийгӀар» →", piece(r, "программа").to, piece(v, "ладийгӏар").to);
}

// 1в. «самый» согласуется со следующим прилагательным, а перед сравнительной степенью не ставится (PaydaDosh:
// «Эггара хозача йоӀах фоарт йӀаьха я аьннад», «Эггара хозагӀа дола хӀама да аьлча, хьаргӀийво ший кӀориг енай»)
{
  const a = C0.translate("Эггара хозача йоӀах фоарт йӀаьха я аьннад", "inh", { noWhole: true });
  assert.ok(/^Самая красивая/.test(a.translation), a.translation);
  const b = C0.translate("Эггара хозагӀа дола хӀама да аьлча, хьаргӀийво ший кӀориг енай", "inh", { noWhole: true });
  assert.ok(!/самый красивее/i.test(b.translation) && /красивее всех/i.test(b.translation), b.translation);
  // притяжательные на -ий: волчий → волчья, коровий → коровье (не «волчая», «коровее»)
  const R = require("../lib/rules/russian.js");
  assert.deepStrictEqual(["f", "n", "pl"].map((g) => R.adj("волчий", g)), ["волчья", "волчье", "волчьи"]);
  assert.strictEqual(R.adj("коровий", "n"), "коровье");
  assert.strictEqual(R.adj("синий", "f"), "синяя");
  console.log("ok 1в:", a.translation, "|", b.translation);
}

// 2. редкая запись PaydaDosh (слово есть в словаре, но не в собранных текстах): «доарех» — «дёшево» (PaydaDosh)
{
  const r = C0.translate("доарех да", "inh");
  const p = piece(r, "доарех");
  assert.ok(p && p.how === "near" && /^деш/.test(p.to.replace(/ё/g, "е")), JSON.stringify(r && r.pieces));
  console.log("ok 2: «доарех» →", p.to, `(${p.how}, ${p.src})`);
}

// 3. частица остаётся в скобках: «аьнна» — «цитирующая частица» (PaydaDosh); перевод корпуса «сказал» здесь мимо
{
  const r = C.translate("дош аьнна", "inh");
  assert.strictEqual(piece(r, "аьнна").how, "unknown", JSON.stringify(r.pieces));
  console.log("ok 3: «дош аьнна» →", r.translation);
}

// 4. похожее слово другого класса не подставляется: «детт» — не «етт» (корова, PaydaDosh)
{
  const r = C0.translate("ЦӀогӀа хӀана детт Ӏа?", "inh");
  assert.ok(!/коров/.test(r.translation), r.translation);
  console.log("ok 4: «ЦӀогӀа хӀана детт Ӏа?» →", r.translation);
}

// 5. перфект класса й с отрицанием пишется «-яц»: «хиннаяц» = хинна + й + ац
// (PaydaDosh: «Ца яьчох нана хиннаяц» — не рожавшая матерью не стала; «хинна» — причастие «хила», inh-verbs.js)
{
  const r = C.translate("Ца яьчох нана хиннаяц", "inh");
  const p = piece(r, "хиннаяц");
  assert.ok(p && p.to === "не была", JSON.stringify(r.pieces));
  console.log("ok 5: «Ца яьчох нана хиннаяц» →", r.translation);
}

// 6. русское слово только с редкой записью PaydaDosh — перевод из неё (how: "near"): «кинотеатр» — «кийнотеатр»
// (PaydaDosh, форма есть в словаре, но не в собранных текстах)
{
  const r = C0.translate("Я иду в кинотеатр", "ru");
  const p = piece(r, "кинотеатр");
  assert.ok(p && p.how === "near" && p.to === "кийнотеатр", JSON.stringify(r && r.pieces));
  console.log("ok 6: «Я иду в кинотеатр» →", r.translation);
}

// 7. формы, которые ждут носителей (CLAUDE.md: «пришёл», «прийти»), догадками не заменяются
{
  for (const t of ["прийти домой", "Она пришла домой"]) {
    const r = C0.translate(t, "ru");
    assert.ok(!r || !r.pieces.some((p) => p.how === "synonym" || p.how === "near"), t + " → " + JSON.stringify(r && r.pieces));
  }
  // и не из таблицы корпуса: «Ӏумар пришёл» не даёт «венав» (имя — PaydaDosh: «Ӏумар»)
  for (const t of ["Ӏумар пришёл", "Он пришёл домой", "Кто пришёл?"]) {
    const r = C.translate(t, "ru");
    assert.ok(!r || !r.pieces.some((p) => /^приш/.test(p.from) && p.how !== "unknown"), t + " → " + JSON.stringify(r && r.pieces));
  }
  console.log("ok 7: «прийти», «пришла», «пришёл» — без догадок");
}

// 8. пометы окончаний и заполнители толкований — не слова: «Ленивый (-ая, -ые)», «Прим.: -ая, ые», «кого-либо»
{
  const a = C0.translate("Ленивый (-ая, -ые), неповоротливый.", "ru").translation;
  assert.ok(!/\[(ая|ые)\]/.test(a), a);
  const b = C0.translate("Горбатый. Прим.: -ая, ые.", "ru").translation;
  assert.ok(!/\[(ая|ые)\]/.test(b), b);
  const c = C0.translate("Вскружить голову кому-либо", "ru");
  assert.ok(!c || !/либо/.test(c.translation), c && c.translation);
  // «что-либо» в обычной фразе — запись «что-нибудь» целиком: «моллагӀа цхьа хӀама» (PaydaDosh)
  const d = C0.translate("Скажи что-либо", "ru");
  const dp = piece(d, "что-либо");
  assert.ok(dp && dp.how === "synonym" && dp.syn === "что-нибудь" && dp.to === "моллагӀа цхьа хӀама", JSON.stringify(d && d.pieces));
  // падежная форма («кого-то») — без синонима: формы падежа словарь по-ингушски не даёт
  const e = C0.translate("Я кого-то видел", "ru");
  assert.ok(!e || !e.pieces.some((p) => p.how === "synonym"), JSON.stringify(e && e.pieces));
  // после «хочу, могу» неопределённая форма — не толкование: «-либо» не пропускается
  const f = C0.translate("Хочу купить что-либо", "ru");
  assert.ok(f.pieces.some((p) => p.from === "что-либо" && p.how === "synonym"), JSON.stringify(f.pieces));
  console.log("ok 8: пометы и заполнители —", a, "|", b, "|", c && c.translation, "|", d.translation, "|", f.translation);
}

// 9. одна согласная буква — не слово: «и т. д.», пометы класса «(й, б, д)»
{
  const r = C.translate("Доастам ваккха (й, б, д,)", "inh");
  assert.ok(!/\[[бд]\]/.test(r.translation), r.translation);
  console.log("ok 9: «Доастам ваккха (й, б, д,)» →", r.translation);
}

// 10. палочка Ӏ в начале слова — не заглавная буква: «Ӏуйре» — утро, не имя
// (PaydaDosh: «И тебе доброго утра — Хьа а хийла Ӏуйре дика»)
{
  const r = C0.translate("Хьа а хийла Ӏуйре дика", "inh", { noWhole: true });
  assert.ok(piece(r, "ӏуйре").how !== "name", JSON.stringify(r.pieces));
  console.log("ok 10: «Хьа а хийла Ӏуйре дика» →", r.translation);
}

console.log("все проверки неизвестных слов прошли");
