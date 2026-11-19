// Проверка перевода простых бытовых предложений без ИИ (как на сайте при выключенном ИИ).
//
//   node scripts/check-everyday.js                 # все предложения: вход → выход [откуда] ФЛАГИ
//   node scripts/check-everyday.js --bad           # только с флагами
//   node scripts/check-everyday.js --json out.json # и сохранить результаты в JSON
//
// Сервер (api/translate.js) вызывается так же, как в test/chunks.test.js, раздел 7: без сети, с пустым
// хранилищем, USE_AI не задан. Список — ~300 русских бытовых предложений и ~100 ингушских, взятых только
// из примеров справочника (lib/ingush-guide.js) и фраз разговорника (data/phrases.json, PaydaDosh), иногда
// с минимальной заменой (местоимение, слово того же класса) — только словами из этих же источников.
//
// Флаги (автоматически):
//   bracket     — слово осталось в [скобках] (не найдено)
//   russian     — русское слово в ингушском ответе (lib/postcheck.js)
//   ingush-left — ингушское слово в русском ответе (буквосочетания ӏ, хь, кх, къ, оа, гласная + ь)
//   same        — ответ совпадает со входом
//   empty       — ответа нет
//   explain     — в ответе пояснения словаря: «наст.», «прош.», «мн.», «отдельного слова нет», (скобки), «см.»
//   dup         — одно и то же слово дважды
//   verb-order  — ru→inh по словам: русский глагол переведён, но стоит не в конце
//   verb-lost   — ru→inh по словам: русский глагол остался в [скобках] или переведён не глаголом (существительным)
//   cop+verb    — ru→inh по словам: в предложении есть глагол, а модуль всё равно поставил связку (ва, я, да, ба)
//   pb-mismatch — в разговорнике (PaydaDosh / справочник) есть то же предложение, а ответ ни с одним вариантом не совпал
//   pb-near     — в разговорнике есть почти то же предложение (одно слово другое): показываем для сравнения
// Ничего не меняет в коде и данных; к ИИ не обращается.
delete process.env.USE_AI;
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const KB = require(path.join(ROOT, "lib/ingush-guide.js"));
const SEED = require(path.join(ROOT, "data/phrases.json"));
const L = require(path.join(ROOT, "lib/rules/lexicon.js"));
const POST = require(path.join(ROOT, "lib/postcheck.js"))({ SEED, KB, L });

