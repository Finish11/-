import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, hasUpdate, parseBuildNumber } from '../src/lib/appUpdate.ts';

test('номер сборки читается из заметок релиза', () => {
  assert.equal(parseBuildNumber('Версия: 1.8.0 (versionCode 108000012)\n\nЧто нового'), 108000012);
  assert.equal(parseBuildNumber('Версия: 1.8.0'), 0);
  assert.equal(parseBuildNumber('versionCode не число'), 0);
  assert.equal(parseBuildNumber(''), 0);
});

test('более новая версия предлагается всегда', () => {
  assert.equal(hasUpdate('1.8.0', 0, '1.7.0', 107000084), true);
  assert.equal(hasUpdate('1.7.1', 1, '1.7.0', 999999999), true, 'версия важнее номера сборки');
  assert.equal(hasUpdate('2.0.0', 0, '10.0.0', 0), false, 'сравнение числовое, а не строковое');
});

test('та же версия, но новая сборка — обновление приходит', () => {
  // Именно этого не хватало: APK пересобирался под тем же номером, и приложение
  // молчало, хотя правки были.
  assert.equal(hasUpdate('1.7.0', 107000084, '1.7.0', 107000082), true);
  assert.equal(hasUpdate('1.7.0', 107000082, '1.7.0', 107000084), false, 'старая сборка не предлагается');
  assert.equal(hasUpdate('1.7.0', 107000084, '1.7.0', 107000084), false, 'та же сборка — тишина');
});

test('без данных о сборке обновление не выдумывается', () => {
  assert.equal(hasUpdate('1.7.0', 107000084, '1.7.0', 0), false);
  assert.equal(hasUpdate('1.7.0', 0, '1.7.0', 107000082), false);
  assert.equal(hasUpdate('', 107000084, '1.7.0', 107000082), false, 'версия в заметках не распознана');
});

test('сравнение версий дополняет отсутствующие части нулями', () => {
  assert.equal(compareVersions('1.7', '1.7.0'), 0);
  assert.equal(compareVersions('1.7.1', '1.7'), 1);
  assert.equal(compareVersions('1.7.0', '1.7.1'), -1);
});
