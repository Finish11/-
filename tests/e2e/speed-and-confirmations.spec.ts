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
  test.skip(isMobile, 'два замера прогоняем один раз на десктопе');
  test.setTimeout(180_000);
  await page.route('**/speed.cloudflare.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    if (url.pathname === '/__up') {
      // Реальный канал не отвечает мгновенно: без этой паузы фаза отдачи
      // кончается за доли секунды и вести себя как настоящий замер не может.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return route.fulfill({ status: 200, headers: CORS, json: { ok: true } });
    }
    const bytes = Math.min(Number(url.searchParams.get('bytes') || 0), 2_000_000);
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(bytes, 7) });
  });
  // CI работает из дата-центра: IP выглядит как VPN. Проверка обязана проходить
  // и в этом случае — догадка по IP не должна отменять выбор пользователя.
  await page.route('**://ipwho.is/**', (route) => route.fulfill({
    status: 200, headers: CORS,
    json: { ip: '203.0.113.77', country_code: 'US', country_name: 'США', city: 'Ashburn',
      connection: { isp: 'Microsoft Azure', asn: 8075 }, security: { hosting: true, proxy: true, vpn: true }, success: true },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /Скорость/ }).first().click();
  await expect(page.getByText('Скорость интернета')).toBeVisible();
  // Настройки замера: экономный режим, единицы и потолок шкалы.
  await page.getByRole('button', { name: /Настройки замера/ }).click();
  await expect(page.getByText(/до ~120 МБ вниз/)).toBeVisible();
  await page.getByRole('checkbox').check();
  await expect(page.getByText(/до ~25 МБ вниз/)).toBeVisible();
  // Потолок шкалы задаётся в текущих единицах, поэтому выбираем его в Мбит/с.
  // Кнопки потолка живут внутри панели настроек; после смены единиц
  // подпись становится «12,5», а не «12.5» — точка здесь не проходит.
  await page.locator('#speed-tune-panel').getByRole('button', { name: '100', exact: true }).click();
  await page.getByRole('button', { name: 'МБ/с', exact: true }).click();
  await expect(page.getByText('Шкала, МБ/с')).toBeVisible();
  // В русской локали дробная часть пишется через запятую: 100 Мбит/с = 12,5 МБ/с.
  await expect(page.getByRole('button', { name: '12,5', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Мбит/с', exact: true }).click();
  await page.getByRole('button', { name: /Настройки замера/ }).click();

  const runOnce = async () => {
    await page.getByRole('button', { name: /^(Замерить|Повторить)$/ }).click();
    await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Замерить|Повторить)$/ })).toBeVisible({ timeout: 90_000 });
  };

  // Порядок как у пользователя: сначала точка отсчёта без VPN, потом конфиг.
  // Догадка по IP показана как подсказка, но выбором не командует.
  await expect(page.getByText(/По внешнему IP выход похож на VPN/)).toBeVisible({ timeout: 20_000 });
  const configSelect = page.locator('select').first();
  await configSelect.selectOption({ value: '' });
  await runOnce();
  // Живой график появляется, как только пошли сэмплы загрузки.
  await expect(page.getByText(/пик /).first()).toBeVisible();
  await expect(page.getByText('Что именно измеряется')).toBeVisible();
  await expect(page.getByText('История замеров')).toBeVisible();
  await expect(page.getByText('Какие конфиги быстрее')).toBeVisible();
  await expect(page.getByText('Без VPN (прямой)').first()).toBeVisible();
  const numbers = await page.locator('.tabular-nums').allTextContents();
  expect(numbers.some((text) => Number(text.replace(',', '.')) > 0)).toBeTruthy();
  // Отдача не должна быть нулём: это ловил реальный баг учёта байтов без progress-событий.
  await expect(page.getByText(/^0,00$/)).toHaveCount(0);
  // График и подписи фаз остаются после замера.
  await expect(page.getByText(/загрузка · /).first()).toBeVisible();
  // Задержка под нагрузкой измерена и показана, а не выдумана.
  await expect(page.getByText(/под нагрузкой \d+ мс/).first()).toBeVisible();
  await expect(page.getByText(/Выбор точки:/).first()).toBeVisible();
  // Второй замер — с выбранным конфигом: только теперь сравнение законно.
  await configSelect.selectOption({ index: 1 });
  await runOnce();
  // Любой законный вердикт сравнения: конфиг может быть и быстрее прямого.
  await expect(page.getByText(/Почти без потерь|Не медленнее прямого канала|Теряет \d+%|Сильно ограничивает/).first()).toBeVisible();
  // Сводка по подписке отвечает на вопрос «какие конфиги режут канал».
  await expect(page.getByText('Подписки: где теряется скорость')).toBeVisible();
  await expect(page.getByText(/измерено \d+ из \d+/).first()).toBeVisible();
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

