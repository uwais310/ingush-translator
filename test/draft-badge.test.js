// Перевод по словам помечен жёлтым «Черновик» — и сразу, и когда открыт из истории (раньше: зелёная метка
// как у проверенного, а из истории — вообще без метки). Функции страницы запускаются с подделкой DOM.
//   node test/draft-badge.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const fn = (name) => { const i = html.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let d = 0, j = html.indexOf("{", i); for (; j < html.length; j++) { if (html[j] === "{") d++; else if (html[j] === "}" && --d === 0) break; } return html.slice(i, j + 1); };
const ICON = /const ICON = \{[\s\S]*?\n\};/.exec(html)[0];

const el = () => ({ children: [], classList: { list: [], add(c) { this.list.push(c); } }, textContent: "", className: "", hidden: false, innerHTML: "",
  appendChild(c) { this.children.push(c); }, append(...c) { this.children.push(...c); }, insertAdjacentHTML() {}, addEventListener(t, f) { this.click = f; } });
const store = {};
const ctx = {
  els: { meta: el(), src: {}, tgt: {}, input: {} }, $: (id) => (ctx[id] || (ctx[id] = el())), document: { createElement: el },
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } }, JSON, LANGS: { ru: { label: "ru" }, inh: { label: "inh" } },
  window: { scrollTo() {} }, showText() {}, hideExtras() {}, closePanels() {}, setButtons() {}, setStatus() {}, refresh() {},
};
vm.createContext(ctx);
vm.runInContext([ICON, fn("setMeta"), fn("loadHistory"), fn("addHistory"), fn("renderHistory")].join("\n"), ctx);

// 1. как страница выбирает метку для ответа сервера
const line = /const metaKind = ([^;]+);/.exec(html)[1];
const kindOf = (data) => vm.runInNewContext(line, { data, trusted: data.verified || data.base });
assert.strictEqual(kindOf({ chunks: true, rules: true, model: "Без ИИ: по словам из словаря" }), "draft");
assert.strictEqual(kindOf({ rules: true }), "rules");
assert.strictEqual(kindOf({ verified: true, chunks: true }), "native");
// 2. «Черновик» жёлтым
ctx.setMeta("Без ИИ: по словам из словаря", "draft");
assert.ok(ctx.els.meta.classList.list.includes("draft"));
assert.ok(/Черновик/.test(ctx.els.meta.children[0].textContent));
assert.ok(/\.trust\.draft \{[^}]*amber/.test(html), "жёлтый стиль");
// 3. из истории — с той же меткой
ctx.addHistory("ru", "inh", "Где карта?", "Мичахьа карта?", { text: "Без ИИ: по словам из словаря", kind: "draft" });
ctx.els.meta = el();
ctx.history.children[0].click();
assert.ok(ctx.els.meta.classList.list.includes("draft"), "из истории — «Черновик»");
// 4. старая запись истории без метки — тоже «Черновик», а не пусто
store["inh-tr-history"] = JSON.stringify([{ src: "ru", tgt: "inh", input: "а", output: "б" }]);
ctx.history = el(); ctx.renderHistory(); ctx.els.meta = el();
ctx.history.children[0].click();
assert.ok(ctx.els.meta.classList.list.includes("draft"), "старая запись — «Черновик»");
console.log("ok: перевод по словам — «Черновик», и из истории тоже");
