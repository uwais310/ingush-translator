// Пометки внутри текста фразы: «Со балха вода. (говорит мужчина)», «Мичахьа я хьо? (к женщине)», «(й, б, д)».
// Их место — в поле note: иначе их копируют вместе с переводом, и по ним не находится та же фраза без пометки.
// Используют scripts/build-phrases.js (при сборке базы) и scripts/clean-notes.js (чистка готовой базы).
const NOTE_INH = /\s*\(((?:говорит|к |о |объект|домой|мн\.|ед\.)[^()]*|[вйдби](?:\s*[,/]\s*[вйдби])*)\)\s*/gi;
const NOTE_RU = /\s*\(((?:говорит (?:мужчина|женщина)|к мужчине|к женщине|о мужчине|о женщине|мужчине|женщине|мужчина|женщина|к нескольким|вежливо)[^()]*)\)\s*/gi;
function splitNotes(text, re) {
  const notes = [];
  const t = String(text).replace(re, (m, n) => {
    n = n.trim();
    notes.push(/^[вйдби](\s*[,/]\s*[вйдби])*$/i.test(n) ? `класс ${n}` : n);
    return " ";
  }).replace(/\s+([.!?,…])/g, "$1").replace(/\s+/g, " ").trim();
  return { text: t || String(text).trim(), notes };
}
// { ru, inh, note } без пометок в тексте; пометки — в начале note
function cleanPair(ru, inh, note) {
  const r = splitNotes(ru, NOTE_RU), i = splitNotes(inh, NOTE_INH);
  const notes = [...new Set([...i.notes, ...r.notes])];
  if (!notes.length) return { ru, inh, note };
  // прежняя пометка (у PaydaDosh — раздел разговорника) остаётся первой: по ней /review показывает источник
  return { ru: r.text, inh: i.text, note: [note, notes.join("; ")].filter(Boolean).join(" · ") };
}
module.exports = { splitNotes, cleanPair, NOTE_INH, NOTE_RU };
