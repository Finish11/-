# ПульсСети — анти-шатдаун и VPN-радар

Полностековое веб-приложение (русский интерфейс, mobile-first), которое проверяет,
включены ли **белые списки** мобильного интернета в РФ, работает ли **ТСПУ/DPI** и не
идёт ли **глушение сети**, а также ведёт **мониторинг VPN-подписок и узлов**.

> Это учебно-демонстрационный проект: диагноз строится по доступности набора сайтов,
> он не является официальным источником и не заменяет измерения оператора.

---

## Что умеет

**Главный экран (мобильный сценарий)**
- Одна большая кнопка «Проверить сеть»: определяет сеть/оператора/ASN, наличие VPN,
  прогоняет 75 сайтов и выдаёт вердикт.
- Если обнаружен VPN — предупреждает и предлагает либо выключить VPN и перепроверить
  доступ по сотовой сети, либо продолжить проверку через туннель.
- Вердикты: `WHITELIST_ACTIVE` (есть белые списки), `DPI_THROTTLING` (ТСПУ),
  `TOTAL_JAMMING` (глушение/шатдаун), `SEVERE_RESTRICTIONS`, `OPEN_INTERNET`.
- Детализация по 6 группам сайтов + разбор каждого домена, заметка к замеру,
  экспорт отчёта для Telegram.
- Пресеты для демонстрации: «Живая сеть», «Белые списки», «С VPN», «ТСПУ», «Глушение».

**Каталог сайтов (CRUD)**
- 75 ресурсов с ролями `ru_whitelist` (24), `global_neutral` (24), `dpi_target` (27).
- Добавление/правка/удаление, включение-выключение, одиночный пинг, сброс к базе.
- Фильтры по статусу и категории, поиск по названию и домену.

**VPN-клиент (как Hiddify / v2rayNG / Streisand)**
- Подписки (subscription URL): добавление, обновление, удаление, автоапдейт по часам.
- Импорт одиночных ссылок и base64-подписок: VLESS/Reality, VMess, Trojan,
  Shadowsocks, Hysteria2, TUCI, WireGuard, Clash YAML.
- Узлы: протокол, локация и флаг, хост:порт, пинг по TCP, статус online/degraded/blocked,
  трафик и срок действия подписки, основной узел, RU-каскад, QR для переноса на телефон.
- Демо-подписка из 8 узлов одним кликом.

**Сбои и белые списки**
- Лента инцидентов по регионам/операторам: тип (белые списки, шатдаун, ТСПУ),
  подтверждения «У меня так же», фильтры, CRUD своих отчётов.

**История замеров**
- График «разрыва связи» (доля доступных сайтов РФ vs нейтральных), 5 сеяных замеров,
  раскрытие деталей по каждому замеру, заметки, переименование, удаление.

**Платформенное**
- Аутентификация: email+пароль (scrypt), cookie-сессия, демо-вход, регистрация.
- SQLite (better-sqlite3) + WAL, сид-данные.
- Единый дизайн: тёмная/светлая тема, адаптивная сетка, нижняя навигация на телефоне,
  скелетоны/пустые состояния, оптимистичные обновления, тосты.
- Автономная демо-сборка в **один HTML** (без сервера) — для показа по ссылке.

---

## Стек

| Слой | Технологии |
|---|---|
| Фронтенд | React 18, TypeScript, Vite 5, Tailwind CSS 3, lucide-react, qrcode.react |
| Бэкенд | Node 20, Express 4, TypeScript (tsx), cookie-parser |
| БД | SQLite через better-sqlite3, режим WAL, миграции в коде |
| Диагностика | fetch-пробы из браузера + серверный релей `/api/net/probe`, TCP-пинг узлов, DNS-кэш, `mapLimit` |
| Сборка демо | vite-plugin-singlefile → один самодостаточный HTML |

---

## Быстрый старт

```bash
git clone https://github.com/Finish11/-.git pulsenet   # URL работает и после переименования репозитория
cd pulsenet
npm ci

cp .env.example .env        # опционально
npm run db:seed             # data/pulsenet.db из data/seed.db
npm run dev                 # http://localhost:3000
```

Демо-вход: кнопка «Войти в демо» или `demo@pulsenet.ru` / `demo1234`.

### Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | сервер Express + Vite в middleware-режиме, порт 3000 |
| `npm run build` | сборка фронтенда в `dist/` |
| `npm start` | продакшн-режим: раздаёт `dist/` + API |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:seed` | создаёт рабочую базу из `data/seed.db` (`-- --force` перезаписать) |
| `npm run build:demo` | автономный `demo-standalone.html` (один файл, без сети) |
| `npm run preview:demo` | локальная раздача демо-файла на :4173 |
| `npm run android:sync` | демо-сборка + перенос в Android-проект (`demo-dist` → `android/`) |
| `npm run apk:debug` | собрать debug APK локально (нужны JDK 21 и Android SDK) |
| `npm run android:open` | открыть проект в Android Studio |

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | порт HTTP-сервера |
| `NODE_ENV` | `development` | `production` — раздавать `dist/` вместо Vite-middleware |
| `DATA_DIR` | `./data` | каталог с `pulsenet.db` |

---

## Деплой

**Docker (рекомендуется для полной версии)**

```bash
docker compose up -d --build
# приложение на http://localhost:3000, база в томе pulsenet-data
```

**Любой Node-хостинг (Railway, Render, Fly.io, VPS)**

1. Build: `npm ci && npm run build`
2. Start: `npm run db:seed && npm start`
3. Смонтируйте постоянный диск и укажите `DATA_DIR` на него — иначе SQLite обнулится
   при каждом деплое.

**GitHub Pages (только демо, без сервера)**

Workflow `.github/workflows/deploy-demo-pages.yml` собирает `demo-standalone.html` и
публикует как `index.html`. В настройках репозитория: *Settings → Pages → Source:
GitHub Actions*. Получите статичную ссылку вида
`https://finish11.github.io/<имя-репозитория>/` — по ней работает вся вёрстка и мок-API.

CI `.github/workflows/ci.yml` на каждый push проверяет типы, собирает прод и демо,
выкладывает `demo-standalone.html` артефактом.

---

## Android (APK)

Приложение упаковано в нативный APK через **Capacitor 8**: внутри — автономная
демо-сборка (`demo-standalone.html`), поэтому APK работает без сети и без бэкенда.
Размер ~5 МБ, `minSdk 24` (Android 7.0+), `targetSdk 36`.

**Взять готовый APK:** вкладка *Actions* → workflow **Android APK** → нужный запуск →
раздел *Artifacts* → `pulsenet-debug-apk`. Внутри — `pulsenet-<sha>-debug.apk`.
Сборка на раннере использует предустановленный Android SDK, локально ничего ставить не нужно.

**Установка на телефон:** скачайте и откройте `.apk` на устройстве, разрешите установку
из этого источника (*Настройки → Приложения → Установка неизвестных приложений*).
APK подписан отладочным ключом — для внутреннего тестирования этого достаточно,
для RuStore/Google Play нужен release-ключ (ниже).

**Локальная сборка** (нужны JDK 21 и Android SDK; проще всего через Android Studio):

```bash
npm ci
npm run apk:debug          # → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open       # или открыть проект в Android Studio и нажать Run
```

**Подключить APK к реальному серверу.** По умолчанию WebView открывает встроенные
ассеты (демо-режим, мок-API). Чтобы APK стал полноценным клиентом, задеплойте бэкенд
по HTTPS и раскомментируйте `server.url` в `capacitor.config.ts`:

```ts
server: {
  androidScheme: 'https',
  url: 'https://ваш-домен.ru',
},
```

затем снова `npm run apk:debug`. Тогда работают настоящие замеры, аккаунты и VPN-подписки.

**Release-сборка со своим ключом** (секреты не коммитятся):

```bash
keytool -genkeypair -v -keystore pulsenet-release.jks -alias pulsenet \
  -keyalg RSA -keysize 2048 -validity 10000
```

Пароли и файл ключа положите в GitHub Secrets
(`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`)
и передайте их в `android/app/build.gradle` через `signingConfigs` — либо соберите
`./gradlew assembleRelease` локально и подпишите через Android Studio
(*Build → Generate Signed Bundle / APK*).

**Чего в APK нет:** фоновых замеров по расписанию, push-уведомлений и настоящего
VPN-туннеля (`VpnService`) — это пункты роадмапа. Все замеры в APK сейчас
симулированные, экран помечен как демо.

---

## Структура