// ---------------- русские предложения ----------------
const RU = `
Привет
Здравствуйте
Доброе утро
Добрый вечер
Спокойной ночи
До свидания
До завтра
Как дела?
Как ты?
Всё хорошо
Спасибо большое
Извини
Рад тебя видеть
С днём рождения
Удачи тебе
Это мой брат
Это моя сестра
Мой отец работает
Моя мать дома
У меня есть брат
У меня нет сестры
У меня два брата
У него три сына
Мой сын учится в школе
Где твой отец?
Как зовут твою сестру?
Моя бабушка старая
Мой дедушка болеет
Наши дети спят
Я люблю свою семью
Твой брат дома?
Его жена учительница
Её муж врач
У нас большая семья
Я старший брат
Отвези еду
Отвези меня домой
Отвези детей в школу
Принеси воду
Принеси хлеб
Принеси чай
Дай мне воды
Я хочу есть
Я хочу пить
Я голоден
Ешь хлеб
Пей чай
Налей чай
Купи молоко
Мясо готово
Хлеб свежий
Я люблю мясо
Мы едим суп
Он пьёт молоко
Она варит обед
Ужин готов?
Чай горячий
Вода холодная
Я не ем мясо
Дай мне соль
Где сахар?
Сколько стоит хлеб?
Положи еду на стол
Убери посуду
Еда вкусная
Я поел
Ты поел?
Мама готовит еду
Закрой дверь
Открой дверь
Открой окно
Закрой окно
Выключи свет
Включи свет
Иди домой
Я иду домой
Он пришёл домой
Дом большой
Наш дом новый
Где ключи?
Ключ на столе
Сядь здесь
Садись
Подожди меня
Подожди немного
Не уходи
Не трогай
Не кричи
Не бойся
Не спи
Не плачь
Вставай
Ложись спать
Помой руки
Отнеси сумку
Возьми книгу
Положи книгу
Дай мне нож
Позови отца
Скажи матери
Спроси брата
Помоги мне
Иди сюда
Иди туда
Приходи завтра
Приходи к нам
Уходи
Стой
Слушай меня
Посмотри сюда
Скажи правду
Дай руку
Иди спать
Не опаздывай
Позвони мне
Напиши мне
Отправь фото
Сколько это стоит?
Это дорого
Это дёшево
Я куплю это
Где магазин?
Где рынок?
Магазин закрыт
Магазин открыт
У меня нет денег
Дай сдачу
Я хочу купить хлеб
Он купил машину
Мы купили дом
Сколько стоит мясо?
Дайте два килограмма
Я болею
У меня болит голова
У меня болит живот
Мне плохо
Мне лучше
Где больница?
Позови врача
Он болен
Она здорова
Выпей лекарство
Я устал
Мне холодно
Мне жарко
Я хочу спать
Сегодня холодно
Сегодня тепло
Идёт дождь
Идёт снег
Светит солнце
Завтра будет дождь
Вчера было холодно
Погода хорошая
Сегодня хорошая погода
Зима холодная
Летом жарко
Где мечеть?
Где школа?
Где дорога?
Иди прямо
Поверни направо
Поверни налево
Это далеко?
Это близко
Как пройти к мечети?
Куда ты идёшь?
Куда он пошёл?
Откуда ты?
Я из Назрани
Он живёт в Назрани
Я живу здесь
Где ты живёшь?
Который час?
Сейчас три часа
Уже поздно
Ещё рано
Когда ты придёшь?
Когда он вернётся?
Я приеду завтра
Вчера я был дома
Завтра я пойду на работу
Сколько тебе лет?
Мне двадцать лет
Каждый день
Утром я работаю
Вечером мы отдыхаем
Я работаю
Где ты работаешь?
Я иду на работу
Он работает в больнице
Отец на работе
Я закончил работу
Много работы
Работа трудная
Я учитель
Он врач
Она учительница
Мы работаем вместе
Я учусь
Я студент
Дети идут в школу
Мальчик идёт в школу
Девочка читает книгу
Я читаю книгу
Напиши письмо
Прочитай книгу
Учитель говорит
Я не понимаю
Я понимаю
Повтори
Я знаю
Я не знаю
Ты знаешь ингушский язык?
Я плохо говорю по-ингушски
Говори медленнее
Где ты?
Где мама?
Куда ты едешь?
Когда ты пришёл?
Почему ты плачешь?
Почему ты молчишь?
Сколько у тебя детей?
Сколько стоит?
Кто это?
Кто пришёл?
Кто там?
Что это?
Что ты делаешь?
Что ты хочешь?
Что случилось?
Как тебя зовут?
Как его зовут?
Чей это дом?
Какой у тебя номер?
Почему он не пришёл?
Где ты был?
Кто твой отец?
Что ты сказал?
Куда мы идём?
Ты голоден?
Я видел его вчера
Он ушёл
Она пришла
Мы пошли домой
Я сделал работу
Он сказал правду
Я купил хлеб
Я напишу письмо
Я позвоню тебе завтра
Мы пойдём на реку
Он приедет завтра
Я буду дома
Она будет работать
Я сделаю это
Мы поедем в Назрань
Он прочитал книгу
Я забыл
Я вспомнил
Дети спали
Отец построил дом
Я не хочу
Я не пойду
Он не пришёл
Я не видел его
Это не мой дом
Он не мой брат
Я не голоден
Не надо
Никто не пришёл
Ничего нет
Я никогда там не был
Мне не нравится
У меня есть машина
У меня есть дом
У меня нет времени
У тебя есть деньги?
У него есть сестра
У нас нет хлеба
У меня есть вопрос
У неё есть дети
Мой дом
Твоя книга
Его машина
Наша школа
Ваш сын
Их дом
Это моя книга
Это твой нож?
Где моя сумка?
Где твоя мать?
Один человек
Два брата
Три дня
Пять рублей
Десять лет
Два дома
Три дочери
Четыре книги
Сто рублей
Один час
Большой дом
Маленький мальчик
Красивая девушка
Хороший человек
Плохой день
Старый друг
Новая машина
Холодная вода
Горячий чай
Высокая гора
Дом красивый
Девушка красивая
Мальчик маленький
Этот человек хороший
Отец и мать работают дома
Мама готовит обед на кухне
Брат читает книгу дома
Я хочу пить воду
Она пошла в магазин за хлебом
Мой брат живёт в Москве
Я жду тебя
Он ждёт автобус
Я тебя люблю
Я знаю этого человека
Мы идём домой
Они пришли вчера
Ты пойдёшь?
Я рад
Мне грустно
Я боюсь
Не переживай
Молодец
Можно войти?
Тебе помочь?
Мне надо идти
Я могу это сделать
`;

