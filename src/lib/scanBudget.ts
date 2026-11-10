/**
 * Бюджет времени на проверку сайтов.
 *
 * Раньше худший путь одного сайта был 8 с (первая проба) + 8 с (главная
 * страница) + 8 с (повтор) + 4 с (TCP) = 28 секунд, а параллельно шло только
 * 8 запросов. На 75 сайтах это 10 волн × 28 с ≈ 4 минуты 40 секунд — именно
 * те «пять минут на 5%», которые видел пользователь.
 *
 * Теперь все запросы уходят сразу, а время ограничено и на сайт, и на всю
 * проверку. Не успевшие сайты не получают выдуманный вердикт: они честно
 * остаются непроверенными.
 */
export type ScanSpeed = 'fast' | 'balanced' | 'thorough';

export interface ScanBudget {
  /** Сколько ждём один сайт суммарно, включая повторы. */
  perSiteMs: number;
  /** Жёсткий предел всей проверки. */
  totalMs: number;
  /** Сколько проб идёт одновременно. */
  concurrency: number;
  /** Повторять ли запрос и пробовать ли главную страницу. */
  retry: boolean;
  /** Проверять ли TCP-порт, когда HTTP не ответил. */
  tcpFallback: boolean;
  /** Таймаут контрольной пробы сети. */
  controlMs: number;
  /**
   * Добирать ли молчащие сайты вторым проходом с большим таймаутом.
   *
   * Короткий таймаут сам по себе врёт: на медленном мобильном канале живой
   * сайт не успевает ответить за 3 секунды и получает «не отвечает». Поэтому
   * первый проход быстрый, а те, кто промолчал, переспрашиваются в остатке
   * общего бюджета — вся проверка всё равно ограничена сверху.
   */
  secondPass: boolean;
  /** Сколько ждём сайт на втором проходе (не больше остатка бюджета). */
  secondPassPerSiteMs: number;
}

export const SCAN_BUDGETS: Record<ScanSpeed, ScanBudget> = {
  // Один запрос на сайт, но не «все сразу»: 64 одновременные пробы на мобильном
  // канале захлёбывали его, и живые сайты получали «нет ответа», хотя одиночный
  // пинг тут же отвечал. 32 пробы — три волны, всё ещё секунды, но честнее.
  fast: { perSiteMs: 3000, totalMs: 22000, concurrency: 32, retry: false, tcpFallback: false, controlMs: 2500,
    secondPass: true, secondPassPerSiteMs: 6000 },
  balanced: { perSiteMs: 5000, totalMs: 35000, concurrency: 24, retry: true, tcpFallback: true, controlMs: 3500,
    secondPass: true, secondPassPerSiteMs: 8000 },
  thorough: { perSiteMs: 8000, totalMs: 90000, concurrency: 12, retry: true, tcpFallback: true, controlMs: 5000,
    secondPass: false, secondPassPerSiteMs: 8000 },
};

export const SCAN_SPEED_LABEL: Record<ScanSpeed, { title: string; hint: string }> = {
  fast: { title: 'Быстро', hint: 'Все сайты одним залпом; промолчавшие переспрашиваются. Предел 20 секунд вместо пяти минут' },
  balanced: { title: 'Сбалансированно', hint: 'Повтор и главная страница для неотвечающих, до 35 секунд' },
  thorough: { title: 'Подробно', hint: 'Все повторы и TCP-пробы, до 90 секунд — для разбора спорных случаев' },
};

export function scanBudgetFor(speed: ScanSpeed | string | undefined): ScanBudget {
  return SCAN_BUDGETS[(speed as ScanSpeed) in SCAN_BUDGETS ? (speed as ScanSpeed) : 'fast'];
}

/** Сколько времени осталось сайту; null — бюджет исчерпан. */
export function remainingMs(deadlineAt: number, now: number): number | null {
  const left = deadlineAt - now;
  return left > 250 ? Math.round(left) : null;
}

/** Оценка худшего случая — показывается пользователю до запуска. */
export function worstCaseSeconds(budget: ScanBudget, siteCount: number): number {
  if (siteCount <= 0) return 0;
  const waves = Math.ceil(siteCount / Math.max(1, budget.concurrency));
  const steps = budget.retry ? (budget.tcpFallback ? 4 : 3) : 1;
  // Контрольная проба идёт параллельно и времени не добавляет. Второй проход
  // в худшем случае касается всех сайтов — поэтому он входит в оценку.
  const second = budget.secondPass ? waves * budget.secondPassPerSiteMs : 0;
  const estimate = (waves * budget.perSiteMs * steps + second) / 1000;
  return Math.min(Math.ceil(estimate), Math.ceil(budget.totalMs / 1000));
}
