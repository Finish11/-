/**
 * Замер скорости интернета: методика как у Ookla Speedtest.
 *
 * Почему так, а не «байты / секунды»:
 *  - одно TCP-соединение не заполняет быстрый канал, поэтому соединений 2–8;
 *  - в начале работает slow start, поэтому первые сэмплы отбрасываются;
 *  - Ookla режет тест на 20 срезов, отбрасывает 10% самых быстрых и 30% самых
 *    медленных и усредняет остальные (примерно 90-й перцентиль канала).
 *
 * Все функции чистые: считаются и в браузере, и в APK, и покрыты тестами.
 */

export interface SpeedSlice {
  /** Момент от начала фазы, мс. */
  t: number;
  /** Накопленные байты (для загрузки — полученные, для отдачи — записанные в сокет). */
  bytes: number;
  /** Байты, подтверждённые приёмом/ответом сервера. */
  confirmed: number;
}

export interface SpeedAggregate {
  mbps: number;
  /** Средняя за всю фазу — показываем как «честное среднее», если нужно. */
  averageMbps: number;
  peakMbps: number;
  bytes: number;
  durationMs: number;
  /** Сколько интервалов попало в расчёт после отбрасывания. */
  usedIntervals: number;
  totalIntervals: number;
  reliable: boolean;
  reason: string;
}

export const SPEED_METHODOLOGY = {
  warmupMs: 1200,
  slices: 20,
  trimFastest: 0.1,
  trimSlowest: 0.3,
  minDurationMs: 2500,
  minBytes: 200_000,
  /**
   * Загрузка считается по подтверждённым байтам, отдача — по записанным в сокет
   * (как прогресс XHR в LibreSpeed): подтверждение приходит только после целого
   * куска, и на медленном канале редкие подтверждения занизили бы скорость.
   */
  field: 'confirmed' as 'confirmed' | 'bytes',
};

export function bytesToMbps(bytes: number, ms: number): number {
  if (!(ms > 0) || !(bytes > 0)) return 0;
  return (bytes * 8) / (ms / 1000) / 1_000_000;
}

/** Мгновенные скорости между соседними сэмплами накопительного счётчика. */
export function sliceRates(slices: SpeedSlice[], field: 'bytes' | 'confirmed' = 'confirmed'): Array<{ t: number; mbps: number }> {
  const ordered = [...slices].filter((s) => Number.isFinite(s.t) && Number.isFinite(s[field]))
    .sort((a, b) => a.t - b.t);
  const rates: Array<{ t: number; mbps: number }> = [];
  for (let i = 1; i < ordered.length; i++) {
    const dt = ordered[i].t - ordered[i - 1].t;
    const dBytes = ordered[i][field] - ordered[i - 1][field];
    if (dt <= 0 || dBytes < 0) continue;
    rates.push({ t: ordered[i].t, mbps: bytesToMbps(dBytes, dt) });
  }
  return rates;
}

/**
 * Итоговая скорость по срезам. Отбрасывание медленных срезов убирает slow start,
 * быстрых — всплески буферизации. Если данных мало, честно помечаем результат
 * как ненадёжный вместо красивого числа.
 */
export function aggregateSpeed(slices: SpeedSlice[], options: Partial<typeof SPEED_METHODOLOGY> = {}): SpeedAggregate {
  const config = { ...SPEED_METHODOLOGY, ...options };
  const ordered = [...slices].filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const last = ordered[ordered.length - 1];
  const bytes = last ? Math.max(0, last[config.field]) : 0;
  const durationMs = last ? Math.max(0, last.t) : 0;
  const averageMbps = bytesToMbps(bytes, durationMs);
  const rates = sliceRates(ordered, config.field).filter((rate) => rate.t >= config.warmupMs);
  const usable = rates.length >= 4 ? rates : sliceRates(ordered, config.field);
  if (usable.length < 3 || bytes < config.minBytes || durationMs < config.minDurationMs) {
    return { mbps: averageMbps, averageMbps, peakMbps: usable.reduce((max, r) => Math.max(max, r.mbps), 0),
      bytes, durationMs, usedIntervals: usable.length, totalIntervals: rates.length, reliable: false,
      reason: bytes < config.minBytes ? 'Передано слишком мало данных: результат приблизительный'
        : durationMs < config.minDurationMs ? 'Замер слишком короткий: результат приблизительный'
        : 'Мало интервалов измерения: результат приблизительный' };
  }
  // Группируем в равные по количеству срезы, как в методике Ookla.
  const groups: number[] = [];
  const groupCount = Math.min(config.slices, usable.length);
  for (let index = 0; index < groupCount; index++) {
    const from = Math.floor((index * usable.length) / groupCount);
    const to = Math.floor(((index + 1) * usable.length) / groupCount);
    const part = usable.slice(from, Math.max(from + 1, to));
    groups.push(part.reduce((sum, rate) => sum + rate.mbps, 0) / part.length);
  }
  groups.sort((a, b) => a - b);
  const cutLow = Math.floor(groups.length * config.trimSlowest);
  const cutHigh = Math.floor(groups.length * config.trimFastest);
  const kept = groups.slice(cutLow, Math.max(cutLow + 1, groups.length - cutHigh));
  const mbps = kept.reduce((sum, value) => sum + value, 0) / kept.length;
  return { mbps, averageMbps, peakMbps: groups[groups.length - 1], bytes, durationMs,
    usedIntervals: kept.length, totalIntervals: rates.length, reliable: true,
    reason: `Методика Ookla: ${groupCount} срезов, отброшено ${cutLow} медленных и ${cutHigh} быстрых` };
}

