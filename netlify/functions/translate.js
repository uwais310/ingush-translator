// Netlify: та же логика перевода, что в api/translate.js (для Vercel).
const handler = require("../../api/translate.js");

exports.handler = async (event) => {
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
    Promise.resolve(handler({ method: event.httpMethod, body }, res)).catch((e) =>
      resolve({ statusCode: 500, body: JSON.stringify({ error: String(e && e.message || e) }) })
    );
  });
};
