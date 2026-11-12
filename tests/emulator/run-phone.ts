/**
 * Ручной проход по приложению «как человек»: телефон с нативным мостом,
 * нажатия по всем экранам, скриншоты и список замечаний.
 *
 * Запуск: `npm run phone` (или `npm run phone -- --keep` — оставить браузер
 * открытым для inspection). Требует запущенный сервер (`npm run dev` или
 * `npx tsx server/index.ts`) на http://127.0.0.1:4173.
 *
 * Это не замена реальному Android-эмулятору: тот в песочнице не поднимается
 * (нет KVM/SDK/сети до dl.google.com). Но все ветки `isNativeApp()` здесь
 * проходятся так же, как в APK.
 */
import { openPhone, BASE_URL, type Finding } from './device';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const outDir = process.env.PHONE_OUT || path.resolve('phone-report');
const keep = process.argv.includes('--keep');

async function main() {
  const { phone, close } = await openPhone({ outDir, headless: !keep });
  const { page } = phone;
  await mkdir(outDir, { recursive: true });

  // Внешний IP: приложение спрашивает его у ipwho.is, в песочнице сети нет.
  await page.route('**://ipwho.is/**', (route) => route.fulfill({
    status: 200, headers: CORS,
    json: { ip: '198.51.100.7', country_code: 'NL', country_name: 'Нидерланды', city: 'Амстердам',
      connection: { isp: 'Datacamp Limited', asn: 212238 }, security: { hosting: true, proxy: false, vpn: true }, success: true },
  }));
  // Точки замера: 62 Мбит/с вниз, 20 вверх — ровный канал.
  await page.route('**/speed.cloudflare.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    if (url.pathname === '/__up') { await new Promise((r) => setTimeout(r, 20)); return route.fulfill({ status: 200, headers: CORS, json: { ok: true } }); }
    const bytes = Math.min(Number(url.searchParams.get('bytes') || 0), 2_000_000);
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(bytes, 7) });
  });

  await phone.step('запуск', BASE_URL, async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Проверка сети|Проверка/ }).first().waitFor({ timeout: 30_000 });
  });
  // APK-режим начинается с шита разрешений: человек его пройдёт, а не закроет
  // вслепую. Если он не закрывается — это блокер, за ним не видно приложения.
  await phone.step('первый запуск: разрешения', 'Продолжить', async () => {
    const skip = page.getByRole('button', { name: 'Продолжить' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByRole('button', { name: /Проверка сети|Проверка/ }).first().waitFor({ timeout: 15_000 });
  });
  await phone.shot('00-start');

  // ---- Проход по всем вкладкам нижней навигации -------------------------
  // Явные aria-label вкладок. Раньше здесь стояли regex вида /VPN/ и /Сайты/:
  // /VPN/ первым находил заголовок «VPN» внутри каталога, и проход оставался
  // на чужой вкладке, ничего не замечая.
  const tabs: Array<[string, string, RegExp]> = [
    ['scanner', 'Проверка сети', /Что с вашим интернетом/],
    ['sites', 'Каталог сайтов', /Каталог сайтов/],
    ['vpn', 'VPN-узлы', /VPN|Подписк/i],
    ['speed', 'Скорость', /скорость интернета/i],
    ['incidents', 'Сбои и белые списки', /Карта сбоев/],
    ['history', 'История', /История/],
  ];
  for (const [id, label, heading] of tabs) {
    await phone.step(`вкладка ${id}`, label, async () => {
      await phone.tap(label, { exact: true });
      await page.waitForTimeout(700);
      await assertNoOnboarding(phone, `вкладка ${id}`);
      const text = (await page.locator('body').innerText()).trim();
      if (text.length < 40) throw new Error('вкладка открылась пустой');
      // Проверяем, что открылась ИМЕННО эта вкладка, а не остались на прошлой.
      const active = await page.evaluate(() => {
        const current = document.querySelector('nav [aria-current="page"]');
        return current ? current.getAttribute('aria-label') : null;
      });
      if (active !== label) throw new Error('активная вкладка «' + active + '», ожидалась «' + label + '»');
      if (!heading.test(text)) throw new Error('на вкладке нет ожидаемого заголовка ' + heading);
    });
    await phone.layoutCheck(`вкладка ${id}`);
    await phone.shot(`tab-${id}`);
  }

  // ---- Скорость: полный замер + замер YouTube --------------------------
  await phone.step('скорость: открыть экран', 'Скорость', async () => {
    await phone.tap(/Скорость/);
    // Ждём появления кнопки, но НЕ нажимаем: иначе замер начнётся здесь, и
    // следующий шаг будет искать «Замерить» во время уже идущего замера.
    await page.waitForTimeout(800);
    if (!(await phone.visible(/^(Замерить|Повторить)$/))) throw new Error('на экране скорости нет кнопки замера');
  });
  await phone.step('скорость: замер', 'Замерить', async () => {
    await phone.tap(/^(Замерить|Повторить)$/);
    // Ждём возврата кнопки — замер закончился сам. Если кнопка «Остановить»
    // висит дольше 90 с, это зависание: его нельзя пропустить молча.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 90_000) {
      if (await phone.visible(/^(Замерить|Повторить)$/)) { await page.waitForTimeout(400); return; }
      await page.waitForTimeout(400);
    }
    throw new Error('замер не закончился за 90 с — экран завис на «Остановить»');
  });
  await phone.step('скорость: результат', 'числа замера', async () => {
    await page.waitForTimeout(800);
  });
  await phone.shot('speed-result');
  await checkSpeedNumbers(phone);

  // ---- YouTube: 403 у видеоголовки, живые картинки ---------------------
  await phone.step('youtube: замер', 'Замерить YouTube', async () => {
    await phone.tap(/Замерить YouTube|Повторить замер YouTube/);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 90_000) {
      if (await phone.visible(/Замерить YouTube|Повторить замер YouTube/)) { await page.waitForTimeout(400); return; }
      await page.waitForTimeout(400);
    }
    throw new Error('замер YouTube не закончился за 90 с — экран завис');
  });
  await phone.step('youtube: результат', 'вердикт качества', async () => {
    await page.waitForTimeout(600);
  });
  await phone.shot('youtube-result');
  await checkYoutube(phone);

  // ---- Живые сценарии, которые человек создаёт сам ---------------------
  // 1. Выключили VPN. Маршрут должен вернуться на прямой без «выход сменился».
  await phone.step('VPN выключен', 'vpn off', async () => {
    await page.evaluate(() => (window as unknown as { __phone: { patch(v: unknown): void } })
      .__phone.setNetwork({ systemVpn: false, appUsesVpn: false, vpnAppName: '', vpnPackage: '' }));
    await page.waitForTimeout(1500);
    const header = (await page.locator('body').innerText()).split('\n').slice(0, 3).join(' | ');
    if (!/203\.0\.113\.20|прям|без VPN/i.test(header)) {
      throw new Error('после выключения VPN шапка не вернулась на прямой маршрут: ' + header.slice(0, 80));
    }
  });
  await phone.layoutCheck('после выключения VPN');
  await phone.shot('vpn-off');

  // 2. Разрыв сети: замер обязан закончиться отказом, а не висеть.
  await phone.step('сеть пропала', 'offline', async () => {
    await page.evaluate(() => (window as unknown as { __phone: { patch(v: unknown): void } })
      .__phone.setNetwork({ connected: false, kind: 'none' }));
    await page.waitForTimeout(1200);
    await phone.tap(/Скорость/);
    await page.waitForTimeout(500);
    await phone.tap(/^(Замерить|Повторить)$/);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      if (await phone.visible(/^(Замерить|Повторить)$/)) break;
      await page.waitForTimeout(400);
    }
    if (Date.now() - startedAt >= 60_000) throw new Error('без сети замер не завершился за 60 с');
    await page.waitForTimeout(500);
    // Честный отказ: «не состоялся», а не «0 Мбит/с».
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (/Нет доступного сервера|Замер не состоялся|сети нет|DNS/i.test(text) === false) {
      throw new Error('отказа без сети не видно: ' + text.slice(0, 120));
    }
  });
  await phone.shot('offline-speed');

  // 3. Сеть вернулась, точка замера отвечает отказом: только это не 0 бит.
  await phone.step('точка замера отказывает', 'HTTP 403', async () => {
    await page.evaluate(() => (window as unknown as { __phone: { patch(v: unknown): void } })
      .__phone.setNetwork({ connected: true, kind: 'wifi', blockedHosts: ['speed.cloudflare.com'] }));
    await page.waitForTimeout(800);
    await phone.tap(/Скорость/);
    await page.waitForTimeout(500);
    await phone.tap(/^(Замерить|Повторить)$/);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      if (await phone.visible(/^(Замерить|Повторить)$/)) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(600);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (!/403/.test(text)) phone.note({ severity: 'minor', area: 'скорость', title: 'Код отказа не показан',
      detail: 'при HTTP 403 от точки замера пользователь не видит код — сложно отличить блокировку от лимита' });
  });
  await phone.shot('speed-403');

  // 4. Шестерёнка в шапке: светлая тема и обратно. «Настройки» под шкалой —
  //    это панель параметров замера, а не тема: раньше шаг жал не ту кнопку.
  await phone.step('светлая тема', 'шестерёнка → Светлая', async () => {
    await phone.tap('Настройки', { exact: true });
    await page.waitForTimeout(700);
    await phone.tap('Светлая', { exact: true });
    await page.waitForTimeout(600);
    // applyTheme() в src/lib/appSettings.ts вешает класс light/dark на <html>.
    const theme = await page.evaluate(() => ({
      className: document.documentElement.className,
      colorScheme: document.documentElement.style.colorScheme,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    if (!theme.className.includes('light') || theme.colorScheme !== 'light') {
      throw new Error('светлая тема не применилась: ' + JSON.stringify(theme));
    }
  });
  await phone.layoutCheck('светлая тема');
  await phone.shot('light-theme');
  await phone.step('тёмная тема', 'шестерёнка → Тёмная', async () => {
    await phone.tap('Тёмная', { exact: true });
    await page.waitForTimeout(600);
  });
  await phone.shot('dark-theme');
  // Шит настроек закрываем «Готово»: иначе он перекрывает нижнюю навигацию и
  // следующие шаги не могут нажать вкладку — ровно так это и выглядело на
  // телефоне, пока проход не научился его закрывать.
  await phone.step('закрыть настройки', 'Готово', async () => {
    await phone.tap('Готово', { exact: true });
    await page.waitForTimeout(700);
    if (await phone.visible('Оформление', { exact: true })) {
      await phone.tap('Закрыть', { exact: true });
      await page.waitForTimeout(500);
    }
    if (await phone.visible('Оформление', { exact: true })) throw new Error('шит настроек не закрылся');
  });

  // 5. Каталог сайтов: поиск и отметка «не открывается» — главный сценарий,
  //    ради которого приложение ставят.
  await phone.step('каталог: поиск и провал сайта', 'Сайты', async () => {
    await phone.tap('Каталог сайтов', { exact: true });
    await page.waitForTimeout(900);
    const search = page.getByPlaceholder(/Поиск|Найти/i).first();
    if (!(await search.isVisible().catch(() => false))) throw new Error('нет поля поиска в каталоге');
    await search.fill('youtube');
    await page.waitForTimeout(700);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (!/youtube/i.test(text)) throw new Error('поиск не нашёл YouTube');
    await phone.shot('sites-search');
  });

  // 6. «Скопировать отчёт» на вкладке проверки: кнопка должна класть текст в
  //    буфер, а не молча ничего не делать.
  await phone.step('проверка: скопировать отчёт', 'Проверка → Скопировать отчёт', async () => {
    await phone.tap('Проверка сети', { exact: true });
    await page.waitForTimeout(900);
    if (!(await phone.visible('Скопировать отчёт', { exact: true }))) {
      // Отчёт появляется после проверки — запускаем быструю, если её нет.
      // Главная кнопка — «Проверить сеть · 75 сайтов», а не просто «Проверить».
      if (await phone.visible(/^Проверить сеть/)) {
        await phone.tap(/^Проверить сеть/);
        // Полный проход по каталогу в автономном API идёт несколько секунд:
        // ждём не фиксированную паузу, а появление отчёта.
        for (let i = 0; i < 40; i += 1) {
          await page.waitForTimeout(500);
          if (await phone.visible('Скопировать отчёт', { exact: true })) break;
        }
      }
    }
    if (!(await phone.visible('Скопировать отчёт', { exact: true }))) {
      phone.note({ severity: 'minor', area: 'проверка', title: 'Кнопки отчёта нет до результата',
        detail: 'на вкладке «Проверка» без свежего результата нельзя скопировать отчёт — это ожидаемо, но проверка не выполнена' });
      return;
    }
    await phone.tap('Скопировать отчёт', { exact: true });
    await page.waitForTimeout(900);
    const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (!text || text.length < 20) {
      throw new Error('буфер пуст после «Скопировать отчёт»: ' + JSON.stringify(text));
    }
    if (!(await phone.visible('Скопировано', { exact: true }))) {
      phone.note({ severity: 'minor', area: 'проверка', title: 'Нет подтверждения копирования',
        detail: 'текст скопирован, но кнопка не сменилась на «Скопировано»' });
    }
    await phone.shot('copy-report');
  });

  // 7. Форма сбоя: открыть, заполнить, отправить. Проверяем, что отчёт
  //    действительно появился в списке, а не потерялся.
  await phone.step('форма сбоя: отправить отчёт', 'Сбои → Сообщить о сбое', async () => {
    await phone.tap('Сбои и белые списки', { exact: true });
    await page.waitForTimeout(900);
    const trigger = (await phone.visible('Сообщить о сбое', { exact: true })) ? 'Сообщить о сбое' : 'Добавить отчёт';
    await phone.tap(trigger, { exact: true });
    await page.waitForTimeout(700);
    await page.getByPlaceholder('Например: на МТС работают только ВК и Госуслуги').fill('Эмулятор: проверка формы');
    await page.getByPlaceholder(/Что именно не работает/).fill('Белые списки, проверено эмулятором телефона.');
    await page.waitForTimeout(300);
    await phone.tap(/^(Сохранить отчёт|Опубликовать)$/);
    await page.waitForTimeout(2500);
    // Шит должен закрыться сам: пока он открыт, заголовок есть только в поле
    // ввода, и проверка «отчёт в списке» ничего не доказывает.
    if (await page.getByPlaceholder('Например: на МТС работают только ВК и Госуслуги').isVisible().catch(() => false)) {
      const toast = ((await page.locator('body').innerText()).match(/Ошибка запроса \(\d+\)|Ошибка[^\n]{0,60}/) || [''])[0];
      throw new Error('форма не закрылась после сохранения' + (toast ? ': ' + toast : ''));
    }
    await phone.tap('Сбои и белые списки', { exact: true });
    await page.waitForTimeout(800);
    // Заголовок отчёта — текст карточки, а не кнопка: getByRole его не увидит.
    const listed = await page.getByText('Эмулятор: проверка формы', { exact: true })
      .first().isVisible().catch(() => false);
    if (!listed) throw new Error('отчёт не появился в списке после сохранения');
  });
  await phone.shot('incident-created');

  // 8. Замер скорости обязан осесть в «Истории замеров» на экране скорости.
  //    Вкладка «История» — про проверки сайтов, и путать их нельзя: раньше шаг
  //    искал замер не там и «находил» пустоту при сохранённом результате.
  await phone.step('история замеров: запись сохранена', 'Скорость → История замеров', async () => {
    await phone.tap('Скорость', { exact: true });
    await page.waitForTimeout(900);
    const saved = await page.getByText('История замеров', { exact: true }).first().isVisible().catch(() => false);
    if (!saved) throw new Error('нет блока «История замеров» на экране скорости');
    const block = page.getByText('История замеров', { exact: true }).first();
    await block.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    // Смотрим текст рядом с блоком истории, а не всю страницу: «62» встречается
    // и в сводке конфигов, и в предыдущих проверках.
    const around = await page.evaluate(() => {
      const title = Array.from(document.querySelectorAll('div'))
        .find((node) => node.textContent?.trim() === 'История замеров');
      const card = title?.parentElement?.parentElement;
      return (card?.textContent || '').replace(/\s+/g, ' ').trim();
    });
    if (/Замеров пока нет/.test(around)) throw new Error('история замеров пуста после сохранения');
    if (!/62/.test(around)) throw new Error('в истории замеров нет результата 62 Мбит/с: ' + around.slice(0, 120));
  });
  await phone.shot('speed-history-saved');

  // 9. Все выбранные подписи в селектах должны влезать в поле. WebView режет
  //    длинный текст без многоточия: «Автоматически (свой сервер → Cloudfla…»
  //    и «Не указан — замер сохранится без име…» видел пользователь.
  await phone.step('настройки: подписи в селектах влезают', 'Сервер и конфиг', async () => {
    await phone.tap('Настройки', { exact: true });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('select'))
      .filter((select) => select.offsetParent)
      .map((select) => {
        const box = select.getBoundingClientRect();
        const canvas = document.createElement('canvas').getContext('2d');
        const style = getComputedStyle(select);
        if (canvas) canvas.font = style.fontSize + ' ' + style.fontFamily;
        const text = (select.selectedOptions[0]?.textContent || '').trim();
        const width = canvas ? canvas.measureText(text).width : 0;
        // 24 px отступов + место под стрелку.
        return { text, width: Math.round(width), available: Math.round(box.width - 30) };
      })
      .filter((item) => item.width > item.available));
    if (overflow.length) {
      throw new Error('подпись обрезается: ' + overflow.map((item) => `«${item.text}» ${item.width} > ${item.available} px`).join('; '));
    }
  });
  await phone.shot('speed-settings');

  // 10. Замер YouTube даёт цифру, а не «не отдал данные». Мок сети отдаёт
  //     байты — значит любая пустота здесь означает дефект приложения.
  await phone.step('YouTube: замер даёт цифру', 'Скорость → Замерить YouTube', async () => {
    // Предыдущий шаг оставил открытой шторку настроек: она перекрывала нижнюю
    // навигацию, и тап по «Скорость» не доходил (клик перехватывал оверлей).
    if (await phone.visible('Готово', { exact: true })) {
      await phone.tap('Готово', { exact: true });
      await page.waitForTimeout(700);
    }
    // Раньше проход намеренно ломал сеть (без VPN, мёртвые хосты). Для замера
    // YouTube возвращаем нормальный маршрут — иначе проверяем не замер, а
    // последствия предыдущего шага.
    await page.evaluate(() => (window as unknown as { __phone: { patch(v: unknown): void } }).__phone.patch({
      connected: true, kind: 'wifi', systemVpn: true, appUsesVpn: true,
      vpnPackage: 'com.v2ray.ang', vpnAppName: 'v2rayNG',
      blockedHosts: [], deadSpeedHosts: [], mbps: 62, latencyMs: 34,
    }));
    await page.waitForTimeout(1800);
    await phone.tap('Скорость', { exact: true });
    // Блок YouTube ниже спидометра: ждём кнопку, а не фиксированную паузу.
    // Раньше шаг тапал в пустоту — кнопка ещё не была отрисована.
    const ytButton = page.getByRole('button', { name: /^(Замерить YouTube|Повторить замер YouTube)$/ });
    await ytButton.first().waitFor({ timeout: 15_000 });
    await ytButton.first().scrollIntoViewIfNeeded();
    await ytButton.first().click();
    let verdict = '';
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const bad = text.match(/YouTube не отдал данные|YouTube не открывается|не отдал ни байта/);
      if (bad) { verdict = bad[0]; break; }
      if (/Хватит на/.test(text) || /YouTube: на какое качество хватит\s*\d/.test(text)) { verdict = 'ok'; break; }
    }
    if (verdict !== 'ok') throw new Error('замер не дал цифры: ' + (verdict || 'нет вердикта за 30 с'));
  });
  await phone.shot('youtube-measured');

  // 11. Успешный замер сам подтверждает сервис: ручное «Работает» не нужно.
  //     Раньше статус жил отдельно от замера — человек видел цифру и
  //     одновременно «приложение не подтверждено».
  await phone.step('YouTube: статус подтверждён замером', 'Скорость → замер → Проверка → YouTube', async () => {
    let confirmed = false;
    for (let i = 0; i < 12; i++) {
      confirmed = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/app-confirmations');
          if (!res.ok) return false;
          const data = (await res.json()) as { confirmations?: Array<{ service_id: string; works: boolean }> };
          return Boolean(data.confirmations?.some((item) => item.service_id === 'youtube' && item.works));
        } catch { return false; }
      });
      if (confirmed) break;
      await page.waitForTimeout(1000);
    }
    if (!confirmed) throw new Error('замер прошёл, но подтверждение сервиса не сохранилось');
    // Чистый вход на вкладку: после шагов с поломанной сетью на экране
    // остаётся прошлая серия «0/75», и её текст перебивает карточку сервиса.
    // Человек в такой ситуации просто перезапускает экран.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await phone.tap('Проверка сети', { exact: true });
    await page.waitForTimeout(2000);
    // Статус читаем в блоке «Мои сервисы» — именно там человек видит плитку
    // «YouTube · приложение работает · подтверждено». Раньше шаг кликал по
    // тексту и попадал не в карточку: шторка не открывалась, а «не
    // подтверждено» находилось где-то ниже в списке сайтов.
    const tile = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll('*'))
        .find((el) => el.children.length === 0 && (el.textContent || '').trim() === 'YouTube');
      let box = node?.parentElement;
      for (let i = 0; i < 3 && box; i++) {
        if ((box.textContent || '').includes('приложение') || (box.textContent || '').includes('подтвержд')) break;
        box = box.parentElement;
      }
      return (box?.textContent || '').replace(/\s+/g, ' ').trim();
    });
    if (!tile) throw new Error('плитка YouTube не найдена в «Моих сервисах»');
    if (/не подтверждено/.test(tile)) throw new Error('плитка YouTube всё ещё «не подтверждено» после успешного замера: ' + tile.slice(0, 160));
    if (!/приложение работает/.test(tile)) throw new Error('плитка YouTube без статуса «приложение работает»: ' + tile.slice(0, 160));
  });
  await phone.shot('youtube-auto-confirmed');

  // 12. Настоящий замер сайтов: ветка «через VPN». Раньше в проходе её не было,
  //     и дефект мока (HTML на favicon) делал её «зелёной»: все 75 сайтов
  //     помечались заблокированными, а вёрстка вердикта обрезала вывод.
  await phone.step('проверка сети: замер даёт вердикт', 'Проверить сеть → с VPN', async () => {
    // Предыдущий шаг мог оставить открытой шторку сервиса: она перекрывает
    // главный экран, и тап по «Проверить сеть» не доходит.
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);
    if (await page.getByRole('button', { name: 'Понятно' }).first().isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Понятно' }).first().click();
      await page.waitForTimeout(500);
    }
    await phone.tap('Проверка сети', { exact: true });
    await page.waitForTimeout(1500);
    // После прошлого замера главная кнопка называется «Повторить замер сети»,
    // а до него — «Проверить сеть»: принимаем оба названия, как и человек.
    const mainBtn = page.getByRole('button', { name: /^(Проверить сеть|Повторить замер сети)$/ }).first();
    if (!(await mainBtn.isVisible().catch(() => false))) {
      const now = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160);
      throw new Error('кнопки запуска проверки нет на экране. Видно: ' + (now || '(пусто)'));
    }
    await mainBtn.click();
    await page.waitForTimeout(1500);
    const vpnSheet = page.getByRole('button', { name: /Проверить с включённым VPN/ });
    if (await vpnSheet.isVisible().catch(() => false)) {
      await vpnSheet.click();
    } else if (await phone.visible('Отмена', { exact: true })) {
      // VPN уже выключен проходом выше — проверяем прямой маршрут.
      await phone.tap('Отмена', { exact: true });
      await page.getByRole('button', { name: /^(Проверить сеть|Повторить замер сети)$/ }).first().click();
    }
    let verdict = '';
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const hit = text.match(/Интернет открыт|Жёсткие ограничения|Белые списки|Шатдаун|Частные ограничения|Часть сайтов недоступна|Сеть не отвечает/);
      if (hit && !/прошло \d+ с/.test(text)) { verdict = hit[0]; break; }
    }
    if (!verdict) throw new Error('замер не дал вердикта за 40 с');
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    // При живом моке «0 из 75» — это провал проверки, а не плохая сеть.
    const answered = text.match(/(\d+)\s*\/\s*(\d+)\s*отвечают/);
    if (answered && Number(answered[1]) === 0) {
      throw new Error('ни один из сайтов не ответил при живом моке — проверка сломана, а не сеть');
    }
    // Вывод вердикта не должен обрываться многоточием на середине фразы.
    const summary = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll('p'))
        .find((el) => (el.textContent || '').length > 60 && /Работает|отвечают|Открываются/.test(el.textContent || ''));
      if (!node) return null;
      const clamped = getComputedStyle(node).webkitLineClamp;
      return { clamp: clamped, truncated: node.scrollHeight > node.clientHeight + 2 };
    });
    if (summary && (summary.clamp === '2' || summary.truncated)) {
      throw new Error('сводка вердикта обрезана: пользователь не дочитывает главный вывод');
    }
  });
  await phone.shot('scan-verdict');

  // 13. Тост не должен перехватывать клики и растягиваться на пол-экрана.
  //     На экране «VPN-узлы» плашка «Узел добавлен» висела ровно над кнопкой
  //     «Проверить»: тап уходил в пустую плашку, проверка узлов не запускалась.
  await phone.step('узел вручную: тост не перекрывает кнопки', 'VPN-узлы → Узел вручную → Сохранить', async () => {
    await phone.tap('VPN-узлы', { exact: true });
    await page.waitForTimeout(900);
    await phone.tap('Узел вручную', { exact: true });
    await page.waitForTimeout(900);
    await page.getByPlaceholder('NL Амстердам — Reality')
      .fill('Эмулятор: длинное название узла для проверки переноса');
    await page.getByPlaceholder('nl1.example.com').fill('nl1.example.com');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForTimeout(800);
    const toast = await page.evaluate(() => {
      const el = document.querySelector('[role="status"]') as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { h: Math.round(r.height), pointer: getComputedStyle(el).pointerEvents };
    });
    if (!toast) throw new Error('тост о добавлении узла не появился');
    if (toast.h > 96) throw new Error(`тост раздулся до ${toast.h} px и закрывает экран`);
    if (toast.pointer === 'auto') throw new Error('тост перехватывает клики: кнопки под ним недоступны');
    // Список узлов перерисовывается после сохранения: ждём кнопку, а не
    // фиксированную паузу.
    const check = page.getByRole('button', { name: /^Проверить$/ }).first();
    await check.waitFor({ timeout: 10_000 });
    await check.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await check.boundingBox();
    if (!box) throw new Error('нет кнопки «Проверить» после добавления узла');
    const under = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return el?.closest('button')?.textContent?.trim().slice(0, 20) || el?.tagName || 'null';
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    if (under !== 'Проверить') throw new Error(`в точке «Проверить» лежит «${under}» — тап не дойдёт`);
  });
  await phone.shot('vpn-manual-node');

  // 14. Ссылка подписки без http:// не должна превращаться в демо-набор узлов.
  //     В APK это выглядело как «подписка загружена: 8 узлов», хотя ссылки нет.
  await phone.step('подписка: строка без http отклоняется', 'Добавить подписку → Загрузить', async () => {
    const before = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
    await phone.tap('Добавить подписку', { exact: true });
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
    if (after <= before) throw new Error('окно подписки не открылось');
    await page.getByPlaceholder('https://panel.example.com/sub/…').fill('просто текст');
    await page.getByRole('button', { name: 'Загрузить подписку' }).click();
    await page.waitForTimeout(2500);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (/Подписка загружена/.test(text)) throw new Error('строка без http принята как подписка');
    if (!/начинаться с http/i.test(text)) throw new Error('нет объяснения, что ссылка должна начинаться с http: ' + text.slice(0, 140));
    await page.getByRole('button', { name: /Отмена|Закрыть|Скрыть/ }).first().click().catch(() => undefined);
    await page.waitForTimeout(600);
  });
  await phone.shot('subscription-invalid');

  // 15. Обновление приложения: релиз новее установленного → видимый прогресс →
  //     установщик. Раньше мок плагина не совпадал с Java, и путь не
  //     проверялся вовсе: пользователь видел «всегда ошибка».
  await phone.step('обновление: прогресс и установщик', 'Скачать и установить → установка', async () => {
    await page.route('**/api.github.com/**', (route) => route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({
        html_url: 'https://github.com/Finish11/-/releases/tag/android-latest',
        body: 'Версия: 9.9.9 (versionCode 999999999)',
        assets: [{ name: 'pulsenet-debug.apk', size: 4_914_631,
          browser_download_url: 'https://github.com/Finish11/-/releases/download/android-latest/pulsenet-debug.apk' }],
      }),
    }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const seen: string[] = [];
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(800);
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const progress = text.match(/Скачиваем APK: (\d+)%/);
      if (progress) seen.push(progress[0]);
      if (/Скачать и установить/.test(text)) { ready = true; break; }
    }
    if (!ready) throw new Error('карточка обновления не появилась: ' + seen.join(', '));
    await phone.tap('Скачать и установить', { exact: true });
    let reached = '';
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(700);
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const progress = text.match(/Скачиваем APK: (\d+)%/);
      if (progress) seen.push(progress[0]);
      if (/Установщик открыт/.test(text)) { reached = 'install'; break; }
      if (/Нужно разрешение/.test(text)) { reached = 'permission'; break; }
      if (/Загрузка прервалась|Не удалось скачать/.test(text)) { reached = 'error'; break; }
    }
    if (reached === 'error') throw new Error('обновление закончилось ошибкой при живом «DownloadManager»: ' + seen.join(', '));
    if (!reached) throw new Error('загрузка не дошла до установки за 14 с: ' + (seen.join(', ') || 'нет процентов'));
    if (!seen.length) throw new Error('прогресс загрузки не показывался — «окно загрузки» отсутствует');
  });
  await phone.shot('update-progress');

  const result = await close();
  await writeFile(path.join(outDir, 'README.md'), renderReport(result), 'utf8');
  printSummary(result.findings, result.steps, outDir);
  process.exitCode = result.findings.some((f) => f.severity === 'blocker') ? 1 : 0;
}

