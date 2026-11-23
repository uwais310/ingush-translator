// Перевод не уезжает за край на iPhone SE (320 px) и когда телефон лежит боком (вырез экрана сбоку).
// Проверено в браузере на 320×568 и 568×320; здесь — что нужные правила CSS на месте.
//   node test/small-screens.test.js
const assert = require("assert");
const html = require("fs").readFileSync(require("path").join(__dirname, "../index.html"), "utf8");
assert.ok(/viewport-fit=cover/.test(html), "страница рисуется под вырезом — значит, нужны отступы safe-area");
for (const sel of ["main", ".band-in"]) {
  const re = new RegExp(`\\n\\s*${sel.replace(".", "\\.")} \\{[^}]*padding-left: max\\(16px, env\\(safe-area-inset-left\\)\\)[^}]*padding-right: max\\(16px, env\\(safe-area-inset-right\\)\\)`);
  assert.ok(re.test(html), `${sel}: отступ не меньше выреза слева и справа`);
}
assert.ok(/main > \* \{ min-width: 0; \}/.test(html), "длинное слово не раздвигает сетку");
assert.ok(/\.tools \{[^}]*flex-wrap: wrap/.test(html), "кнопки под полем переносятся на 320 px");
assert.ok(/\.output \{[^}]*overflow-wrap: anywhere/.test(html), "длинное слово перевода переносится");
console.log("ok: отступы под вырез, перенос кнопок и слов");
