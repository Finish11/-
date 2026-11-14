import { aggregateSpeed, bytesToMbps, latencyStats, type SpeedAggregate } from './speedTest';
import { defaultTransport, type SpeedPhaseResult, type SpeedTransport } from './speedRunner';
import { isNativeApp } from './nativeBridge';

/**
 * Замер доступа к YouTube и оценка «на какое качество хватит».
 *
 * Зачем отдельно от обычного спидометра: канал до сервера замера и канал до
 * видеоплощадки — разные вещи. В РФ замедляют именно видеоголовку (googlevideo),
 * поэтому 100 Мбит/с в обычном замере ничего не говорят о YouTube.
 *
 * Что измеряется честно:
 *   1. задержка до youtube.com и до видеоголовки googlevideo;
 *   2. реальная прокачка байт с хоста YouTube — сначала пробуем прямой адрес
 *      видеопотока со страницы ролика, если его нет — CDN картинок ytimg;
 *   3. источник цифры всегда указан: googlevideo и ytimg замедляют по-разному.
 *
 * Чего здесь нет: расшифровки подписанных ссылок и обхода ограничений. Если
 * прямую ссылку получить не удалось, так и пишем, а не выдаём ytimg за видео.
 */

export interface YoutubeQuality {
  id: string;
  label: string;
  /** Типичный битрейт потока SDR (VP9/H.264), Мбит/с. Оценка, не гарантия. */
  mbps: number;
}

/**
 * Типичные битрейты YouTube. Разброс большой (кодек, сцена, HDR), поэтому это
 * ориентир для выбора качества, а не точное значение конкретного ролика.
 */
export const YOUTUBE_QUALITIES: YoutubeQuality[] = [
  { id: '144p', label: '144p', mbps: 0.1 },
  { id: '240p', label: '240p', mbps: 0.3 },
  { id: '360p', label: '360p', mbps: 0.7 },
  { id: '480p', label: '480p', mbps: 1.1 },
  { id: '720p', label: '720p', mbps: 2.5 },
  { id: '720p60', label: '720p60', mbps: 4 },
  { id: '1080p', label: '1080p', mbps: 5 },
  { id: '1080p60', label: '1080p60', mbps: 8 },
  { id: '1440p', label: '1440p', mbps: 10 },
  { id: '2160p', label: '4K', mbps: 20 },
];

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/**
 * Запас на служебный трафик и неровность потока: манифесты, звук, TLS, повторы.
 * Без него «впритык» выглядело бы как «хватит», и видео вставало бы на буферизацию.
 */
export const YOUTUBE_HEADROOM = 1.2;

/**
 * Сколько нужно качать, чтобы смотреть без остановок.
 *
 * На скорости 2× плеер расходует секунду видео за полсекунды, значит поток нужен
 * вдвое плотнее. Это главная причина, по которой «1080p идёт» на 1× и сыплется
 * на 2×.
 */
export function requiredMbps(quality: YoutubeQuality, rate: number = 1, headroom = YOUTUBE_HEADROOM): number {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const safeHeadroom = Number.isFinite(headroom) && headroom >= 1 ? headroom : YOUTUBE_HEADROOM;
  return Math.round(quality.mbps * safeRate * safeHeadroom * 100) / 100;
}

export function rateLabel(rate: number): string {
  return `${String(rate).replace('.', ',')}×`;
}

export interface YoutubeVerdict {
  /** Лучшее качество, которое канал тянет на этой скорости воспроизведения. */
  best: YoutubeQuality | null;
  /** Следующая ступень и сколько до неё не хватает. */
  next: YoutubeQuality | null;
  neededForNext: number | null;
  /** Во сколько раз измеренный канал больше потребности выбранного качества. */
  headroomRatio: number | null;
  tone: 'ok' | 'warn' | 'bad';
  label: string;
  detail: string;
}