// ---------------- ингушские предложения ----------------
// v: дословно из справочника (G) или PaydaDosh (P); m: минимальная замена, в комментарии — исходная фраза.
const INH = [
  // справочник (lib/ingush-guide.js, EXAMPLES)
  "Ӏуйре дика хийла хьа!", "Ди дика хилда хьа!", "Фу деш ва хьо?", "Фу деш я хьо?", "Баркал хьона!", "ЦӀи фу я хьа?",
  "Мичара ва хьо?", "Мича вода хьо?", "Мича йода хьо?", "Со цӀагӀа ва.", "Мича вах хьо?", "Со укхаза вахаш ва.",
  "Из Назране вахаш ва.", "Сона хов.", "Сона хац.", "Со кхеташ вац.", "Сона хьо еза.", "Фу хиннад?", "Фу аьлар Ӏа?",
  "Цо аьлар.", "Аз хаьттар.", "Фу де?", "Мала ва цига?", "Из дика саг ва.", "Ма де!", "Хабар ма дувца!",
  "Дукха хабар дувц цо.", "Эхь да.", "Фу деза шоана?", "Фу хиннад хьона?", "Могаш вий хьо?",
  // PaydaDosh (data/phrases.json, kind: phrase)
  "Миштав хьо?", "Со меца ва.", "КӀеззига сабардел.", "Кор дӀакъовла.", "Малув из?", "Мичахьа ва хьо?",
  "Геттара хоза хет.", "Со Наьсарера ва.", "Со дешаш ва.", "Корта лаза са.", "Ер са нана я.", "Из са да ва.",
  "ХӀанз тӀехьа да.", "НиӀ хьаел.", "Хий дӀайха да.", "Тахан шийла я.", "Со балха вода.", "Тика мичахьа я?",
  "Юхе да из.", "Деза да ер.", "Сога ахча дац.", "Аз кинишка дийшад.", "ДогӀ делх.", "Из дика да.",
  "Сагот ма де.", "Кхер со.", "Да цӀагӀа ва.", "Нана цӀагӀа яц.", "Хий шийла да.", "Никъ бӀаьха ба.",
  "Сона хьо гу.", "Сога машен я.", "Ха яц цунга.", "Со гӀоргвац.", "Маца воагӀаргва хьо?", "Мича долха вай?",
  "Дас машен ийцай.", "Аз урс хьаийцад.", "Ер са кинишка да.", "Со кхоана воагӀаргва.", "Аз эцаргда из.",
  "Со цамогаш ва.", "Ишта ма де.", "Сих ма ле.", "Сона хоза хет из.", "Сона хоза хетац из.", "ДогӀ сацад.",
  // минимальные замены (слова и формы — из тех же фраз)
  "Хьо цӀагӀа ва?", // Со цӀагӀа ва. — со → хьо
  "Из цӀагӀа ва.", // Наверное, он дома: цӀагӀа ва из
  "Са воша цӀагӀа ва.", // Да цӀагӀа ва. + «са воша» (справочник/тест: Из са воша ва)
  "Са нана цӀагӀа яц.", // Нана цӀагӀа яц. + са
  "Хьо меца ва?", // Со меца ва. — со → хьо
  "Из меца ва.", // Со меца ва. — со → из
  "Хьона хов?", // Сона хов. — сона → хьона (Ты знаешь…: хов хьона?)
  "Хьона хац.", // Сона хац.
  "Ер са воша ва.", // Ер са да ва. — да → воша (оба класса в)
  "Ер хьа нана я.", // Ер са нана я. — са → хьа
  "Из хьа да ва?", // Из са да ва. — са → хьа
  "Ер хьа кинишка да?", // Ер са кинишка да. — са → хьа
  "Мича вода из?", // Мича вода хьо? — хьо → из
  "Со балха йода.", // PaydaDosh: Со балха йода.
  "Из балха вода.", // Со балха вода. — со → из
  "Цо кинишка дийшад.", // Аз кинишка дийшад. — аз → цо
  "Цо урс хьаийцад.", // Аз урс хьаийцад. — аз → цо
  "Хий дика да.", // Хий шийла да. + Из дика да.
  "Кхоана шийла я.", // Тахан шийла я. — тахан → кхоана
  "Хьога ахча дац?", // Сога ахча дац. — сога → хьога
  "Хьога машен я?", // Сога машен я. — сога → хьога
  "Сона из гу.", // Сона хьо гу. — хьо → из
  "Хьо гӀоргвац?", // Со гӀоргвац. — со → хьо
  "Мала ва укхаза?", // Мала ва цига? — цига → укхаза
  "Хьо кхеташ вац?", // Со кхеташ вац. — со → хьо
  "Сона нана еза.", // Сона хьо еза. — хьо → нана (класс й)
  "НиӀ дӀакъовла.", // Кор дӀакъовла. — кор → ниӀ
  "Из укхаза вахаш ва.", // Со укхаза вахаш ва. — со → из
  "Из Наьсарера ва.", // Со Наьсарера ва. — со → из
  "Хьо дешаш ва?", // Со дешаш ва. — со → хьо
  "Из дика саг вац.", // Из дика саг ва. + вац
  "Да цӀагӀа вац.", // PaydaDosh: Отца нет дома
  "Нана цӀагӀа я.", // PaydaDosh: Мать дома
  "Ер са урс да.", // PaydaDosh: Это мой нож
  "Хьо мича вода?", // тест chunks: Хьо мича вода?
  "Из кхалсаг я.", // тест chunks: Из кхалсаг я
  "Мишта ва хьо?", // тест chunks
  "Со студент ва.", // PaydaDosh: Я студент
  "Хьо студент ва?", // Со студент ва. — со → хьо
  "Из студент я.", // PaydaDosh: Со студент я. — со → из
  "Цо машен ийцай.", // Дас машен ийцай. — дас → цо
  "Аз машен ийцай.", // Дас машен ийцай. — дас → аз
  "Со кхоана йоагӀаргья.", // PaydaDosh
  "Хьо кхоана воагӀаргва?", // Со кхоана воагӀаргва. — со → хьо
  "Из дика да?", // Из дика да.
  "Ер дика хоам ба.", // PaydaDosh
  "Тахан дика да.", // Тахан шийла я. + Из дика да. (дика да)
  "Хьо Наьсарера ва?", // Со Наьсарера ва. — со → хьо
  "Нана балха йода.", // Со балха йода. — со → нана
  "Да балха вода.", // Со балха вода. — со → да
  "Сона хьо веза.", // справочник
];

