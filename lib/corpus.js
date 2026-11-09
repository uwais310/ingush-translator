// Примеры настоящих переводов для ИИ: пары предложений «ингушский — русский»
// из параллельного корпуса GhalghayTools (книги, газета «Сердало», Википедия).
//
// Сами тексты в этом репозитории не хранятся. При первом запросе функция скачивает корпус
// из исходного репозитория (github.com/Morgxth/GhalghayTools), оставляет только хорошо
// выровненные пары (их отпечатки — в lib/corpus-keep.js) и кладёт результат в хранилище
// Netlify Blobs сайта (оно не публичное). Дальше корпус берётся оттуда.
// Для каждого перевода находятся пары с теми же редкими словами, что и в тексте.

const crypto = require("crypto");
const KEEP_RAW = require("./corpus-keep.js");

const SHA = "92e877ec4c537802dcb16ecf0fe7713cd7f101b5";
const BASE = `https://raw.githubusercontent.com/Morgxth/GhalghayTools/${SHA}/corpus/finetune/`;
const FILES = ["train.jsonl", "dev.jsonl", "test.jsonl"];
const BLOB_KEY = `pairs-${SHA.slice(0, 8)}-${KEEP_RAW.length / 11}`;
const RETRY_AFTER_MS = 5 * 60 * 1000;

let storeOverride = null, fetchOverride = null; // для тестов
let PAIRS = null, INDEX = null, LOADING = null, FAILED_AT = 0;

function store() {
  if (storeOverride) return storeOverride;
  try {
    return require("@netlify/blobs").getStore("corpus");
  } catch {
    return null;
  }
}

let KEEP = null;
function keepMap() {
  if (!KEEP) {
    KEEP = new Map();
    for (let i = 0; i + 11 <= KEEP_RAW.length; i += 11) KEEP.set(KEEP_RAW.slice(i, i + 10), Number(KEEP_RAW[i + 10]));
  }
  return KEEP;
}

const clean = (s) =>
  String(s || "").replace(/[­​]/g, "").replace(/\+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^["'«»\s]+|["'«»\s]+$/g, "");
const fixPal = (s) =>
  s.replace(/ӏ/g, "Ӏ")
    .replace(/([А-Яа-яЁё])[1Il|ІіΙⅠǀ](?=[А-Яа-яЁё]|\b)/g, "$1Ӏ")
    .replace(/(^|[^А-Яа-яЁёA-Za-z0-9])[1Il|ІіΙⅠǀ](?=[А-Яа-яЁё])/g, "$1Ӏ");

async function download() {
  const f = fetchOverride || fetch;
  const keep = keepMap();
  const pairs = [];
  for (const name of FILES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let text;
    try {
      const r = await f(BASE + name, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${name}`);
      text = await r.text();
    } finally {
      clearTimeout(timer);
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"inh_Cyrl"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!String(row.src_lang).startsWith("inh")) continue;
      const h = crypto.createHash("sha1").update(`${row.src}\x01${row.tgt}`, "utf8").digest("hex").slice(0, 10);
      if (keep.has(h)) pairs.push([fixPal(clean(row.src)), clean(row.tgt), keep.get(h)]);
    }
  }
  if (pairs.length < 1000) throw new Error(`corpus too small: ${pairs.length}`);
  return pairs;
}

async function load() {
  const s = store();
  if (s) {
    try {
      const cached = await s.get(BLOB_KEY, { type: "json" });
      if (Array.isArray(cached) && cached.length) return cached;
    } catch (e) {
      console.error("corpus blob read:", e.message);
    }
  }
  const pairs = await download();
  if (s) {
    try { await s.setJSON(BLOB_KEY, pairs); } catch (e) { console.error("corpus blob write:", e.message); }
  }
  return pairs;
}

// ---------------- поиск ----------------

const stems = (t) =>
  (String(t).toLowerCase().replace(/Ӏ/g, "ӏ").replace(/ё/g, "е").match(/[а-яӏ]+/g) || [])
    .filter((w) => w.length >= 2)
    .map((w) => w.slice(0, 5));

function buildIndex(pairs) {
  const ru = new Map(), inh = new Map();
  const add = (m, k, i) => { const a = m.get(k); if (a) a.push(i); else m.set(k, [i]); };
  const len = new Uint16Array(pairs.length);
  pairs.forEach((p, i) => {
    for (const s of new Set(stems(p[0]))) add(inh, s, i);
    for (const s of new Set(stems(p[1]))) add(ru, s, i);
    len[i] = Math.min(65535, p[0].length + p[1].length);
  });
  return { ru, inh, len, n: pairs.length };
}

function start() {
  if (INDEX) return Promise.resolve(true);
  if (LOADING) return LOADING;
  if (FAILED_AT && Date.now() - FAILED_AT < RETRY_AFTER_MS) return Promise.resolve(false);
  LOADING = load()
    .then((pairs) => { PAIRS = pairs; INDEX = buildIndex(pairs); return true; })
    .catch((e) => { console.error("corpus:", e.message); FAILED_AT = Date.now(); return false; })
    .finally(() => { LOADING = null; });
  return LOADING;
}

// Ждём корпус не дольше waitMs; если не успел — переводим без примеров (загрузка продолжится).
function ready(waitMs) {
  if (INDEX) return Promise.resolve(true);
  const p = start();
  return Promise.race([p, new Promise((r) => setTimeout(() => r(false), waitMs))]);
}

// Пары, где есть редкие слова из текста. lang — язык текста: "ru" или "inh".
function search(text, lang, k = 10) {
  if (!INDEX) return [];
  const idx = lang === "inh" ? INDEX.inh : INDEX.ru;
  const scores = new Map();
  for (const s of new Set(stems(text))) {
    const post = idx.get(s);
    if (!post || post.length > INDEX.n * 0.05) continue; // слишком частые слова не помогают
    const idf = Math.log(INDEX.n / post.length);
    for (const i of post) scores.set(i, (scores.get(i) || 0) + idf);
  }
  return [...scores]
    .filter(([, v]) => v >= 4)
    .map(([i, v]) => [i, v / (1 + INDEX.len[i] / 250) + PAIRS[i][2] * 0.08])
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([i]) => PAIRS[i]);
}

module.exports = {
  ready, search,
  size: () => (PAIRS ? PAIRS.length : 0),
  _set: ({ store: s, fetch: f } = {}) => { storeOverride = s || null; fetchOverride = f || null; PAIRS = INDEX = LOADING = null; FAILED_AT = 0; },
  _blobKey: BLOB_KEY,
};
