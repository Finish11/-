# Общий API «Сбоев»

Один контракт работает в двух средах:

- Express + SQLite: `server/communityStore.ts`;
- Cloudflare Worker + D1: `community/worker.ts`.

Общий код: `community/handler.ts`, `community/contract.ts`, `community/store.ts`.
Схема: `community/migrations/0001_community.sql`.

## Endpoint

- `GET /api/community/health`
- `GET /api/community/incidents?limit=1..200&cursor=…`
- `POST /api/community/incidents`
- `PATCH /api/community/incidents/:clientId`
- `DELETE /api/community/incidents/:clientId`
- `PUT /api/community/incidents/:clientId/vote` body `{ "voted": true|false }`
- `POST /api/community/incidents/:clientId/upvote` — legacy toggle для старых APK

Заголовки устройства: `X-Device-Id` (UUID v4 или legacy hex32), `X-Device-Secret`
(64 hex). Сервер хранит только SHA-256 от `deviceId:secret`, не сам секрет.
Публичный ответ не содержит `device_hash`.

## Гарантии

- `client_id` идемпотентен: повторный POST не создаёт дубль и не меняет чужой отчёт.
  Если ответ на первый POST потерялся, а пользователь уже успел отредактировать отчёт,
  клиент после идемпотентного ответа доводит правку отдельным PATCH — старая серверная
  копия не перетирает свежую локальную.
- PATCH/DELETE разрешены только устройству-владельцу.
- DELETE оставляет tombstone: повторный POST того же `client_id` получает 410.
- PUT vote идемпотентен; количество голосов пересчитывается из таблицы голосов.
- Лента имеет стабильный курсор `created_at DESC, id DESC`.
- Rate limits: 120 чтений/мин и 30 записей/мин на устройство, 300 запросов/мин на IP.
- Суточные квоты создания: 30 новых отчётов на устройство и 100 на IP (`429` +
  `Retry-After: 3600`). Повторы принятого отчёта, правки, удаления и голоса квоту не
  расходуют, поэтому потерянный ответ не «съедает» лимит. Минутные и суточные счётчики
  хранятся в одной таблице, но чистятся разными порогами (`rateLimitCleanup`).
- Старые `incidents.community=1` мигрируют в отдельную таблицу и не попадают в личную ленту.

## Деплой

Секреты только в окружении/GitHub Secrets: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`. Workflow `Deploy community API` запускается вручную.
Без секретов деплой не выполняется и публичный URL не выдумывается.

Для своего Express-сервера IP клиента берётся из `X-Forwarded-For` только от доверенного
прокси: `TRUST_PROXY` по умолчанию `loopback` (Caddy/nginx на том же хосте). Значение
`true` доверять нельзя — клиент подделает заголовок и обойдёт IP-лимиты; за несколькими
прокси укажите их число или список подсетей.