/**
 * Шит разрешений показывается один раз, на первом запуске. Если он всплывает
 * снова посреди работы — это блокер: человек теряет экран и не понимает, что
 * нажал. Ловим сразу и говорим, на каком экране.
 */
async function assertNoOnboarding(phone: Awaited<ReturnType<typeof openPhone>>['phone'], area: string) {
  if (await phone.visible('Продолжить', { exact: true })) {
    const intro = await phone.page.evaluate(() => {
      try { return localStorage.getItem('pulsenet_permissions_intro_v1'); } catch { return 'нет доступа'; }
    });
    phone.note({
      severity: 'blocker', area,
      title: 'Шит разрешений вернулся посреди работы',
      detail: `экран перекрыт «Разрешения для ПульсСети»; метка прохождения = ${String(intro)}`,
      screenshot: await phone.shot('onboarding-again'),
    });
  }
}

/** Скорость: ноль и пустые карточки — это провал, а не «быстрый канал». */
async function checkSpeedNumbers(phone: Awaited<ReturnType<typeof openPhone>>['phone']) {
  const text = await phone.page.locator('main, body').first().innerText();
  if (/Замер не состоялся|Нет доступного сервера/.test(text)) {
    phone.note({ severity: 'blocker', area: 'скорость', title: 'Замер не состоялся',
      detail: 'Экран сообщает о провале вместо результата — проверьте точку замера и мок сети' });
  }
  const numbers = await phone.page.locator('.tabular-nums').allTextContents();
  const zero = numbers.filter((value) => /^0([.,]00)?$/.test(value.trim()));
  if (zero.length >= 2) {
    phone.note({ severity: 'major', area: 'скорость', title: 'Нули в результате',
      detail: `нулевых значений: ${zero.length} — похоже на учёт байтов` });
  }
}

