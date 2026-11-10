import { test, expect } from '@playwright/test';

/**
 * Раскладка на телефоне: нижняя панель всегда в один ряд и видна, страница
 * не выезжает за экран, а кнопка запуска замера не требует прокрутки.
 * Ширины от 320 px (старые Android) до планшета.
 */
// Доступные имена вкладок: у кнопок панели стоит aria-label из полного названия.
const TABS = ['Проверка сети', 'Каталог сайтов', 'VPN-узлы', 'Скорость', 'Сбои и белые списки', 'История'];
const WIDTHS = [320, 360, 390, 414, 768];

test('раскладка не разъезжается ни на одной вкладке и ширине', async ({ page }) => {
  // Ширины задаём сами, но прогоняем и в мобильной эмуляции: у неё свой
  // viewport-meta и dvh — именно там ломалась нижняя панель.
  const problems: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/?demo=1');
    await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
    for (const label of TABS) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const nav = document.querySelector('nav.fixed');
        const rows = new Set(Array.from(nav?.querySelectorAll('button') || []).map((b) => Math.round(b.getBoundingClientRect().top)));
        const rect = nav?.getBoundingClientRect();
        const wide = Array.from(document.querySelectorAll('main *'))
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
          .slice(0, 3)
          .map((el) => el.tagName + '.' + (typeof el.className === 'string' ? el.className.slice(0, 50) : ''));
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          navRows: rows.size,
          navVisible: Boolean(rect && rect.height > 0 && rect.bottom <= window.innerHeight + 2 && rect.top < window.innerHeight),
          wide,
        };
      });
      if (info.overflow > 1) problems.push(`${width}px «${label}»: страница шире экрана на ${info.overflow}px ${JSON.stringify(info.wide)}`);
      if (info.navRows !== 1) problems.push(`${width}px «${label}»: нижняя панель в ${info.navRows} ряда`);
      if (!info.navVisible) problems.push(`${width}px «${label}»: нижняя панель не видна`);
    }
  }
  if (problems.length) console.log(problems.join('\n'));
  expect(problems, problems.join('\n')).toEqual([]);
});

