// Админка v3: восстановление из копии, «Сейчас на сайте», сервер, качество по дням, противоречия в словаре.
//   node test/admin-v3.test.js
const assert = require("assert");

process.env.NO_WARMUP = "1";
delete process.env.USE_AI;
delete process.env.ADMIN_LOG;
const handler = require("../api/translate.js");
const INS = require("../lib/admin-insights.js");
const { MAX } = require("../lib/activity-log.js");

const mem = {};
const store = { async get(k) { return mem[k] === undefined ? null : JSON.parse(JSON.stringify(mem[k])); }, async setJSON(k, v) { mem[k] = JSON.parse(JSON.stringify(v)); } };
handler._setStore(store);

function call(body) {
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(obj) { resolve({ status: this.code, body: obj }); } };
    Promise.resolve(handler({ method: "POST", body }, res)).catch(reject);
  });
}
process.env.ADMIN_CODE = "код-v3";
const A = (b) => call({ action: "admin", code: "код-v3", ...b });

// ингушский текст только из базы проекта (data/phrases.json), не придуманный
const SEED = require("../data/phrases.json");
const pairs = SEED.filter((p) => p.kind === "phrase" && /^PaydaDosh/.test(p.source || "") && p.ru && p.inh && p.ru.length < 40).slice(0, 4);
assert.ok(pairs.length === 4, "в базе есть пары для теста");

