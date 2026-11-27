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
  // отрицание не теряется: «венавац» (корпус: «пришёл») — не «пришёл»; числительные — не из таблицы корпуса
  for (const t of ["Саг венавац", "шовзткъеи ши"]) {
    const q = C0.translate(t, "inh");
    assert.ok(!q || !q.pieces.some((p) => p.how === "corpus" && !/^не/.test(p.to) && /ц$/.test(p.from)) && !q.pieces.some((p) => p.how === "corpus" && /пятьдесят|четверт/.test(p.to)), JSON.stringify(q && q.pieces));
  }
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
  console.log("ok 8: пометы и заполнители —", a, "|", b, "|", c && c.translation, "|", d.translation);
}

// 9. одна согласная буква — не слово: «и т. д.», пометы класса «(й, б, д)»
{
  const r = C.translate("Доастам ваккха (й, б, д,)", "inh");
  assert.ok(!/\[[бд]\]/.test(r.translation), r.translation);
  console.log("ok 9: «Доастам ваккха (й, б, д,)» →", r.translation);
}

// 10. палочка Ӏ в начале слова — не заглавная буква: «Ӏуйре» — утро, не имя (справочник: «Ӏуйре дика хийла»)
{
  const r = C0.translate("дика Ӏуйре", "inh");
  assert.ok(piece(r, "ӏуйре").how !== "name", JSON.stringify(r.pieces));
  console.log("ok 10: «дика Ӏуйре» →", r.translation);
}

console.log("все проверки неизвестных слов прошли");