/** Джиттер — средний модуль разницы соседних замеров задержки (как в Speedtest). */
export function jitterMs(samples: number[]): number | null {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length < 2) return null;
  let total = 0;
  for (let i = 1; i < valid.length; i++) total += Math.abs(valid[i] - valid[i - 1]);
  return total / (valid.length - 1);
}

export function latencyStats(samples: number[]): { pingMs: number | null; jitterMs: number | null; minMs: number | null } {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!valid.length) return { pingMs: null, jitterMs: null, minMs: null };
  const mid = Math.floor(valid.length / 2);
  const pingMs = valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
  return { pingMs, jitterMs: jitterMs(samples), minMs: valid[0] };
}

/** Чем быстрее канал, тем больше соединений нужно, чтобы его заполнить. */
export function planConnections(estimatedMbps: number): number {
  if (estimatedMbps >= 300) return 8;
  if (estimatedMbps >= 100) return 6;
  if (estimatedMbps >= 20) return 4;
  return 2;
}

/** Размер куска: не меньше 1 МБ на быстрых линиях, но и не gigabyte на мобильных. */
export function planChunkBytes(estimatedMbps: number): number {
  if (estimatedMbps >= 200) return 16 * 1024 * 1024;
  if (estimatedMbps >= 50) return 8 * 1024 * 1024;
  if (estimatedMbps >= 10) return 4 * 1024 * 1024;
  return 1024 * 1024;
}

export const SPEED_BYTE_BUDGET = { download: 120 * 1024 * 1024, upload: 40 * 1024 * 1024 };

export function formatSpeed(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps)) return '—';
  if (mbps >= 100) return `${Math.round(mbps)}`;
  if (mbps >= 10) return mbps.toFixed(1).replace('.', ',');
  // Ненулевой замер не должен выглядеть нулём: в МБ/с медленный канал даёт
  // сотые доли, и «0,00» читается как «интернета нет».
  if (mbps > 0 && mbps < 0.005) return '< 0,01';
  return mbps.toFixed(2).replace('.', ',');
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} ГБ`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(0, Math.round(bytes / 1024))} КБ`;
}

const COMMON_CAPS = [1, 2, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300, 500, 1000];

export interface CapGuess { capped: boolean; nearMbps: number | null; reason: string }

/**
 * Признак ограничения канала: скорость упёрлась в круглое значение и почти не
 * колеблется. Так выглядят тарифные лимиты и шейперы VPN-провайдеров.
 */
export function guessSpeedCap(aggregate: SpeedAggregate): CapGuess {
  if (!aggregate.reliable || aggregate.mbps <= 0) return { capped: false, nearMbps: null, reason: 'Недостаточно данных для вывода об ограничении' };
  const near = COMMON_CAPS.find((cap) => Math.abs(aggregate.mbps - cap) / cap <= 0.08) ?? null;
  const spread = aggregate.peakMbps > 0 ? (aggregate.peakMbps - aggregate.averageMbps) / aggregate.peakMbps : 1;
  if (near != null && spread <= 0.25)
    return { capped: true, nearMbps: near, reason: `Скорость держится около ${near} Мбит/с почти без колебаний — похоже на ограничение тарифа или сервера` };
  return { capped: false, nearMbps: near, reason: near != null ? 'Значение близко к круглому, но канал колеблется: ограничение не доказано' : 'Явного потолка не видно' };
}

