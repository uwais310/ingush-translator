// Скачивает пары «ингушский — русский» с сайта PaydaDosh (paydadosh.ru) в data/sources/paydadosh.json.
// Владельцы PaydaDosh дали разрешение на использование (см. SOURCES.md).
// Запуск: node scripts/fetch-paydadosh.js            (Node 18+, ничего устанавливать не нужно)
//         node scripts/fetch-paydadosh.js --no-words (только разговорник и пословицы, ~5 минут)
//
// Вежливо: не больше 1 запроса в секунду, только страницы, открытые для поисковиков (robots.txt:
// /api/, /poisk, /razbor и т. п. не трогаем). Скачанные страницы лежат в .cache-sources/paydadosh/ —
// повторный запуск их не скачивает заново (удалите папку, чтобы обновить).
// Что берём:
//   1. Разговорник /phrasebook — все разделы и «Переводы носителей» (PDFR), постранично;
//   2. Пословицы /proverbs (сборник Дахкильгова, 2000);
//   3. Словарь по алфавиту /browse?letter=… — слово и первые значения, плюс примеры [ ингушский — русский ].
// Ничего не переводим и не придумываем: только текст со страниц. Чистка (палочка, дубли, проверка слов
// по ингушским текстам, чеченские формы) — в scripts/build-phrases.js, как для других источников.

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, ".cache-sources", "paydadosh");
const OUT = path.join(ROOT, "data", "sources", "paydadosh.json");
const BASE_URL = "https://paydadosh.ru";
const UA = "ingush-translator-import/1.0 (+https://github.com/uwais310/ingush-translator; with permission of PaydaDosh owners)";
const MIN_GAP_MS = 1100; // ≤ 1 запрос в секунду
const WITH_WORDS = !process.argv.includes("--no-words");
const MAX_SENSES = 3;

fs.mkdirSync(CACHE, { recursive: true });
let lastAt = 0, requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheFile = (p) => path.join(CACHE, encodeURIComponent(p).replace(/%/g, "_").slice(0, 200) + ".html");

async function get(p) {
  const f = cacheFile(p);
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  for (let attempt = 1; ; attempt++) {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now(); requests++;
    let res;
    try { res = await fetch(BASE_URL + p, { headers: { "User-Agent": UA, "Accept": "text/html" } }); }
    catch (e) { res = { status: 0, statusText: e.message }; }
    if (res.status === 200) { const t = await res.text(); fs.writeFileSync(f, t); return t; }
    if (res.status === 403 || res.status === 401) throw new Error(`Сайт отказал в доступе (${res.status}) на ${p} — останавливаемся.`);
    if (res.status === 404) return "";
    if (attempt >= 4) throw new Error(`Не скачалось ${p}: ${res.status} ${res.statusText || ""}`);
    const back = res.status === 429 ? 30000 * attempt : 5000 * attempt;
    console.warn(`  ${p}: ${res.status}, жду ${back / 1000} с`);
    await sleep(back);
  }
}

const decode = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const clean = (s) => decode(s).replace(/[\u00ad\u200b]/g, "").replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
const maxPage = (html, re) => Math.max(1, ...[...html.matchAll(re)].map((m) => +m[1]));

const pairs = [], seen = new Set(), stats = {};
function push(kind, inh, ru, note, from) {
  inh = clean(inh).replace(/\s+/g, " "); ru = clean(ru).replace(/\s+/g, " ").replace(/^«|»$/g, "").replace(/^\d+\s*\)\s*/, "").trim();
  if (!inh || !ru || inh.length > 300 || ru.length > 300) return;
  const k = `${kind}|${inh}|${ru}`;
  if (seen.has(k)) return;
  seen.add(k);
  const p = { kind, ru, inh };
  if (note) p.note = clean(note).replace(/\s+/g, " ");
  pairs.push(p);
  stats[from] = (stats[from] || 0) + 1;
}

