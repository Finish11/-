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
| `src/types.ts` | общие типы |

## Демо-слой

| Файл | Роль |
|---|---|
| `src/demo/localApi.ts` | мок-сервер: перехват `window.fetch` для `/api/*` |
| `src/demo/bundle-data.json` | снимок данных для демо (75 сайтов, 5 замеров, 8 инцидентов) |

## Инфраструктура

| Файл | Роль |
|---|---|
| `.github/workflows/ci.yml` | typecheck + build + build:demo на каждый push |
| `.github/workflows/deploy-demo-pages.yml` | публикация демо на GitHub Pages |
| `Dockerfile`, `docker-compose.yml` | прод-образ и запуск с томом для SQLite |
| `.env.example` | `PORT`, `NODE_ENV`, `DATA_DIR` |

## Проверки

`npm run typecheck` · `npm run build` · `npm run build:demo` — все три должны быть зелёными.

Проверка API вручную:

```bash
curl -s -X POST localhost:3000/api/auth/demo -c /tmp/ck.txt | head -c 200
curl -s -b /tmp/ck.txt localhost:3000/api/sites | head -c 200
curl -s -b /tmp/ck.txt localhost:3000/api/sample-subscription | head -c 80
```
