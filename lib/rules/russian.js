// Русская грамматика для перевода с ингушского по правилам: род слова, падеж (кого? чего?),
// согласование «мой / моя / моё», «хороший / хорошая», формы глаголов по лицу.
// Здесь только правила русского языка, ничего ингушского. Где правило неоднозначно (род слова на -ь,
// падеж одушевлённого множественного), функция возвращает null — и правило перевода молчит.

const L = require("./lexicon.js");

// Слова на -ь: род не виден по окончанию
const FEM_SOFT = new Set(["мать", "дочь", "тетрадь", "ночь", "дверь", "соль", "жизнь", "любовь", "осень", "площадь", "кровать", "печь", "мышь", "лошадь", "церковь", "речь", "вещь", "помощь", "болезнь", "новость", "радость", "грязь", "боль", "кровь", "морковь", "степь", "сеть", "часть", "власть", "область", "постель", "медь", "ткань", "цепь", "дробь", "даль", "мебель", "пыль"]);
const MASC_SOFT = new Set(["день", "конь", "гость", "учитель", "путь", "рубль", "словарь", "календарь", "камень", "огонь", "дождь", "зверь", "пень", "ремень", "гвоздь", "уголь", "корень", "царь", "князь", "житель", "писатель", "водитель", "родитель", "председатель", "секретарь", "январь", "февраль", "апрель", "июнь", "июль", "сентябрь", "октябрь", "ноябрь", "декабрь", "хлеб"]);
const PLURAL_ONLY = new Set(["деньги", "дети", "люди", "братья", "сестры", "родители", "ножницы", "очки", "брюки", "ворота", "часы", "сутки", "сыновья", "друзья", "дочери"]);
// Мужской род, хотя кончается на -а/-я
const MASC_A = new Set(["папа", "дедушка", "дядя", "мужчина", "юноша", "слуга", "судья"]);

// Род: "m" | "f" | "n" | "pl" | null (неизвестно)
function gender(word, cls) {
  const w = String(word).toLowerCase();
  if (PLURAL_ONLY.has(w)) return "pl";
  const person = L.PERSON_CLASS[w];
  if (person) return person === "й" ? "f" : "m";
  if (MASC_A.has(w)) return "m";
  if (/мя$/.test(w)) return "n";
  if (/[ая]$/.test(w)) return "f";
  if (/[оеё]$/.test(w)) return "n";
  if (/ь$/.test(w)) return FEM_SOFT.has(w) ? "f" : MASC_SOFT.has(w) ? "m" : null;
  if (/[бвгджзйклмнпрстфхцчшщ]$/.test(w)) return "m";
  return null;
}
const animate = (w) => !!(L.PERSON_CLASS[w] || L.PEOPLE.has(w) || PLURAL_ONLY.has(w) && /^(дети|люди|братья|сестры|родители|сыновья|друзья|дочери)$/.test(w));
const AFTER_HUSH = /[гкхжшщч]$/; // после этих букв — и, а не ы

// Винительный падеж (кого? что?) — для дополнения: «люблю маму», «пью воду», «знаю брата»
function acc(word) {
  const w = String(word).toLowerCase();
  const g = gender(w);
  if (!g) return null;
  if (g === "pl") return animate(w) ? ({ "дети": "детей", "люди": "людей", "братья": "братьев", "сестры": "сестер", "родители": "родителей", "сыновья": "сыновей", "друзья": "друзей", "дочери": "дочерей" }[w] || null) : w;
  if (/а$/.test(w)) return w.slice(0, -1) + "у"; // мама → маму, папа → папу
  if (/я$/.test(w) && g !== "n") return w.slice(0, -1) + "ю"; // дядя → дядю
  if (g === "m" && animate(w)) {
    if (/й$/.test(w)) return w.slice(0, -1) + "я";
    if (/ь$/.test(w)) return w.slice(0, -1) + "я"; // учитель → учителя
    if (w === "отец") return "отца";
    return w + "а"; // брат → брата, друг → друга
  }
  return w; // дом, слово, мать, книгу (выше) …
}
// Родительный падеж (чего?) — после «нет»: «нет денег», «нет машины», «нет времени»
function gen(word) {
  const w = String(word).toLowerCase();
  const g = gender(w);
  if (!g) return null;
  const IRR = { "деньги": "денег", "дети": "детей", "люди": "людей", "время": "времени", "имя": "имени", "мать": "матери", "дочь": "дочери", "отец": "отца", "день": "дня" };
  if (IRR[w]) return IRR[w];
  if (g === "pl") return null;
  if (/а$/.test(w)) return w.slice(0, -1) + (AFTER_HUSH.test(w.slice(0, -1)) ? "и" : "ы");
  if (/я$/.test(w)) return w.slice(0, -1) + "и";
  if (/ь$/.test(w)) return w.slice(0, -1) + (g === "f" ? "и" : "я");
  if (/о$/.test(w)) return w.slice(0, -1) + "а";
  if (/е$/.test(w)) return w.slice(0, -1) + "я";
  if (/й$/.test(w)) return w.slice(0, -1) + "я";
  if (g === "m") return w + "а";
  return null;
}