export interface SpeedRun {
  id: number;
  created_at: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number | null;
  jitter_ms: number | null;
  /** Задержка во время нагрузки: рост относительно ping_ms = bufferbloat. */
  loaded_ping_ms?: number | null;
  download_bytes: number;
  upload_bytes: number;
  server: string;
  /** wifi/cellular — физическая сеть, чтобы не сравнивать LTE с Wi-Fi. */
  network_kind: string;
  /** Имя источника: оператор из Android или провайдер из GeoIP. */
  network_name?: string;
  route: 'vpn' | 'direct' | 'unknown';
  vpn_package?: string;
  vpn_app_name?: string;
  exit_ip?: string;
  profile_id?: number | null;
  profile_name?: string;
  reliable?: boolean;
  note?: string;
}

export interface ConfigSpeedSummary {
  key: string;
  label: string;
  profileId: number | null;
  runs: number;
  bestDownload: number;
  medianDownload: number;
  medianUpload: number;
  medianPing: number | null;
  /** Медиана задержки под нагрузкой: конфиг может быть быстрым, но «лагать». */
  medianLoadedPing: number | null;
  lastAt: string;
  route: SpeedRun['route'];
  /** Источник интернета: Wi-Fi/мобильная сеть и имя оператора, если известно. */
  networkLabel: string;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Сравнение конфигов подписки: медиана устойчивее одного удачного замера. */
/** Человекочитаемое имя группы замера: конфиг → прямой канал → клиент → IP. */
export function configLabel(run: SpeedRun): string {
  if (run.profile_name) return run.profile_name;
  if (run.route === 'direct') return 'Без VPN (прямой)';
  if (run.exit_ip) return run.vpn_app_name ? `${run.vpn_app_name} · ${run.exit_ip}` : `Выход ${run.exit_ip}`;
  if (run.vpn_app_name) return run.vpn_app_name;
  return 'Маршрут неизвестен';
}

/** Тип сети словами: сравнение честно только внутри одного типа. */
export function networkKindLabel(kind: string | null | undefined): string {
  if (kind === 'wifi') return 'Wi-Fi';
  if (kind === 'cellular') return 'мобильная сеть';
  if (kind === 'ethernet') return 'проводная сеть';
  return 'неизвестная сеть';
}

/**
 * Источник интернета словами: транспорт и имя сети. В истории раньше был только
 * узел VPN, поэтому два замера — по Wi-Fi дома и по LTE у оператора — выглядели
 * одинаково, и сравнение вводило в заблуждение.
 */
export function speedNetworkLabel(run: Pick<SpeedRun, 'network_kind' | 'network_name'>): string {
  const kind = networkKindLabel(run.network_kind);
  const name = (run.network_name || '').trim();
  if (!name) return kind;
  return `${kind} · ${name}`;
}

/** Куда шёл трафик: узел VPN с выходным IP или прямое подключение. */
export function speedRouteLabel(run: Pick<SpeedRun, 'route' | 'profile_name' | 'vpn_app_name' | 'exit_ip'>): string {
  const ip = (run.exit_ip || '').trim();
  if (run.route === 'direct') return ip ? `напрямую · ${ip}` : 'напрямую';
  const node = (run.profile_name || '').trim() || (run.vpn_app_name || '').trim();
  if (run.route === 'vpn') {
    const head = node ? `VPN · ${node}` : 'VPN · узел не выбран';
    return ip ? `${head} · ${ip}` : head;
  }
  const head = node ? `маршрут не подтверждён · ${node}` : 'маршрут не подтверждён';
  return ip ? `${head} · ${ip}` : head;
}

export function summarizeByConfig(runs: SpeedRun[]): ConfigSpeedSummary[] {
  const groups = new Map<string, SpeedRun[]>();
  for (const run of runs) {
    const key = run.profile_id != null ? `profile:${run.profile_id}` : run.route === 'direct' ? 'direct' : `ip:${run.exit_ip || 'unknown'}`;
    const list = groups.get(key) || [];
    list.push(run);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const newest = sorted[0];
    const downloads = list.map((run) => run.download_mbps).filter((value) => Number.isFinite(value) && value > 0);
    const uploads = list.map((run) => run.upload_mbps).filter((value) => Number.isFinite(value) && value > 0);
    const pings = list.map((run) => run.ping_ms).filter((value): value is number => value != null && Number.isFinite(value));
    const loadedPings = list.map((run) => run.loaded_ping_ms).filter((value): value is number => value != null && Number.isFinite(value));
    return {
      key,
      label: configLabel(newest),
      profileId: newest.profile_id ?? null,
      runs: list.length,
      bestDownload: downloads.length ? Math.max(...downloads) : 0,
      medianDownload: median(downloads),
      medianUpload: median(uploads),
      medianPing: pings.length ? median(pings) : null,
      medianLoadedPing: loadedPings.length ? median(loadedPings) : null,
      lastAt: newest.created_at,
      route: newest.route,
      networkLabel: speedNetworkLabel(newest),
    };
  }).sort((a, b) => b.medianDownload - a.medianDownload);
}

