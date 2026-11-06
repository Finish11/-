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
- PATCH/DELETE разрешены только устройству-владельцу.
- DELETE оставляет tombstone: повторный POST того же `client_id` получает 410.
- PUT vote идемпотентен; количество голосов пересчитывается из таблицы голосов.
- Лента имеет стабильный курсор `created_at DESC, id DESC`.
- Rate limits: 120 чтений/мин и 30 записей/мин на устройство, 300 запросов/мин на IP.
- Старые `incidents.community=1` мигрируют в отдельную таблицу и не попадают в личную ленту.

## Деплой

Секреты только в окружении/GitHub Secrets: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`. Workflow `Deploy community API` запускается вручную.
Без секретов деплой не выполняется и публичный URL не выдумывается.