(async () => {
  // ---- 1. data: поле server, quality, conflicts ----
  await call({ text: "мама", source: "ru", target: "inh", mode: "word", noAi: true });
  let r = await A({});
  assert.strictEqual(r.status, 200);
  const sv = r.body.server;
  assert.ok(sv, "в данных есть server");
  for (const k of ["uptimeSec", "memMB", "node", "version", "startedAt", "logPending"]) assert.ok(k in sv, "server." + k);
  assert.ok(Number.isInteger(sv.uptimeSec) && sv.uptimeSec >= 0);
  assert.ok(sv.memMB > 0);
  assert.strictEqual(sv.node, process.version);
  assert.ok(typeof sv.version === "string" && sv.version.length > 0);
  assert.ok(!isNaN(Date.parse(sv.startedAt)));
  assert.ok(Array.isArray(r.body.quality) && r.body.quality.length === 14, "качество за 14 дней");
  assert.ok(r.body.quality[13].total >= 1, "сегодняшний перевод посчитан");
  assert.ok(Array.isArray(r.body.conflicts));

  process.env.COMMIT_REF = "abcdef1234567890";
  // версия кэшируется при первом чтении: проверяем только формат
  assert.ok(/^([0-9a-f]{7}|—)$/.test(sv.version), "версия — короткий коммит или «—»: " + sv.version);
  delete process.env.COMMIT_REF;

  // ---- 2. live ----
  r = await A({ op: "live" });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.log) && r.body.log.length >= 1 && r.body.log.length <= 20);
  assert.strictEqual(r.body.log[0].text, "мама", "новые сверху");
  assert.ok(r.body.hour >= 1, "за последний час");
  assert.ok(!("dict" in r.body) && !("popular" in r.body), "live — без словаря и подсчётов");
  r = await call({ action: "admin", code: "не тот", op: "live" });
  assert.strictEqual(r.status, 403, "live без кода — 403");

  // ---- 3. restore ----
  const now = new Date().toISOString();
  // каждая пара — со своим переводом из базы; «другой перевод» — по-русски (ингушский не придумываем)
  const existing = { source: "inh", target: "ru", text: pairs[0].inh, translation: pairs[0].ru };
  const dayAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const D26 = dayAgo(26);
  r = await A({ op: "fix", ...existing });
  assert.strictEqual(r.status, 200);
  const reviewId = SEED.find((p) => p.id).id;
  const backup = {
    kind: "ingush-translator-backup", version: 1, at: now,
    corrections: [
      { source: "inh", target: "ru", text: pairs[0].inh, translation: "совсем другой перевод", at: "2026-01-01T00:00:00Z" }, // уже есть: не перепишется
      { source: "ru", target: "inh", text: pairs[2].ru, translation: pairs[2].inh, at: "2026-01-02T00:00:00Z" },
      { source: "xx", target: "inh", text: "плохая", translation: "запись" }, // неверный язык — пропуск
    ],
    reports: [{ at: "2026-01-03T00:00:00Z", text: "Старая жалоба", translation: "", source: "ru", target: "inh" }],
    review: { [reviewId]: { s: "ok", at: "2026-01-04T00:00:00Z" }, bad: { s: "maybe" } },
    distilled: [],
    log: [
      { at: "2026-01-05T10:00:00Z", text: "старый перевод", translation: "", source: "ru", target: "inh", how: "none", label: "" },
      { at: "2026-01-05T11:00:00Z", text: "ещё один", translation: "", source: "ru", target: "inh", how: "none", label: "" },
    ],
    logStats: { days: { [D26]: { total: 5, ruInh: 3, inhRu: 2, empty: 1 } } },
  };
  const before = JSON.stringify(mem);
  r = await A({ op: "restore", dry: true, backup });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.dry, true);
  assert.deepStrictEqual(r.body.added, { corrections: 1, reports: 1, review: 1, log: 2, logStats: 1 }, "dry: что добавится");
  assert.deepStrictEqual(r.body.skipped, { corrections: 0, reports: 0, review: 1, log: 0, logStats: 0 }, "dry: неверное решение — пропуск");
  assert.strictEqual(JSON.stringify(mem), before, "dry ничего не пишет");

  r = await A({ op: "restore", backup });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.added, { corrections: 1, reports: 1, review: 1, log: 2, logStats: 1 });
  const kept = mem.all.find((p) => p.source === "inh" && p.text === pairs[0].inh);
  assert.strictEqual(kept.translation, pairs[0].ru, "существующая запись не перезаписана");
  assert.ok(mem.all.some((p) => p.text === pairs[2].ru), "недостающая запись добавлена");
  assert.ok(!mem.all.some((p) => p.source === "xx"), "неверная запись пропущена");
  for (const p of mem.all) assert.deepStrictEqual(Object.keys(p).sort(), ["at", "source", "target", "text", "translation"], "формат словаря прежний");
  assert.ok(mem.reports.some((x) => x.text === "Старая жалоба"));
  assert.deepStrictEqual(mem.review[reviewId].s, "ok");
  assert.ok(!("bad" in mem.review), "неверное решение пропущено");
  assert.ok(mem.log.some((e) => e.text === "старый перевод"));
  assert.ok(mem.log.findIndex((e) => e.text === "старый перевод") < mem.log.findIndex((e) => e.text === "мама"), "журнал отсортирован по времени");
  assert.strictEqual(mem["log-stats"].days[D26].total, 5);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(mem["log-stats"].days[today].total >= 1, "сегодняшние счётчики не тронуты");

  r = await A({ op: "restore", backup });
  assert.deepStrictEqual(r.body.added, { corrections: 0, reports: 0, review: 0, log: 0, logStats: 0 }, "второй раз добавляется 0");

  // по частям — то же самое (страница шлёт большую копию кусками)
  r = await A({ op: "restore", backup: { kind: "ingush-translator-backup", version: 1, log: backup.log.slice(0, 1) } });
  assert.strictEqual(r.body.added.log, 0);
  r = await A({ op: "restore", backup: { ...backup, version: 2 } });
  assert.strictEqual(r.status, 400, "неизвестная версия копии отклоняется");

  r = await A({ op: "restore", backup: { ...backup, kind: "something-else" } });
  assert.strictEqual(r.status, 400, "чужой файл отклоняется");
  r = await A({ op: "restore", backup: "строка" });
  assert.strictEqual(r.status, 400);
  r = await A({ op: "restore" });
  assert.strictEqual(r.status, 400, "без копии — 400");
  const snap = JSON.stringify(mem);
  r = await call({ action: "admin", code: "не тот", op: "restore", backup });
  assert.strictEqual(r.status, 403, "без кода не восстановить");
  assert.strictEqual(JSON.stringify(mem), snap);

  const R = (b, extra) => A({ op: "restore", backup: { kind: "ingush-translator-backup", version: 1, ...b }, ...extra });

  // журнал: только в свободное место, существующие записи не вытесняются
  const logNow = mem.log.length;
  const big = [];
  for (let i = 0; i < MAX + 50; i++) big.push({ at: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 1000).toISOString(), text: "старое " + i, translation: "", source: "ru", target: "inh", how: "none" });
  r = await R({ log: big }, { dry: true });
  assert.strictEqual(r.body.added.log, MAX - logNow, "dry: поместится только свободное место");
  assert.strictEqual(r.body.skipped.log, big.length - (MAX - logNow));
  const oldLog = JSON.stringify(mem.log);
  r = await R({ log: big });
  assert.strictEqual(mem.log.length, MAX, "журнал не больше " + MAX);
  for (const e of JSON.parse(oldLog)) assert.ok(mem.log.some((x) => x.at === e.at && x.text === e.text), "прежняя запись осталась: " + e.text);
  assert.ok(mem.log.some((e) => e.text === "старое " + (MAX + 49)) && !mem.log.some((e) => e.text === "старое 0"), "при нехватке места берутся самые свежие из копии");
  r = await R({ log: [{ at: "2024-01-01T00:00:00Z", text: "ещё старее", translation: "", source: "ru", target: "inh" }] });
  assert.deepStrictEqual([r.body.added.log, r.body.skipped.log], [0, 1], "журнал полон — пропуск, а не вытеснение");

  // счётчики: только дни в окне STAT_DAYS
  r = await R({ logStats: { days: { [dayAgo(400)]: { total: 1 }, [dayAgo(30)]: { total: 2 } } } });
  assert.deepStrictEqual([r.body.added.logStats, r.body.skipped.logStats], [1, 1], "день старше окна пропущен");
  assert.ok(!(dayAgo(400) in mem["log-stats"].days));

  // жалобы: не больше 2000 (иначе следующая жалоба молча вытеснит старые)
  mem.reports = Array.from({ length: 1995 }, (_, i) => ({ at: new Date(Date.parse("2025-06-01T00:00:00Z") + i * 1000).toISOString(), text: "жалоба " + i, translation: "", source: "ru", target: "inh" }));
  const newReps = Array.from({ length: 10 }, (_, i) => ({ at: new Date(Date.parse("2025-07-01T00:00:00Z") + i * 1000).toISOString(), text: "из копии " + i, translation: "", source: "ru", target: "inh" }));
  r = await R({ reports: newReps.slice(0, 4) }, { dry: true });
  assert.strictEqual(r.body.added.reports, 4);
  r = await R({ reports: newReps.slice(4) }, { dry: true, used: { reports: 4 } });
  assert.deepStrictEqual([r.body.added.reports, r.body.skipped.reports], [1, 5], "предпросмотр по частям учитывает место, занятое прежними частями");
  r = await R({ reports: newReps });
  assert.deepStrictEqual([r.body.added.reports, r.body.skipped.reports], [5, 5]);
  assert.strictEqual(mem.reports.length, 2000, "жалоб ровно 2000");
  assert.ok(mem.reports.some((x) => x.text === "жалоба 0"), "старые жалобы не вытеснены");
  await call({ action: "report", text: "новая", translation: "", source: "ru", target: "inh" });
  assert.ok(mem.reports.length <= 2000);

  // словарь: не больше 3000, старое не вытесняется (тестовые записи англ → рус, без ингушского)
  const before3000 = mem.all.length;
  mem.all = mem.all.concat(Array.from({ length: 2998 - before3000 }, (_, i) => ({ source: "en", target: "ru", text: "word " + i, translation: "слово " + i, at: "2025-01-01T00:00:00Z" })));
  handler._setStore(store); // сбросить кэш словаря
  r = await R({ corrections: [1, 2, 3, 4].map((i) => ({ source: "en", target: "ru", text: "new word " + i, translation: "новое слово " + i })) });
  assert.deepStrictEqual([r.body.added.corrections, r.body.skipped.corrections], [2, 2]);
  assert.strictEqual(mem.all.length, 3000);
  assert.ok(mem.all.some((p) => p.text === "word 0"), "старые записи словаря не вытеснены");

  // __proto__ и прочие опасные ключи в решениях /review
  const evil = JSON.parse('{"__proto__": {"s": "ok", "polluted": true}, "constructor": {"s": "ok"}}');
  r = await R({ review: evil });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.added.review, 0);
  assert.strictEqual(({}).polluted, undefined, "прототип не испорчен");
  assert.ok(!Object.prototype.hasOwnProperty.call(mem.review, "__proto__") && !Object.prototype.hasOwnProperty.call(mem.review, "constructor"));

  // ---- 4. INSIGHTS.quality ----
  const NOW = Date.parse("2026-11-27T12:00:00Z");
  const q = INS.quality([
    { at: "2026-11-27T01:00:00Z", translation: "x", how: "base" },
    { at: "2026-11-27T02:00:00Z", translation: "[слово] x", how: "chunks" },
    { at: "2026-11-27T03:00:00Z", translation: "", how: "none" },
    { at: "2026-11-27T04:00:00Z", translation: "x", how: "none" },
    { at: "2026-11-26T04:00:00Z", translation: "x", how: "rules" },
    { at: "2026-10-01T04:00:00Z", translation: "x", how: "rules" }, // вне окна
  ], 14, NOW);
  assert.strictEqual(q.length, 14);
  assert.deepStrictEqual(q[13], { day: "2026-11-27", total: 4, full: 1 });
  assert.deepStrictEqual(q[12], { day: "2026-11-26", total: 1, full: 1 });
  assert.deepStrictEqual(q[0], { day: "2026-11-14", total: 0, full: 0 }, "пустые дни есть");
  assert.strictEqual(INS.quality([], 7, NOW).length, 7);

  // ---- 5. INSIGHTS.conflicts ----
  const c = INS.conflicts([
    { id: "1", source: "en", target: "ru", text: "Hello!", translation: "привет" },
    { id: "2", source: "en", target: "ru", text: "hello", translation: "здравствуйте" },
    { id: "3", source: "ru", target: "en", text: "hello", translation: "другое" }, // другая сторона
    { id: "4", source: "en", target: "ru", text: "Bye", translation: "пока" },
    { id: "5", source: "en", target: "ru", text: "bye.", translation: "Пока!" }, // тот же перевод — не противоречие
  ]);
  assert.strictEqual(c.length, 1, "одна группа: " + JSON.stringify(c));
  assert.deepStrictEqual(c[0].entries.map((e) => e.id), ["1", "2"]);
  assert.strictEqual(c[0].source + ">" + c[0].target, "en>ru");
  assert.deepStrictEqual(INS.conflicts([]), []);

  // ---- 6. страница: новые блоки на месте, по-прежнему без innerHTML ----
  const html = require("fs").readFileSync(require("path").join(__dirname, "../admin.html"), "utf8");
  assert.ok(!/innerHTML/.test(html));
  for (const id of ["live", "quality", "heatmap", "records", "server", "restore-file", "conflicts"]) assert.ok(html.includes('id="' + id + '"'), "на странице есть #" + id);
  assert.ok(/prefers-reduced-motion/.test(html));

  console.log("ok: админка v3 — восстановление, живой режим, сервер, качество, противоречия");
})().catch((e) => { console.error(e); process.exit(1); });
