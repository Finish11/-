# ПульсСети — продакшн-образ (сервер Express + SQLite + собранный фронтенд)
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# better-sqlite3 требует нативную сборку — ставим только runtime-зависимости
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/data/seed.db ./data/seed.db
EXPOSE 3000
CMD ["sh", "-c", "npx tsx scripts/seed-db.ts && npx tsx server/index.ts"]
