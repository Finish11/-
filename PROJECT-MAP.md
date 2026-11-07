# Карта проекта

**ПульсСети** — анти-шатдаун и VPN-радар. Что где лежит.

## Точки входа

| Файл | Роль |
|---|---|
| `server/index.ts` | Express: все `/api/*`, cookie-сессии, раздача Vite/`dist` |
| `src/main.tsx` | вход полной версии (React 18, createRoot) |
| `src/main.demo.tsx` | вход автономной демо-сборки: сначала `src/demo/localApi.ts`, затем App |
| `index.html` / `demo.html` | HTML-шаблоны для `vite build` и демо-сборки |
| `scripts/seed-db.ts` | `data/seed.db` → `data/pulsenet.db` |

## Сервер

| Файл | Роль |
|---|---|
| `server/db.ts` | схема SQLite, `DEFAULT_SITES` (75), сид демо-замеров/профилей/инцидентов |
| `server/auth.ts` | scrypt-хеши, cookie-сессии, `requireAuth` |
| `server/networkProbe.ts` | инспекция соединения, `/api/net/probe`, TCP-пинг, `mapLimit` |
| `server/subscription.ts` | парсер подписок: VLESS/Reality, VMess, Trojan, SS, Hysteria2, WG, Clash |
| `server/vpnRoutes.ts` | подписки, узлы, импорт, QR, пинг |
| `server/communityStore.ts` | SQLite-адаптер общего API и миграция старых community-отчётов |
| `community/handler.ts` | единый HTTP-handler Express/SQLite и Worker/D1 |
| `community/contract.ts` | валидация, курсор, публичная проекция без секретов |
| `community/worker.ts` | Cloudflare Worker entrypoint + D1 adapter |
| `community/migrations/` | схема D1/SQLite: отчёты, голоса, tombstones, rate limits |

## Фронтенд

| Файл | Роль |
|---|---|
| `src/App.tsx` | бутстрап, вкладки, состояние сессии |
| `src/components/Layout.tsx` | сайдбар, нижняя навигация, тема, демо-баннер |
| `src/components/ScannerView.tsx` | главный экран: кнопка, VPN-детект, вердикт, группы |
| `src/components/SitesView.tsx` | каталог сайтов, CRUD, пинг, фильтры |
| `src/components/VpnMonitorView.tsx` | VPN-клиент: подписки, узлы, QR, импорт |
| `src/components/IncidentsView.tsx` | сбои и белые списки по регионам |
| `src/components/HistoryView.tsx` | история замеров и график разрыва |
| `src/components/AuthView.tsx` | вход, регистрация, демо-вход |
| `src/lib/scanner.ts` | пробники, правила вердикта, демо-симуляции |
| `src/lib/api.ts` | `apiFetch` + цепочка токена |
| `src/lib/quickPicks.ts` | каталог «быстрого выбора»: AI-чаты, мессенджеры, YouTube, игры |
| `src/lib/subscriptionParser.ts` | общий парсер подписок (сервер + APK), без Node-зависимостей |
| `src/lib/nativeBridge.ts` | нативный HTTP (CapacitorHttp), TLS-проба узла, mapLimit |
| `src/lib/appUpdate.ts` | проверка версии на GitHub Releases + плагин ApkUpdater |
| `src/components/QuickPicks.tsx` | блок быстрого выбора на главном экране |
| `src/components/UpdateCard.tsx` | карточка обновления: версия, прогресс, установка |
| `src/types.ts` | общие типы |

## Демо-слой

| Файл | Роль |
|---|---|
| `src/demo/localApi.ts` | мок-сервер: перехват `window.fetch` для `/api/*` |
| `src/demo/realSubscription.ts` | настоящая загрузка подписки в APK (нативный HTTP) |
| `src/demo/bundle-data.json` | снимок данных для демо (75 сайтов, 5 замеров, 8 инцидентов) |
| `src/lib/speedTest.ts` | чистая методика замера: срезы, отбрасывание, потолок, сравнение конфигов |
| `src/lib/speedRunner.ts` | оркестратор фаз и транспорты (нативный стриминг / fetch+XHR) |
| `src/lib/speedEndpoints.ts` | выбор сервера замера: свой → общий → Cloudflare |
| `src/components/SpeedTestView.tsx` | вкладка «Скорость»: шкала, результат, история, сравнение |
| `src/lib/incidentShare.ts` | обмен отчётами пакетом и ссылка-приглашение на общий сервер |
| `docs/diagnostics.md` | что означает каждая цифра и что Android измерить не может |

