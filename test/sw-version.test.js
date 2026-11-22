// sw.js: версия кэша поднята после изменений страниц (index.html, review.html) — иначе телефоны покажут старую.
//   node test/sw-version.test.js
const assert = require("assert");
const src = require("fs").readFileSync(require("path").join(__dirname, "../sw.js"), "utf8");
const m = /const CACHE = "ingush-v(\d+)";/.exec(src);
assert.ok(m, "версия кэша на месте");
assert.ok(Number(m[1]) >= 24, "версия не ниже v24: " + m[1]);
console.log("ok: sw.js кэш ingush-v" + m[1]);