test('кнопка замера видна без прокрутки, единицы и шкала переключаются', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/?demo=1');
    await page.getByRole('button', { name: 'Скорость', exact: true }).click();
    const start = page.getByRole('button', { name: 'Замерить', exact: true }).first();
    await expect(start).toBeVisible();
    const box = await start.boundingBox();
    const nav = await page.locator('nav.fixed').boundingBox();
    expect(box, `кнопка замера на ${width}px`).not.toBeNull();
    expect(box!.y + box!.height, `кнопка замера не спрятана под панель на ${width}px`).toBeLessThan(nav!.y);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  // Настройки замера: единицы меняют подписи, потолок шкалы — деления.
  const tune = page.getByRole('button', { name: /Настройки замера/ });
  await expect(tune).toHaveAttribute('aria-expanded', 'false');
  await tune.click();
  await expect(tune).toHaveAttribute('aria-expanded', 'true');
  // Выбранные единицы и потолок объявлены скринридеру, а не только подсвечены.
  await expect(page.getByRole('button', { name: 'Мбит/с', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'МБ/с', exact: true }).click();
  await expect(page.getByRole('button', { name: 'МБ/с', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Мбит/с', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('Шкала, МБ/с')).toBeVisible();
  await expect(page.getByText('МБ/с').first()).toBeVisible();
  await page.getByRole('button', { name: 'Мбит/с', exact: true }).click();
  await page.getByRole('button', { name: '250', exact: true }).click();
  await expect(page.getByRole('button', { name: /шкала 250/ })).toBeVisible();
});

test('во время замера цифры не перекрываются указателем и шкалой', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  test.setTimeout(120_000);
  const problems: string[] = [];
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/?demo=1');
    await page.getByRole('button', { name: 'Скорость', exact: true }).click();
    await page.getByRole('button', { name: /Настройки замера/ }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Настройки замера/ }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: /^Замерить/ }).first().click();
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const svg = document.querySelector('svg[role=img]')!;
        const box = svg.getBoundingClientRect();
        const centre = svg.parentElement!.querySelector('div.absolute');
        const texts = Array.from(centre?.querySelectorAll('div') || []).map((el) => el.getBoundingClientRect());
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          outside: texts.filter((r) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)).length,
          navRows: new Set(Array.from(document.querySelectorAll('nav.fixed button')).map((b) => Math.round(b.getBoundingClientRect().top))).size,
          arc: (() => {
            const el = svg.querySelector('.gauge-arc');
            if (!el) return null;
            return { offset: Number(el.getAttribute('stroke-dashoffset')), seconds: parseFloat(getComputedStyle(el).transitionDuration) };
          })(),
          // Риски шкалы не должны наползать друг на друга: на автомасштабе они
          // считались каждая по своей ступени и собирались в кучу у конца дуги.
          labels: Array.from(svg.querySelectorAll('text')).map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: el.textContent || '' };
          }),
        };
      });
      if (info.overflow > 1) problems.push(`${width}px #${i}: страница шире экрана`);
      if (info.outside) problems.push(`${width}px #${i}: подписи замера вылезли за шкалу`);
      if (info.navRows !== 1) problems.push(`${width}px #${i}: панель в ${info.navRows} ряда`);
      if (info.arc && !(info.arc.offset >= 0 && info.arc.offset <= 1)) problems.push(`${width}px #${i}: дуга вне шкалы (${info.arc.offset})`);
      if (info.arc && !(info.arc.seconds > 0)) problems.push(`${width}px #${i}: дуга не анимируется`);
      for (let a = 0; a < info.labels.length; a += 1) {
        for (let b = a + 1; b < info.labels.length; b += 1) {
          const d = Math.hypot(info.labels[a].x - info.labels[b].x, info.labels[a].y - info.labels[b].y);
          if (d < 13) problems.push(`${width}px #${i}: риски «${info.labels[a].t}» и «${info.labels[b].t}» слиплись (${Math.round(d)} px)`);
        }
      }
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('длинный адрес и название сайта не расширяют страницу', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  // Пользовательский сайт с очень длинными строками — типичная причина
  // «компьютерного режима»: страница шире экрана, нижняя панель уезжает.
  // Имя уникально для прогона: иначе поиск находил карточки прошлых прогонов,
  // и первая из них могла быть за экраном (content-visibility её не рисует).
  const long = `очень-длинное-название-сервиса-без-пробелов-${Date.now()}`;
  const created = await page.request.post('/api/sites', {
    data: { name: `${long}-${'я'.repeat(60)}`, domain: `${'sub.'.repeat(12)}${Date.now()}.example.com`,
      probe_url: `https://${'segment-'.repeat(15)}example.com/${'path/'.repeat(10)}check`,
      category: 'other', marker_role: 'global_neutral', description: 'x'.repeat(240) },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  // Список приходит с сервера при загрузке: без перезагрузки приложение держит
  // прежний набор, и тест проверял бы пустое место (на чистой базе CI так и было).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Каталог сайтов', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить все сайты' })).toBeVisible();
  // Поиск оставляет одну карточку — она точно на экране, а не за пределами списка.
  await page.getByPlaceholder('Поиск: youtube, госуслуги, steam').fill(long);
  await expect(page.getByText(`${long}-`, { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const nav = document.querySelector('nav.fixed')!.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      navRows: new Set(Array.from(document.querySelectorAll('nav.fixed button')).map((b) => Math.round(b.getBoundingClientRect().top))).size,
      navVisible: nav.bottom <= window.innerHeight + 2 && nav.height > 0,
    };
  });
  expect(info.overflow, 'страница не должна становиться шире экрана').toBeLessThanOrEqual(1);
  expect(info.navRows).toBe(1);
  expect(info.navVisible).toBe(true);

  // Модальное окно с длинным адресом проверки — ещё один типичный источник
  // горизонтального выезда и недоступных кнопок.
  await page.getByTitle('Изменить').last().click();
  await expect(page.getByRole('button', { name: 'Отмена' })).toBeVisible();
  // Шторка выезжает снизу: измеряем после анимации, а не в её середине.
  await page.waitForTimeout(450);
  const modal = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cancelBottom: Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Отмена')!.getBoundingClientRect().bottom,
    vh: window.innerHeight,
  }));
  expect(modal.overflow, 'окно не шире экрана').toBeLessThanOrEqual(1);
  expect(modal.cancelBottom, 'кнопки окна достижимы').toBeLessThanOrEqual(modal.vh + 1);
  await page.getByRole('button', { name: 'Отмена' }).click();
  // Убираем за собой: тест не должен накапливать сайты в базе прогонов.
  const body = await created.json() as { id?: number; site?: { id?: number } };
  const id = body.id ?? body.site?.id;
  if (id) await page.request.delete(`/api/sites/${id}`);
});

