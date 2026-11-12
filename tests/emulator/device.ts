import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { phoneInitScript, type PhoneOptions, type PhoneState } from './phone';
import { chromiumLaunch } from './chromium';

/**
 * «Телефон» для прохода по приложению как обычный человек.
 *
 * Внутри — Chromium в режиме Pixel 7 (то же устройство, что в мобильных тестах),
 * с поднятым нативным мостом Capacitor. Приложение считает себя APK и идёт по
 * тем же веткам, что на устройстве.
 *
 * Что собирается за один проход:
 *  - журнал действий (`steps`) — что нажимали и что увидели;
 *  - консоль и ошибки страницы (`console`, `pageErrors`) — JS-падения;
 *  - снимки экрана на каждом шаге;
 *  - замечания (`findings`) — залипшие состояния, пустые экраны, горизонтальное
 *    переполнение, неработающие кнопки, «0 бит» и прочее, что видит человек.
 */

export interface StepLog {
  index: number;
  action: string;
  target?: string;
  ok: boolean;
  detail?: string;
  screenshot?: string;
  ms: number;
}

export interface Finding {
  severity: 'blocker' | 'major' | 'minor';
  area: string;
  title: string;
  detail: string;
  screenshot?: string;
}

export interface PhoneRunResult {
  steps: StepLog[];
  findings: Finding[];
  console: Array<{ type: string; text: string }>;
  pageErrors: string[];
  screenshotsDir: string;
  startedAt: string;
  finishedAt: string;
}

export interface Phone {
  page: Page;
  context: BrowserContext;
  steps: StepLog[];
  findings: Finding[];
  console: Array<{ type: string; text: string }>;
  pageErrors: string[];
  /** Выполнить шаг: действие + проверка. Ошибка шага не роняет проход. */
  step<T>(action: string, target: string, run: () => Promise<T>): Promise<T | null>;
  /** Замечание руками, если проверка не универсальная. */
  note(finding: Omit<Finding, 'screenshot'> & { screenshot?: string }): void;
  /** Снимок текущего экрана. */
  shot(name: string): Promise<string>;
  /** Проверка раскладки: горизонтальное переполнение и обрезанный текст. */
  layoutCheck(area: string): Promise<void>;
  /**
   * Нажать то, что реально видно на телефоне.
   *
   * На мобильной вёрстке в DOM остаются кнопки десктопного сайдбара
   * (`hidden lg:block`). `getByRole(...).first()` попадал в них и ждал
   * кликабельности 30 секунд — проход падал на ровном месте.
   */
  tap(name: string | RegExp, options?: { exact?: boolean; index?: number }): Promise<void>;
  /** Виден ли элемент с такой подписью. */
  visible(name: string | RegExp, options?: { exact?: boolean }): Promise<boolean>;
}

// APK грузит demo.html (scripts/android-assets.mjs копирует его в index.html):
// интерфейс тот же, но /api/* обслуживает локальный API из src/demo/localApi.ts.
// Открывать / (index.html) — значит проверять не ту сборку: на телефоне нет
// backend, и сохранение отчётов шло бы другим путём.
const BASE_URL = process.env.PHONE_URL || 'http://127.0.0.1:4173/demo.html';

export async function openPhone(options: PhoneOptions & {
  outDir?: string;
  headless?: boolean;
} = {}): Promise<{ phone: Phone; browser: Browser; close: () => Promise<PhoneRunResult> }> {
  const outDir = options.outDir ?? path.resolve('/tmp/phone-shots');
  await mkdir(outDir, { recursive: true });
  const runtime = await chromiumLaunch();
  const browser = await chromium.launch({
    headless: options.headless !== false,
    executablePath: runtime.executablePath,
    args: runtime.args,
    env: runtime.env,
  });
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/126.0.0.0 Mobile Safari/537.36',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // Без разрешений clipboard.writeText() отклоняется, и кнопки «Скопировать»
    // в проходе падали бы «не удалось скопировать» — как на телефоне с
    // запрещённым доступом к буферу.
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  await page.addInitScript(phoneInitScript(options));

  const steps: StepLog[] = [];
  const findings: Finding[] = [];
  const consoleLog: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    const type = message.type();
    if (type === 'error' || type === 'warning') consoleLog.push({ type, text: message.text() });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Имя снимка не должно зависеть только от номера шага: при провале нумерация
  // сдвигается, и новый снимок молча перезаписывал прошлый — в отчёте оставался
  // старый экран от другой вкладки.
  let shots = 0;
  const shot = async (name: string) => {
    shots += 1;
    const file = path.join(outDir, `${String(shots).padStart(2, '0')}-${name.replace(/[^\wа-яА-Я-]+/gi, '_')}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  };

  const phone: Phone = {
    page, context, steps, findings, console: consoleLog, pageErrors,
    async step<T>(action: string, target: string, run: () => Promise<T>) {
      const startedAt = Date.now();
      const index = steps.length + 1;
      try {
        const value = await run();
        steps.push({ index, action, target, ok: true, ms: Date.now() - startedAt });
        return value;
      } catch (error) {
        const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
        let screenshot: string | undefined;
        try { screenshot = await shot(`fail-${index}`); } catch { /* экран мог закрыться */ }
        steps.push({ index, action, target, ok: false, detail, screenshot, ms: Date.now() - startedAt });
        findings.push({ severity: 'major', area: action, title: `Шаг не выполнился: ${target}`, detail, screenshot });
        return null;
      }
    },
    async tap(name, options = {}) {
      const matches = page.getByRole('button', { name, exact: options.exact ?? false });
      const count = await matches.count();
      let seen = 0;
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        if (seen === (options.index ?? 0)) { await candidate.click({ timeout: 8000 }); return; }
        seen += 1;
      }
      throw new Error('на экране нет кнопки «' + String(name) + '»');
    },
    async visible(name, options = {}) {
      const matches = page.getByRole('button', { name, exact: options.exact ?? false });
      const count = await matches.count();
      for (let index = 0; index < count; index += 1) {
        if (await matches.nth(index).isVisible().catch(() => false)) return true;
      }
      return false;
    },
    note(finding) {
      findings.push(finding);
    },
    shot,
    async layoutCheck(area: string) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) {
        findings.push({ severity: 'major', area, title: 'Горизонтальное переполнение',
          detail: `страница шире экрана на ${overflow} px`, screenshot: await shot('overflow') });
      }
      // Кнопки и ссылки, у которых нет ни подписи, ни доступного имени.
      const nameless = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
        return nodes.filter((node) => {
          if (!node.offsetParent) return false;
          const name = (node.textContent || '').trim() || node.getAttribute('aria-label') || node.getAttribute('title');
          return !name;
        }).length;
      });
      if (nameless > 0) {
        findings.push({ severity: 'minor', area, title: 'Кнопки без подписи',
          detail: `${nameless} кнопок без текста и aria-label — скринридер их не назовёт` });
      }
    },
  };

  const close = async (): Promise<PhoneRunResult> => {
    const started = new Date().toISOString();
    await browser.close();
    const result: PhoneRunResult = {
      steps, findings, console: consoleLog, pageErrors,
      screenshotsDir: outDir, startedAt: started, finishedAt: new Date().toISOString(),
    };
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2), 'utf8');
    return result;
  };

  return { phone, browser, close };
}

export { BASE_URL };
export type { PhoneState };
