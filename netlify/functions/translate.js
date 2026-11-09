// Netlify: та же логика перевода, что в api/translate.js (для Vercel).
const handler = require("../../api/translate.js");

exports.handler = async (event, context) => {
  // Сколько времени хостинг даёт функции (чтобы успеть ответить до обрыва).
  let deadlineMs = null;
  try {
    if (context && typeof context.getRemainingTimeInMillis === "function") deadlineMs = context.getRemainingTimeInMillis();
  } catch (e) { /* не знаем — будет 9 секунд */ }
  // Подключаем хранилище Netlify Blobs (разговорник с исправлениями).
  try { require("@netlify/blobs").connectLambda(event); } catch (e) { /* хранилище недоступно — перевод всё равно работает */ }
  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { body = {}; }

  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(obj) {
        resolve({
          statusCode: this.statusCode,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(obj),
        });
      },
    };
    Promise.resolve(handler({ method: event.httpMethod, body, deadlineMs }, res)).catch((e) =>
      resolve({ statusCode: 500, body: JSON.stringify({ error: String(e && e.message || e) }) })
    );
  });
};
