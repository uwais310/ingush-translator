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

// 1. ингушская форма из таблицы корпуса, перевод подтверждён словарями: «эггара» — «самых» (corpus-lexicon: самых:28*)
{
  const r = C.translate("эггара дика саг", "inh");
  const p = piece(r, "эггара");
  assert.ok(p && p.how === "corpus" && p.to === "самых", JSON.stringify(r && r.pieces));
  console.log("ok 1: «эггара дика саг» →", r.translation);
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

// 6. русский синоним из нашего словаря: «поручать» есть только в редкой записи PaydaDosh «амалт де — поручить,
// поручать»; «поручить» — «тӀадила» (PaydaDosh: «тӀадила — задать, поручить…»)
{
  const r = C0.translate("Мама поручает мне работу", "ru");
  const p = piece(r, "поручает");
  assert.ok(p && p.how === "synonym" && p.syn === "поручить" && p.to === "тӀадила", JSON.stringify(r.pieces));
  console.log("ok 6: «Мама поручает мне работу» →", r.translation, `(«поручает» ≈ «${p.syn}»)`);
}

// 7. формы, которые ждут носителей (CLAUDE.md: «пришёл», «прийти»), синонимом не заменяются
{
  for (const t of ["прийти домой", "Она пришла домой"]) {
    const r = C0.translate(t, "ru");
    assert.ok(!r || !r.pieces.some((p) => p.how === "synonym"), t + " → " + JSON.stringify(r && r.pieces));
  }
  console.log("ok 7: «прийти», «пришла» — без синонимов");
}

// 8. пометы окончаний и заполнители толкований — не слова: «Ленивый (-ая, -ые)», «Прим.: -ая, ые», «кого-либо»
{
  const a = C0.translate("Ленивый (-ая, -ые), неповоротливый.", "ru").translation;
  assert.ok(!/\[(ая|ые)\]/.test(a), a);
  const b = C0.translate("Горбатый. Прим.: -ая, ые.", "ru").translation;
  assert.ok(!/\[(ая|ые)\]/.test(b), b);
  const c = C0.translate("Вскружить голову кому-либо", "ru");
  assert.ok(!c || !/либо/.test(c.translation), c && c.translation);
  // одно такое слово — синоним из словаря: «что-либо» → «что-нибудь»
  const d = C0.translate("что-либо", "ru");
  assert.ok(d && d.pieces[0].how === "synonym" && d.pieces[0].syn === "что-нибудь", JSON.stringify(d && d.pieces));
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

// 10. замер считает неизвестные слова (scripts/eval-chunks.js)
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "../scripts/eval-chunks.js"), "utf8");
  assert.ok(/неизвестные слова: во фразах/.test(src) && /unkPhr, unkTok/.test(src));
  console.log("ok 10: eval-chunks показывает неизвестные слова");
}
console.log("все проверки неизвестных слов прошли");
