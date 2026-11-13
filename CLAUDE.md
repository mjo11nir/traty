# Траты — правила работы с проектом

Личное PWA для учёта расходов. Владелец — не разработчик: общаться **по-русски, простыми словами**, без жаргона (а если термин нужен — объяснить его). Делать всё «как принято», не дожидаясь, пока попросят.

## Экономно: не тратить лимиты владельца

- **Не читать `index.html` целиком** (~5 400 строк). Найти нужное место по карте ниже (`grep -n "имяФункции"`) и читать только его (`sed -n 'A,Bp'`).
- **Проверки уже написаны** — `bash tests/run.sh` (или только нужные: `bash tests/run.sh app ai`). Не писать проверки заново; новую функцию — дописать проверкой в подходящий `tests/*.test.js`.
- **Выпуск версии** — навык `release` (`.claude/skills/release/SKILL.md`). Сервер — `bash scripts/deploy-worker.sh inbox|ai`.
- Если владелец пишет «без полной проверки» — достаточно `bash tests/run.sh` по затронутому набору, без скриншотов.
- Отвечать коротко: что сделано, что проверено, что сделать владельцу.

## Что где

| Файл | Что внутри |
|---|---|
| `index.html` | Всё приложение: разметка, стили, JS (разделы пронумерованы — см. карту) |
| `sw.js` | Service worker: офлайн-кэш, уведомления (push). `VERSION` управляет обновлением у пользователей |
| `manifest.json`, `icons/` | Установка на экран «Домой» |
| `inbox-worker/worker.js` | Сервер «Входящие» (Cloudflare Worker + KV): траты из Apple Pay/SMS, ключи, копии, уведомления |
| `traty-ai-worker/worker.js` | Сервер ИИ (Workers AI): чек, позиции чека, категории |
| `tests/` | Проверки: `run.sh`, `*.test.js`, копия сервера `servers/mock-inbox.mjs`. Скриншоты — `tests/out/` |
| `scripts/` | `deploy-worker.sh` (выкладка серверов), `bump-version.sh` (версия) |
| `README.md` | Инструкция для пользователя |
| `CHANGELOG.md` | Журнал версий — пополнять при каждом изменении |

Сайт публикуется через **GitHub Pages из ветки `main`**: всё, что попало в `main`, через 1–2 минуты у пользователя на телефоне. Сборки нет — файлы отдаются как есть.

## Карта `index.html` (искать по имени, номера строк «плывут»)

**Стили** (`<style>`): 1 токены тем (`:root`, `[data-theme="dark"]`) · 3 каркас, нижняя панель, `.fab` · 4 кнопки, поля, `.chip`, `.seg` · 5 главная `.hero`, `.banner`, `.tx` · 6 аналитика · 7 бюджеты, настройки `.row` · 8 листы `.sheet`, форма, тосты · далее блоки «Входящие», «Доходы, планы…», «облачная копия», «Анимации 1.7» · 9 `@keyframes`, адаптив.

**Скрипт** (`<script>`, разделы `/* ===… N. …`):
| Раздел | Что | Ключевые имена |
|---|---|---|
| 1 Константы | категории, валюты, даты, деньги | `DEFAULT_CATEGORIES`, `INCOME_CATEGORIES`, `DEFAULT_INBOX_URL`, `AI_URL`, `fmtMoney`, `parseNum`, `aiRequest`, `aiStream`, `parseItemLines`, `cleanItems`, `itemsHtml`, `compressReceipt` |
| 2 Хранилище | состояние, миграции, демо | `defaultState`, `migrate`, `seedDemo`, `Store`, `S()`, `afterCommit`, `makeExpense`, `getCat`, `catOf` |
| 3 Курсы | API курсов, кэш | `Rates`, `resolvePending` |
| 4 UI-ядро | листы, тосты, диалоги | `Sheet`, `toast`, `choiceSheet`, `confirmSheet` |
| 5 Фильтры | поиск, период | `Filters`, `matchFilters`, `matchIncomeFilters`, `Period` |
| 6 Экраны | главная, аналитика, бюджеты, настройки | `App`, `txRow`, `groupedList`, `renderHome`, `renderHero`, `renderBanners`, `renderAnalytics`, `incomeCardHtml`, `renderBudgets`, `renderSettings` |
| 7 Форма | покупка/доход, шаблоны | `openExpenseForm` (внутри: `applyReceipt`, `autoCategory`, `collect`), `deleteExpense`, `quickAddTemplate` |
| 8 Редакторы | категории, валюты, оплата | `openCategoryEditor`, `changeBaseCurrency` |
| 9 Экспорт/импорт | JSON, CSV | `exportJSON`, `parseBackupJSON`, `normalizeExpense`, `handleImportFile` |
| 9a Входящие | Apple Pay/SMS | `Inbox`, `normalizeInboxItem`, `parseMoney`, `openInboxSheet`, `openInboxSetupSheet` |
| 9b Анимации | | `countUp`, `confetti`, `slideIn`, `collapseOut`, `fabSuccess`, `SegThumb` |
| 9c Планы | цели, долги | `renderPlans`, `renderGoals`, `openGoalEditor`, `openGoalTopUp`, `renderDebts`, `openDebtEditor`, `openDebtSheet` |
| 9d Фраза | «кофе 120» | `parsePhrase`, `PHRASE_HINTS`, `submitPhrase` |
| 9e Итоги месяца | | `monthStats`, `openMonthSummary`, `summaryImage` |
| 9f Бюджет 80/100 % | | `BudgetAlerts` |
| 9g Фото чека | | `Receipt` |
| 9h Облачная копия | | `Backup`, `openBackupSheet`, `ensureConnected` |
| 9i Уведомления | | `Notify`, `openNotifySheet`, `handleLaunchUrl` |
| 10 PWA | тема, установка, SW | `applyTheme`, `openInstallSheet`, `maybeShowInstallHint`, `registerServiceWorker` |
| 11 Запуск | клики, init | `Actions` (все `data-action`), `bindStatic`, `init` |