// ---------------- разговорник для сравнения ----------------
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[1lI|Ӏ]/g, "ӏ").replace(/[̀́]/g, "")
  .replace(/\([^()]*\)/g, " ").replace(/[^а-яӏ\s-]/g, " ").replace(/\s+/g, " ").trim();
const PB = { ru: new Map(), inh: new Map() };
const addPB = (ru, inh, src) => {
  if (!ru || !inh || /…|\.\.\./.test(ru)) return;
  for (const r of String(ru).split(/\s—\s/).slice(0, 1)) {
    for (const i of String(inh).split(/\s\/\s/)) {
      const kr = norm(r), ki = norm(i);
      if (!kr || !ki) continue;
      if (!PB.ru.has(kr)) PB.ru.set(kr, []); PB.ru.get(kr).push({ text: i.trim(), src });
      if (!PB.inh.has(ki)) PB.inh.set(ki, []); PB.inh.get(ki).push({ text: r.replace(/\s*\([^()]*\)\s*/g, " ").trim(), src });
    }
  }
};
for (const p of SEED) if (p.kind === "phrase" && /^(PaydaDosh|Справочник)/.test(p.source || "")) addPB(p.ru, p.inh, p.source.split(" ")[0]);
for (const [ru, inh] of KB.EXAMPLES) addPB(ru, inh, "Справочник");
const BY_LEN = { ru: new Map(), inh: new Map() };
for (const lang of ["ru", "inh"]) for (const k of PB[lang].keys()) { const n = k.split(" ").length; if (!BY_LEN[lang].has(n)) BY_LEN[lang].set(n, []); BY_LEN[lang].get(n).push(k); }
function phrasebook(input, lang) {
  const k = norm(input);
  if (PB[lang].has(k)) return { exact: true, key: k, refs: PB[lang].get(k) };
  const ws = k.split(" ");
  if (ws.length < 2) return null;
  for (const c of BY_LEN[lang].get(ws.length) || []) {
    const cs = c.split(" ");
    let diff = 0;
    for (let j = 0; j < ws.length && diff < 2; j++) if (cs[j] !== ws[j]) diff++;
    if (diff === 1) return { exact: false, key: c, refs: PB[lang].get(c) };
  }
  return null;
}