test('история замеров подписывает источник интернета и маршрут', async ({ page, isMobile }) => {
  test.skip(isMobile, 'достаточно одного прогона');
  test.setTimeout(120_000);
  // Сначала открываем приложение: демо-сессия авторизует запросы к API.
  await page.goto('/');
  await page.getByRole('button', { name: /Скорость/ }).first().click();
  // Два замера на разных сетях: без подписи источника они выглядели бы одинаково.
  const make = (patch: Record<string, unknown>) => ({
    created_at: new Date().toISOString(), download_mbps: 40, upload_mbps: 12, ping_ms: 25, jitter_ms: 3,
    download_bytes: 5_000_000, upload_bytes: 1_000_000, server: 'Cloudflare (ближайший узел)',
    network_kind: 'wifi', network_name: 'Домашний провайдер', route: 'direct', exit_ip: '203.0.113.10',
    reliable: true, ...patch,
  });
  const wifi = await page.request.post('/api/speed-tests', { data: make({}) });
  expect(wifi.ok(), await wifi.text()).toBeTruthy();
  const lte = await page.request.post('/api/speed-tests', {
    data: make({ network_kind: 'cellular', network_name: 'МТС', route: 'vpn', profile_name: '', vpn_app_name: 'v2rayNG', exit_ip: '198.51.100.7' }),
  });
  expect(lte.ok(), await lte.text()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Скорость/ }).first().click();
  await page.getByText('История замеров').scrollIntoViewIfNeeded();
  await expect(page.getByText('Wi-Fi · Домашний провайдер').first()).toBeVisible();
  await expect(page.getByText('мобильная сеть · МТС').first()).toBeVisible();
  await expect(page.getByText('напрямую · 203.0.113.10').first()).toBeVisible();
  await expect(page.getByText('VPN · v2rayNG · 198.51.100.7').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('оценка качества YouTube учитывает ускорение 2×', async ({ page, isMobile }) => {
  test.skip(isMobile, 'достаточно одного прогона');
  await page.goto('/');
  await page.getByRole('button', { name: /Скорость/ }).first().click();
  await page.getByText('YouTube: на какое качество хватит').scrollIntoViewIfNeeded();
  // Скорость воспроизведения выбирается до замера и меняет требования к каналу.
  await expect(page.getByRole('button', { name: '2×', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1×', exact: true }).click();
  await page.getByRole('button', { name: '2×', exact: true }).click();
  await expect(page.getByText(/плеер расходует/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Замерить YouTube' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('смена выходного IP снимает зелёный статус и просит перепроверить', async ({ page, isMobile }) => {
  test.skip(isMobile, 'сценарий одинаков на обоих проектах, достаточно десктопа');
  test.setTimeout(120_000);
  // Пользователь переключает узел в VPN-клиенте: приложение видит только новый IP.
  let exitIp = '203.0.113.10';
  await page.route('**://ipwho.is/**', (route) => route.fulfill({
    status: 200, headers: CORS,
    json: { ip: exitIp, country_code: 'NL', country_name: 'Нидерланды', city: 'Амстердам',
      connection: { isp: 'Test ISP', asn: 64500 }, success: true },
  }));
  await page.goto('/');
  await page.getByText('ChatGPT', { exact: false }).first().click();
  const select = page.locator('select').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  await select.selectOption({ index: 1 });
  await expect(page.getByRole('button', { name: 'Работает', exact: true })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Работает', exact: true }).click();
  await expect(page.getByText(/Вы подтвердили: приложение работает/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /Закрыть|Отмена/ }).first().click();
  await expect(page.getByRole('button', { name: 'приложение работает · подтверждено' }).first()).toBeVisible({ timeout: 15_000 });

  // Тот же узел в списке, но выход сменился — прежний зелёный статус больше не врёт.
  exitIp = '198.51.100.77';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const banner = page.getByText('Выходной IP сменился — похоже, в клиенте другой узел');
  // В демо-сборке VPN-клиента нет: показывается событие смены сети. Оба варианта
  // означают одно — прежний отзыв больше не описывает текущий маршрут.
  await expect(banner.or(page.getByText('Сменилась сеть: другой оператор или Wi-Fi')).first())
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Было 203\.0\.113\.10, стало 198\.51\.100\.77/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Я напрямую — сбросить узел|Узел верный, скрыть/ }).first()).toBeVisible();
  // Карточка больше не зелёная: статус честно просит перепроверку.
  await expect(page.getByRole('button', { name: /перепроверьте/ }).first()).toBeVisible();
});

test('спидометр подписывает ровные значения и не пишет ноль при провале', async ({ page, isMobile }) => {
  test.skip(isMobile, 'раскладку проверяем на десктопе, чтобы не ждать два раза');
  test.setTimeout(90_000);
  // Сеть без выхода: замер обязан закончиться честным «не состоялся»,
  // а не «0 Мбит/с» — ноль означал бы измеренную нулевую скорость.
  await page.route('**/speed.cloudflare.com/**', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: /Скорость/ }).first().click();
  await expect(page.getByLabel(/Спидометр скорости/)).toBeVisible();
  await page.getByRole('button', { name: /^Замерить$/ }).click();
  await expect(page.getByText('Замер не состоялся')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/скорость не измерена/)).toBeVisible();
  // В карточках тоже прочерк, а не нули: 0 КБ читалось как «канал нулевой».
  await expect(page.getByText('0 КБ')).toHaveCount(0);
  // Шкала подписана только крайними значениями — без «12,5» и прочих дробей.
  const ticks = await page.getByLabel(/Спидометр скорости/).locator('text').allTextContents();
  for (const tick of ticks) expect(tick).toMatch(/^\d+$/);
});
