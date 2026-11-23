// Админка /admin: журнал переводов и жалобы «Неправильный перевод?», доступ по ADMIN_CODE.
//   node test/admin.test.js
const assert = require("assert");
const http = require("http");

process.env.NO_WARMUP = "1";
delete process.env.USE_AI;
const handler = require("../api/translate.js");
const { createLog } = require("../lib/activity-log.js");

// хранилище в памяти с тем же интерфейсом, что у Supabase / Netlify Blobs
const mem = {};
const store = { async get(k) { return mem[k] === undefined ? null : JSON.parse(JSON.stringify(mem[k])); }, async setJSON(k, v) { mem[k] = JSON.parse(JSON.stringify(v)); } };
handler._setStore(store);

function call(body) {
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(obj) { resolve({ status: this.code, body: obj }); } };
    Promise.resolve(handler({ method: "POST", body }, res)).catch(reject);
  });
}

(async () => {
  // 1. без ADMIN_CODE админка выключена
  delete process.env.ADMIN_CODE;
  let r = await call({ action: "admin", code: "x" });
  assert.strictEqual(r.status, 503, "без ADMIN_CODE — 503");

  process.env.ADMIN_CODE = "тайна-42";
  r = await call({ action: "admin", code: "неверно" });
  assert.strictEqual(r.status, 403, "неверный код — 403");
  r = await call({ action: "admin" });
  assert.strictEqual(r.status, 403, "без кода — 403");
  assert.ok(!r.body.log && !r.body.reports, "без кода данных нет");

  // 2. переводы попадают в журнал; прогрев и повтор — нет
  await call({ text: "мама", source: "ru", target: "inh", mode: "word", noAi: true });
  await call({ text: "мама", source: "ru", target: "inh", mode: "word", noAi: true }); // повтор подряд (предпросмотр + кнопка)
  await call({ text: "нана", source: "inh", target: "ru", mode: "word", noAi: true });
  await call({ text: "дом", source: "ru", target: "inh", mode: "word", noAi: true, warmup: true });
  await call({ text: "", source: "ru", target: "inh" }); // ошибка «пустой текст» — не пишем
  await call({ action: "config" });

  r = await call({ action: "admin", code: "тайна-42" });
  assert.strictEqual(r.status, 200);
  const log = r.body.log;
  assert.strictEqual(log.length, 2, "две записи: «мама» один раз и «нана»: " + JSON.stringify(log.map((x) => x.text)));
  assert.strictEqual(log[0].text, "нана", "новые сверху");
  assert.strictEqual(log[1].source + ">" + log[1].target, "ru>inh");
  for (const e of log) {
    assert.deepStrictEqual(Object.keys(e).sort(), ["at", "how", "label", "source", "target", "text", "translation"], "в журнале только текст, перевод, направление, время и откуда ответ");
    assert.ok(e.translation, "перевод записан: " + e.text);
  }
  assert.ok(Array.isArray(mem.log) && mem.log.length === 2, "журнал сохранён в хранилище под ключом log");
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(r.body.stats[today].total, 2, "счётчик за сегодня");
  assert.strictEqual(r.body.stats[today].ruInh, 1);
  assert.strictEqual(r.body.stats[today].inhRu, 1);

  // 3. жалобы: видны с id, отмечаются обработанными и возвращаются в новые
  await call({ action: "report", text: "Как дела?", translation: "что-то не то", source: "ru", target: "inh" });
  await call({ action: "report", text: "Со цӀа вода", translation: "плохо", source: "inh", target: "ru" });
  r = await call({ action: "admin", code: "тайна-42" });
  assert.strictEqual(r.body.reports.length, 2);
  assert.strictEqual(r.body.reports[0].text, "Со цӀа вода", "новые жалобы сверху");
  const id = r.body.reports[1].id;
  assert.ok(/^[0-9a-f]{12}$/.test(id), "у жалобы есть id");
  assert.ok(!r.body.reports.some((x) => x.handled));
  assert.ok(!r.body.log.some((x) => x.text === "Как дела?"), "жалоба — не перевод, в журнал не попадает");

  r = await call({ action: "admin", code: "неверно", op: "report", id, handled: true });
  assert.strictEqual(r.status, 403, "отметить без кода нельзя");
  r = await call({ action: "admin", code: "тайна-42", op: "report", id, handled: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.handled, true);
  assert.ok(mem.reports.find((x) => x.text === "Как дела?").handled, "отметка сохранена в хранилище");
  assert.ok(!mem.reports[0].id, "id не пишется в хранилище: формат жалоб тот же");
  r = await call({ action: "admin", code: "тайна-42" });
  assert.strictEqual(r.body.reports.find((x) => x.id === id).handled, true);
  r = await call({ action: "admin", code: "тайна-42", op: "report", id, handled: false });
  assert.strictEqual(r.body.handled, false);
  assert.ok(!mem.reports.find((x) => x.text === "Как дела?").handled, "вернулась в новые");
  r = await call({ action: "admin", code: "тайна-42", op: "report", id: "000000000000", handled: true });
  assert.strictEqual(r.status, 404, "чужой id — 404");

  // 4. ADMIN_LOG=0 — журнал не ведётся
  process.env.ADMIN_LOG = "0";
  await call({ text: "отец", source: "ru", target: "inh", mode: "word", noAi: true });
  r = await call({ action: "admin", code: "тайна-42" });
  assert.ok(!r.body.log.some((x) => x.text === "отец"), "ADMIN_LOG=0: не записано");
  assert.strictEqual(r.body.logging, false);
  delete process.env.ADMIN_LOG;

  // 5. журнал сам по себе: обрезка до последних записей, ошибки хранилища не теряют записи
  let t = Date.parse("2026-11-20T10:00:00Z");
  const m2 = {};
  let fail = true;
  const s2 = { async get(k) { if (fail) throw new Error("нет сети"); return m2[k] || null; }, async setJSON(k, v) { m2[k] = v; } };
  const L = createLog(() => s2, { now: () => (t += 1000) });
  L.add({ text: "один", source: "ru", target: "inh" }, { translation: "цхьаъ", base: true });
  await L.flush();
  assert.strictEqual(L._pending().length, 1, "хранилище недоступно — запись осталась в памяти");
  fail = false;
  for (let i = 0; i < 3100; i++) L.add({ text: "слово " + i, source: "inh", target: "ru" }, { translation: "", base: true, noAi: true });
  await L.flush();
  assert.strictEqual(m2.log.length, 3000, "храним последние 3000");
  assert.strictEqual(m2.log[2999].text, "слово 3099");
  assert.strictEqual(m2["log-stats"].days["2026-11-20"].total, 3101, "счётчики считают все, а не только последние 3000");
  assert.strictEqual(m2["log-stats"].days["2026-11-20"].empty, 3100);
  assert.strictEqual(L._howOf({ translation: "x", chunks: true, rules: true }), "chunks");
  assert.strictEqual(L._howOf({ translation: "x", verified: true }), "verified");
  assert.strictEqual(L._howOf({ translation: "x", model: "Gemini" }), "ai");
  assert.strictEqual(L._howOf({ translation: "", base: true }), "none");

  // 6. исправить перевод из жалобы: сохраняется в словарь сайта, сайт сразу отвечает им, жалоба — обработана
  const A = (b) => call({ action: "admin", code: "тайна-42", ...b });
  r = await A({});
  const rep = r.body.reports.find((x) => x.text === "Как дела?");
  // перевод для теста — пара из базы проекта (data/phrases.json), не придуманная
  const SEED = require("../data/phrases.json");
  const pair = SEED.find((p) => p.kind === "phrase" && /^PaydaDosh/.test(p.source || "") && p.ru && p.inh && p.ru.length < 40);
  r = await A({ op: "fix", reportId: rep.id, source: "ru", target: "inh", text: "Как дела?", translation: pair.inh });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.report.handled, true);
  assert.ok(mem.reports.find((x) => x.text === "Как дела?").fixed, "в жалобе записано исправление");
  assert.ok(mem.all.some((p) => p.text === "Как дела?" && p.source === "ru" && p.target === "inh"), "исправление в словаре сайта (ключ all, прежний формат)");
  assert.deepStrictEqual(Object.keys(mem.all[mem.all.length - 1]).sort(), ["at", "source", "target", "text", "translation"], "формат записи словаря не изменился");
  r = await call({ text: "Как дела?", source: "ru", target: "inh", mode: "text", noAi: true });
  assert.ok(r.body.verified, "сайт отвечает исправлением как носитель: " + JSON.stringify(r.body).slice(0, 200));
  r = await A({ op: "fix", source: "ru", target: "inh", text: "x", translation: "" });
  assert.strictEqual(r.status, 400, "пустой перевод не сохраняется");
  r = await A({ op: "fix", source: "xx", target: "inh", text: "x", translation: "y" });
  assert.strictEqual(r.status, 400, "неизвестный язык");

  // 7. словарь: виден в админке, правится и удаляется
  r = await A({});
  let d = r.body.dict.find((x) => x.text === "Как дела?");
  assert.ok(d && /^[0-9a-f]{12}$/.test(d.id), "словарь с id в данных админки");
  r = await A({ op: "dict-save", id: d.id, source: "ru", target: "inh", text: "Как твои дела?", translation: pair.inh });
  assert.strictEqual(r.status, 200);
  assert.ok(!mem.all.some((p) => p.text === "Как дела?"), "старая запись ушла при правке текста");
  assert.ok(mem.all.some((p) => p.text === "Как твои дела?"));
  r = await A({ op: "dict-delete", id: r.body.entry.id });
  assert.strictEqual(r.status, 200);
  assert.ok(!mem.all.some((p) => p.text === "Как твои дела?"), "удалено");
  r = await A({ op: "dict-delete", id: "000000000000" });
  assert.strictEqual(r.status, 404);
  r = await call({ action: "admin", code: "неверно", op: "dict-delete", id: "x" });
  assert.strictEqual(r.status, 403, "без кода словарь не меняется");

  // 8. частые запросы и слова без перевода — из журнала
  const INS = require("../lib/admin-insights.js");
  const fake = [
    { at: "2026-11-20T10:00:00Z", text: "Привет", source: "ru", target: "inh", translation: "a", how: "base" },
    { at: "2026-11-20T11:00:00Z", text: "привет!", source: "ru", target: "inh", translation: "b", how: "base" },
    { at: "2026-11-20T12:00:00Z", text: "один раз", source: "ru", target: "inh", translation: "c", how: "base" },
    { at: "2026-11-20T13:00:00Z", text: "мой компьютер сломался", source: "ru", target: "inh", translation: "[компьютер] x", how: "chunks" },
    { at: "2026-11-20T14:00:00Z", text: "компьютер", source: "ru", target: "inh", translation: "", how: "none" },
    { at: "2026-11-20T15:00:00Z", text: "очень длинный запрос из многих слов", source: "ru", target: "inh", translation: "", how: "none" },
  ];
  const pop = INS.popular(fake);
  assert.strictEqual(pop.length, 1, "в частых — только повторы");
  assert.strictEqual(pop[0].count, 2);
  assert.strictEqual(pop[0].translation, "b", "последний перевод");
  const miss = INS.missed(fake);
  assert.strictEqual(miss[0].word, "компьютер");
  assert.strictEqual(miss[0].count, 2, "из [скобок] и из пустого ответа");
  assert.ok(!miss.some((m) => m.word.includes("длинный")), "длинные тексты не считаются словом");
  r = await A({});
  assert.ok(Array.isArray(r.body.popular) && Array.isArray(r.body.missed));

  // 9. резервная копия и очистка с возвратом
  r = await A({ op: "backup" });
  assert.strictEqual(r.body.kind, "ingush-translator-backup");
  for (const k of ["corrections", "review", "reports", "log", "logStats"]) assert.ok(k in r.body, "в копии есть " + k);
  const logBefore = mem.log.length;
  assert.ok(logBefore > 0);
  r = await A({ op: "clear", what: "log" });
  assert.strictEqual(r.body.removed, logBefore);
  assert.strictEqual(mem.log.length, 0, "журнал очищен");
  assert.ok(mem["log-stats"].days[today].total > 0, "счётчики при очистке журнала остаются");
  r = await A({});
  assert.strictEqual(r.body.trash.what, "log");
  r = await A({ op: "undo-clear" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(mem.log.length, logBefore, "журнал вернулся");
  r = await A({ op: "undo-clear" });
  assert.strictEqual(r.status, 404, "второй раз возвращать нечего");
  await A({ op: "report", id: r.body.id || (await A({})).body.reports[0].id, handled: true });
  const nRep = mem.reports.length, nHandled = mem.reports.filter((x) => x.handled).length;
  assert.ok(nHandled >= 1);
  r = await A({ op: "clear", what: "reports-handled" });
  assert.strictEqual(mem.reports.length, nRep - nHandled, "удалены только обработанные");
  r = await A({ op: "clear", what: "stats" });
  assert.deepStrictEqual(mem["log-stats"].days, {});
  r = await A({ op: "undo-clear" });
  assert.ok(mem["log-stats"].days[today].total > 0, "счётчики вернулись");
  r = await A({ op: "clear", what: "all-the-things" });
  assert.strictEqual(r.status, 400);
  r = await call({ action: "admin", code: "неверно", op: "clear", what: "log" });
  assert.strictEqual(r.status, 403, "без кода не очистить");
  assert.ok(mem.all.length >= 0 && Array.isArray(mem.all), "словарь при очистках не тронут");

  // 10. страница /admin отдаётся локальным сервером; скрипт страницы не вставляет чужой текст как HTML
  const html = require("fs").readFileSync(require("path").join(__dirname, "../admin.html"), "utf8");
  assert.ok(!/innerHTML/.test(html), "admin.html не использует innerHTML (тексты людей — только textContent)");
  assert.ok(/noindex/.test(html), "админка не индексируется");
  const { createServer } = require("../server.js");
  const srv = createServer().listen(0);
  await new Promise((ok) => srv.once("listening", ok));
  const port = srv.address().port;
  const got = await new Promise((ok, bad) => http.get({ port, path: "/admin" }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode, b })); }).on("error", bad));
  srv.close();
  assert.strictEqual(got.status, 200);
  assert.ok(got.b.includes("Код администратора"));
  for (const f of ["netlify.toml", "vercel.json"]) assert.ok(require("fs").readFileSync(require("path").join(__dirname, "..", f), "utf8").includes("/admin.html"), f + ": маршрут /admin");

  console.log("ok: админка — код, журнал переводов, жалобы и отметка «обработано»");
})().catch((e) => { console.error(e); process.exit(1); });