// ---------------- флаги ----------------
const NOT_RU = /ӏ|[аеиоуыэюя]ь|хь|кх|къ|оа|гӏ/;
const EXPLAIN = /\bнаст\.|\bпрош\.|\bмн\.|\bед\.|отдельного слова нет|\bсм\.|\bбукв\.|\bпер\.|\bдиал\.|\(|\)/;
const WORD = /[а-яёӀӏ]+(?:-[а-яёӀӏ]+)*/gi;
// модуль «по кускам» — такой же, как в api/translate.js (chunksEngine), чтобы видеть куски и глаголы
let CH = null;
function chunks() {
  if (CH) return CH;
  const RET = require(path.join(ROOT, "lib/retrieval.js"))({ KB, SEED, LEX: require(path.join(ROOT, "lib/corpus-lexicon.js")) });
  const ok = (p) => /^(PaydaDosh|Справочник)/.test(p.source || "");
  const phrases = SEED.filter((p) => p.kind === "phrase" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.EXAMPLES.map(([ru, inh]) => [ru, inh]));
  const words = SEED.filter((p) => p.kind === "word" && ok(p)).map((p) => [p.ru, p.inh]).concat(KB.GLOSSARY.map(([ru, inh]) => [ru, inh]));
  const ALIGN = require(path.join(ROOT, "lib/rules/align.js"))([...phrases, ...words]);
  CH = { RET, C: require(path.join(ROOT, "lib/rules/chunks.js"))({ RET, SEED, ALIGN, EXAMPLES: phrases }) };
  return CH;
}
const isVerbLemma = (l) => /(ть|ться|ти|чь|чься)$/.test(l);

