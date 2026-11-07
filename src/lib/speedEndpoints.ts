import { isNativeApp } from './nativeBridge';

/**
 * Серверы замера скорости.
 *
 * Приоритет: свой сервер (без чужих лимитов) → общий сервер сообщества →
 * публичные точки Cloudflare. Публичные точки держат CORS, но отвечают 429 при
 * слишком частых замерах, поэтому своего сервера достаточно, чтобы не зависеть
 * от них.
 */
export interface SpeedServer {
  id: string;
  label: string;
  source: 'own' | 'community' | 'cloudflare';
  ping: string;
  download: (bytes: number) => string;
  upload: string;
}

function ownServer(base: string, label: string, source: SpeedServer['source']): SpeedServer {
  const root = base.replace(/\/+$/, '');
  return {
    id: `${source}:${root}`,
    label,
    source,
    ping: `${root}/api/speed/ping`,
    download: (bytes: number) => `${root}/api/speed/down?bytes=${Math.max(0, Math.round(bytes))}`,
    upload: `${root}/api/speed/up`,
  };
}

export const CLOUDFLARE_SPEED: SpeedServer = {
  id: 'cloudflare',
  label: 'Cloudflare (ближайший узел)',
  source: 'cloudflare',
  ping: 'https://speed.cloudflare.com/__down?bytes=0',
  download: (bytes: number) => `https://speed.cloudflare.com/__down?bytes=${Math.max(0, Math.round(bytes))}`,
  upload: 'https://speed.cloudflare.com/__up',
};

function demoBuild(): boolean {
  return (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DEMO === '1';
}

export interface SpeedServerOptions {
  communityEndpoint?: string;
  /** Origin обычного веб-сервера: /api/speed отдаёт он же. */
  webOrigin?: string;
}

export function availableSpeedServers(options: SpeedServerOptions = {}): SpeedServer[] {
  const servers: SpeedServer[] = [];
  const origin = options.webOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  // В автономном демо /api/* обслуживает локальный mock: реальных байт там нет.
  if (!isNativeApp() && !demoBuild() && origin && /^https?:/.test(origin))
    servers.push(ownServer(origin, 'Этот сервер «ПульсСети»', 'own'));
  if (options.communityEndpoint)
    servers.push(ownServer(options.communityEndpoint, 'Общий сервер сообщества', 'community'));
  servers.push(CLOUDFLARE_SPEED);
  return servers;
}

/** 429 от публичной точки — не «нет интернета»: объясняем и предлагаем свой сервер. */
export function speedEndpointError(errors: string[], server: SpeedServer): string {
  const joined = errors.join('; ');
  if (/429|Retry-After/i.test(joined))
    return server.source === 'cloudflare'
      ? `Cloudflare ограничил частоту замеров (${joined}). Подождите или подключите свой сервер в «Сбоях» — на нём лимитов нет.`
      : `Сервер ограничил частоту замеров: ${joined}`;
  if (/404/.test(joined)) return `На сервере нет точек замера скорости (${joined}). Обновите сервер или выберите другой.`;
  if (/timeout|timed out/i.test(joined)) return `Сервер замера не отвечает: ${joined}`;
  return joined || 'Замер не состоялся';
}

/** Результат пробы кандидата: медиана задержки и причина отказа, если он был. */
export interface SpeedServerProbe {
  server: SpeedServer;
  pingMs: number | null;
  samples: number[];
  error?: string;
}

export interface SpeedServerChoice {
  server: SpeedServer | null;
  pingMs: number | null;
  samples: number[];
  /** Почему выбрана именно эта точка — показывается пользователю. */
  reason: string;
  /** Сколько точек ответили: нужно, чтобы «ближайшая» была честной. */
  reachable: number;
}

const RATE_LIMITED = /429|Retry-After/i;

/**
 * Выбор точки замера по задержке — как Speedtest, а не «первая ответившая».
 *
 * Своя точка предпочтительнее при близкой задержке: у публичной есть чужие
 * лимиты (429 на час), и гоняться за 5 мс ценой отказа замера незачем. Если своя
 * заметно медленнее, берём быструю и честно пишем, почему.
 */
export function pickSpeedServer(probes: SpeedServerProbe[], tolerance = 1.25): SpeedServerChoice {
  const answered = probes.filter((probe) =>
    probe.pingMs != null && Number.isFinite(probe.pingMs) && probe.pingMs >= 0 && probe.samples.length > 0);
  const usable = answered.filter((probe) => !RATE_LIMITED.test(probe.error || ''));
  if (!usable.length) {
    const details = probes.map((probe) => `${probe.server.label}: ${probe.error || 'нет ответа'}`).join(' · ');
    return { server: null, pingMs: null, samples: [], reachable: 0,
      reason: details || 'Нет доступных точек замера' };
  }
  const sorted = [...usable].sort((a, b) => (a.pingMs as number) - (b.pingMs as number));
  const fastest = sorted[0];
  const own = sorted.find((probe) => probe.server.source !== 'cloudflare'
    && (probe.pingMs as number) <= (fastest.pingMs as number) * Math.max(1, tolerance));
  const chosen = own || fastest;
  const ping = Math.round(chosen.pingMs as number);
  let reason: string;
  if (usable.length === 1) reason = `Единственная доступная точка · ${ping} мс`;
  else if (chosen === fastest) reason = `Ближайшая из ${usable.length} точек · ${ping} мс`;
  else reason = `Своя точка без чужих лимитов · ${ping} мс (быстрее только ${fastest.server.label} — ${Math.round(fastest.pingMs as number)} мс)`;
  return { server: chosen.server, pingMs: chosen.pingMs, samples: chosen.samples, reason, reachable: usable.length };
}
