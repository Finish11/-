// Готовит demo-dist к упаковке в Android-проект (Capacitor ожидает index.html).
// Запускается после `npm run build:demo`, отдельной зависимости не требует.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const distDir = 'demo-dist';
const source = join(distDir, 'demo.html');
const target = join(distDir, 'index.html');

if (!existsSync(source)) {
  console.error(
    `Нет ${source}. Сначала выполните "npm run build:demo" — без него APK соберётся пустым.`,
  );
  process.exit(1);
}

copyFileSync(source, target);

const size = (statSync(target).size / 1024).toFixed(1);
console.log(`demo-dist готов к упаковке: index.html (${size} КБ)`);
