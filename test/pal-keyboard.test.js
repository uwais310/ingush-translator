// Кнопка Ӏ не закрывает клавиатуру на телефоне: нажатие на неё не забирает фокус у поля ввода
// (pointerdown/mousedown — preventDefault; touchstart не трогаем, иначе на iPhone не будет click).
//   node test/pal-keyboard.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
for (const [file, ids] of [["index.html", ["els.key", '$("fix-key")']], ["review.html", ['"pal"', '"a-pal"']]]) {
  const html = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  for (const id of ids) assert.ok(html.includes(id), `${file}: ${id}`);
  assert.ok(/\["pointerdown", "mousedown"\]/.test(html), `${file}: фокус не уходит с поля`);
  assert.ok(!/touchstart[^\n]*preventDefault/.test(html), `${file}: touchstart не блокируем — иначе пропадёт click на iPhone`);
}
// поведение: обработчик keepFocus отменяет pointerdown и mousedown, а click по-прежнему вставляет букву
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const src = /function keepFocus\(b\) \{[^\n]*\}/.exec(html)[0];
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const h = {}; ctx.keepFocus({ addEventListener: (ev, f) => { h[ev] = f; } });
for (const ev of ["pointerdown", "mousedown"]) { let prevented = false; h[ev]({ preventDefault: () => { prevented = true; } }); assert.ok(prevented, ev); }
assert.ok(!h.touchstart && !h.click);
console.log("ok: кнопка Ӏ не забирает фокус у поля");