export function youtubeQualityVerdict(mbps: number | null | undefined, rate: number = 2): YoutubeVerdict {
  const value = mbps == null || !Number.isFinite(mbps) || mbps < 0 ? 0 : mbps;
  const fits = YOUTUBE_QUALITIES.filter((quality) => requiredMbps(quality, rate) <= value);
  const best = fits.length ? fits[fits.length - 1] : null;
  const next = YOUTUBE_QUALITIES.find((quality) => requiredMbps(quality, rate) > value) || null;
  const neededForNext = next ? requiredMbps(next, rate) : null;
  const ratio = best && requiredMbps(best, rate) > 0 ? value / requiredMbps(best, rate) : null;
  const rateText = rateLabel(rate);
  if (!best) {
    return {
      best: null, next, neededForNext, headroomRatio: null, tone: 'bad',
      label: `Не хватит даже на 144p при ${rateText}`,
      detail: `Измерено ${value.toFixed(2)} Мбит/с, а для 144p при ${rateText} нужно около ${requiredMbps(YOUTUBE_QUALITIES[0], rate)} Мбит/с. Похоже на замедление или блокировку видеоплощадки.`,
    };
  }
  // Запас меньше 1.5× — качество держится «впритык»: любая просадка даст буфер.
  const tight = ratio != null && ratio < 1.5;
  return {
    best, next, neededForNext, headroomRatio: ratio,
    tone: tight ? 'warn' : 'ok',
    label: `Хватит на ${best.label} при ${rateText}${tight ? ' · впритык' : ''}`,
    detail: next
      ? `Для ${next.label} при ${rateText} нужно около ${neededForNext} Мбит/с — сейчас ${value.toFixed(2)} Мбит/с.${tight ? ' Запас маленький: на просадках будет буферизация.' : ''}`
      : `Это максимум шкалы: ${best.label} при ${rateText} требует около ${requiredMbps(best, rate)} Мбит/с, измерено ${value.toFixed(2)} Мбит/с.`,
  };
}

// ------------------------------------------------------------------- точки замера

export const YOUTUBE_PING_URL = 'https://www.youtube.com/generate_204';
export const YOUTUBE_VIDEO_PING_URL = 'https://redirector.googlevideo.com/generate_204';
/** Ролик-«якорь» для поиска прямой ссылки: короткий, давно доступен. */
export const YOUTUBE_SAMPLE_WATCH = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/**
 * Адреса, с которых реально качаются байты YouTube.
 *
 * Почему не один: прямой адрес видеопотока (`videoplayback`) живёт минуты и
 * привязан к клиенту — сервер штатно отвечает 403/410. Раньше такой ответ
 * обрывал всю фазу, и замер заканчивался «0 бит», хотя YouTube работал.
 * Теперь у каждого адреса свой шанс: один отказал — качаем с остальных.
 */
export const YOUTUBE_CDN_URLS = [
  'https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg',
  'https://i.ytimg.com/vi/jNQXAC9IVRw/hq720.jpg',
  'https://i.ytimg.com/vi/jNQXAC9IVRw/sddefault.jpg',
  'https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg',
];

/** Служебные ответы YouTube: маленькие, без CORS-запрета на чтение. */
export const YOUTUBE_PROBE_URLS = [
  'https://www.youtube.com/generate_204',
  'https://www.youtube.com/robots.txt',
];

/**
 * Крупные файлы с хостов youtube.com — настоящий источник цифры.
 *
 * Раньше, если страница ролика отдавала только `signatureCipher` (так делает
 * современный YouTube), замер падал на CDN картинок: `maxresdefault.jpg` —
 * это 30–150 КБ, а `mqdefault` — вообще 10 КБ. На быстром канале такие файлы
 * приходят одним пакетом, делятся на почти нулевое время и дают либо ноль,
 * либо случайные десятки мегабит. В худшем случае всё упиралось в таймаут 6 с
 * и вердикт «YouTube не отдал ни байта» при полностью рабочем YouTube.
 *
 * player JS и каталог станций — мегабайты с того же youtube.com, по которому
 * видно и задержку, и реальную пропускную способность до площадки.
 */