test('настройки: режим проверки и единицы выбираются на узком экране', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Настройки/ }).first().click();
  await expect(page.getByText('Замеры и проверки')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Сбалансированно/ }).click();
  await page.getByRole('button', { name: 'МБ/с', exact: true }).click();
  await page.waitForTimeout(350);
  const info = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vh: window.innerHeight,
    sheetBottom: document.querySelector('.sheet-panel')!.getBoundingClientRect().bottom,
  }));
  expect(info.overflow).toBeLessThanOrEqual(1);
  expect(info.sheetBottom, 'шторка настроек не выезжает за экран').toBeLessThanOrEqual(info.vh + 1);
  // Выбор сохраняется и виден после перезагрузки.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Настройки/ }).first().click();
  await expect(page.getByText('Замеры и проверки')).toBeVisible({ timeout: 15_000 });
  const balanced = page.getByRole('button', { name: /Сбалансированно/ });
  await expect(balanced).toHaveAttribute('style', /accent/);
  await expect(balanced).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Быстро/ }).click();
  await page.getByRole('button', { name: 'Мбит/с', exact: true }).click();
});

test('во время проверки сайтов раскладка держится, а список обновляется', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^(Проверить|Повторить замер)/ }).first().click();
  const problems: string[] = [];
  let sawProgress = false, sawTimer = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const nav = document.querySelector('nav.fixed')!.getBoundingClientRect();
      const text = document.querySelector('main')!.textContent || '';
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        navRows: new Set(Array.from(document.querySelectorAll('nav.fixed button')).map((b) => Math.round(b.getBoundingClientRect().top))).size,
        navVisible: nav.height > 0 && nav.bottom <= window.innerHeight + 2,
        // Прогресс проверки: «N / 75» и секундомер с пределом.
        progress: /\d+\s*\/\s*\d+/.test(text),
        timer: /прошло \d+ с · предел \d+ с/.test(text),
      };
    });
    if (info.progress) sawProgress = true;
    if (info.timer) sawTimer = true;
    if (info.overflow > 1) problems.push(`шаг ${i}: страница шире экрана на ${info.overflow}px`);
    if (info.navRows !== 1) problems.push(`шаг ${i}: панель в ${info.navRows} ряда`);
    if (!info.navVisible) problems.push(`шаг ${i}: нижняя панель скрыта`);
  }
  expect(sawProgress, 'проверка должна показывать прогресс').toBe(true);
  expect(sawTimer, 'во время проверки видно, сколько прошло и какой предел').toBe(true);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('кнопки в карточках сайтов удобно нажимать пальцем', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Каталог сайтов', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить все сайты' })).toBeVisible();
  const sizes = await page.evaluate(() => {
    const pick = (title: string) => {
      const el = document.querySelector(`main [title="${title}"]`) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const toggle = document.querySelector('main [aria-label="Отключить сайт"]') as HTMLElement | null;
    const tr = toggle?.getBoundingClientRect();
    return { ping: pick('Проверить сейчас'), edit: pick('Изменить'), del: pick('Удалить'),
      toggle: tr ? { w: Math.round(tr.width), h: Math.round(tr.height) } : null };
  });
  for (const [name, box] of Object.entries(sizes)) {
    expect(box, `кнопка ${name} есть на экране`).not.toBeNull();
    expect(box!.w, `ширина зоны нажатия ${name}`).toBeGreaterThanOrEqual(name === 'toggle' ? 44 : 36);
    expect(box!.h, `высота зоны нажатия ${name}`).toBeGreaterThanOrEqual(name === 'toggle' ? 32 : 36);
  }
});

