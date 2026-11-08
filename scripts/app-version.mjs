#!/usr/bin/env node
/**
 * Версия приложения lives в package.json. Этот скрипт переносит её в Android-
 * проект, чтобы versionName в APK, номер в релизе и версия в интерфейсе никогда
 * не расходились.
 *
 * versionCode обязан расти при каждом обновлении, иначе Android откажется
 * ставить APK поверх. Схема: MMmmpppBBB — старшая/средняя/младшая версия и номер
 * сборки в младших трёх знаках: M×100000000 + m×1000000 + p×1000 + build%1000.
 * Разряды не перекрываются (patch до 999, сборок до 1000), поэтому код монотонен
 * и между версиями, и внутри одной версии, и помещается в int32 (max 999999999).
 * Он заведомо больше прежней схемы (run+1000), поэтому обновление встанет поверх.
 *
 *   node scripts/app-version.mjs                 # версия из package.json, сборка 0
 *   node scripts/app-version.mjs --build 137     # номер сборки из CI
 *   node scripts/app-version.mjs --print         # только показать, ничего не менять
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) throw new Error(`Версия "${version}" не похожа на major.minor.patch`);
  const [, major, minor, patch] = match.map(Number);
  if (major > 9 || minor > 99 || patch > 999)
    throw new Error(`Версия ${version} не помещается в схему versionCode (9.99.999 максимум)`);
  return { major, minor, patch };
}

export function versionCodeFor(version, buildNumber = 0) {
  const { major, minor, patch } = parseVersion(version);
  const build = Number.isFinite(Number(buildNumber)) ? Math.max(0, Math.floor(Number(buildNumber))) : 0;
  return major * 100_000_000 + minor * 1_000_000 + patch * 1_000 + (build % 1000);
}

export function applyToGradle(gradleSource, version, buildNumber = 0) {
  const code = versionCodeFor(version, buildNumber);
  let next = gradleSource.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
  next = next.replace(/versionCode\s+\d+/, `versionCode ${code}`);
  if (!next.includes(`versionName "${version}"`) || !next.includes(`versionCode ${code}`))
    throw new Error('В build.gradle не найдены versionName/versionCode');
  return next;
}

function main() {
  const args = process.argv.slice(2);
  const buildIndex = args.indexOf('--build');
  const buildNumber = buildIndex >= 0 ? Number(args[buildIndex + 1] || 0) : 0;
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const code = versionCodeFor(version, buildNumber);
  if (!args.includes('--print')) {
    const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
    writeFileSync(gradlePath, applyToGradle(readFileSync(gradlePath, 'utf8'), version, buildNumber));
  }
  console.log(`versionName ${version}`);
  console.log(`versionCode ${code}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
