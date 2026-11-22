// Подпись ответа из примеров справочника (lib/base.js) не должна говорить «проверенная»: на сайте «проверено» значит
// «проверил носитель языка» (/review, исправления с сайта), а примеры справочника носители проекта не проверяли.
// Без ключей и без интернета.   node test/label-guide-phrase.test.js
delete process.env.USE_AI;
const assert = require("assert");
const KB = require("../lib/ingush-guide.js");
const BASE = require("../lib/base.js")(KB, require("../lib/corpus-lexicon.js"));
const [ru] = KB.EXAMPLES.find(([r]) => BASE.lookup(r, "ru", "inh") && BASE.lookup(r, "ru", "inh").kind === "phrase");
const r = BASE.lookup(ru, "ru", "inh");
assert.ok(!/провер/i.test(r.label), `«${ru}»: подпись «${r.label}» говорит «проверено», а носитель не проверял`);
assert.ok(/справочник/i.test(r.label), `«${ru}»: подпись «${r.label}» не говорит, откуда фраза`);
console.log(`ok: «${ru}» → «${r.label}»`);
console.log("Все проверки подписи фраз справочника прошли.");
