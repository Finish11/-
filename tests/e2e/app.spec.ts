import { test, expect } from '@playwright/test';

test('демо-вход, вкладки, мобильная вёрстка и форма сбоя', async ({ page }) => {
  await page.goto('/');
  // Первый визит автоматически входит в демо-аккаунт; отдельная кнопка не обязательна.
  await expect(page.getByRole('button', { name: /Проверка сети|Проверка/ }).first()).toBeVisible();
  for (const name of [/Сайты|Каталог сайтов/, /VPN/, /Сбои/, /История/]) {
    await page.getByRole('button', { name }).first().click();
    await expect(page.locator('body')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: /Сбои/ }).first().click();
  await page.getByRole('button', { name: 'Сообщить о сбое' }).click();
  await expect(page.getByText('Тип ограничений')).toBeVisible();
  await page.getByPlaceholder('Например: на МТС работают только ВК и Госуслуги').fill('E2E: проверка формы');
  await page.getByRole('button', { name: 'Отмена' }).click();
});

test('общий сервер отклоняет небезопасный HTTP-адрес', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Проверка сети|Проверка/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Сбои/ }).first().click();
  await page.getByRole('button', { name: 'Подключить сервер' }).click();
  await page.getByPlaceholder('https://pulsenet-api.example.com').fill('http://example.com');
  await page.getByRole('button', { name: 'Проверить и подключить' }).click();
  await expect(page.getByText(/Общий API должен использовать HTTPS/)).toBeVisible();
});