## Как вносить любое изменение

1. **Ветка.** Работать в отдельной ветке от свежего `main`, не коммитить в `main` напрямую.
2. **Не ломать данные.** Данные пользователя живут только в `localStorage` телефона (`traty.data.v1`), потерять их нельзя:
   - новые поля — только с значениями по умолчанию в `defaultState()` **и** в `migrate()` (старые данные должны открываться без ошибок);
   - не переименовывать и не удалять существующие поля; если формат правда нужно поменять — миграция в `migrate()` и предупреждение владельцу;
   - проверить, что импорт/экспорт JSON (`exportJSON`, `parseBackupJSON`, `handleImportFile`) и облачная копия (`Backup.snapshot`) учитывают новые данные.
   - данные: `expenses` (необязательное поле `items` — позиции чека `[{ name, qty, price }]`), `incomes` (как покупки + `kind: 'income'`), `goals`, `debts`, `categories`, `templates`, `merchantRules`, `inbox`, `settings` (в т. ч. `inbox`, `backup`, `notify`), `meta`.
3. **Версия.** `bash scripts/bump-version.sh X.Y.Z` (меняет `APP_VERSION` в `index.html` и `VERSION` в `sw.js`). Без этого у пользователя не появится «Доступна новая версия». Мелкое исправление — третья цифра, новая функция — вторая. Изменения только в `tests/`, `scripts/`, документации — версию не поднимать.
4. **Проверка перед слиянием.** `bash tests/run.sh` — должно быть «ВСЁ ХОРОШО ✓». Для заметных изменений внешнего вида — посмотреть скриншоты в `tests/out/` (светлая/тёмная тема, iPhone SE). Ошибки в консоли недопустимы (проверки это ловят).
5. **Документация.** Запись в `CHANGELOG.md`; если меняется то, что видит пользователь, — `README.md`.
6. **Коммит, push, pull request** с понятным описанием на русском: что сделано, как проверено, что не проверено.
7. **Слияние.** Изменения, которые только добавляют новое и проверены, можно сливать (владелец согласен). Если изменение трогает формат данных, удаляет что-то или рискованно — сначала объяснить владельцу и спросить; перед слиянием напомнить сделать «Экспорт JSON».
8. **После слияния** — сказать владельцу: открыть приложение и нажать «Обновить».

Если что-то не удалось проверить (например, работу на реальном iPhone) — прямо сказать об этом.

## Серверы (Cloudflare)

- Аккаунт Cloudflare владельца. **Выкладка — только `bash scripts/deploy-worker.sh inbox|ai`**: сохраняет все ключи и привязки (`keep_bindings`) и проверяет живой сервер. Нужен API-токен (шаблон «Edit Cloudflare Workers»): попросить владельца создать и передать через защищённую форму, **никогда через чат**; в сети среды должны быть разрешены адреса серверов. После работы напомнить удалить токен.
- **«Входящие»** — воркер `traty-inbox`, адрес `https://traty-inbox.traty-758cef38.workers.dev` (`DEFAULT_INBOX_URL`), KV `traty-inbox` (привязка `INBOX`), секрет `TOKEN` — ключ владельца. У каждого пользователя свой ключ и своя очередь (`tx:<id>:…`), ключи выдаёт `POST /register`.
- Менять API только **совместимо**: уже настроенные команды на iPhone (`POST /tx?key=…`, `POST /batch?key=…`) должны продолжать работать.
- Уведомления: `VAPID_PRIVATE_JWK` (секрет), `VAPID_PUBLIC`, `PUSH_SUBJECT`, расписание `*/15 * * * *`. **Ключи VAPID нельзя менять** — подписки перестанут работать.
- Копии (`/backup`) зашифрованы в приложении; сервер не должен получать код восстановления.
- **ИИ** — воркер `traty-ai` (`AI_URL`): Cloudflare Workers AI (привязка `AI`, бесплатно, без внешних ключей), доступ по тем же личным ключам (`INBOX`, `TOKEN`), лимит 120 запросов/день на человека. Пользователь ничего не настраивает: **никаких полей для ключей и адресов в интерфейсе**. Чек: `/api/ai/receipt` (итог, ~8 с) + `/api/ai/receipt-items?stream=1` (позиции потоком, ~40 с).
- Перед выкладкой — `bash tests/run.sh workers` (поддельный KV, шифрование уведомлений проверяется библиотекой `http_ece`).

## Безопасность

- Никаких ключей, токенов и паролей в репозитории и в коммитах.
- Не просить владельца присылать секреты в чат.