export interface ConfigComparison {
  baseline: ConfigSpeedSummary | null;
  /** Прямой замер есть, но на другом типе сети — сравнивать с ним нельзя. */
  baselineOtherNetwork: (ConfigSpeedSummary & { networkKind: string }) | null;
  ranked: ConfigSpeedSummary[];
  verdicts: Array<{ key: string; text: string; tone: 'ok' | 'warn' | 'bad' }>;
}

/**
 * Отвечает на вопрос «какой конфиг режет скорость»: сравниваем медианы конфигов
 * с прямым подключением на том же типе сети. Без прямого замера сравнение
 *_configs между собой возможно, но вывод о потере скорости делать нельзя.
 */
export function compareConfigs(runs: SpeedRun[], networkKind?: string): ConfigComparison {
  const relevant = networkKind ? runs.filter((run) => run.network_kind === networkKind) : runs;
  const summaries = summarizeByConfig(relevant);
  const baseline = summaries.find((item) => item.key === 'direct') || null;
  let baselineOtherNetwork: ConfigComparison['baselineOtherNetwork'] = null;
  if (!baseline && networkKind) {
    const other = runs.find((run) => run.route === 'direct' && run.profile_id == null && run.network_kind !== networkKind);
    if (other) baselineOtherNetwork = { ...summarizeByConfig([other])[0], networkKind: other.network_kind };
  }
  const ranked = summaries;
  const verdicts = summaries.map((item) => {
    if (item.key === 'direct') return { key: item.key, text: 'Прямое подключение — точка отсчёта', tone: 'ok' as const };
    if (!baseline || baseline.medianDownload <= 0)
      return { key: item.key, text: 'Нет замера без VPN на этой сети — сравнить потери нельзя', tone: 'warn' as const };
    const ratio = item.medianDownload / baseline.medianDownload;
    // Отдача может быть срезана отдельно: у части прокси быстрый вход и узкий
    // выход. Молчать об этом нельзя — человек выбирает конфиг и для звонков.
    const uploadRatio = baseline.medianUpload > 0 && item.medianUpload > 0
      ? item.medianUpload / baseline.medianUpload : null;
    const uploadNote = uploadRatio != null && uploadRatio < 0.6 && uploadRatio < ratio - 0.2
      ? ` Отдача проседает сильнее: ${Math.round(uploadRatio * 100)}% от прямого канала.` : '';
    if (ratio > 1.05) return { key: item.key, text: `Не медленнее прямого канала: ${Math.round(ratio * 100)}% от него.${uploadNote}`,
      tone: uploadNote ? 'warn' as const : 'ok' as const };
    if (ratio >= 0.85) return { key: item.key, text: `Почти без потерь: ${Math.round(ratio * 100)}% от прямого канала.${uploadNote}`,
      tone: uploadNote ? 'warn' as const : 'ok' as const };
    if (ratio >= 0.5) return { key: item.key, text: `Теряет ${Math.round((1 - ratio) * 100)}% скорости относительно прямого подключения.${uploadNote}`, tone: 'warn' as const };
    return { key: item.key, text: `Сильно ограничивает: ${Math.round(ratio * 100)}% от прямого канала.${uploadNote}`, tone: 'bad' as const };
  });
  return { baseline, baselineOtherNetwork, ranked, verdicts };
}

