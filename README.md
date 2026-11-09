# Ингушский переводчик — сайт и приложение

Переводчик (ингушский, русский, английский и др.), который можно поставить на телефон как приложение.
Переводит через **Google Gemini — бесплатный ключ, без карты**. Ключ хранится на сервере Vercel, в браузер он не попадает.

```
index.html            сайт
api/translate.js      сервер: принимает текст, спрашивает ИИ, отдаёт перевод
manifest, sw.js, png  чтобы сайт ставился на телефон как приложение
```

## 1. Бесплатный ключ Gemini (1 минута)
1. Зайдите на **aistudio.google.com** и войдите через Google.
2. Нажмите **Get API key → Create API key**.
3. Скопируйте ключ (начинается на `AIza...`). Карта не нужна.

## 2а. Выложить на Netlify (бесплатно)
1. app.netlify.com → **Sign up** → **GitHub**.
2. **Add new project** → **Import an existing project** → **GitHub** → выберите `ingush-translator`.
3. Ничего не меняйте в настройках сборки. Откройте **Environment variables** → **Add** → Key `GEMINI_API_KEY`, Value — ваш ключ.
4. **Deploy**. Будет ссылка вида `https://ingush-translator.netlify.app`.

Если переменную добавили уже после первого деплоя: **Deploys → Trigger deploy → Deploy site**.

## 2б. Или на Vercel (бесплатно)
**С телефона, через GitHub:**
1. github.com → **+ → New repository** → название `ingush-translator` → **Create**.
2. **uploading an existing file** → все файлы, кроме папки `api` → **Commit changes**.
3. **Add file → Create new file** → имя `api/.keep` → **Commit** (появится папка `api`).
4. Откройте папку `api` → **Add file → Upload files** → `translate.js` → **Commit**.
5. vercel.com → **Sign Up → Continue with GitHub** → **Add New → Project** → **Import** `ingush-translator`.
6. **Environment Variables**: Key `GEMINI_API_KEY`, Value — ваш ключ → **Add** → **Deploy**.

**С компьютера:** `npx vercel` в папке проекта, потом ключ в Vercel → Settings → Environment Variables → Redeploy.

Через минуту будет ссылка вида `https://ingush-translator.vercel.app`.

## 3. Поставить на телефон как приложение
- **iPhone (Safari):** открыть сайт → «Поделиться» → «На экран Домой».
- **Android (Chrome):** ⋮ → «Установить приложение».

## Настройки (необязательно)
| Переменная | Что делает |
|---|---|
| `GEMINI_MODEL` | модель Gemini, по умолчанию `gemini-flash-latest` |
| `XAI_API_KEY` | использовать Grok вместо Gemini (платно; работает, только если нет `GEMINI_API_KEY`) |
| `XAI_MODEL` | модель Grok, по умолчанию `grok-4` |

## Если что-то не работает
- **«Check GEMINI_API_KEY»** — ключ скопирован не полностью или не добавлен в Vercel (после добавления нужен Redeploy).
- **«Check GEMINI_MODEL»** — Google переименовал модель: посмотрите актуальные названия в AI Studio и впишите в `GEMINI_MODEL`.
- **Ошибка 429** — закончился бесплатный дневной лимит Gemini, он обновится на следующий день.

## Важно
- Бесплатный лимит Gemini рассчитан на небольшое число переводов в день. Если сайтом начнёт пользоваться много людей, лимита перестанет хватать.
- На бесплатном тарифе Google может использовать тексты запросов для улучшения своих продуктов.
