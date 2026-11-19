const test = require("node:test");
const assert = require("node:assert");
const { supabaseStore } = require("../lib/supabase-store.js");

test("без ключей хранилище Supabase не включается", () => {
  assert.strictEqual(supabaseStore({}, async () => {}), null);
});

test("get и setJSON ходят в таблицу kv", async () => {
  const calls = [];
  const db = {};
  const fake = async (u, opt = {}) => {
    calls.push({ u, opt });
    if (opt.method === "POST") { const b = JSON.parse(opt.body); db[b.key] = b.value; return { ok: true, json: async () => ({}) }; }
    const k = decodeURIComponent(u.split("key=eq.")[1]);
    return { ok: true, json: async () => (k in db ? [{ value: db[k] }] : []) };
  };
  const s = supabaseStore({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" }, fake);
  assert.strictEqual(await s.get("all", { type: "json" }), null);
  await s.setJSON("all", [{ text: "а" }]);
  assert.deepStrictEqual(await s.get("all", { type: "json" }), [{ text: "а" }]);
  assert.ok(calls[0].u.startsWith("https://x.supabase.co/rest/v1/kv?"));
  assert.strictEqual(calls[1].opt.headers.apikey, "k");
});