export function speedUsageVerdict(downloadMbps: number, uploadMbps: number, pingMs: number | null): string {
  if (downloadMbps >= 100 && (pingMs ?? 0) < 60) return 'Хватает для 4K на нескольких устройствах и онлайн-игр';
  if (downloadMbps >= 25) return 'Хватает для 4K-видео и видеозвонков';
  if (downloadMbps >= 10) return 'Хватает для HD-видео и видеосвязи';
  if (downloadMbps >= 3) return uploadMbps >= 1 ? 'Хватает для видео в среднем качестве и мессенджеров' : 'Видео идёт, но отдача слабая — звонки могут рваться';
  return 'Скорости мало: видео будет останавливаться, страницы открываются медленно';
}

/** Логарифмическая шкала стрелки, как в Speedtest: 0…1000 Мбит/с в 240°. */
export const GAUGE_TICKS = [0, 1, 5, 10, 50, 100, 500, 1000];

/** Потолок шкалы: как в Ookla, пользователь может закрепить его вручную. */
export type GaugeCeiling = 'auto' | 100 | 250 | 500 | 1000;
/** Уже вычисленный числовой потолок тоже допустим: автошкала считается на лету. */
export type GaugeScale = GaugeCeiling | number;

/**
 * Ступени автоматической шкалы. Как в Speedtest, диск сам подбирает масштаб:
 * на 5 Мбит/с показывает 0…10, на 900 — 0…1000. Пользователю не нужно ничего
 * выбирать, и стрелка никогда не упирается в искусственный потолок.
 */
export const GAUGE_LADDER = [10, 50, 100, 250, 500, 1000, 2500, 10000] as const;

const LADDER_TICKS: Record<number, number[]> = {
  10: [0, 1, 2, 5, 10],
  50: [0, 5, 10, 25, 50],
  100: [0, 1, 5, 10, 25, 50, 100],
  250: [0, 5, 10, 25, 50, 100, 250],
  500: [0, 10, 25, 50, 100, 250, 500],
  1000: GAUGE_TICKS,
  2500: [0, 50, 100, 500, 1000, 2500],
  10000: [0, 100, 500, 1000, 5000, 10000],
};

/** Ближайшая ступень сверху: шкала растёт за скоростью, а не ограничивает её. */
export function gaugeAutoCeiling(mbps: number | null | undefined): number {
  const value = mbps == null || !Number.isFinite(mbps) || mbps < 0 ? 0 : mbps;
  return GAUGE_LADDER.find((step) => value <= step) ?? GAUGE_LADDER[GAUGE_LADDER.length - 1];
}

export function gaugeTicks(ceiling: GaugeScale = 'auto', mbps?: number | null): number[] {
  const max = gaugeCeilingValue(ceiling, mbps);
  return LADDER_TICKS[max] ?? GAUGE_TICKS;
}

/**
 * Потолок шкалы. 'auto' — без предела: масштаб подбирается под скорость.
 * Без замера диск показывает привычные 0…100.
 */
export function gaugeCeilingValue(ceiling: GaugeScale = 'auto', mbps?: number | null): number {
  return ceiling === 'auto' ? (mbps == null ? 100 : gaugeAutoCeiling(mbps)) : ceiling;
}

export function speedGaugeFraction(mbps: number | null | undefined, ceiling: GaugeScale = 'auto'): number {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return 0;
  const max = gaugeCeilingValue(ceiling, mbps);
  const clamped = Math.min(max, mbps);
  // Логарифмическая шкала: 1 Мбит/с не прилипает к нулю, 1000 не улетает за дугу.
  return Math.max(0, Math.min(1, Math.log10(1 + clamped) / Math.log10(1 + max)));
}

/**
 * Риски шкалы вместе с их местом на дуге. Место считается по ОДНОМУ масштабу
 * всей шкалы: если считать каждую риску по её собственной ступени, в режиме
 * «без предела» цифры собьются в кучу у конца дуги.
 */
export function gaugeTickMarks(scale: GaugeScale = 'auto', mbps?: number | null): Array<{ value: number; fraction: number }> {
  const max = gaugeCeilingValue(scale, mbps);
  return gaugeTicks(max).map((value) => ({ value, fraction: speedGaugeFraction(value, max) }));
}

/**
 * Скорость выше выбранного потолка: стрелка упирается в конец шкалы, и без
 * подсказки показалось бы, что измерено ровно 100 Мбит/с, а не 900.
 */
export function gaugeExceedsCeiling(mbps: number | null | undefined, ceiling: GaugeScale = 'auto'): boolean {
  if (mbps == null || !Number.isFinite(mbps)) return false;
  // В режиме «без предела» шкала растягивается сама, превышение возможно только
  // за последней ступенью — это уже десятки гигабит.
  return mbps > gaugeCeilingValue(ceiling, mbps);
}

