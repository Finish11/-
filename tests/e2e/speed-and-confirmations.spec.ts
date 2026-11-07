import { test, expect } from '@playwright/test';

/**
 * Сквозные проверки новых экранов. Внешние сервисы замокированы: в CI нет
 * интернета, а методика замера и логика интерфейса проверяются детерминированно.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

test('замер скорости показывает результат и сохраняет его в историю', async ({ page, isMobile }) => {
  test.skip(isMobile, 'длинный замер прогоняем один раз на десктопе');
  test.setTimeout(120_000);
  await page.route('**/speed.cloudflare.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    if (url.pathname === '/__up') return route.fulfill({ status: 200, headers: CORS, json: { ok: true } });
    const bytes = Math.min(Number(url.searchParams.get('bytes') || 0), 2_000_000);
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(bytes, 7) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Скорость/ }).first().click();
  await expect(page.getByText('Скорость интернета')).toBeVisible();
  // Экономный режим меняет и расчёт трафика, и длительность фаз.
  await expect(page.getByText(/до ~120 МБ на загрузку/)).toBeVisible();
  await page.getByRole('checkbox').check();
  await expect(page.getByText(/до ~25 МБ на загрузку/)).toBeVisible();
  await page.getByRole('button', { name: 'Замерить' }).click();
  // Живой график появляется, как только пошли сэмплы загрузки.
  await expect(page.getByText(/пик /).first()).toBeVisible({ timeout: 40_000 });
  // Фаза загрузки идёт 10 секунд, отдачи — 8: ждём сохранения результата.
  await expect(page.getByText('Что именно измеряется')).toBeVisible();
  // Ждём завершения обеих фаз: кнопка «Замерить» возвращается после сохранения.
  await expect(page.getByRole('button', { name: 'Замерить' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('История замеров')).toBeVisible();
  await expect(page.getByText('Какие конфиги быстрее')).toBeVisible();
  const numbers = await page.locator('.tabular-nums').allTextContents();
  expect(numbers.some((text) => Number(text.replace(',', '.')) > 0)).toBeTruthy();
  // Отдача не должна быть нулём: это ловил реальный баг учёта байтов без progress-событий.
  await expect(page.getByText(/^0,00$/)).toHaveCount(0);
  // График и подписи фаз остаются после замера.
  await expect(page.getByText(/загрузка · /).first()).toBeVisible();
  // Задержка под нагрузкой измерена и показана, а не выдумана.
  await expect(page.getByText(/под нагрузкой \d+ мс/).first()).toBeVisible();
  await expect(page.getByText(/Выбор точки:/).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('подтверждение приложения сохраняется для выбранного VPN-узла', async ({ page, isMobile }) => {
  test.skip(isMobile, 'сценарий одинаков на обоих проектах, достаточно десктопа');
  await page.route('**://ipwho.is/**', (route) => route.fulfill({
    status: 200, headers: CORS,
    json: { ip: '203.0.113.10', country_code: 'NL', country_name: 'Нидерланды', city: 'Амстердам',
      connection: { isp: 'Test ISP', asn: 64500 }, success: true },
  }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Проверка сети|Проверка/ }).first()).toBeVisible();
  // Карточка быстрого доступа открывает лист с выбором маршрута.
  await page.getByText('ChatGPT', { exact: false }).first().click();
  const select = page.locator('select').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  const options = await select.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  await select.selectOption({ index: 1 });
  await expect(page.getByRole('button', { name: 'Работает', exact: true })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Работает', exact: true }).click();
  await expect(page.getByText(/Вы подтвердили: приложение работает/)).toBeVisible({ timeout: 20_000 });
  // После закрытия карточка в списке остаётся зелёной — отзыв привязан к узлу.
  await page.getByRole('button', { name: /Закрыть|Отмена/ }).first().click();
  await expect(page.getByRole('button', { name: 'приложение работает · подтверждено' }).first()).toBeVisible({ timeout: 15_000 });
});

test('обмен отчётами работает без общего сервера', async ({ page, isMobile }) => {
  test.skip(isMobile, 'проверяем один раз');
  await page.goto('/');
  await page.getByRole('button', { name: /Сбои/ }).first().click();
  await page.getByRole('button', { name: 'Обмен' }).click();
  await expect(page.getByText('Обмен отчётами')).toBeVisible();
  const bundle = JSON.stringify({
    pulsenet: 'incidents', version: 1, exported_at: new Date().toISOString(), author: 'Участник',
    incidents: [{
      client_id: '90000000-0000-4000-8000-000000000001', region: 'Москва и МО', carrier: 'МТС',
      incident_type: 'whitelist', severity: 'high', status: 'active', title: 'E2E отчёт участника',
      description: 'Передан пакетом', upvotes: 2, ru_sites_ok: true, foreign_sites_ok: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }],
  });
  await page.getByPlaceholder('{"pulsenet":"incidents","version":1,…}').fill(bundle);
  await page.getByRole('button', { name: 'Загрузить отчёты' }).click();
  await expect(page.getByText(/Добавлено 1/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Закрыть|Отмена/ }).first().click();
  await expect(page.getByText('E2E отчёт участника').first()).toBeVisible({ timeout: 15_000 });
});
