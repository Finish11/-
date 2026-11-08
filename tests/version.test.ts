import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyToGradle, parseVersion, versionCodeFor } from '../scripts/app-version.mjs';
import { currentChangelogSection, releaseNotes } from '../scripts/release-notes.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');

test('версия в package.json, журнале и Android-проекте совпадает', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(changelog.includes(`## ${pkg.version}\n`), 'верхняя секция журнала должна быть про эту версию');
  assert.match(currentChangelogSection(changelog, pkg.version), new RegExp(`^Что нового в ${pkg.version.replace(/\./g, '\\.')}`));
  assert.ok(gradle.includes(`versionName "${pkg.version}"`), 'versionName в build.gradle отстал от package.json');
  assert.ok(gradle.includes(`versionCode ${versionCodeFor(pkg.version)}`), 'versionCode в build.gradle не соответствует версии');
});

test('журнал не совпадает с версией — скрипт падает, а не врёт в релизе', () => {
  assert.throws(() => currentChangelogSection(changelog, '9.9.9'), /не совпадает/);
  assert.throws(() => currentChangelogSection('# пусто', '1.0.0'), /нет ни одной секции/);
});

test('заметки релиза начинаются с текущей версии и сохраняют историю', () => {
  const notes = releaseNotes(changelog, pkg.version);
  assert.ok(notes.startsWith(`Что нового в ${pkg.version}`));
  assert.match(notes, /Изменения 1\.5\.8/);
  const only = releaseNotes(changelog, pkg.version, true);
  assert.ok(!only.includes('Изменения 1.5.8'));
  // Обратные кавычки в тексте не должны теряться: заметки пишутся файлом.
  assert.ok(notes.includes('`client_id`'), 'markdown журнала сохраняется как есть');
});

test('versionCode растёт и между версиями, и внутри одной версии', () => {
  assert.equal(versionCodeFor('1.6.0'), 106_000_000);
  assert.equal(versionCodeFor('1.6.0', 137), 106_000_137);
  assert.ok(versionCodeFor('1.6.1') > versionCodeFor('1.6.0', 999));
  assert.ok(versionCodeFor('1.7.0') > versionCodeFor('1.6.999', 999));
  assert.ok(versionCodeFor('2.0.0') > versionCodeFor('1.99.999', 999));
  // Прежняя схема (run + 1000) давала меньше 100000 — обновление поверх пройдёт.
  assert.ok(versionCodeFor(pkg.version) > 100_000);
  assert.ok(versionCodeFor('9.99.999', 999) < 2_147_483_647, 'versionCode — int32');
  assert.equal(versionCodeFor('1.6.0', -5), 106_000_000);
  assert.throws(() => parseVersion('1.6'), /не похожа/);
  assert.throws(() => versionCodeFor('10.0.0'), /не помещается/);
});

test('патч Gradle меняет только версию и переживает повторный запуск', () => {
  const source = 'android {\n  defaultConfig {\n    versionCode 1\n    versionName "1.0.0"\n    applicationId "ru.pulsenet.app"\n  }\n}\n';
  const once = applyToGradle(source, '1.6.0', 42);
  assert.ok(once.includes('versionCode 106000042'));
  assert.ok(once.includes('versionName "1.6.0"'));
  assert.ok(once.includes('applicationId "ru.pulsenet.app"'));
  assert.equal(applyToGradle(once, '1.6.0', 42), once, 'повторный запуск идемпотентен');
  assert.throws(() => applyToGradle('android {}', '1.6.0'), /не найдены/);
});