```
server/
  index.ts          Express-приложение, все /api-роуты, раздача фронтенда
  db.ts             схема SQLite, каталог из 75 сайтов, сид демо-замеров и профилей
  auth.ts           scrypt-хеши, cookie-сессии, requireAuth
  networkProbe.ts   инспекция соединения, серверный релей проб, TCP-пинг с mapLimit
  subscription.ts   парсеры подписок и ссылок (VLESS/VMess/Trojan/SS/Hysteria2/WG/Clash)
  vpnRoutes.ts      CRUD подписок и узлов, импорт, QR, пинг
src/
  App.tsx           загрузка бутстрапа, роутинг по вкладкам
  components/       Layout, ScannerView, SitesView, VpnMonitorView, IncidentsView,
                    HistoryView, AuthView, Toast
  lib/scanner.ts    пробники, диагностика вердикта, демо-симуляции
  lib/api.ts        apiFetch + цепочка токена (cookie → localStorage → bootstrap)
  types.ts          общие типы
  demo/localApi.ts  мок-сервер для автономной сборки (перехватывает window.fetch)
  demo/bundle-data.json  снимок БД для демо
scripts/
  seed-db.ts        копирование seed.db → рабочая база
```

### API (кратко)

```
POST /api/auth/register | /login | /demo | /logout
GET  /api/auth/me          PATCH /api/auth/profile

GET/POST /api/sites        PATCH|DELETE /api/sites/:id     POST /api/sites/reset
GET/POST /api/scans        PATCH|DELETE /api/scans/:id
GET/POST /api/vpn-subscriptions   PATCH|DELETE /api/vpn-subscriptions/:id
GET/POST /api/vpn-profiles PATCH|DELETE /api/vpn-profiles/:id
POST /api/vpn-profiles/import   POST /api/vpn-profiles/check-all
GET  /api/vpn-profiles/:id/qr   POST /api/vpn-profiles/:id/ping
GET/POST /api/incidents    PATCH|DELETE /api/incidents/:id  POST /api/incidents/:id/upvote

POST /api/network/inspect  — IP, страна, оператор, ASN, признаки VPN по эвристикам
POST /api/net/probe        — серверный релей замера { url } → latency/status
GET  /api/sample-subscription — демо-подписка (8 узлов, base64 + заголовки userinfo)
```

---

## Как считается вердикт

1. Берётся включённый каталог, сайты делятся на три роли:
   `ru_whitelist`, `global_neutral`, `dpi_target`.
2. Каждый домен пробуется из браузера (fetch/img с таймаутом), при блокировке —
   через серверный релей. Сайт считается живым, если ответ получен быстрее порога.
3. Считаются проценты доступа по каждой группе → `ru_ok_pct`, `global_ok_pct`, `dpi_ok_pct`.
4. Правила:
   - `ru_ok ≥ 45%` и `global_ok ≤ 40%` и VPN выключен → **WHITELIST_ACTIVE**;
   - `ru_ok < 45%` и `global_ok < 30%` → **TOTAL_JAMMING**;
   - нейтральные открыты, но `dpi_ok` низкий/пинги растут → **DPI_THROTTLING**;
   - часть зарубежных подсетей отваливается → **SEVERE_RESTRICTIONS**;
   - иначе → **OPEN_INTERNET**.
5. Порог «блокировки» узла VPN: DNS-фейл, успех < 50% или средний пинг > 900 мс;
   «замедлен»: средний > 320 мс или худший > 2.5× среднего.

---

## Известные ограничения / что можно улучшить

- [ ] Пробники в браузере ограничены CORS и таймаутами — часть сайтов нужно мерить
      только серверным релеем (сейчас есть фолбэк, но нет пула региональных релеев).
- [ ] Нет автоматического планировщика фоновых замеров (cron) — замеры только по кнопке.
- [ ] Нет push/Telegram-уведомлений о смене вердикта.
- [ ] Инциденты не модерируются и не дедуплицируются по гео.
- [ ] Нет e2e-тестов (проверялось вручную через headless Chromium).
- [ ] Сессии живут в SQLite; для нескольких инстансов нужен внешний стор (Redis).
- [ ] Каталог сайтов статичен в коде (`DEFAULT_SITES`) — редактируется только в UI.

---

## Лицензия

MIT — см. [LICENSE](LICENSE).

---

## Disclaimer

Проект создан как учебный и диагностический инструмент. Оценка «белые списки»,
«ТСПУ» или «шатдаун» строится на доступности набора сайтов с конкретного устройства и
оператора в конкретный момент: локальные сбои, CORS-ограничения браузера, кэш DNS и
особенности тарифа могут влиять на результат. Проект не связан с операторами связи и
государственными органами, не является официальным источником информации о блокировках
и не призывает к нарушению законодательства. Данные о статусах сайтов в каталоге
актуальны на ноябрь 2026 года — перед использованием в продакшене перепроверяйте их
по первоисточникам.