export const YOUTUBE_BULK_URLS = [
  // Крупный статический JS плеера — ~0.8–1.2 МБ, есть на всех локалях.
  // Раньше сюда попадали iframe_api и robots.txt (1–5 КБ): на быстром канале
  // они приходили одним пакетом и давали 0.08 Мбит/с, хотя канал держал 12 МБ/с.
  'https://www.youtube.com/s/player/2f2b8b6b/player_ias.vflset/ru_RU/base.js',
  'https://www.youtube.com/s/player/2f2b8b6b/player_ias.vflset/en_US/base.js',
  'https://www.youtube.com/s/player/2f2b8b6b/player_ias.vflset/en_GB/base.js',
];

export type YoutubeSource = 'googlevideo' | 'ytimg' | 'youtube';
export type YoutubeVerdictKind = 'ok' | 'slow' | 'blocked' | 'offline' | 'unsupported' | 'aborted';

export function youtubeSourceLabel(source: YoutubeSource): string {
  return source === 'googlevideo' ? 'видеоголовка googlevideo'
    : source === 'youtube' ? 'файлы youtube.com (player JS)'
    : 'CDN картинок ytimg';
}

/**
 * Прямые ссылки на видеопоток со страницы ролика, по убыванию пригодности.
 *
 * Готовый `url` есть не всегда: современная страница чаще отдаёт
 * `signatureCipher`. Поэтому видеоголовка — только один из источников:
 * если ссылки нет или она отдала 403, замер продолжается на CDN и сайте.
 */
export function extractGoogleVideoUrls(html: string): string[] {
  if (!html) return [];
  const found: string[] = [];
  const pattern = /"url"\s*:\s*"(https:\/\/[^"]*googlevideo\.com\/videoplayback[^"]*)"/g;
  for (const match of html.matchAll(pattern)) {
    const decoded = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
    // Ссылка должна быть пригодна для GET без расшифровки подписи.
    if (/signatureCipher|\\u0026sig=/.test(decoded)) continue;
    if (!/[?&](mime|itag)=/.test(decoded)) continue;
    if (!found.includes(decoded)) found.push(decoded);
  }
  return found.sort(linkPriority);
}

/** Первая готовая ссылка — прежний API, которым пользуется остальной код. */
export function extractGoogleVideoUrl(html: string): string | null {
  return extractGoogleVideoUrls(html)[0] ?? null;
}

/** Лёгкие форматы первыми: меньше нужно байт, чтобы увидеть реальную скорость. */
function linkPriority(a: string, b: string): number {
  const rank = (link: string) => (link.includes('itag=18') ? 0 : link.includes('itag=22') ? 1 : 2);
  return rank(a) - rank(b);
}

export interface YoutubeProbeResult {
  ok: boolean;
  mbps: number;
  aggregate: SpeedAggregate | null;
  source: YoutubeSource | null;
  /** Задержка до youtube.com, мс. */
  pingMs: number | null;
  /** Задержка до видеоголовки, мс: её замедляют отдельно от сайта. */
  videoPingMs: number | null;
  bytes: number;
  errors: string[];
  /** Почему цифра получена именно так — показывается пользователю. */
  note: string;
  aborted: boolean;
  /** Машинный вердикт: по нему UI выбирает тон и что советовать. */
  verdict: YoutubeVerdictKind;
  /** Сколько всего длился замер, мс: видно, что зависания нет. */
  elapsedMs: number;
  /** Цифра есть, но канала не хватает даже на 144p — это медленно, а не «ок». */
  slow: boolean;
}

