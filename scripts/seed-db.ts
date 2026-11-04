/**
 * Подготовка базы для локального запуска / деплоя.
 *
 * Берёт `data/seed.db` (снимок демо-состояния: каталог из 75 сайтов, 5 замеров,
 * 5 VPN-профилей, 8 инцидентов, демо-аккаунт) и кладёт его как рабочую базу
 * `data/pulsenet.db`, если такой ещё нет.
 *
 *   npm run db:seed            # создаст data/pulsenet.db из seed.db
 *   npm run db:seed -- --force # перезаписать существующую базу
 *   DATA_DIR=/var/lib/pulsenet npm run db:seed
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const seedPath = path.join(ROOT, 'data', 'seed.db');
const targetPath = path.join(dataDir, 'pulsenet.db');
const force = process.argv.includes('--force');

if (!fs.existsSync(seedPath)) {
  console.error(`Не найден ${seedPath}`);
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });

if (fs.existsSync(targetPath) && !force) {
  console.log(`База уже существует: ${targetPath} — пропускаю (используйте --force для перезаписи)`);
  process.exit(0);
}

for (const suffix of ['-wal', '-shm']) {
  const stale = targetPath + suffix;
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

fs.copyFileSync(seedPath, targetPath);
console.log(`Готово: ${targetPath}`);
