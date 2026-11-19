// Хранилище исправлений в Supabase (таблица public.kv: key text, value jsonb).
// Тот же интерфейс, что у Netlify Blobs: get(key, { type: "json" }) и setJSON(key, value),
// поэтому api/translate.js работает с любым из них одинаково.
// Ключи берутся только из переменных окружения хостинга (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY),
// в коде и в репозитории их нет.

function supabaseStore(env = process.env, fetchImpl = globalThis.fetch) {
  const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "";
  if (!url || !key || typeof fetchImpl !== "function") return null;
  const base = url + "/rest/v1/kv";
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };

  return {
    async get(name) {
      const r = await fetchImpl(base + "?select=value&key=eq." + encodeURIComponent(name), { headers });
      if (!r.ok) throw new Error("supabase get " + name + ": " + r.status);
      const rows = await r.json();
      return rows.length ? rows[0].value : null;
    },
    async setJSON(name, value) {
      const r = await fetchImpl(base + "?on_conflict=key", {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: name, value, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) throw new Error("supabase set " + name + ": " + r.status);
    },
  };
}

module.exports = { supabaseStore };