/** YouTube: «0 бит» при живом CDN — это ровно та жалоба, что чинили. */
async function checkYoutube(phone: Awaited<ReturnType<typeof openPhone>>['phone']) {
  const text = await phone.page.locator('body').innerText();
  if (/не отдал ни байта/i.test(text) && !/HTTP 403/.test(text)) {
    phone.note({ severity: 'blocker', area: 'youtube', title: 'YouTube: нет данных без объяснения',
      detail: 'замер не дал байтов, но в причинах нет кода отказа' });
  }
  if (/0[.,]00\s*Мбит\/с/.test(text) && /YouTube/.test(text)) {
    phone.note({ severity: 'major', area: 'youtube', title: 'YouTube показывает «0 бит»',
      detail: 'нулевая скорость выдаётся за измерение' });
  }
}

function renderReport(result: Awaited<ReturnType<typeof openPhone>> extends never ? never : {
  steps: Array<{ index: number; action: string; target?: string; ok: boolean; detail?: string; screenshot?: string; ms: number }>;
  findings: Finding[]; console: Array<{ type: string; text: string }>; pageErrors: string[];
  screenshotsDir: string;
}) {
  const lines: string[] = [];
  lines.push('# Проход по приложению «как человек»', '');
  lines.push(`Снимки: \`${result.screenshotsDir}\`. Шагов: ${result.steps.length}.`, '');
  lines.push('## Замечания', '');
  if (!result.findings.length) lines.push('Замечаний нет.');
  for (const finding of result.findings) {
    lines.push(`- **${finding.severity}** · ${finding.area} — ${finding.title}: ${finding.detail}`);
  }
  lines.push('', '## Шаги', '');
  for (const step of result.steps) {
    lines.push(`- ${step.ok ? '✓' : '✗'} ${step.action}${step.target ? ` — ${step.target}` : ''} (${step.ms} мс)${step.detail ? `: ${step.detail}` : ''}`);
  }
  if (result.pageErrors.length) {
    lines.push('', '## Ошибки страницы', '', ...result.pageErrors.map((error) => `- ${error}`));
  }
  return lines.join('\n');
}

function printSummary(findings: Finding[], steps: Array<{ ok: boolean }>, dir: string) {
  const failed = steps.filter((step) => !step.ok).length;
  console.log(`\nШагов: ${steps.length}, провалено: ${failed}, замечаний: ${findings.length}`);
  for (const finding of findings) console.log(`  [${finding.severity}] ${finding.area}: ${finding.title} — ${finding.detail}`);
  console.log(`Отчёт и снимки: ${dir}`);
}

main().catch(async (error) => {
  console.error('Эмулятор упал:', error);
  process.exitCode = 1;
});