function flagsFor(r) {
  const f = [];
  const out = String(r.out || "");
  const nIn = norm(r.input), nOut = norm(out);
  if (!out.trim()) { f.push("empty"); return f; }
  if (/\[[^\]]+\]/.test(out)) f.push("bracket");
  if (nIn === nOut) f.push("same");
  if (EXPLAIN.test(out)) f.push("explain");
  const ws = (nOut.match(/[а-яӏ]+(?:-[а-яӏ]+)*/g) || []).filter((w) => w !== "а" && w !== "е" && w.length > 1);
  const seen = new Set();
  for (const w of ws) { if (seen.has(w)) { f.push("dup"); break; } seen.add(w); }
  if (r.tgt === "inh") {
    const ru = POST.russian(out.replace(/\[[^\]]*\]/g, " "), r.input);
    if (ru.length) { f.push("russian"); r.russian = ru; }
  } else {
    const left = (out.match(WORD) || []).filter((w) => NOT_RU.test(norm(w)));
    if (left.length) { f.push("ingush-left"); r.ingushLeft = left; }
  }
  // по словам ru→inh: где глагол
  if (r.src === "ru" && r.chunks && r.pieces) {
    const { RET } = chunks();
    const ps = r.pieces.filter((p) => p.to || p.how === "unknown");
    const verbIdx = ps.map((p, k) => (p.verb ? k : -1)).filter((k) => k >= 0);
    if (verbIdx.length) {
      const tail = ps.length - verbIdx.length;
      // «Мича вода хьо?» — в вопросе глагол сразу за вопросительным словом (справочник, раздел 7): не ошибка
      const qOrder = ps.length === 3 && Object.values(L.QUESTION_WORDS).includes(ps[0].to) && ps[1].verb && Object.values(L.PRONOUNS).some((P) => P.nom === ps[2].to || P.erg === ps[2].to);
      if (!qOrder && verbIdx.some((k) => k < tail) && ps.slice(tail).some((p) => !p.verb && p.how !== "cop")) f.push("verb-order");
    }
    // глагол во входе: слово, у которого начальная форма — глагол, и которое не существительное в словаре
    const ruVerbs = (norm(r.input).match(/[а-я]+/g) || []).filter((w) => !["есть", "нет", "был", "была", "было", "были", "надо", "можно"].includes(w) && (isVerbLemma(w) || RET.lemmas(w, "ru").some(isVerbLemma)) && !(RET.lookupWord(w, "ru", 1) && !RET.lookupWord(w, "ru", 1).lemma && !isVerbLemma(w)));
    // омонимы-существительные («еду» — еда, «дети», «матери»): есть начальная форма-существительное в словаре — не глагол
    const nounToo = (w) => RET.lemmas(w, "ru").some((l) => !isVerbLemma(l) && (() => { const x = RET.lookupWord(l, "ru", 1); return x && !x.lemma; })());
    // глагол потерян: слово-глагол осталось в [скобках] или переведено одним словом, но не как глагол
    // (куски «analog», «phrase», «template» — целые фразы из разговорника, их не проверяем)
    const lost = ruVerbs.filter((w) => !nounToo(w)).filter((w) => { const p = ps.find((x) => x.from.split(" ").includes(w)); return !p || p.how === "unknown" || (!p.verb && /^(word|lemma|align|lexicon)$/.test(p.how)); });
    if (lost.length) { f.push("verb-lost"); r.verbLost = lost; }
    // связка добавлена, хотя в русском предложении есть глагол («Он пришёл домой → Из венав цӀа ва»)
    if (ruVerbs.length && ps.some((p) => p.how === "cop") && !ps.some((p) => /^(analog|phrase|template)$/.test(p.how))) f.push("cop+verb");
  }
  if (r.pb) {
    const outK = norm(out);
    const match = r.pb.refs.some((x) => norm(x.text) === outK);
    if (r.pb.exact && !match) f.push("pb-mismatch");
    if (!r.pb.exact && !match) f.push("pb-near");
  }
  return f;
}

