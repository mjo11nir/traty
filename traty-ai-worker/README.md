# AI Worker для «Траты»

Отдельный Cloudflare Worker для подсказки категории по описанию и разбора фото чека. Он не меняет `traty-inbox` и не сохраняет отправленный текст или изображение.

## Маршруты

- `GET /api/ai/health` — проверка конфигурации и токена.
- `POST /api/ai/suggest` — описание траты → категория и теги.
- `POST /api/ai/receipt` — фото чека → поля черновика покупки.

Все запросы, кроме preflight `OPTIONS`, требуют `Authorization: Bearer <AI_ACCESS_TOKEN>`. Ключ Gemini хранится только в секретах Cloudflare как `GEMINI_API_KEY`.

## Секреты Cloudflare

Создайте отдельный Worker с именем `traty-ai`, вставьте `worker.js` в Quick Edit и добавьте секреты в Settings → Variables and Secrets:

- `GEMINI_API_KEY` — отдельный ключ Gemini API из Google AI Studio.
- `AI_ACCESS_TOKEN` — случайная строка не короче 32 символов, которую вы введёте также в раздел «ИИ» настроек PWA.

Подписка Gemini не выдаёт автоматически Gemini API кредит; AI Studio использует отдельные API-квоты и биллинг. Смотрите текущие [тарифы Gemini API](https://ai.google.dev/gemini-api/docs/pricing).

## Подключение PWA

В настройках PWA укажите URL Worker (`https://traty-ai.<ваш-субдомен>.workers.dev`) и тот же `AI_ACCESS_TOKEN`. PWA сохраняет эту настройку отдельно от экспортируемого JSON-резервного файла. Текст или фото отправляются только по нажатию AI-кнопки. Фото временно обрабатывается в браузере (JPEG/WebP, максимум 1600 px и 1.8 MB) и Worker не кладёт его в KV или журналы.

Ответ Gemini является подсказкой; пользователь проверяет и подтверждает поля в форме до сохранения покупки.
