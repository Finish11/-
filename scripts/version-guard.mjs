#!/usr/bin/env node
/**
 * Защита правила «версия растёт при каждом изменении».
 *
 * Сравнивает версию в package.json с уже опубликованной в релизе android-latest.
 * Если номер тот же, а исходники приложения с тех пор изменились, сборка APK
 * останавливается: иначе приложение не предложит обновление (оно сравнивает
 * версию и номер сборки, но человек видит один и тот же номер).
 *
 *   node scripts/version-guard.mjs                 # проверить текущее состояние
 *   node scripts/version-guard.mjs --sha <commit>  # сравнить с конкретным коммитом
 *
 * Сеть и GITHUB_TOKEN нужны только для сравнения с релизом. Если GitHub
 * недоступен, скрипт печатает предупреждение и не блокирует сборку — проверка
 * не должна ломать релиз из-за чужого простоя.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.GITHUB_REPOSITORY || 'Finish11/-';
const APP_PATHS = [
  /^src\//, /^android\/app\/src\//, /^server\//, /^community\//, /^scripts\//,
  /^package\.json$/, /^package-lock\.json$/, /^capacitor\.config\.ts$/, /^vite.*\.config\.ts$/,
];

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function releasedVersion(body) {
  const match = String(body || '').match(/Верси[яи]:\s*([0-9]+(?:\.[0-9]+){1,3})/i);
  return match ? match[1] : '';
}

export function touchesApp(files) {
  return files.filter((file) => APP_PATHS.some((re) => re.test(file)));
}

/**
 * Решение без сети: чистая функция, чтобы правило было проверяемо тестом.
 * Возвращает { ok, reason }.
 */
export function verdict({ current, released, changed }) {
  if (!released) return { ok: true, reason: 'Опубликованной версии не найдено — сравнивать не с чем' };
  const cmp = compareVersions(current, released);
  if (cmp > 0) return { ok: true, reason: `Версия поднята: ${released} → ${current}` };
  if (cmp < 0) return { ok: false, reason: `Версия ${current} младше опубликованной ${released}` };
  const app = touchesApp(changed);
  if (!app.length) return { ok: true, reason: 'Исходники приложения не менялись — версия может остаться' };
  return {
    ok: false,
    reason: `Исходники изменились (${app.slice(0, 5).join(', ')}${app.length > 5 ? ', …' : ''}), а версия осталась ${current}. Поднимите её: npm run version:bump -- patch`,
  };
}

async function github(url) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  return res.json();
}

async function main() {
  const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const args = process.argv.slice(2);
  const shaArg = args.indexOf('--sha');
  try {
    const release = await github(`https://api.github.com/repos/${REPO}/releases/tags/android-latest`);
    const released = releasedVersion(release.body);
    // В заголовке релиза лежит короткий sha коммита, из которого собран APK.
    const base = shaArg >= 0 ? args[shaArg + 1] : (String(release.name || '').match(/\(([0-9a-f]{7,40})\)/) || [])[1];
    const head = process.env.GITHUB_SHA || 'HEAD';
    let changed = [];
    if (base) {
      const compare = await github(`https://api.github.com/repos/${REPO}/compare/${base}...${head}`);
      changed = (compare.files || []).map((f) => f.filename);
    } else {
      // Без точки сравнения считаем, что исходники менялись: лучше лишний подъём.
      changed = ['src/'];
    }
    const result = verdict({ current, released, changed });
    // В GitHub verdict виден прямо в аннотациях: логи раннера не всегда доступны.
    const marker = process.env.CI ? (result.ok ? '::notice::' : '::error::') : '';
    console.log(`${marker}Проверка версии: ${result.reason}`);
    if (!result.ok) process.exit(1);
  } catch (error) {
    const marker = process.env.CI ? '::warning::' : '';
    console.log(`${marker}Проверка версии пропущена: ${error.message}. Версия в package.json — ${current}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();