// ---------------- запуск через сервер ----------------
(async () => {
  const args = process.argv.slice(2);
  const onlyBad = args.includes("--bad");
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  global.fetch = async () => { throw new Error("no network"); };
  const T = require(path.join(ROOT, "api/translate.js"));
  T._setStore({ get: async () => null, setJSON: async () => {} });
  require(path.join(ROOT, "lib/corpus.js"))._set({ store: { get: async () => null, setJSON: async () => {} }, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  const call = (body) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
    Promise.resolve(T({ method: "POST", body }, res)).catch((e) => resolve({ code: 500, data: { error: String(e && e.message) } }));
  });

  const ruList = [...new Set(RU.split("\n").map((s) => s.trim()).filter(Boolean))];
  const inhList = [...new Set(INH)];
  const jobs = [...ruList.map((t) => ({ input: t, src: "ru", tgt: "inh" })), ...inhList.map((t) => ({ input: t, src: "inh", tgt: "ru" }))];
  const results = [];
  for (const j of jobs) {
    const words = (j.input.match(WORD) || []).length;
    const { code, data } = await call({ text: j.input, source: j.src, target: j.tgt, mode: words <= 1 ? "word" : "text" });
    const r = { ...j, code, out: data.translation || "", label: data.model || (data.noAi ? "нет ответа (ИИ выключен)" : data.error || ""), chunks: !!data.chunks };
    if (r.chunks) { const s = chunks().C.translate(j.input, j.src); r.pieces = s ? s.pieces.map((p) => ({ from: p.from, to: p.to, how: p.how, verb: !!p.verb })) : null; }
    const pb = phrasebook(j.input, j.src);
    if (pb) r.pb = pb;
    r.flags = flagsFor(r);
    results.push(r);
  }

  const count = (rs, f) => rs.filter((r) => r.flags.includes(f)).length;
  const FLAGS = ["empty", "bracket", "russian", "ingush-left", "same", "explain", "dup", "verb-order", "verb-lost", "cop+verb", "pb-mismatch", "pb-near"];
  for (const r of results) {
    if (onlyBad && !r.flags.length) continue;
    const extra = [r.russian ? `russian: ${r.russian.join(", ")}` : "", r.ingushLeft ? `inh: ${r.ingushLeft.join(", ")}` : "", r.verbLost ? `глагол потерян: ${r.verbLost.join(", ")}` : "",
      r.pb && (r.flags.includes("pb-mismatch") || r.flags.includes("pb-near")) ? `разговорник${r.pb.exact ? "" : " (почти: «" + r.pb.key + "»)"}: ${[...new Set(r.pb.refs.map((x) => x.text))].slice(0, 3).join(" | ")}` : "",
      r.pieces && r.flags.length ? "куски: " + r.pieces.map((p) => `${p.from}→${p.to || "∅"}(${p.how}${p.verb ? ",гл" : ""})`).join(" ") : ""].filter(Boolean);
    console.log(`${r.src}→${r.tgt}  ${r.input} → ${r.out || "∅"}  [${r.label}]${r.flags.length ? "  !! " + r.flags.join(" ") : ""}`);
    for (const e of extra) console.log("        " + e);
  }
  console.log("\n=== Итого ===");
  for (const [name, rs] of [["ru→inh", results.filter((r) => r.src === "ru")], ["inh→ru", results.filter((r) => r.src === "inh")]]) {
    const bad = rs.filter((r) => r.flags.some((f) => f !== "pb-near")).length;
    const labels = {};
    for (const r of rs) { const k = r.chunks ? "по словам (chunks)" : r.label.replace(/:.*$/, "") || "—"; labels[k] = (labels[k] || 0) + 1; }
    console.log(`${name}: ${rs.length} предложений, с флагами (кроме pb-near): ${bad}`);
    console.log("  флаги: " + FLAGS.map((f) => `${f} ${count(rs, f)}`).join(", "));
    console.log("  откуда ответ: " + Object.entries(labels).map(([k, v]) => `${k} ${v}`).join(", "));
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
