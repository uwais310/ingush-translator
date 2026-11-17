// Раздел «Учить»: ингушский текст только из разрешённых записей, упражнения целые, проверка ответа, API.
//   node test/learn.test.js
const assert = require("assert");
const SEED = require("../data/phrases.json");
const KB = require("../lib/ingush-guide.js");
const LEARN = require("../lib/learn.js");

// разрешённые записи считаем здесь заново, независимо от lib/learn.js
const PD_OK = /^PaydaDosh, разговорник: (уроки|ситуации|переводы носителей|выражения) /;
const allowed = [];
for (const p of SEED) {
  if (p.kind === "phrase" && p.source === "Справочник проекта") allowed.push(p.inh);
  else if (p.kind === "phrase" && p.source === "PaydaDosh" && PD_OK.test(p.note || "")) allowed.push(p.inh);
  else if (p.kind === "word" && (p.source === "Справочник проекта" || p.source === "PaydaDosh")) allowed.push(p.inh);
}
for (const [, inh] of KB.EXAMPLES) allowed.push(inh);
const exact = new Set(allowed);
const parts = new Set(); // варианты внутри записи (« / », «;»)
for (const s of allowed) for (const v of s.split(/\s+\/\s+|\s*;\s*/)) parts.add(v.trim());
const words = new Set(); // слова из записей — для «собери из слов»
for (const s of parts) for (const w of s.split(/\s+/)) words.add(w.replace(/^[^\p{L}Ӏӏ]+|[^\p{L}Ӏӏ]+$/gu, ""));

const isRecord = (s) => exact.has(s) || parts.has(s);
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; if (failures < 30) console.error("  ✗ " + msg); } };

const course = LEARN.buildCourse(SEED, KB);
const allItems = course.units.flatMap((u) => u.lessons.flatMap((l) => l.items));

// ---------- курс ----------
assert.ok(course.units.length >= 1 && course.units.length <= 5, "от 1 до 5 тем");
for (const u of course.units) {
  assert.ok(u.id && u.title, "у темы есть id и название");
  assert.ok(u.lessons.length >= 1 && u.lessons.length <= 5, `${u.id}: от 1 до 5 уроков`);
  for (const l of u.lessons) {
    assert.ok(l.items.length >= 6 && l.items.length <= 8, `${l.id}: 6–8 записей, а не ${l.items.length}`);
    for (const it of l.items) {
      check(it.id && it.ru && it.inh && it.source, `${l.id}: у записи есть id, ru, inh, source`);
      check(exact.has(it.inh), `${l.id}: «${it.inh}» — не разрешённая запись`);
      check(!/[A-Za-z0-9]/.test(it.inh), `${l.id}: латиница/цифры в «${it.inh}»`);
      check(it.inh.split(/\s+/).length <= 8, `${l.id}: длиннее 8 слов «${it.inh}»`);
    }
  }
}
const ids = allItems.map((i) => i.id);
assert.strictEqual(new Set(ids).size, ids.length, "каждая запись — только в одной теме и одном уроке");