test('настройки прокручиваются до конца на маленьком экране', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Настройки/ }).first().click();
  await expect(page.getByText('Замеры и проверки')).toBeVisible({ timeout: 15_000 });
  // Самый низ шторки — версия сборки: если она достигается, достигается всё.
  const scrolled = await page.evaluate(async () => {
    const body = document.querySelector('.sheet-panel .overflow-y-auto') as HTMLElement | null;
    if (!body) return { ok: false, reason: 'нет прокручиваемого тела' };
    body.scrollTop = body.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { ok: body.scrollTop > 0, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(scrolled.ok, `шторка должна прокручиваться: ${JSON.stringify(scrolled)}`).toBe(true);
  expect(scrolled.overflow).toBeLessThanOrEqual(1);
  await expect(page.getByText(/\d+\.\d+\.\d+ · веб/)).toBeVisible();
});

test('проверка всех сайтов укладывается в обещанное время и честно отчитывается', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Каталог сайтов', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить все сайты' })).toBeVisible();
  // Быстрый режим обещает предел 22 секунды и пачки по 32 запроса — подсказка
  // не должна врать: прежний текст обещал «все сайты одновременно».
  await expect(page.getByText(/пачками по 32/)).toBeVisible();
  await expect(page.getByText(/22 с/).first()).toBeVisible();
  const started = Date.now();
  await page.getByRole('button', { name: 'Проверить все сайты' }).click();
  // Пока идёт проверка, видно секундомер и предел — «зависло на 5%» больше нет.
  await expect(page.getByText(/Идёт проверка: прошло \d+ с из 22 с/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить все сайты' })).toBeVisible({ timeout: 60_000 });
  const elapsed = Date.now() - started;
  expect(elapsed, `проверка шла ${elapsed} мс`).toBeLessThan(45_000);
  // Итог называет число сайтов, а не просто «готово».
  await expect(page.getByText(/Проверено \d+/)).toBeVisible({ timeout: 15_000 });
});