export interface YoutubeProbeOptions {
  transport?: SpeedTransport;
  signal?: AbortSignal;
  onProgress?: (message: string, mbps: number) => void;
  /** Экономный режим: меньше трафика на мобильном тарифе. */
  lite?: boolean;
  /** Своя страница ролика — можно проверить конкретное видео. */
  watchUrl?: string;
  fetchHtml?: (url: string) => Promise<string>;
  durationMs?: number;
  /** Жёсткий потолок на всю процедуру. Без него «нет сети» выглядело как зависание. */
  deadlineMs?: number;
  /** Где выполняется замер. По умолчанию определяется по Capacitor; в тестах задаётся явно. */
  native?: boolean;
}

const EMPTY: YoutubeProbeResult = {
  ok: false, mbps: 0, aggregate: null, source: null, pingMs: null, videoPingMs: null,
  bytes: 0, errors: [], note: '', aborted: false, verdict: 'offline', elapsedMs: 0, slow: false,
};

/**
 * Сколько ждать youtube.com, прежде чем честно сказать «не открывается».
 * Без этого «нет сети» превращалось в бесконечную крутилку: таймауты копились
 * (2 × 5 с пинг + 12 с страница + две фазы по 7 с), а вердикта всё не было.
 */
export const YOUTUBE_PING_TIMEOUT_MS = 4000;
export const YOUTUBE_DEADLINE_MS = 26000;
/** Ниже этой скорости цифра считается «на грани»: нужен честный тон в UI. */
export const YOUTUBE_SLOW_MBPS = 0.35;

/**
 * Браузерное представление: YouTube отдаёт обычную страницу иначе, чем
 * техническому клиенту. С клиентским User-Agent чаще приходит упрощённая
 * разметка без данных плеера, и прямой ссылки в ней нет вовсе.
 */
export const YOUTUBE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