// ---------- упражнения ----------
const TYPES = new Set(["choose", "tiles", "match", "type"]);
let nEx = 0;
for (const u of course.units) for (const l of u.lessons) for (const seed of [0, 1, 7]) {
  const exs = LEARN.buildLesson(l, u, seed, allItems);
  check(exs.length >= 8 && exs.length <= 12, `${l.id}/${seed}: 8–12 упражнений, а не ${exs.length}`);
  const types = new Set(exs.map((e) => e.type));
  check([...TYPES].every((t) => types.has(t)), `${l.id}/${seed}: все четыре типа (есть ${[...types]})`);
  for (const e of exs) {
    nEx++;
    check(TYPES.has(e.type) && e.itemId && e.prompt && (e.promptLang === "ru" || e.promptLang === "inh") && e.answer != null, `${l.id}: поля упражнения ${JSON.stringify(e).slice(0, 80)}`);
    if (e.promptLang === "inh") check(isRecord(e.prompt), `${l.id}: задание «${e.prompt}» не из записи`);
    if (e.type === "choose") {
      check(e.options.length === 4, `${l.id}: 4 варианта`);
      check(new Set(e.options).size === 4, `${l.id}: варианты повторяются ${e.options}`);
      check(e.options.includes(e.answer), `${l.id}: правильного ответа нет среди вариантов`);
      if (e.promptLang === "ru") for (const o of e.options) check(isRecord(o), `${l.id}: вариант «${o}» не из записи`);
      check(LEARN.checkAnswer(e, e.answer).ok, `${l.id}: правильный вариант не засчитан`);
      const wrong = e.options.filter((o) => o !== e.answer);
      for (const w of wrong) check(!LEARN.checkAnswer(e, w).ok, `${l.id}: неверный вариант «${w}» засчитан`);
    }
    if (e.type === "tiles") {
      check(isRecord(e.answer), `${l.id}: ответ «${e.answer}» не из записи`);
      for (const t of e.tiles) check(words.has(t), `${l.id}: плитка «${t}» — не слово из записи`);
      const need = e.answer.split(/\s+/).map((w) => w.replace(/^[^\p{L}Ӏӏ]+|[^\p{L}Ӏӏ]+$/gu, "")).filter(Boolean);
      const extra = e.tiles.length - need.length;
      check(extra >= 2 && extra <= 3, `${l.id}: лишних плиток 2–3, а не ${extra}`);
      check(LEARN.checkAnswer(e, need.join(" ")).ok, `${l.id}: собранная фраза не засчитана`);
    }
    if (e.type === "type") {
      check(isRecord(e.answer), `${l.id}: ответ «${e.answer}» не из записи`);
      for (const a of e.accept || []) check(isRecord(a), `${l.id}: принимаемый ответ «${a}» не из записи`);
      check(LEARN.checkAnswer(e, e.answer).ok, `${l.id}: правильный ответ не засчитан`);
    }
    if (e.type === "match") {
      check(e.pairs.length === 5, `${l.id}: 5 пар`);
      check(new Set(e.pairs.map((p) => p.ru)).size === 5 && new Set(e.pairs.map((p) => p.inh)).size === 5, `${l.id}: пары повторяются`);
      for (const p of e.pairs) check(isRecord(p.inh), `${l.id}: пара «${p.inh}» не из записи`);
      check(LEARN.checkAnswer(e, e.pairs.map((p) => [p.ru, p.inh])).ok, `${l.id}: верные пары не засчитаны`);
      check(!LEARN.checkAnswer(e, e.pairs.map((p, i, a) => [p.ru, a[(i + 1) % a.length].inh])).ok, `${l.id}: неверные пары засчитаны`);
    }
  }
}
assert.strictEqual(failures, 0, `ошибок в курсе: ${failures}`);

// ---------- проверка ответа ----------
const ex = { type: "type", answer: "ЦӀи фу я хьа?", accept: ["ЦӀи фу я хьа?"] };
for (const v of ["ЦӀи фу я хьа", "Ц1и фу я хьа", "цӀи фу я хьа?", "  ЦIи  фу я хьа!", "Цlи фу я хьа", "Ц|и фу я хьа", "цӏи фу я хьа"]) assert.ok(LEARN.checkAnswer(ex, v).ok, `засчитать «${v}»`);
assert.ok(!LEARN.checkAnswer(ex, "Фу я хьа").ok, "неверный ответ не засчитан");
assert.ok(!LEARN.checkAnswer(ex, "").ok, "пустой ответ не засчитан");
assert.strictEqual(LEARN.checkAnswer(ex, "x").expected, "ЦӀи фу я хьа?");
assert.ok(LEARN.checkAnswer({ type: "choose", answer: "Ещё рано" }, "еще рано").ok, "ё = е");
const multi = { type: "type", answer: "хӀаа / ва; дика" };
for (const v of ["хӀаа", "ва", "дика"]) assert.ok(LEARN.checkAnswer(multi, v).ok, `вариант «${v}» засчитан`);

// ---------- API ----------
function run(T, body) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, data: o }); } };
    T({ method: "POST", body }, res);
  });
}
(async () => {
  const T = require("../api/translate.js");
  const c = await run(T, { action: "learn", op: "course" });
  assert.strictEqual(c.code, 200);
  assert.ok(c.data.units.length >= 1 && c.data.units[0].lessons.length >= 1, "курс: темы и уроки");
  assert.ok(c.data.units[0].title && c.data.units[0].lessons[0].id, "у урока есть id");
  const id = c.data.units[0].lessons[0].id;
  const l = await run(T, { action: "learn", op: "lesson", id });
  assert.strictEqual(l.code, 200);
  assert.strictEqual(l.data.id, id);
  assert.ok(l.data.exercises.length >= 8, "урок: упражнения");
  const again = await run(T, { action: "learn", op: "lesson", id });
  assert.deepStrictEqual(again.data, l.data, "один и тот же seed — те же упражнения");
  const miss = await run(T, { action: "learn", op: "lesson", id: "нет-такого" });
  assert.strictEqual(miss.code, 404);
  const bad = await run(T, { action: "learn", op: "что-то" });
  assert.strictEqual(bad.code, 400);

  const sum = course.units.map((u) => `${u.title}: ${u.lessons.length} ур., ${u.lessons.reduce((n, x) => n + x.items.length, 0)} зап.`).join("; ");
  console.log(`learn: ${course.units.length} тем, ${nEx} упражнений проверено. ${sum}`);
  console.log("learn.test.js: все проверки пройдены");
})().catch((e) => { console.error(e); process.exit(1); });