// Прилагательное в нужном роде: хороший → хорошая / хорошее / хорошие. kase: "nom" | "acc"
function adj(lemma, g, kase = "nom", anim = false) {
  const w = String(lemma).toLowerCase();
  const m = /^(.*)(ый|ий|ой)$/.exec(w);
  if (!m || !g) return null;
  const [, stem, end] = m;
  const hush = AFTER_HUSH.test(stem), sibil = /[жшщч]$/.test(stem);
  const soft = end === "ий" && !hush; // синий
  const forms = {
    m: w,
    f: soft ? stem + "яя" : stem + "ая",
    n: soft ? stem + "ее" : end === "ой" ? stem + "ое" : sibil ? stem + "ее" : stem + "ое",
    pl: soft || hush ? stem + "ие" : stem + "ые",
  };
  if (kase === "acc") {
    if (g === "f") return soft ? stem + "юю" : stem + "ую";
    if ((g === "m" || g === "pl") && anim) return g === "m" ? stem + (end !== "ой" && (soft || sibil) ? "его" : "ого") : stem + (soft || hush ? "их" : "ых");
  }
  return forms[g] || null;
}
// мой / твой / свой / наш / ваш в нужном роде и падеже
const POSS = {
  "мой": { f: "моя", n: "мое", pl: "мои", accF: "мою", accM: "моего", accPl: "моих" },
  "твой": { f: "твоя", n: "твое", pl: "твои", accF: "твою", accM: "твоего", accPl: "твоих" },
  "свой": { f: "своя", n: "свое", pl: "свои", accF: "свою", accM: "своего", accPl: "своих" },
  "наш": { f: "наша", n: "наше", pl: "наши", accF: "нашу", accM: "нашего", accPl: "наших" },
  "ваш": { f: "ваша", n: "ваше", pl: "ваши", accF: "вашу", accM: "вашего", accPl: "ваших" },
  "этот": { f: "эта", n: "это", pl: "эти", accF: "эту", accM: "этого", accPl: "этих" },
};
function poss(lemma, g, kase = "nom", anim = false) {
  const P = POSS[lemma];
  if (!P) return lemma; // его, ее, их — не меняются
  if (kase === "acc") {
    if (g === "f") return P.accF;
    if (g === "m" && anim) return P.accM;
    if (g === "pl" && anim) return P.accPl;
  }
  return g === "m" ? lemma : P[g] || null;
}

// Глагол: формы из библиотеки слов (ru.pres — я, ты, он, мы, вы, они; ru.past — он, она, оно, они)
const PERSON_INDEX = { "я": 0, "ты": 1, "он": 2, "она": 2, "мы": 3, "вы": 4, "они": 5 };
function verbPres(v, subj) {
  const i = PERSON_INDEX[subj];
  return v.ru.pres && i != null ? v.ru.pres[i] || null : null;
}
function verbPast(v, g) {
  const i = { m: 0, f: 1, n: 2, pl: 3 }[g];
  return v.ru.past && i != null ? v.ru.past[i] || null : null;
}
const COP_PAST = { m: "был", f: "была", n: "было", pl: "были" };
// Род подлежащего-местоимения по ингушскому классу: «Со кийча я» — говорит женщина
function pronGender(p, cls) {
  if (p === "мы" || p === "вы" || p === "они") return "pl";
  if (p === "он") return "m";
  if (p === "она") return "f";
  return cls === "й" ? "f" : "m";
}
const PRON_ACC = { "я": "меня", "ты": "тебя", "он": "его", "она": "ее", "мы": "нас", "вы": "вас", "они": "их" };
const PRON_DAT = { "я": "мне", "ты": "тебе", "он": "ему", "она": "ей", "мы": "нам", "вы": "вам", "они": "им" };
const PRON_GEN_U = { "я": "у меня", "ты": "у тебя", "он": "у него", "она": "у нее", "мы": "у нас", "вы": "у вас", "они": "у них" };

module.exports = { gender, animate, acc, gen, adj, poss, verbPres, verbPast, COP_PAST, pronGender, PRON_ACC, PRON_DAT, PRON_GEN_U };