async function defaultFetchHtml(url: string): Promise<string> {
  const bridge = await import('./nativeBridge');
  const attempts: string[] = [];
  if (bridge.isNativeApp()) {
    try {
      const res = await bridge.nativeGet(url, 12000, YOUTUBE_USER_AGENT, { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' });
      if (res.status >= 200 && res.status < 300 && res.text) return res.text;
      attempts.push(`нативный HTTP: сервер ответил ${res.status}`);
    } catch (error) {
      attempts.push(`нативный HTTP: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(`Страница YouTube не скачалась. ${attempts.join('; ')}`);
  }
  try {
    return await bridge.fetchTextUniversal(url, 12000);
  } catch (error) {
    // Общий загрузчик говорит про подписки — здесь это сбивало бы с толку.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace('Не удалось скачать подписку.', 'Страница YouTube не скачалась.'));
  }
}

function isWatchPage(url: string): boolean {
  return /youtube\.com\/watch/.test(url);
}

/**
 * Обещание с предохранителем: если сигнал уже сработал, ждать зависший вызов
 * бессмысленно. Возвращает заглушку, чтобы замер дошёл до вердикта.
 */
function untilAborted<T>(task: Promise<T>, signal: AbortSignal, fallback: () => T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback());
  return new Promise<T>((resolve) => {
    const done = (value: T) => { signal.removeEventListener('abort', onAbort); resolve(value); };
    const onAbort = () => done(fallback());
    signal.addEventListener('abort', onAbort);
    task.then(done, () => done(fallback()));
  });
}

/**
 * Замер до YouTube: задержка → прямые адреса потока → CDN картинок.
 *
 * Ключевые правила, из-за которых раньше показывался ноль:
 *  - отказ одного адреса (403/410 у videoplayback) не отменяет замер;
 *  - у каждой стадии свой короткий бюджет, у всей процедуры — общий дедлайн;
 *  - «нет байт» отделяется от «замер не состоялся»: у результата есть вердикт.
 */
export async function runYoutubeProbe(options: YoutubeProbeOptions = {}): Promise<YoutubeProbeResult> {
  const transport = options.transport ?? defaultTransport();
  const runId = `yt-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const result: YoutubeProbeResult = { ...EMPTY, errors: [], elapsedMs: 0 };
  const startedAt = Date.now();
  const say = (message: string, mbps = 0) => options.onProgress?.(message, mbps);
  const durationMs = options.durationMs ?? (options.lite ? 4000 : 7000);
  const maxBytes = options.lite ? 8 * 1024 * 1024 : 25 * 1024 * 1024;
  const budget = Math.max(8000, options.deadlineMs ?? YOUTUBE_DEADLINE_MS);
  const native = options.native ?? isNativeApp();
  const finish = (verdict: YoutubeVerdictKind, note: string): YoutubeProbeResult => {
    cleanup();
    result.verdict = verdict;
    result.note = note;
    result.elapsedMs = Date.now() - startedAt;
    return result;
  };
  const stop = (): YoutubeProbeResult => {
    result.aborted = true;
    return finish('aborted', 'Замер остановлен до первых байт');
  };
  /** Остаток общего бюджета: стадии не должны выедать его друг у друга. */
  const leftMs = () => Math.max(0, budget - (Date.now() - startedAt));

  // Предохранитель: даже если транспорт завис на сокете и не вернул управление,
  // замер обязан закончиться сам. Без него «нет сети» — вечная крутилка.
  const guard = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => guard.abort();
  options.signal?.addEventListener('abort', onOuterAbort);
  const guardTimer = setTimeout(() => { timedOut = true; guard.abort(); }, budget);
  const cleanup = () => {
    clearTimeout(guardTimer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  };

  say('Проверяем задержку до YouTube…');
  // Оба пинга идут параллельно: последовательные таймауты складывались в
  // долгое «Начинаем…», которое выглядело как зависание.
  const [site, video] = await Promise.all([
    // untilAborted обязателен: реализация транспорта может не заметить сигнал,
    // и тогда ожидание пинга — это и есть то самое «зависание» без VPN.
    untilAborted(
      transport.latency(YOUTUBE_PING_URL, 3, guard.signal, YOUTUBE_PING_TIMEOUT_MS)
        .catch(() => ({ samples: [] as number[], error: 'youtube.com не ответил' })),
      guard.signal, () => ({ samples: [] as number[], error: 'youtube.com не ответил' }),
    ),
    untilAborted(
      transport.latency(YOUTUBE_VIDEO_PING_URL, 2, guard.signal, YOUTUBE_PING_TIMEOUT_MS)
        .catch(() => ({ samples: [] as number[], error: 'googlevideo не ответил' })),
      guard.signal, () => ({ samples: [] as number[], error: 'googlevideo не ответил' }),
    ),
  ]);
  result.pingMs = latencyStats(site.samples).pingMs;
  result.videoPingMs = latencyStats(video.samples).pingMs;
  if (site.error) result.errors.push(`youtube.com: ${site.error}`);
  if (video.error) result.errors.push(`googlevideo: ${video.error}`);
  if (options.signal?.aborted) return stop();

  // Ни один пинг не прошёл: байты всё равно попробуем (пинг может блокироваться
  // отдельно от загрузки, и наоборот), но вердикт будет честный.
  const noPing = site.samples.length === 0 && video.samples.length === 0;
  // Ни один служебный адрес не ответил: страницу ролика (до 12 с) не ждём —
  // это и было «зависание» без VPN. Байты проверим сразу на CDN, он короче.
  const reachable = !noPing;
  const networkDown = noPing && result.errors.some((item) => /DNS|не резолвится|ENOTFOUND|UnknownHost|network|сети|недоступ/i.test(item));
  const download = async (urls: string[], source: YoutubeSource, connections: number, sliceMs: number) => {
    const label = source === 'googlevideo' ? 'Качаем видеопоток…'
      : source === 'ytimg' ? 'Качаем с CDN YouTube…' : 'Качаем данные YouTube…';
    say(label);
    const empty = { slices: [] as SpeedPhaseResult['slices'], bytes: 0, confirmed: 0, errors: [] as string[] };
    const phase = await untilAborted(transport.phase({
      runId: `${runId}-${source}`, direction: 'download', urls,
      connections, durationMs: Math.max(1500, Math.min(sliceMs, leftMs())),
      chunkBytes: 1_000_000, maxBytes, signal: guard.signal,
      // Мелкие объекты CDN: один зависший адрес не должен держать всю фазу.
      timeoutMs: source === 'ytimg' ? 6000 : 10000,
      onSample: (slice) => say(label, bytesToMbps(slice.confirmed, slice.t)),
    }), guard.signal, () => empty);
    result.errors.push(...phase.errors.map((item) => `${source}: ${item}`));
    return phase;
  };

  type Attempt = { source: YoutubeSource; phase: { slices: SpeedPhaseResult['slices']; bytes: number; confirmed: number } };
  /** Итог по источнику: байты и срезы. Пустой массив — источник не дал ничего. */
  const attempts: Attempt[] = [];

  say(reachable ? 'Ищем прямой адрес видеопотока…' : 'YouTube не отвечает — проверяем CDN…');
  const watchUrl = options.watchUrl || YOUTUBE_SAMPLE_WATCH;
  let streamUrls: string[] = [];
  let pageLoaded = false;
  if (!reachable) result.errors.push('Служебные адреса YouTube не ответили, страницу ролика не запрашивали');
  try {
    if (!reachable) throw new Error('YouTube не отвечает');

    const html = await untilAborted((options.fetchHtml ?? defaultFetchHtml)(watchUrl), guard.signal, () => '');
    pageLoaded = /ytInitialPlayerResponse|"videoDetails"|<title>YouTube<\/title>/i.test(html);
    streamUrls = extractGoogleVideoUrls(html);
    if (!streamUrls.length && pageLoaded) {
      result.errors.push('Готовая ссылка на поток в странице не пришла (подпись не расшифровывается)');
    }
  } catch (error) {
    result.errors.push(`Страница ролика не открылась: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.signal?.aborted) return stop();

  // 1. Прямой видеопоток: самый честный источник, но и самый хрупкий —
  //    ссылка живёт минуты и легко отдаёт 403. Отказ не отменяет замер.
  if (streamUrls.length) {
    const phase = await download(streamUrls.slice(0, 2), 'googlevideo', 2, durationMs);
    if (phase.confirmed) attempts.push({ source: 'googlevideo', phase });
  } else if (networkDown) {
    // Ссылку не достать и без сети: не тратим остаток бюджета на заведомые отказы.
    result.errors.push('Сеть не отвечает: адрес потока получить не удалось');
  }
  // 2. CDN картинок: тот же хостинг YouTube, стабильные адреса. Раньше это
  //    был единственный резерв после видеоголовки, но файлы тут мелкие
  //    (10–150 КБ): на быстром канале они приходят одним пакетом, и цифра —
  //    случайная. Поэтому CDN остаётся первым быстрым ответом «YouTube жив»,
  //    а настоящую пропускную способность уточняет фаза крупных файлов.
  if (!attempts.length && !timedOut && !options.signal?.aborted && leftMs() > 3000) {
    const phase = await download(YOUTUBE_CDN_URLS, 'ytimg', 3, durationMs);
    if (phase.confirmed) attempts.push({ source: 'ytimg', phase });
  }
  // 3. Крупные файлы с youtube.com: если прямой поток не отдался (обычный
  //    случай в РФ — страница приходит с signatureCipher), а CDN картинок молчит
  //    или отдал крохи, это единственный источник, где видна настоящая скорость,
  //    а не время установки TCP. Если цифра уже есть — не трогаем её: лишняя
  //    фаза только съедает бюджет и путает источник.
  // Если цифра уже есть, лишняя фаза только съедает бюджет и путает источник.
  // Она нужна ровно тогда, когда ни видеоголовка, ни CDN ничего не отдали:
  // иначе вердикт «YouTube не отдал ни байта» при живом YouTube.
  if (!attempts.length && !timedOut && !options.signal?.aborted && leftMs() > 3000) {
    const phase = await download(YOUTUBE_BULK_URLS, 'youtube', 3, durationMs);
    if (phase.confirmed > 0) attempts.push({ source: 'youtube', phase });
  }
  // 4. Служебные адреса: последняя проверка, что канал до сайта живой.
  if (!attempts.length && !timedOut && !options.signal?.aborted && leftMs() > 3000) {
    const phase = await download(YOUTUBE_PROBE_URLS, 'youtube', 2, Math.min(durationMs, 4000));
    if (phase.confirmed) attempts.push({ source: 'youtube', phase });
  }
  // aborted — только про действие пользователя. Истёкший бюджет — это не
  // «остановлено», а честный вердикт «сеть не отвечает», иначе UI покажет отмену.
  result.aborted = Boolean(options.signal?.aborted);

  const best = attempts.find((item) => item.source === 'googlevideo') ?? attempts[0];
  if (!best) {
    result.elapsedMs = Date.now() - startedAt;
    if (options.signal?.aborted) return finish('aborted', 'Замер остановлен до первых байт');
    if (timedOut) {
      return finish('offline', `YouTube не ответил за ${Math.round(budget / 1000)} с: похоже, сеть не пускает к видеоплощадке. Проверьте подключение или включите VPN.`);
    }
    // Различаем «нет сети» и «сеть есть, YouTube не отдаёт»: совет разный.
    const noNetwork = result.errors.some((item) => /DNS|не резолвится|ENOTFOUND|UnknownHost|сети|network/i.test(item));
    const browser = !native;
    if (browser) {
      return finish('unsupported', 'Браузер не даёт читать ответы YouTube (CORS), поэтому замер доступен в Android-приложении. Ноль здесь не означает блокировку.');
    }
    if (noNetwork) {
      return finish('offline', `YouTube не открывается вовсе: ${result.errors[0] || 'сеть не отвечает'}. Проверьте подключение или включите VPN — без него YouTube в РФ не грузится.`);
    }
    return finish('blocked', 'YouTube не отдал ни байта: похоже на блокировку видеоплощадки. Обычный замер скорости при этом может показывать быстрый канал — это нормально, замедляют именно YouTube.');
  }

  result.source = best.source;
  result.bytes = best.phase.confirmed || best.phase.bytes;
  result.aggregate = aggregateSpeed(best.phase.slices);
  // Среднее по всей фазе честнее для коротких срезов: методика Ookla отбрасывает
  // края, и на 4 секундах у неё остаётся слишком мало интервалов.
  result.mbps = result.aggregate.mbps || result.aggregate.averageMbps || bytesToMbps(result.bytes, Math.max(1, result.aggregate.durationMs || durationMs));
  result.ok = result.mbps > 0;
  result.slow = result.ok && result.mbps < YOUTUBE_SLOW_MBPS;
  result.elapsedMs = Date.now() - startedAt;
  result.verdict = !result.ok ? 'blocked' : result.slow ? 'slow' : 'ok';
  result.note = best.source === 'googlevideo'
    ? 'Измерено на прямом видеопотоке googlevideo — том самом хосте, который замедляют.'
    : best.source === 'youtube'
      ? 'Прямую ссылку на поток получить не удалось, измерено на крупных файлах youtube.com (player JS, ~1 МБ каждый, качаем параллельно). Видеоголовку могут замедлять отдельно — оценка ориентировочная.'
      : 'Прямую ссылку на поток получить не удалось, измерено на CDN картинок ytimg (картинки 150 КБ, поэтому цифра занижена, оценка ориентировочная). Для точной оценки нужен крупный файл — если VPN включён, проверьте, что приложение идёт через туннель, иначе YouTube всё ещё замедляют.';
  if (result.verdict === 'slow') {
    result.note += ' Скорость ниже 0,35 Мбит/с: этого не хватает даже на 144p — похоже на сильное замедление.';
  }
  if (!result.aggregate.reliable && result.aggregate.reason) result.note += ` ${result.aggregate.reason}`;
  cleanup();
  return result;
}
