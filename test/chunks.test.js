// Перевод «по кускам» без ИИ (lib/rules/chunks.js) и то, что сервер отвечает им, когда ИИ выключен.
//   node test/chunks.test.js
// Ожидаемые ингушские слова — из справочника (lib/ingush-guide.js) и словаря проекта, не придуманы.
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const LEX = require("../lib/corpus-lexicon.js");
const SEED = require("../data/phrases.json");
const RET = require("../lib/retrieval.js")({ KB, SEED, LEX });
const C = require("../lib/rules/chunks.js")({ RET, SEED });
const tr = (t, src = "ru") => (C.translate(t, src) || {}).translation;

(async () => {
  // 1. глаголы знания — с дательным (справочник: «сона хов»), дополнение в именительном, глагол в конце
  assert.strictEqual(tr("Я знаю этого человека"), "Сона ер саг хов");
  console.log("ok 1: «Я знаю этого человека» →", tr("Я знаю этого человека"));

  // 2. «и» — «а» после каждого слова (справочник: «да а нана а»)
  assert.ok(/^Да а нана а /.test(tr("Отец и мать работают дома")), tr("Отец и мать работают дома"));
  console.log("ok 2: «Отец и мать…» →", tr("Отец и мать работают дома"));

  // 3. «идёт» согласуется с подлежащим: мальчик — в (вода), она — й (йода); предлог «в» не переводится
  assert.ok(/ вода$/.test(tr("Мальчик идёт в школу")), tr("Мальчик идёт в школу"));
  assert.ok(/^Из .* йода$/.test(tr("Она идёт в магазин")), tr("Она идёт в магазин"));
  console.log("ok 3: класс глагола по подлежащему —", tr("Мальчик идёт в школу"), "|", tr("Она идёт в магазин"));

  // 4. «люблю» согласуется с тем, кого любят (справочник: «Сона хьо веза» — мужчине)
  assert.strictEqual(tr("Я тебя люблю"), "Сона хьо веза");
  assert.ok(/нана еза$/.test(tr("Я люблю свою маму")), tr("Я люблю свою маму"));
  console.log("ok 4: «Я тебя люблю» →", tr("Я тебя люблю"), "|", tr("Я люблю свою маму"));

  // 5. ингушский → русский: местоимения, глаголы по лицу, связка в конце не переводится;
  // в русском вопросе вопросительное слово — первым
  assert.strictEqual(tr("Хьо мича вода?", "inh"), "Куда ты идешь?");
  assert.strictEqual(tr("Из кхалсаг я", "inh"), "Она женщина");
  console.log("ok 5: ингушский → русский —", tr("Хьо мича вода?", "inh"), "|", tr("Из кхалсаг я", "inh"));

  // 6. неизвестное слово — в [скобках]; почти ничего не известно — модуль молчит
  assert.ok(/\[[а-я]+\]/.test(tr("Сегодня хорошая погода, мы пойдём на реку")), tr("Сегодня хорошая погода, мы пойдём на реку"));
  assert.strictEqual(C.translate("Квазиэлектрон фрактализуется", "ru"), null);
  console.log("ok 6: неизвестные слова в скобках, бессмыслица — без ответа");

  // 6б. связка, если глагола нет (справочник, раздел 4): «Из дика саг ва»; с «не» — вац; в вопросе — за вопросительным словом
  assert.strictEqual(tr("Он мой брат"), "Из са воша ва");
  assert.strictEqual(tr("Мой брат не дома"), "Са воша цӀагӀа вац");
  assert.strictEqual(tr("Где мой брат?"), "Мичахьа ва са воша?");
  assert.ok(!/ (ва|да)$/.test(tr("Старый друг вернулся")), "«старый друг» — не «друг старый»: связки нет");
  console.log("ok 6б: связка —", tr("Он мой брат"), "|", tr("Мой брат не дома"), "|", tr("Где мой брат?"));

  // 6в. шаблоны разговорника с «…» (PaydaDosh: «Меня зовут … — Со … яхаш ва» / «Са цӀи … я»); имя остаётся как есть
  assert.ok(/Ахмед/.test(tr("Меня зовут Ахмед")) && /(яхаш|цӀи)/.test(tr("Меня зовут Ахмед")), tr("Меня зовут Ахмед"));
  assert.strictEqual(tr("Са цӀи Ахмед я", "inh"), "Меня зовут Ахмед");
  // повелительное наклонение не угадываем: остаётся в скобках
  assert.ok(/\[приходи\]/.test(tr("Приходи завтра")), tr("Приходи завтра"));
  // «Мишта ва хьо?» — связка перед местоимением в русском не нужна
  assert.strictEqual(tr("Мишта ва хьо?", "inh"), "Как ты?");
  console.log("ok 6в: шаблоны и осторожность —", tr("Меня зовут Ахмед"), "|", tr("Приходи завтра"), "|", tr("Мишта ва хьо?", "inh"));

  // 6е. ингушский → русский (справочник, разделы 4–8; PaydaDosh):
  // причастие на -ш + связка — настоящее время глагола по лицу подлежащего; «вац» — «не»
  assert.strictEqual(tr("Со кхеташ вац.", "inh"), "Я не понимаю.");
  assert.ok(/^Он .*живет\.$/.test(tr("Из Назране вахаш ва.", "inh")), tr("Из Назране вахаш ва.", "inh"));
  // глагол второй, подлежащее после него → по-русски подлежащее перед глаголом, вопросительное слово первым
  assert.ok(/^(Где|Куда) ты живешь\?$/.test(tr("Мича вах хьо?", "inh")), tr("Мича вах хьо?", "inh"));
  // прошедшее связки — по подлежащему: «Мича дар шо?» (Where were you?)
  assert.ok(/^(Где|Куда) вы были\?$/.test(tr("Мича дар шо?", "inh")), tr("Мича дар шо?", "inh"));
  // «X а Y а» — «X и Y»
  assert.strictEqual(tr("ди а бийса а", "inh"), "День и ночь");
  // слитная связка: «Миштав хьо?» = «Мишта ва хьо?»
  assert.strictEqual(tr("Миштав хьо?", "inh"), "Как ты?");
  // глагол с дательным: кому — подлежащее, кто в именительном — дополнение («Сона хьо веза» — я тебя люблю)
  assert.strictEqual(tr("Сона хьо веза", "inh"), "Я тебя люблю");
  // «не» связки — перед сказуемым
  assert.strictEqual(tr("Са воша цӀагӀа вац", "inh"), "Мой брат не дома");
  console.log("ok 6е: ингушский → русский —", tr("Со кхеташ вац.", "inh"), "|", tr("Мича вах хьо?", "inh"), "|", tr("ди а бийса а", "inh"), "|", tr("Миштав хьо?", "inh"));

  // 6ж. русское спряжение (lib/rules/ru-conj.js) — только русская грамматика
  const RC = require("../lib/rules/ru-conj.js");
  assert.strictEqual(RC.present("понимать", 0), "понимаю");
  assert.strictEqual(RC.present("ходить", 0), "хожу");
  assert.strictEqual(RC.present("любить", 0), "люблю");
  assert.strictEqual(RC.present("жить", 2), "живет");
  assert.strictEqual(RC.present("учиться", 5), "учатся");
  assert.strictEqual(RC.present("написать", 1), "напишешь");
  assert.strictEqual(RC.present("прийти", 0), "приду");
  assert.strictEqual(RC.present("рисовать", 0), "рисую");
  assert.strictEqual(RC.past("идти", "f"), "шла");
  assert.strictEqual(RC.past("учиться", "m"), "учился");
  assert.strictEqual(RC.past("мочь", "pl"), "могли");
  console.log("ok 6ж: русское спряжение");

  // 6г. таблица фраз из пар разговорника (lib/rules/align.js): «я не знаю» — «сона хац» (PaydaDosh / справочник);
  // каждое слово куска взято из ингушской стороны настоящих пар; редкий кусок (одна пара) не используется
  {
    const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "");
    const pairs = SEED.filter((p) => (p.kind === "phrase" || p.kind === "word") && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES, KB.GLOSSARY);
    const A = require("../lib/rules/align.js")(pairs);
    const toks = require("../lib/rules/align.js").toks;
    const ap = A.phrase(["я", "не", "знаю"], "ru");
    assert.ok(ap && ap.to === "сона хац" && ap.n >= 2 && ap.p >= 0.3, JSON.stringify(ap));
    const inhWords = new Set(pairs.flatMap(([, i]) => toks(i)));
    assert.ok(ap.to.split(" ").every((w) => inhWords.has(w)));
    assert.strictEqual(A.phrase(["квази", "электрон"], "ru"), null);
    assert.strictEqual(A.phrase(["я", "не", "знаю"], "ru", { minN: 1000 }), null);
    // хук в chunks.js: кусок, которого нет в словаре, берётся из таблицы фраз
    const C2 = require("../lib/rules/chunks.js")({ RET, SEED, ALIGN: { best: () => null, prob: () => 0, phrase: (ws) => (ws.join(" ") === "квази электрон" ? { to: "сона хац", p: 1, n: 9 } : null) } });
    const r = C2.translate("Квази электрон", "ru");
    assert.ok(r && r.pieces.some((x) => x.how === "align-phrase"), JSON.stringify(r));
    console.log("ok 6г: таблица фраз — «я не знаю» →", ap.to, `(p=${ap.p.toFixed(2)}, n=${ap.n})`);
  }

  // 7. сервер: без USE_AI=1 ИИ не вызывается, отвечает перевод по кускам
  let aiCalls = 0;
  global.fetch = async () => { aiCalls++; throw new Error("no network"); };
  process.env.GEMINI_API_KEY = "test"; // ключ есть, но ИИ выключен
  const T = require("../api/translate.js");
  T._setStore({ get: async () => null, setJSON: async () => {} });
  require("../lib/corpus.js")._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  const call = (body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } }; T({ method: "POST", body }, res); });
  const s = await call({ text: "Мальчик идёт в большую школу", source: "ru", target: "inh", mode: "text" });
  assert.strictEqual(s.code, 200);
  assert.strictEqual(s.data.chunks, true);
  assert.ok(!s.data.ai, "не ИИ");
  assert.ok(/ вода$/.test(s.data.translation), s.data.translation);
  assert.strictEqual(aiCalls, 0, "к ИИ не обращались");
  // одно ингушское слово — форма глагола из библиотеки слов, а не «бегущий» из словаря
  const v = await call({ text: "вода", source: "inh", target: "ru", mode: "word" });
  assert.ok(/^ид[её]т$/.test(v.data.translation), v.data.translation);
  console.log(`ok 7: сервер без ИИ → «${s.data.translation}» [${s.data.model}]`);

  console.log("\nВсе проверки перевода по кускам прошли.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