// строки разговорника и пословиц: <div class="pd-row …"> … <a href="/phrase/…">ингушский</a> … «русский» … biblio-tag
const SECTION = {
  PDFR: "переводы носителей", lesson_phrase: "уроки", everyday_phrase: "ситуации", lovca: "обряды и праздники",
  religious_phrase: "обряды и праздники", celebration_phrase: "обряды и праздники", tradition_phrase: "обряды и праздники",
  condolence_phrase: "обряды и праздники", ramadan_phrase: "обряды и праздники", meal_phrase: "ситуации",
  idiom_phrase: "выражения", article_phrase: "фразы из статей словаря", proverbs: "пословицы",
};
function parseRows(html, from, section = "") {
  let n = 0;
  for (const chunk of html.split(/<div class="pd-row[ "]/).slice(1)) {
    const a = /<a href="\/(?:phrase|proverb)\/[^"]+"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    const r = /<div class="mt-[\d.]+ font-academic-serif italic[^"]*"[^>]*>\s*«([\s\S]*?)»\s*<\/div>/.exec(chunk);
    if (!a || !r) continue;
    const tag = /<span\s+class="biblio-tag"[^>]*>([^<]+)<\/span>/.exec(chunk);
    // пометка: раздел сайта и источник фразы, например «PaydaDosh, разговорник: уроки (УРОКИ)»
    push("phrase", a[1], r[1], `PaydaDosh, ${section || from}` + (tag ? ` (${clean(tag[1])})` : ""), from);
    n++;
  }
  return n;
}

// «а {~но} (~наш) (д, д)» → слово «а» и грамматика «~но, ~наш; д, д»
function headword(raw) {
  const t = clean(raw);
  const gram = [...t.matchAll(/[{(]([^{}()]*)[})]/g)].map((m) => m[1].trim()).filter(Boolean);
  const w = t.replace(/\{[^{}]*\}|\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  return { w, gram: gram.join("; ") };
}
const INH_ONLY = /[Ӏӏ]|аь|оа|уо|яь|юь|кх|къ|хь|гӀ/i; // признаки ингушского толкования, а не русского
function parseBrowse(html) {
  let n = 0;
  for (const m of html.matchAll(/<a href="\/word\/\d+[^"]*" class="group block">\s*<span[^>]*>([\s\S]*?)<\/span>\s*(?:<p[^>]*>([\s\S]*?)<\/p>)?/g)) {
    const { w, gram } = headword(m[1]);
    if (!w || /^-|-$/.test(w) || /^[А-ЯӀ]{1,2}$/.test(w) || !m[2]) continue;
    n++;
    const lines = decode(m[2]).split("\n").map((x) => x.trim()).filter(Boolean);
    let senses = 0;
    for (const line of lines) {
      // примеры [ Укх шера — В этом году ]
      for (const ex of line.matchAll(/\[([^\]]+)\]/g)) {
        for (const part of ex[1].split(/;\s*(?=[^;]+—)/)) {
          const two = part.split(/\s+—\s+/);
          if (two.length === 2 && !INH_ONLY.test(two[1]) && !/[a-z]/i.test(two[1])) push("phrase", two[0], two[1], `PaydaDosh, пример к слову «${w}»`, "словарь: примеры");
        }
      }
      if (senses >= MAX_SENSES) continue;
      const body = line.replace(/\[[^\]]*\]/g, " ").replace(/^\s*\d+\s*[).]\s*/, "").trim(); // «1) отозвать…» → «отозвать…»
      if (!body || /^[-–—]|^см\.|^то же/i.test(body) || INH_ONLY.test(body)) continue;
      const note = [...body.matchAll(/\(([^()]*)\)/g)].map((x) => x[1].trim()).filter(Boolean);
      const ru = body.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").replace(/[;,.:]+$/, "").trim();
      if (!ru || ru.length > 80 || !/[а-яё]/i.test(ru) || /[a-z]/i.test(ru)) continue; // «экспорт — export»: двуязычные толкования не берём
      const notes = note.filter((x) => !/[a-z]/i.test(x)); // английские пометки («This.») — мимо
      // «КӀомал» — «конопля»: заглавная только из-за начала статьи
      const inh = /^[А-ЯЁӀ][а-яёӏӀ]/.test(w) && /^[а-яё]/.test(ru) && !/^[А-ЯЁ]{2}/.test(w) ? w[0].toLowerCase() + w.slice(1) : w;
      push("word", inh.replace(/^ӏ/, "Ӏ"), ru, [gram, notes.join("; ")].filter(Boolean).join(" · "), "словарь: слова");
      senses++;
    }
  }
  return n;
}