test('длинная причина отказа не сжимает название сайта в столбик', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  //Regression со скриншота пользователя: дата и причина лежали в правой
  // колонке с shrink-0, она распиралась по тексту и выдавливала название.
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  const unique = `NETFLIX-${Date.now()}`;
  const created = await page.request.post('/api/sites', {
    data: { name: unique, domain: `netflix-${Date.now()}.example.com`, category: 'streaming', marker_role: 'dpi_target' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { site } = await created.json() as { site: { id: number } };
  const patched = await page.request.patch(`/api/sites/${site.id}`, {
    data: {
      last_status: 'blocked', last_checked_at: new Date().toISOString(),
      last_note: 'вместо сайта открылась заглушка провайдера: соединение установлено, но содержимое подменено на страницу-уведомление о блокировке ресурса',
    },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Проверка сети', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Каталог сайтов', exact: true }).click();
  await page.getByPlaceholder('Поиск: youtube, госуслуги, steam').fill(unique);
  const card = page.locator('article').filter({ hasText: unique }).first();
  await expect(card).toBeVisible();
  const shape = await card.evaluate((el) => {
    const name = Array.from(el.querySelectorAll('span')).find((s) => s.textContent?.startsWith('NETFLIX-'))!;
    const note = Array.from(el.querySelectorAll('div')).find((d) => d.textContent?.includes('заглушка провайдера'))!;
    const r = el.getBoundingClientRect();
    return {
      cardHeight: Math.round(r.height), cardWidth: Math.round(r.width),
      nameWidth: Math.round(name.getBoundingClientRect().width),
      nameHeight: Math.round(name.getBoundingClientRect().height),
      noteWidth: Math.round(note.getBoundingClientRect().width),
      noteRight: Math.round(note.getBoundingClientRect().right),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  // Название занимает строку, а не столбик по букве; карточка остаётся компактной.
  expect(shape.nameWidth, `название сжато: ${JSON.stringify(shape)}`).toBeGreaterThan(100);
  expect(shape.nameHeight, `название в столбик: ${JSON.stringify(shape)}`).toBeLessThan(40);
  expect(shape.cardHeight, `карточка раздута: ${JSON.stringify(shape)}`).toBeLessThan(200);
  expect(shape.noteRight, 'подпись не выезжает за экран').toBeLessThanOrEqual(320);
  expect(shape.overflow).toBeLessThanOrEqual(1);
  await page.request.delete(`/api/sites/${site.id}`);
});


/**
 * Ловушка раскладки: длинная подпись в соседнем блоке с shrink-0 распирает его
 * по содержимому и сжимает основной текст в столбик по одной букве. Так выглядел
 * скриншот пользователя (карточка сайта высотой 545 px) и строка VPN-узла.
 * Проверяем все вкладки на трёх узких ширинах: у текстового блока не может быть
 * ширины в пару символов при высоте в десятки строк.
 */
test('нигде текст не сжат в столбик', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'ширины задаются вручную');
  test.setTimeout(180_000);
  const problems: string[] = [];
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/?demo=1');
    await page.getByRole('button', { name: 'Проверка сети', exact: true }).waitFor({ timeout: 30_000 });
    for (const tab of ['Проверка сети', 'Каталог сайтов', 'VPN-узлы', 'Скорость', 'Сбои и белые списки', 'История']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForTimeout(400);
      const squeezed = await page.evaluate(() => Array.from(document.querySelectorAll('main span, main div'))
        .filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 12)
        .map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), t: (el.textContent || '').trim().slice(0, 30) }; })
        .filter((x) => x.w > 0 && x.w < 40 && x.h > 60));
      if (squeezed.length) problems.push(`${width}px «${tab}»: ${JSON.stringify(squeezed.slice(0, 3))}`);
    }
  }
  if (problems.length) console.log(problems.join('\n'));
  expect(problems).toEqual([]);
});

test('светлая тема: текст не остаётся белым на белом', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'проверяем цвета один раз');
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('pulsenet_settings_v1', JSON.stringify({ theme: 'light' })));
  await page.goto('/');
  const contrast = async (selector: string) => page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const parse = (value: string) => {
      const nums = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return nums.length >= 3 ? nums.slice(0, 3) : null;
    };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Полупрозрачный фон — не фон: идём вверх до первого непрозрачного слоя,
    // иначе прозрачный body давал ложный «чёрный» и любой текст считался тёмным.
    const alphaOf = (value: string) => {
      const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return parts.length >= 4 ? parts[3] : parts.length === 3 ? 1 : 0;
    };
    const fg = parse(getComputedStyle(node).color);
    let back: number[] | null = null;
    let parent: Element | null = node;
    while (parent) {
      const value = getComputedStyle(parent).backgroundColor;
      if (alphaOf(value) > 0.9 && parse(value)) { back = parse(value); break; }
      parent = parent.parentElement;
    }
    const resolvedBackground = back ?? [246, 248, 246];
    if (!fg) return null;
    const a = lum(fg), b = lum(resolvedBackground);
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
  }, selector);

  // Заголовок страницы раньше наследовал белый цвет из index.html и пропадал.
  await page.getByRole('button', { name: 'Каталог сайтов', exact: true }).click();
  const heading = await contrast('h1');
  expect(heading, 'заголовок должен читаться на светлой теме').toBeGreaterThan(4.5);
  const muted = await contrast('.text-muted');
  expect(muted, 'приглушённый текст тоже').toBeGreaterThan(4.5);

  // И на тёмной теме те же элементы не должны потемнеть.
  await page.evaluate(() => localStorage.setItem('pulsenet_settings_v1', JSON.stringify({ theme: 'dark' })));
  await page.reload();
  await page.getByRole('button', { name: 'Каталог сайтов', exact: true }).click();
  const darkHeading = await contrast('h1');
  expect(darkHeading, 'на тёмной теме заголовок светлый').toBeGreaterThan(4.5);
});
