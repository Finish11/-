import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion, withChangelogSection } from '../scripts/version-bump.mjs';
import { verdict, releasedVersion, touchesApp, compareVersions } from '../scripts/version-guard.mjs';
import { versionCodeFor } from '../scripts/app-version.mjs';

test('подъём версии по правилам semver', () => {
  assert.equal(nextVersion('1.8.0', 'patch'), '1.8.1');
  assert.equal(nextVersion('1.8.9', 'minor'), '1.9.0');
  assert.equal(nextVersion('1.9.9', 'major'), '2.0.0');
  assert.equal(nextVersion('1.8.0', '2.5.7'), '2.5.7');
  assert.throws(() => nextVersion('1.8.0', 'как-нибудь'), /Укажите patch/);
  assert.throws(() => nextVersion('мусор', 'patch'), /Не разобрать/);
});

test('каждый подъём увеличивает и номер сборки Android', () => {
  for (const kind of ['patch', 'minor', 'major']) {
    const next = nextVersion('1.8.0', kind);
    assert.ok(versionCodeFor(next) > versionCodeFor('1.8.0'), `${kind}: ${next}`);
  }
});

test('секция журнала добавляется наверх, история сохраняется', () => {
  const changelog = '# Журнал\n\nШапка\n\n## 1.8.0\n\n- было\n\n## 1.7.0\n\n- ещё раньше\n';
  const next = withChangelogSection(changelog, '1.8.1', 'мелкая правка');
  assert.ok(next.indexOf('## 1.8.1') < next.indexOf('## 1.8.0'));
  assert.match(next, /## 1\.8\.1\n\n- мелкая правка\n\n## 1\.8\.0/);
  assert.match(next, /## 1\.7\.0\n\n- ещё раньше/);
  assert.match(withChangelogSection(changelog, '1.8.1', ''), /TODO: описать изменение/);
});

test('версия из заметок релиза читается, как и в приложении', () => {
  assert.equal(releasedVersion('Версия: 1.8.0 (versionCode 108000012)'), '1.8.0');
  assert.equal(releasedVersion('без версии'), '');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
});

test('изменившиеся исходники под той же версией не проходят', () => {
  const bad = verdict({ current: '1.8.0', released: '1.8.0', changed: ['src/components/Layout.tsx', 'README.md'] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /version:bump/);
  assert.deepEqual(touchesApp(['docs/diagnostics.md', 'tests/core.test.ts']), []);
  assert.deepEqual(touchesApp(['android/app/src/main/java/X.java']), ['android/app/src/main/java/X.java']);
  // Сборочные скрипты и конфиги тоже влияют на APK — версия обязана расти.
  assert.deepEqual(touchesApp(['scripts/version-guard.mjs', 'vite.demo.config.ts']),
    ['scripts/version-guard.mjs', 'vite.demo.config.ts']);
});

test('поднятая версия и правки только в документации проходят', () => {
  assert.equal(verdict({ current: '1.8.1', released: '1.8.0', changed: ['src/lib/x.ts'] }).ok, true);
  assert.equal(verdict({ current: '1.8.0', released: '1.8.0', changed: ['docs/diagnostics.md'] }).ok, true);
  assert.equal(verdict({ current: '1.8.0', released: '', changed: ['src/lib/x.ts'] }).ok, true);
  // Откат версии — ошибка, даже если исходники не менялись.
  assert.equal(verdict({ current: '1.7.0', released: '1.8.0', changed: [] }).ok, false);
});
