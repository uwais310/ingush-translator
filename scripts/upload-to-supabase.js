#!/usr/bin/env node
// Загружает базу пар data/phrases.json в таблицу public.phrases в Supabase (схема: supabase/schema.sql).
// Запуск: SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=<ключ> node scripts/upload-to-supabase.js
// Ключ нужен с правом записи (секретный/service_role). Повторный запуск обновляет строки по id.
const path = require("path");
const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!url || !key) { console.error("Нужны SUPABASE_URL и SUPABASE_KEY"); process.exit(1); }

const rows = require(path.join(__dirname, "..", "data", "phrases.json")).map((p) => ({
  id: p.id, kind: p.kind, ru: p.ru, inh: p.inh, source: p.source ?? null, verified: !!p.verified,
  also: p.also ?? null, note: p.note ?? null, count: p.count ?? null, license: p.license ?? null, rare: p.rare ?? null,
}));

(async () => {
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(url + "/rest/v1/phrases?on_conflict=id", {
        method: "POST",
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
      if (r.ok) break;
      const msg = await r.text();
      if (attempt >= 4) { console.error("Ошибка:", r.status, msg); process.exit(1); }
      await new Promise((ok) => setTimeout(ok, 1000 * attempt));
    }
    console.log(`${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }
  console.log("Готово");
})();
