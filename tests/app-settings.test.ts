import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/lib/appSettings.ts';

test('пустое и испорченное хранилище даёт настройки по умолчанию', () => {
  for (const raw of [null, undefined, 'мусор', 42, [], true]) {
    assert.deepEqual(sanitizeSettings(raw), DEFAULT_SETTINGS, `значение ${JSON.stringify(raw)}`);
  }
});

test('настройки замера из старого хранилища не ломают экран', () => {
  const restored = sanitizeSettings({
    scanSpeed: 'turbo', speedUnit: 'mbit', gaugeMax: '500', speedLite: 'да', probeMode: 'demo',
  });
  assert.equal(restored.scanSpeed, 'fast');
  assert.equal(restored.speedUnit, 'mbps');
  // Строка '500' — не число 500: такого потолка в списке нет.
  assert.equal(restored.gaugeMax, 'auto');
  assert.equal(restored.speedLite, true, 'Truthy-значение приводится к флагу');
  assert.equal(restored.probeMode, 'auto', 'режим имитации больше не существует');
});

test('допустимые значения сохраняются без изменений', () => {
  const good = {
    operator: 'МТС', city: 'Казань', networkType: 'cellular', probeMode: 'real',
    accent: 'violet', theme: 'system', calmMotion: true,
    scanSpeed: 'thorough', speedUnit: 'MBps', gaugeMax: 250, speedLite: true,
  };
  assert.deepEqual(sanitizeSettings(good), good);
  for (const gaugeMax of ['auto', 100, 250, 500, 1000]) {
    assert.equal(sanitizeSettings({ gaugeMax }).gaugeMax, gaugeMax);
  }
});

test('тема, акцент и тип сети проверяются по списку', () => {
  const restored = sanitizeSettings({ theme: 'неон', accent: 'chartreuse', networkType: '5g' });
  assert.equal(restored.theme, DEFAULT_SETTINGS.theme);
  assert.equal(restored.accent, DEFAULT_SETTINGS.accent);
  assert.equal(restored.networkType, DEFAULT_SETTINGS.networkType);
});

test('строки профиля обрезаются и не принимают числа', () => {
  const restored = sanitizeSettings({ operator: 'x'.repeat(500), city: 42 });
  assert.equal(restored.operator.length, 120);
  assert.equal(restored.city, '');
});

test('неизвестные поля не протекают в настройки', () => {
  const restored = sanitizeSettings({ speedUnit: 'MBps', __proto__: { evil: true }, evil: 1 });
  assert.deepEqual(Object.keys(restored).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.equal((restored as unknown as Record<string, unknown>).evil, undefined);
});