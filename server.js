// Локальный запуск переводчика на своём компьютере: node server.js → http://localhost:3000
// Ничего устанавливать не нужно, кроме Node.js 18 или новее (npm install не требуется).
//
// Это тот же переводчик, что и на сайте: сначала база, потом ИИ (Gemini) со справочником.
// Отличия от хостинга:
//   - ключи читаются из файла .env рядом с этим файлом (образец — .env.example);
//   - исправления, решения со страницы /review и корпус хранятся в папке local-data/;
//   - нет ограничения в 10 секунд, поэтому Gemini думает над переводом столько, сколько ему нужно.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const ROOT = __dirname;
const DATA = path.join(ROOT, "local-data");

// ---------- .env ----------
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
const hasEnvFile = loadEnv(path.join(ROOT, ".env"));
// времени много: модели думают без спешки (на хостинге было бы около 10 секунд)
if (!process.env.TIME_LIMIT_SECONDS) process.env.TIME_LIMIT_SECONDS = "90";

// ---------- хранилище в файлах (вместо Netlify Blobs) ----------
function fileStore(name) {
  const file = (key) => path.join(DATA, `${name}-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  return {
    async get(key) {
      try { return JSON.parse(fs.readFileSync(file(key), "utf8")); } catch { return null; }
    },
    async setJSON(key, value) {
      fs.mkdirSync(DATA, { recursive: true });
      const tmp = file(key) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file(key)); // запись целиком: файл не останется наполовину записанным
    },
  };
}

// ---------- страницы и файлы сайта (только из этого списка) ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json; charset=utf-8" };
const PAGES = { "/": "index.html", "/index.html": "index.html", "/review": "review.html", "/review.html": "review.html", "/rules": "rules.html", "/rules.html": "rules.html", "/admin": "admin.html", "/admin.html": "admin.html", "/sw.js": "sw.js", "/manifest.webmanifest": "manifest.webmanifest" };
for (const f of fs.readdirSync(ROOT)) if (f.endsWith(".png")) PAGES["/" + f] = f;

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// Файлы сайта: текст (страницы, sw.js, манифест) сжимается gzip — на телефоне грузится в разы быстрее.
// Сжатая копия держится в памяти, пока файл не изменится. Иконки браузер может хранить неделю.
const packed = new Map();
function sendFile(req, res, file) {
  const full = path.join(ROOT, file);
  const stat = fs.statSync(full);
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  const text = /^(text|application\/(manifest\+)?json)/.test(type) || type.includes("javascript");
  const headers = { "Content-Type": type, "Cache-Control": file.endsWith(".png") ? "public, max-age=604800" : "no-cache", "Vary": "Accept-Encoding" };
  let data;
  if (text && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    let p = packed.get(file);
    if (!p || p.mtime !== stat.mtimeMs) { p = { mtime: stat.mtimeMs, gz: zlib.gzipSync(fs.readFileSync(full), { level: 9 }) }; packed.set(file, p); }
    data = p.gz; headers["Content-Encoding"] = "gzip";
  } else data = fs.readFileSync(full);
  headers["Content-Length"] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : data);
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Слишком большой запрос"), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createServer() {
  const handler = require("./api/translate.js");
  // На хостинге (Railway и т.п.) с ключами Supabase исправления хранятся в Supabase, иначе в local-data/.
  if (!require("./lib/supabase-store.js").supabaseStore()) handler._setStore(fileStore("phrases"));
  require("./lib/corpus.js")._set({ store: fileStore("corpus") });

  return http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    try {
      if (url === "/api/translate") {
        if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "Use POST" }));
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {
          if (e.status) return send(res, e.status, JSON.stringify({ error: e.message }));
        }
        const out = {
          code: 200,
          status(c) { this.code = c; return this; },
          json(obj) { send(res, this.code, JSON.stringify(obj)); },
        };
        return await handler({ method: "POST", body }, out);
      }
      const file = PAGES[url];
      if (!file || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, "Not found", "text/plain; charset=utf-8");
      return sendFile(req, res, file);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: "Ошибка сервера. Посмотрите окно, где запущен server.js." }));
    }
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

function start() {
  if (typeof fetch !== "function") {
    console.error("Нужен Node.js 18 или новее. Сейчас: " + process.version + ". Скачайте свежую версию на https://nodejs.org");
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  // HOST=127.0.0.1 в .env — если сайт должен открываться только на этом компьютере
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Порт ${port} занят. Закройте другое окно с переводчиком или впишите в .env строку PORT=3001` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const keys = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY"].filter((k) => process.env[k]);
    console.log("\nИнгушский переводчик запущен.\n");
    console.log(`  На этом компьютере:      http://localhost:${port}`);
    if (host === "0.0.0.0") for (const a of lanAddresses()) console.log(`  С телефона в том же Wi-Fi: http://${a}:${port}`);
    console.log(`  Проверка переводов:      http://localhost:${port}/review` + (process.env.EDITOR_CODE ? "" : "  (нужен EDITOR_CODE в .env)"));
    console.log(`  Админка (переводы и жалобы): http://localhost:${port}/admin` + (process.env.ADMIN_CODE ? "" : "  (нужен ADMIN_CODE в .env)"));
    console.log("");
    if (keys.length) console.log("  ИИ: " + keys.map((k) => k.replace("_API_KEY", "")).join(", ") + ". Ключи взяты из " + (hasEnvFile ? ".env" : "переменных окружения") + ".");
    else console.log("  Ключа ИИ нет: работают только ответы из базы.\n  Чтобы переводил Gemini, скопируйте .env.example в .env и впишите GEMINI_API_KEY.");
    console.log("\n  Чтобы остановить, нажмите Ctrl+C.\n");
    warmUp();
  });
  return server;
}

// Прогрев: словари, корпус и правила строят свои индексы при первом переводе (это 1–2 секунды).
// Делаем это сразу после запуска, чтобы первый человек на сайте не ждал. Только база и правила, без ИИ.
async function warmUp() {
  if (process.env.NO_WARMUP) return;
  const handler = require("./api/translate.js");
  const t0 = Date.now();
  const jobs = [
    ["Доброе утро! Как у тебя дела?", "ru", "inh", "text"], ["Мой брат вчера ходил в магазин и купил хлеб", "ru", "inh", "text"],
    ["маму", "ru", "inh", "word"], ["Сона хьо веза", "inh", "ru", "text"], ["нана", "inh", "ru", "word"],
  ];
  for (const [text, source, target, mode] of jobs) {
    await new Promise((done) => {
      const out = { status() { return this; }, json() { done(); } };
      Promise.resolve(handler({ method: "POST", body: { text, source, target, mode, noAi: true, warmup: true } }, out)).catch(() => done()).finally(done);
    });
  }
  console.log(`  Словари и правила загружены за ${((Date.now() - t0) / 1000).toFixed(1)} с: переводы будут быстрыми.\n`);
}

if (require.main === module) start();
module.exports = { createServer, start, fileStore, loadEnv };
