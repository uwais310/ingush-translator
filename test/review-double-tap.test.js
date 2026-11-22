// /review: двойной тап по «Верно» не одобряет следующую пару, которую человек ещё не видел.
// Скрипт страницы запускается с маленькой подделкой DOM; сервер отвечает парами 1, 2, 3.
//   node test/review-double-tap.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "../review.html"), "utf8");
const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

const els = {};
const el = () => ({ hidden: false, disabled: false, textContent: "", innerHTML: "", value: "", className: "", style: {}, handlers: {},
  addEventListener(t, f) { this.handlers[t] = f; }, append() {}, appendChild() {}, focus() {}, setRangeText() {} });
const document = { getElementById: (id) => els[id] || (els[id] = el()), createElement: () => el() };
const saved = [];
let n = 0;
const fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  if (b.action === "review-save") saved.push(b.id);
  if (b.action === "review-next") n++;
  return { ok: true, json: async () => ({ total: 10, reviewed: saved.length, item: { id: "pair" + n, ru: "ru" + n, inh: "inh" + n }, index: n }) };
};
const ctx = { document, fetch, sessionStorage: { getItem: () => "", setItem() {}, removeItem() {} }, console, setTimeout, Date, Number, JSON, Math, RegExp, String, Error };
vm.createContext(ctx);
vm.runInContext(js, ctx);
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  await vm.runInContext('next(-1)', ctx);
  await new Promise((r) => setTimeout(r, 800)); // человек посмотрел на пару 1
  const tap = els.ok.handlers.click;
  tap(); await tick(); await tick(); await tick(); // первый тап: сохранил pair1, показана pair2
  tap(); await tick(); await tick(); await tick(); // второй тап сразу же — pair2 человек не видел
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(saved, ["pair1"], "одобрена только первая пара: " + saved);
  await new Promise((r) => setTimeout(r, 800)); // посмотрел на pair2 — теперь можно
  tap(); await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(saved, ["pair1", "pair2"]);
  console.log("ok: двойной тап по «Верно» не одобряет следующую пару");
})().catch((e) => { console.error(e); process.exit(1); });