/** Единицы как в оригинальном Speedtest: биты по умолчанию, байты по выбору. */
export type SpeedDisplayUnit = 'mbps' | 'MBps';

export function speedInUnit(mbps: number | null | undefined, unit: SpeedDisplayUnit = 'mbps'): number | null {
  if (mbps == null || !Number.isFinite(mbps)) return null;
  return unit === 'MBps' ? mbps / 8 : mbps;
}

export function speedUnitLabel(unit: SpeedDisplayUnit = 'mbps'): string {
  return unit === 'MBps' ? 'МБ/с' : 'Мбит/с';
}

export function formatSpeedIn(mbps: number | null | undefined, unit: SpeedDisplayUnit = 'mbps'): string {
  return formatSpeed(speedInUnit(mbps, unit));
}

/** Точка живого графика: мгновенная скорость и фаза, в которой она измерена. */
export interface SpeedTracePoint {
  mbps: number;
  phase: 'download' | 'upload';
}

export interface SpeedTraceGeometry {
  /** SVG-путь загрузки (пустая строка, если точек нет). */
  download: string;
  /** SVG-путь отдачи. */
  upload: string;
  /** Верх шкалы: максимум по всем точкам, но не меньше 1 Мбит/с. */
  max: number;
}

/**
 * Геометрия живого графика, как в Speedtest: ось X — время (равномерные отсчёты),
 * ось Y — скорость от 0 до максимума замера. Загрузка и отдача рисуются отдельно,
 * чтобы фаза была видна по цвету, а не только по подписи.
 */
