// Журнал переводов для страницы /admin: что переводили, в какую сторону, когда и откуда взялся ответ.
// Хранится только сам текст и перевод: ни IP, ни браузера, ни других данных о человеке.
//
// Записи копятся в памяти и пачкой уходят в то же хранилище, что и исправления (Supabase kv,
// Netlify Blobs или local-data/phrases-log.json), под ключами "log" (последние MAX записей)
// и "log-stats" (счётчики по дням — они не обрезаются, поэтому графику хватает истории).
// Если в .env / на хостинге задано ADMIN_LOG=0, журнал не ведётся.

const MAX = 3000;          // сколько последних переводов хранить
const FLUSH_MS = 15_000;   // как часто сбрасывать пачку в хранилище
const FLUSH_SIZE = 25;     // или сразу, когда накопилось столько
const DEDUP_MS = 120_000;  // тот же текст в ту же сторону подряд — одна запись (предпросмотр + кнопка)
const STAT_DAYS = 120;     // счётчики по дням храним за 4 месяца

function createLog(getStore, opts = {}) {
  const now = opts.now || (() => Date.now());
  let pending = [];
  let timer = null;
  let last = null; // последняя запись: чтобы не писать один перевод дважды

  const enabled = () => process.env.ADMIN_LOG !== "0";

  function howOf(result) {
    if (!result) return "none";
    if (result.verified) return "verified";
    if (result.chunks) return "chunks";
    if (result.rules) return "rules";
    if (result.base) return result.translation ? "base" : "none";
    if (result.translation) return "ai";
    return "none";
  }

  function add(body, result) {
    if (!enabled() || !body || body.warmup || body.test) return;
    const text = String(body.text || "").trim();
    if (!text || !result || result.error) return;
    const entry = {
      at: new Date(now()).toISOString(),
      text: text.slice(0, 500),
      translation: String(result.translation || "").slice(0, 1000),
      source: String(body.source || ""),
      target: String(body.target || ""),
      how: howOf(result),
      label: String(result.model || "").slice(0, 120),
    };
    const key = entry.source + ">" + entry.target + ">" + entry.text;
    if (last && last.key === key && now() - last.t < DEDUP_MS) {
      // повтор: обновим перевод у той же записи, если она ещё не ушла в хранилище
      const same = pending.find((p) => p === last.entry);
      if (same && entry.translation) Object.assign(same, { translation: entry.translation, how: entry.how, label: entry.label });
      return;
    }
    last = { key, t: now(), entry };
    pending.push(entry);
    if (pending.length >= FLUSH_SIZE) flush();
    else if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
      if (timer.unref) timer.unref();
    }
  }

  // сбросы идут строго по очереди: иначе два сброса прочитали бы один и тот же журнал и один затёр бы другой
  let chain = Promise.resolve();
  function flush() {
    chain = chain.then(write, write);
    return chain;
  }

  async function write() {
    if (!pending.length) return;
    const store = getStore();
    if (!store) { pending = pending.slice(-MAX); return; }
    const batch = pending;
    pending = [];
    try {
      const list = (await store.get("log", { type: "json" })) || [];
      const merged = (Array.isArray(list) ? list : []).concat(batch).slice(-MAX);
      await store.setJSON("log", merged);
      const stats = (await store.get("log-stats", { type: "json" })) || {};
      const days = stats.days && typeof stats.days === "object" ? stats.days : {};
      for (const e of batch) {
        const d = e.at.slice(0, 10);
        const s = days[d] || (days[d] = { total: 0, ruInh: 0, inhRu: 0, empty: 0 });
        s.total++;
        if (e.source === "ru" && e.target === "inh") s.ruInh++;
        if (e.source === "inh" && e.target === "ru") s.inhRu++;
        if (!e.translation) s.empty++;
      }
      const keep = Object.keys(days).sort().slice(-STAT_DAYS);
      await store.setJSON("log-stats", { days: Object.fromEntries(keep.map((d) => [d, days[d]])) });
    } catch (e) {
      console.error("log:", e.message);
      pending = batch.concat(pending).slice(-MAX); // не потеряем: попробуем в следующий раз
    }
  }

  // всё сохранённое + то, что ещё в памяти
  async function read() {
    await flush();
    const store = getStore();
    let list = [], stats = {};
    if (store) {
      try { list = (await store.get("log", { type: "json" })) || []; } catch (e) { console.error("log read:", e.message); }
      try { stats = (await store.get("log-stats", { type: "json" })) || {}; } catch (e) { console.error("log stats:", e.message); }
    }
    return { list: (Array.isArray(list) ? list : []).concat(pending), stats: stats.days || {} };
  }

  // очистить журнал и/или счётчики (из админки): в той же очереди, что и сбросы, чтобы не смешаться с записью
  function clear({ log = true, stats = false } = {}) {
    chain = chain.then(async () => {
      const store = getStore();
      if (log) { pending = []; last = null; }
      if (!store) return;
      if (log) await store.setJSON("log", []);
      if (stats) await store.setJSON("log-stats", { days: {} });
    });
    return chain;
  }

  // восстановление из резервной копии (админка): добавляет только то, чего нет, ничего не удаляет и не переписывает.
  //   записи журнала — по at+text и только в свободное место (до MAX), при нехватке места — самые свежие;
  //   счётчики — только дни, которых нет, в пределах последних STAT_DAYS дней и свободного места.
  // Всё, что не поместилось, — skipped (иначе следующий сброс молча вытеснил бы старое).
  // used — сколько места уже заняли прежние части того же предпросмотра. dry: true — только посчитать.
  function merge(entries, statDays, { dry = false, used = {} } = {}) {
    const out = { added: { log: 0, logStats: 0 }, skipped: { log: 0, logStats: 0 } };
    chain = chain.then(write, write).then(async () => {
      const store = getStore();
      if (!store) return;
      const key = (e) => e.at + "|" + e.text;
      const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
      const list = (await store.get("log", { type: "json" })) || [];
      const cur = Array.isArray(list) ? list : [];
      const have = new Set(cur.concat(pending).map(key));
      const add = [];
      for (const e of entries || []) { const k = key(e); if (!have.has(k)) { have.add(k); add.push(e); } }
      const room = Math.max(0, MAX - cur.length - pending.length - (used.log || 0)); // место и для того, что ещё в памяти
      const take = room ? add.sort(byTime).slice(-room) : [];
      out.added.log = take.length; out.skipped.log = add.length - take.length;

      const stats = (await store.get("log-stats", { type: "json" })) || {};
      const days = stats.days && typeof stats.days === "object" ? { ...stats.days } : {};
      const oldest = new Date(now() - (STAT_DAYS - 1) * 864e5).toISOString().slice(0, 10);
      const missing = Object.keys(statDays || {}).filter((d) => !Object.prototype.hasOwnProperty.call(days, d)).sort();
      const dayRoom = Math.max(0, STAT_DAYS - Object.keys(days).length - (used.logStats || 0));
      const inWindow = missing.filter((d) => d >= oldest);
      const newDays = dayRoom ? inWindow.slice(-dayRoom) : [];
      out.added.logStats = newDays.length; out.skipped.logStats = missing.length - newDays.length;
      if (dry) return;
      if (take.length) await store.setJSON("log", cur.concat(take).sort(byTime));
      if (newDays.length) {
        for (const d of newDays) days[d] = statDays[d];
        await store.setJSON("log-stats", { days: Object.fromEntries(Object.keys(days).sort().map((d) => [d, days[d]])) });
      }
    });
    const done = chain.then(() => out);
    chain = chain.catch((e) => console.error("log merge:", e.message)); // ошибка не ломает очередь сбросов
    return done;
  }

  return { add, flush, read, clear, merge, _pending: () => pending, _howOf: howOf };
}

module.exports = { createLog, MAX, STAT_DAYS };
