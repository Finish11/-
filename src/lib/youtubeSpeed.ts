import { aggregateSpeed, bytesToMbps, latencyStats, type SpeedAggregate } from './speedTest';
import { defaultTransport, type SpeedTransport } from './speedRunner';
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
/** Картинки того же ролика: CDN YouTube, но не видеоголовка. */
export const YOUTUBE_CDN_URLS = [
  'https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg',
  'https://i.ytimg.com/vi/jNQXAC9IVRw/hq720.jpg',
  'https://i.ytimg.com/vi/jNQXAC9IVRw/sddefault.jpg',
];

export type YoutubeSource = 'googlevideo' | 'ytimg';

export function youtubeSourceLabel(source: YoutubeSource): string {
  return source === 'googlevideo' ? 'видеоголовка googlevideo' : 'CDN картинок ytimg';
}

/**
 * Прямая ссылка на видеопоток со страницы ролика. Берём только готовые `url`:
 * подписанные `signatureCipher` не расшифровываем — это отдельная задача, и
 * молча подменять её картинками было бы нечестно.
 */
export function extractGoogleVideoUrl(html: string): string | null {
  if (!html) return null;
  const pattern = /"url"\s*:\s*"(https:\/\/[^"]*googlevideo\.com\/videoplayback[^"]*)"/g;
  for (const match of html.matchAll(pattern)) {
    const decoded = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
    // Ссылка должна быть пригодна для GET без расшифровки подписи.
    if (!/signatureCipher|\\u0026sig=/.test(decoded) && /[?&](mime|itag)=/.test(decoded)) return decoded;
  }
  return null;
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
}

const EMPTY: YoutubeProbeResult = {
  ok: false, mbps: 0, aggregate: null, source: null, pingMs: null, videoPingMs: null,
  bytes: 0, errors: [], note: '', aborted: false,
};

async function defaultFetchHtml(url: string): Promise<string> {
  const { fetchTextUniversal } = await import('./nativeBridge');
  try {
    return await fetchTextUniversal(url, 12000);
  } catch (error) {
    // Общий загрузчик говорит про подписки — здесь это сбивало бы с толку.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace('Не удалось скачать подписку.', 'Страница YouTube не скачалась.'));
  }
}

/**
 * Замер до YouTube. Порядок: задержка → поиск прямой ссылки → прокачка байт.
 * Если видеоголовка не отдала ни байта, пробуем CDN картинок и честно помечаем
 * источник: это ответ YouTube, но не видеопоток.
 */
export async function runYoutubeProbe(options: YoutubeProbeOptions = {}): Promise<YoutubeProbeResult> {
  const transport = options.transport ?? defaultTransport();
  const runId = `yt-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const result: YoutubeProbeResult = { ...EMPTY, errors: [] };
  const say = (message: string, mbps = 0) => options.onProgress?.(message, mbps);
  const durationMs = options.durationMs ?? (options.lite ? 4000 : 7000);
  const maxBytes = options.lite ? 8 * 1024 * 1024 : 25 * 1024 * 1024;

  say('Проверяем задержку до YouTube…');
  const [site, video] = await Promise.all([
    transport.latency(YOUTUBE_PING_URL, 3, options.signal, 5000).catch(() => ({ samples: [] as number[], error: 'youtube.com не ответил' })),
    transport.latency(YOUTUBE_VIDEO_PING_URL, 3, options.signal, 5000).catch(() => ({ samples: [] as number[], error: 'googlevideo не ответил' })),
  ]);
  result.pingMs = latencyStats(site.samples).pingMs;
  result.videoPingMs = latencyStats(video.samples).pingMs;
  if (site.error) result.errors.push(`youtube.com: ${site.error}`);
  if (video.error) result.errors.push(`googlevideo: ${video.error}`);
  if (options.signal?.aborted) { result.aborted = true; result.note = 'Замер остановлен'; return result; }

  say('Ищем прямой адрес видеопотока…');
  let streamUrl: string | null = null;
  try {
    const html = await (options.fetchHtml ?? defaultFetchHtml)(options.watchUrl || YOUTUBE_SAMPLE_WATCH);
    streamUrl = extractGoogleVideoUrl(html);
    if (!streamUrl) result.errors.push('На странице ролика нет готовой ссылки на поток (подпись не расшифровывается)');
  } catch (error) {
    result.errors.push(`Страница ролика не открылась: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.signal?.aborted) { result.aborted = true; result.note = 'Замер остановлен'; return result; }

  const download = async (urls: string[], source: YoutubeSource, connections: number) => {
    say(source === 'googlevideo' ? 'Качаем видеопоток…' : 'Качаем с CDN YouTube…');
    const phase = await transport.phase({
      runId: `${runId}-${source}`, direction: 'download', urls,
      connections, durationMs, chunkBytes: 1_000_000, maxBytes, signal: options.signal,
      onSample: (slice) => say(source === 'googlevideo' ? 'Качаем видеопоток…' : 'Качаем с CDN YouTube…', bytesToMbps(slice.confirmed, slice.t)),
    });
    result.errors.push(...phase.errors.map((item) => `${source}: ${item}`));
    return phase;
  };

  let source: YoutubeSource = 'googlevideo';
  let phase = streamUrl
    ? await download([streamUrl], 'googlevideo', 2)
    : { slices: [], bytes: 0, confirmed: 0, errors: [] as string[] };
  if (!phase.confirmed && !options.signal?.aborted) {
    source = 'ytimg';
    phase = await download(YOUTUBE_CDN_URLS, 'ytimg', 3);
  }
  result.aborted = Boolean(options.signal?.aborted);
  result.bytes = phase.confirmed || phase.bytes;
  if (!result.bytes) {
    result.note = result.aborted
      ? 'Замер остановлен до первых байт'
      : isNativeApp()
        ? 'YouTube не отдал ни байта: похож на блокировку. Обычный замер скорости при этом может показывать быстрый канал.'
        : 'Браузер не даёт читать ответы YouTube (CORS), поэтому замер доступен только в Android-приложении. Отсутствие цифры здесь не означает блокировку.';
    return result;
  }
  result.source = source;
  result.aggregate = aggregateSpeed(phase.slices);
  result.mbps = result.aggregate.mbps || bytesToMbps(result.bytes, durationMs);
  result.ok = true;
  result.note = source === 'googlevideo'
    ? 'Измерено на прямом видеопотоке googlevideo — том самом хосте, который замедляют.'
    : 'Прямую ссылку на поток получить не удалось, измерено на CDN картинок ytimg. Это ответ YouTube, но видеоголовку могут замедлять отдельно — оценка качества ориентировочная.';
  if (!result.aggregate.reliable) result.note += ` ${result.aggregate.reason}`;
  return result;
}