export function speedTraceGeometry(points: SpeedTracePoint[], width: number, height: number): SpeedTraceGeometry {
  const usable = points.filter((point) => Number.isFinite(point.mbps));
  if (usable.length < 2 || width <= 0 || height <= 0) return { download: '', upload: '', max: 1 };
  const padding = 2;
  const usableHeight = Math.max(1, height - padding * 2);
  const max = Math.max(1, ...usable.map((point) => Math.max(0, point.mbps)));
  const step = width / (usable.length - 1);
  const build = (phase: SpeedTracePoint['phase']) => {
    const parts: string[] = [];
    usable.forEach((point, index) => {
      if (point.phase !== phase) return;
      const x = index * step;
      const y = height - padding - (Math.max(0, point.mbps) / max) * usableHeight;
      parts.push(`${parts.length === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    });
    // Одиночная точка фазы рисуется коротким штрихом, иначе её не видно.
    if (parts.length === 1) {
      const [, x, y] = parts[0].split(' ');
      parts.push(`L ${(Number(x) + Math.min(step, 4)).toFixed(1)} ${y}`);
    }
    return parts.join(' ');
  };
  return { download: build('download'), upload: build('upload'), max };
}

/**
 * Отзывчивость канала под нагрузкой (bufferbloat) — то, что Ookla показывает как
 * «задержка при загрузке». Разница важнее абсолютных цифр: именно она портит
 * звонки и игры, когда рядом идёт большая загрузка.
 */
export function bufferbloatVerdict(idleMs: number | null | undefined, loadedMs: number | null | undefined):
  { grade: 'ok' | 'warn' | 'bad' | 'unknown'; deltaMs: number | null; text: string } {
  if (idleMs == null || loadedMs == null || !Number.isFinite(idleMs) || !Number.isFinite(loadedMs) || idleMs < 0 || loadedMs < 0)
    return { grade: 'unknown', deltaMs: null, text: 'Задержка под нагрузкой не измерена' };
  const deltaMs = Math.max(0, Math.round(loadedMs - idleMs));
  if (deltaMs <= 30) return { grade: 'ok', deltaMs, text: `Отзывчивый канал: под нагрузкой задержка выросла всего на ${deltaMs} мс` };
  if (deltaMs <= 100) return { grade: 'warn', deltaMs, text: `Под нагрузкой задержка растёт на ${deltaMs} мс — звонки могут подтормаживать при активной загрузке` };
  return { grade: 'bad', deltaMs, text: `Сильный bufferbloat: +${deltaMs} мс под нагрузкой. Игры и звонки будут лагать, пока идёт загрузка` };
}


/** Строка сводки по подписке: сколько конфигов измерено и сколько из них режут канал. */
export interface SubscriptionSpeedRow {
  key: string;
  label: string;
  totalConfigs: number;
  measured: number;
  /** configs ниже 50% прямого канала. */
  limiting: number;
  /** Конфигов в диапазоне 50–85%. */
  slowing: number;
  medianMbps: number | null;
  bestMbps: number | null;
  worstMbps: number | null;
  medianLoadedPing: number | null;
}

export interface SubscriptionProfileLike {
  id: number;
  subscription_id?: number | null;
  group_name?: string;
}

/**
 * Отвечает на вопрос «какая подписка подсела»: конфиги группируются по подписке
 * (или по группе, если подписки нет), считаются только замеры на той же сети.
 * Без прямого замера числа «режут» не выдумываются — они остаются нулями.
 */
export function subscriptionSpeedRows(
  runs: SpeedRun[],
  profiles: SubscriptionProfileLike[],
  labels: Record<number, string> = {},
  networkKind?: string
): SubscriptionSpeedRow[] {
  const comparison = compareConfigs(runs, networkKind);
  const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
  const groups = new Map<string, { label: string; total: number; summaries: ConfigSpeedSummary[] }>();
  const keyOf = (profile: SubscriptionProfileLike) => profile.subscription_id != null
    ? `sub:${profile.subscription_id}` : profile.group_name ? `group:${profile.group_name}` : 'none';
  const labelOf = (profile: SubscriptionProfileLike) => profile.subscription_id != null
    ? labels[profile.subscription_id] || `Подписка №${profile.subscription_id}`
    : profile.group_name || 'Без подписки';
  for (const profile of profiles) {
    const key = keyOf(profile);
    const entry = groups.get(key) || { label: labelOf(profile), total: 0, summaries: [] };
    entry.total += 1;
    groups.set(key, entry);
  }
  for (const summary of comparison.ranked) {
    if (summary.profileId == null) continue;
    const profile = byProfile.get(summary.profileId);
    if (!profile) continue;
    groups.get(keyOf(profile))?.summaries.push(summary);
  }
  const baseline = comparison.baseline;
  return [...groups.entries()]
    .filter(([, entry]) => entry.summaries.length > 0)
    .map(([key, entry]) => {
      const downloads = entry.summaries.map((item) => item.medianDownload).filter((value) => value > 0);
      const loaded = entry.summaries.map((item) => item.medianLoadedPing)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const ratioOf = (value: number) => baseline && baseline.medianDownload > 0 ? value / baseline.medianDownload : null;
      return {
        key,
        label: entry.label,
        totalConfigs: entry.total,
        measured: entry.summaries.length,
        limiting: entry.summaries.filter((item) => { const ratio = ratioOf(item.medianDownload); return ratio != null && ratio < 0.5; }).length,
        slowing: entry.summaries.filter((item) => { const ratio = ratioOf(item.medianDownload); return ratio != null && ratio >= 0.5 && ratio < 0.85; }).length,
        medianMbps: downloads.length ? median(downloads) : null,
        bestMbps: downloads.length ? Math.max(...downloads) : null,
        worstMbps: downloads.length ? Math.min(...downloads) : null,
        medianLoadedPing: loaded.length ? median(loaded) : null,
      };
    })
    .sort((a, b) => (b.medianMbps ?? 0) - (a.medianMbps ?? 0));
}

export type SpeedRouteKind = 'vpn' | 'direct' | 'unknown';

/**
 * Что приложение знает о маршруте само. Авторитетен только системный факт VPN
 * из Android: догадка по IP («похоже на дата-центр») маршрутом не является.
 */
export function systemSpeedRoute(
  connection: { vpn_detected?: boolean; vpn_source?: string } | null | undefined,
  native: boolean
): SpeedRouteKind {
  if (connection?.vpn_detected && connection.vpn_source === 'system') return 'vpn';
  return native ? 'direct' : 'unknown';
}

/**
 * Маршрут, который попадает в историю: измеренный транспортом → системный →
 * выбор пользователя. Без последнего шага сравнение конфигов не работало бы
 * в браузере, где система о VPN молчит.
 */
export function recordedSpeedRoute(measured: SpeedRouteKind, system: SpeedRouteKind, declaredProfile: boolean): SpeedRouteKind {
  if (measured !== 'unknown') return measured;
  if (system !== 'unknown') return system;
  return declaredProfile ? 'vpn' : 'direct';
}