(async () => {
  const t0 = Date.now();
  console.log("PaydaDosh: разговорник…");
  const front = await get("/phrasebook");
  const cats = [...new Set([...front.matchAll(/href="\/phrasebook\?category=([a-z_]+)["#&]/g)].map((m) => m[1]))];
  // сначала самые бытовые разделы: при повторе фраза получает пометку первого раздела
  const first3 = ["/phrasebook?source=PDFR", "/phrasebook?category=lesson_phrase", "/phrasebook?category=everyday_phrase"];
  const lists = [...first3, ...cats.map((c) => `/phrasebook?category=${c}`).filter((l) => !first3.includes(l))];
  for (const l of lists) {
    const first = await get(l);
    const last = maxPage(first, /[?&](?:amp;)?page=(\d+)/g);
    const sec = "разговорник: " + (SECTION[l.split("=")[1]] || "другое");
    let rows = parseRows(first, "разговорник", sec);
    for (let p = 2; p <= last; p++) rows += parseRows(await get(`${l}&page=${p}`), "разговорник", sec);
    console.log(`  ${l}: страниц ${last}, строк ${rows}`);
  }
  console.log("PaydaDosh: пословицы…");
  const pv = await get("/proverbs");
  const pvLast = maxPage(pv, /\/proverbs\?page=(\d+)/g);
  let pvRows = parseRows(pv, "пословицы");
  for (let p = 2; p <= pvLast; p++) pvRows += parseRows(await get(`/proverbs?page=${p}`), "пословицы");
  console.log(`  страниц ${pvLast}, пословиц ${pvRows}`);

  if (WITH_WORDS) {
    console.log("PaydaDosh: словарь по алфавиту (около 1 300 страниц, ~25 минут при первом запуске)…");
    const br = await get("/browse");
    const letters = [...new Set([...br.matchAll(/href="\/browse\?letter=([^"&#]+)"/g)].map((m) => m[1]))];
    for (const L of letters) {
      const first = await get(`/browse?letter=${L}`);
      const last = maxPage(first, /letter=[^"&]*&(?:amp;)?page=(\d+)/g);
      let words = parseBrowse(first);
      for (let p = 2; p <= last; p++) words += parseBrowse(await get(`/browse?letter=${L}&page=${p}`));
      console.log(`  ${decodeURIComponent(L)}: страниц ${last}, слов ${words}`);
    }
  }

  const out = {
    source: "PaydaDosh",
    license: "разрешение владельцев PaydaDosh", // не открытая лицензия: без их согласия базу не распространять (SOURCES.md)
    url: "https://paydadosh.ru (разговорник /phrasebook, пословицы /proverbs, словарь /browse)",
    note: "Ингушский текст и русский перевод — как на сайте PaydaDosh. verified: false — проверяет носитель на /review.",
    fetched: new Date().toISOString().slice(0, 10),
    pairs,
  };
  fs.writeFileSync(OUT, "{\n" + Object.entries(out).filter(([k]) => k !== "pairs").map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")
    + '\n"pairs": [\n' + pairs.map((p) => JSON.stringify(p)).join(",\n") + "\n]\n}\n");
  console.log(`Готово: ${pairs.length} пар →`, path.relative(ROOT, OUT), stats, `запросов к сайту: ${requests}, ${Math.round((Date.now() - t0) / 1000)} с`);
})().catch((e) => { console.error(e.message); process.exit(1); });
