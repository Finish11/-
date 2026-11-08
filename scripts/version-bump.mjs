#!/usr/bin/env node
/**
 * Подъём версии одной командой — при каждом изменении приложения.
 *
 *   npm run version:bump -- patch     # 1.8.0 → 1.8.1 (правки, фиксы)
 *   npm run version:bump -- minor     # 1.8.1 → 1.9.0 (новые возможности)
 *   npm run version:bump -- major     # 1.9.0 → 2.0.0 (несовместимые изменения)
 *   npm run version:bump -- 1.9.3     # явный номер
 *
 * Меняет package.json и android/app/build.gradle, добавляет секцию в CHANGELOG.md
 * и печатает, что осталось вписать. Номер сборки Android считает CI по номеру
 * прогона, поэтому он всегда растёт и обновление приходит в приложение.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyToGradle, versionCodeFor } from './app-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Чистая функция: следующий номер по правилам semver. */
export function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const parts = current.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
    throw new Error(`Не разобрать текущую версию «${current}»`);
  const [major, minor, patch] = parts;
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('Укажите patch, minor, major или явный номер вида 1.9.3');
}

/** Секция журнала для новой версии; заметка обязательна, чтобы не забыть смысл. */
export function withChangelogSection(changelog, version, note) {
  const marker = changelog.indexOf('\n## ');
  if (marker < 0) throw new Error('В CHANGELOG.md нет ни одной секции версии');
  const line = `- ${note && note.trim() ? note.trim() : 'TODO: описать изменение'}`;
  return `${changelog.slice(0, marker + 1)}## ${version}\n\n${line}\n\n${changelog.slice(marker + 1)}`;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const kind = args[0] || 'patch';
  const note = args.slice(1).join(' ');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const current = pkg.version;
  const version = nextVersion(current, kind);
  if (versionCodeFor(version) <= versionCodeFor(current))
    throw new Error(`Новая версия ${version} не больше текущей ${current}`);

  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  writeFileSync(gradlePath, applyToGradle(readFileSync(gradlePath, 'utf8'), version, 0));

  const changelogPath = path.join(root, 'CHANGELOG.md');
  writeFileSync(changelogPath, withChangelogSection(readFileSync(changelogPath, 'utf8'), version, note));

  console.log(`${current} → ${version}`);
  console.log(`versionCode ${versionCodeFor(version)} (CI добавит номер прогона)`);
  if (!note.trim()) console.log('В CHANGELOG.md добавлена строка TODO — впишите, что изменилось.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();