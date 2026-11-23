// Русский текст, который ввели при направлении «ингушский → русский» (жалоба 23.11: «Доброе утро! Как у тебя
// дела?» переводилось как ингушское — «Доброе Утро! Как чума [тебя] смеяться?»).
// looksRussian(text) → true, если почти все слова есть только в русском словаре и ни одного — только в ингушском.
// Списки слов — те же, что у проверки ответа ИИ (lib/postcheck.js): ингушские словоформы корпуса и русские слова базы.
const INH_MARKS = /[ӏӀ1]|аь|оа|уо|яь|хь|кх|къ|гӏ|кӏ|пӏ|тӏ|цӏ|чӏ|хӏ/i;

module.exports = function ({ POST }) {
  return function looksRussian(text) {
    const raw = String(text || "").replace(/[\u0300\u0301]/g, "");
    const words = (raw.toLowerCase().replace(/ё/g, "е").match(/[а-яӏ]+/g) || []).filter((w) => w.length >= 2);
    if (!words.length || words.length > 60) return false;
    let ru = 0, inh = 0, both = 0;
    for (const w of words) {
      if (INH_MARKS.test(w)) { inh++; continue; }
      const isI = POST.isInh(w), isR = POST.isRu(w);
      if (isI && !isR) inh++;
      else if (isR && !isI) ru++;
      else if (isR && isI) both++;
    }
    if (inh) return false;
    // одно слово — только если оно точно русское; иначе большинство слов русские и не меньше двух,
    // или все слова русские («Я иду домой»: «я» и «домой» бывают и в ингушских текстах, «иду» — только русское)
    if (words.length === 1) return ru === 1 && words[0].length >= 4;
    return (ru >= 2 && ru / words.length >= 0.5) || (ru >= 1 && ru + both === words.length);
  };
};
