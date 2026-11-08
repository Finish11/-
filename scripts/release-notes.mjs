#!/usr/bin/env node
/**
 * Описание релиза берётся из CHANGELOG.md, а не из текста внутри workflow:
 * иначе номер версии в заметках отстаёт от собранного APK (так и было — в
 * заметках стояло «Что нового в 1.5.8», хотя изменения уже были другими).
 *
 *   node scripts/release-notes.mjs            # весь журнал без заголовка
 *   node scripts/release-notes.mjs --current  # только текущая версия
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Первая секция журнала обязана совпадать с версией в package.json. */
export function currentChangelogSection(changelog, version) {
  const sections = changelog.split(/^## /m).slice(1);
  const first = sections[0];
  if (!first) throw new Error('В CHANGELOG.md нет ни одной секции версии');
  const title = first.split('\n')[0].trim();
  if (!title.startsWith(version))
    throw new Error(`Верхняя секция журнала «${title}» не совпадает с версией ${version} в package.json`);
  return `Что нового в ${title}\n${first.slice(first.indexOf('\n') + 1).trim()}`;
}

export function releaseNotes(changelog, version, onlyCurrent = false) {
  const current = currentChangelogSection(changelog, version);
  if (onlyCurrent) return current;
  const rest = changelog.split(/^## /m).slice(2).map((section) => {
    const title = section.split('\n')[0].trim();
    return `Изменения ${title}\n${section.slice(section.indexOf('\n') + 1).trim()}`;
  });
  return [current, ...rest].join('\n\n');
}

function main() {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  console.log(releaseNotes(changelog, version, process.argv.includes('--current')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