## Инфраструктура

| Файл | Роль |
|---|---|
| `.github/workflows/ci.yml` | typecheck + core/regressions/sync/worker + audit + build + demo + e2e |
| `.github/workflows/deploy-community.yml` | ручной деплой Workers + D1 с секретами владельца |
| `scripts/deploy-community.mjs` | create/reuse D1, migrations, deploy, health-check |
| `playwright.config.ts`, `tests/e2e/` | mobile/desktop smoke через bundled Chromium |
| `tests/sync-hardening.test.ts` | outbox: доводящий PATCH, защита ключа, очередь по серверу, счётчик id |
| `tests/community-quota.test.ts` | суточные квоты устройства/IP, окна очистки лимитов, `TRUST_PROXY` |
| `tests/native-contract.test.ts` | каждый метод моста реализован в Java, плагины зарегистрированы, манифест полон |
| `tests/speed-test.test.ts` | методика Ookla: срезы, разгон, джиттер, потолок канала, сравнение конфигов |
| `tests/speed-endpoints.test.ts` | реальные HTTP-точки замера на Express и в Worker/D1 |
| `tests/routes-and-sharing.test.ts` | раздельный туннель, отзывы по узлу, автоопределение, обмен отчётами |
| `tests/e2e/speed-and-confirmations.spec.ts` | сквозные сценарии: замер, подтверждение на узле, импорт пакета |
| `server/speed.ts` | точки `/api/speed/ping\|down\|up` с лимитами по IP |
| `android/.../NetworkProbePlugin.java` | HTTP-проба, TCP мимо VPN, реальная задержка, фазы замера скорости |
| `android/.../NetUtil.java` | сети Android: физическая сеть под VPN, владелец VPN, always-on |
| `.github/workflows/deploy-demo-pages.yml` | публикация демо на GitHub Pages |
| `.github/workflows/android-apk.yml` | сборка debug APK на раннере: артефакт + публикация в Releases (тег `android-latest`) |
| `capacitor.config.ts` | Capacitor: `appId`, `appName`, `webDir: demo-dist`, `server.url` для боевого режима |
| `android/` | нативный Android-проект (Capacitor): тема, иконки, сплэш, gradle |
| `android/.../ApkUpdaterPlugin.java` | скачивание APK через DownloadManager + установщик |
| `scripts/android-assets.mjs` | `demo-dist/demo.html` → `index.html` для Capacitor |
| `scripts/generate-android-assets.sh` | иконки и сплэш из фирменного стиля (ImageMagick 6) |
| `Dockerfile`, `docker-compose.yml` | прод-образ и запуск с томом для SQLite |
| `.env.example` | `PORT`, `NODE_ENV`, `DATA_DIR`, `TRUST_PROXY` |
| `server/proxyTrust.ts` | разбор `TRUST_PROXY`: `X-Forwarded-For` только от доверенного прокси |

## Проверки

`npm run typecheck` · `npm run typecheck:community` · `npm run test:core` ·
`npm run test:regressions` · `npm run test:sync` · `npm run test:native` ·
`npm run test:speed` · `npm run test:routes` · `npm run test:worker` · `npm run build` ·
`npm run build:demo` · `npm run test:e2e` — должны быть зелёными.
`npm audit --omit=dev` не должен находить известных уязвимостей.

Android: `npm run android:sync` (без SDK) → `npm run apk:debug` (нужны JDK 21 и Android SDK).
APK в CI собирает `.github/workflows/android-apk.yml`.

Проверка API вручную:

```bash
curl -s -X POST localhost:3000/api/auth/demo -c /tmp/ck.txt | head -c 200
curl -s -b /tmp/ck.txt localhost:3000/api/sites | head -c 200
curl -s -b /tmp/ck.txt localhost:3000/api/sample-subscription | head -c 80
```
