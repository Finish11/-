import { httpProbe, isNativeApp, tcpPing, type NativeHttpProbe } from './nativeBridge';
import { assessSiteContent } from './siteContent';
import { remainingMs } from './scanBudget';
import type { SiteProof } from '../types';

export type ProbeVerdict = 'ok' | 'slow' | 'blocked' | 'intercepted' | 'offline';
export interface SiteProbeResult {
  verdict: ProbeVerdict; latencyMs: number | null; httpStatus?: number; reason?: string; detail?: string;
  proof?: SiteProof; networkStatus?: 'ok' | 'slow' | 'blocked'; probeUrl?: string; attempts?: number;
  /** Сайт ответил капчей/проверкой браузера — сеть до него есть. */
  challenge?: boolean;
}
export interface ProbeOptions {
  timeoutMs?: number; verifyContent?: boolean;
  /** Injectable transport for regression tests; production uses the registered native plugin. */
  nativeHttp?: (url: string, timeoutMs?: number) => Promise<NativeHttpProbe>;
  /** Момент (performance.now), после которого сайт больше не проверяется. */
  deadlineAt?: number;
  /** Повтор и главная страница — только в подробных режимах. */
  retry?: boolean;
  /** TCP-проба как последнее средство. */
  tcpFallback?: boolean;
}
const OK_MS = 1500;
const HTML_SERVICE_HOSTS = new Set(['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
  'telegram.org', 'web.telegram.org', 'whatsapp.com', 'web.whatsapp.com', 'youtube.com', 'store.supercell.com']);
export function canonicalServiceProbeUrl(value: string): string {
  try {
    const parsed = new URL(value), host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (HTML_SERVICE_HOSTS.has(host) && /\/favicon\.(ico|png|svg)$/i.test(parsed.pathname)) return `${parsed.origin}/`;
  } catch { /* caller reports invalid URL */ }
  return value;
}
function classifyError(message: string): { verdict: ProbeVerdict; reason: string } {
  const m = message.toLowerCase();
  // Молчаливый отказ моста нельзя выдавать за блокировку сайта.
  if (/not implemented|unimplemented|не реализован/.test(m))
    return { verdict: 'offline', reason: 'Эта сборка приложения не умеет проверять сайты. Обновите APK — сайт при этом может работать.' };
  if (/permission denied|lockdown/.test(m))
    return { verdict: 'offline', reason: 'Система запретила приложению этот маршрут (постоянный VPN). Проверка не выполнена.' };
  if (/timeout|timed out|deadline/.test(m)) return { verdict: 'blocked', reason: 'сервер не ответил (таймаут)' };
  if (/certificate|ssl|cert|handshake|tls|trust anchor|hostname/.test(m))
    return { verdict: 'blocked', reason: 'Ошибка TLS/сертификата: страница не открыта; причина не установлена' };
  if (/reset|econnreset|closed|broken pipe|aborted|unexpected end/.test(m)) return { verdict: 'blocked', reason: 'соединение сброшено; причина не установлена' };
  if (/resolve|no address|nxdomain|enotfound|dns/.test(m)) return { verdict: 'blocked', reason: 'домен не резолвится (DNS)' };
  if (/cleartext|not permitted/.test(m)) return { verdict: 'blocked', reason: 'незашифрованное соединение запрещено' };
  return { verdict: 'blocked', reason: 'нет соединения' };
}
/** Жёсткий предел ожидания транспорта: зависший мост не держит всю проверку. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | NativeHttpProbe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<NativeHttpProbe>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `timeout: транспорт не ответил за ${Math.round(ms / 1000)} с` }), ms);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

const webSpeed = (ms: number) => ms > OK_MS ? 'slow' as const : 'ok' as const;

export async function probeSite(url: string, options: ProbeOptions = {}): Promise<SiteProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8000, verifyContent = options.verifyContent ?? true;
  url = canonicalServiceProbeUrl(url);
  const started = performance.now();
  if (!isNativeApp() && !options.nativeHttp) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
      const ms = Math.round(performance.now() - started);
      return { verdict: 'blocked', latencyMs: ms, proof: 'opaque', networkStatus: webSpeed(ms), probeUrl: url,
        reason: 'Браузер получил непрозрачный ответ: содержимое и HTTP-код недоступны' };
    } catch { return { verdict: 'blocked', latencyMs: null, networkStatus: 'blocked', reason: 'нет ответа (браузер)', probeUrl: url }; }
    finally { clearTimeout(timer); }
  }
  // Страховка на стороне JS: если нативный поток завис (бывает на DNS), проверка
  // всё равно закончится вовремя. Поздний ответ просто отбрасывается.
  const res = await raceTimeout((options.nativeHttp || httpProbe)(url, timeoutMs), timeoutMs + 400);
  if (!res.ok || res.status == null) return { ...classifyError(res.error || 'нет ответа'), latencyMs: null, networkStatus: 'blocked', probeUrl: url };
  try {
    const bytes = Uint8Array.from(atob(res.data_base64 || ''), (char) => char.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const ms = Math.round(res.latency_ms ?? performance.now() - started), finalUrl = res.url || url;
    const content = verifyContent ? assessSiteContent(finalUrl, text, res.status, res.content_type || '') : null;
    const base = { latencyMs: ms, httpStatus: res.status, probeUrl: finalUrl,
      detail: `${finalUrl !== url ? `редирект на ${finalUrl.slice(0, 100)} · ` : ''}${res.truncated ? 'прочитаны первые 256 KiB' : 'ответ прочитан'}` };
    if (content && !content.own) return { ...base, verdict: content.intercepted ? 'intercepted' : 'blocked',
      networkStatus: content.intercepted ? 'blocked' : webSpeed(ms), proof: 'opaque',
      challenge: content.challenge === true, reason: content.reason || 'сайт не открыл своё содержимое' };
    const own = res.status === 204 || Boolean(content?.own);
    return { ...base, verdict: own ? webSpeed(ms) : 'blocked', networkStatus: webSpeed(ms),
      proof: res.status === 204 ? 'endpoint' : content?.proof || 'opaque',
      reason: res.status >= 400 ? `Адрес ответил HTTP ${res.status}; страница не открыта`
        : !own ? 'Ответ адреса получен, но содержимое страницы не подтверждено' : 'Получен ответ адреса; работа приложения этим не доказана' };
  } catch (err) { return { ...classifyError(err instanceof Error ? err.message : String(err)), latencyMs: null, networkStatus: 'blocked', probeUrl: url }; }
}

/**
 * Общий алгоритм одиночной и массовой проверки.
 *
 * Каждый следующий шаг получает только остаток бюджета сайта: раньше первая
 * проба, главная страница, повтор и TCP складывались в 28 секунд на один сайт.
 * В быстром режиме повторов нет вовсе — сайты проверяются одним залпом.
 */
export async function probeSiteResilient(url: string, options: ProbeOptions = {}, signal?: AbortSignal): Promise<SiteProbeResult> {
  const retry = options.retry ?? true;
  const budgetLeft = () => options.deadlineAt == null ? (options.timeoutMs ?? 8000) : remainingMs(options.deadlineAt, performance.now());
  const firstBudget = budgetLeft();
  if (firstBudget == null) return { verdict: 'offline', latencyMs: null, networkStatus: 'blocked', attempts: 0,
    probeUrl: url, reason: 'Не проверен: вышло время проверки' };
  let first = await probeSite(url, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 8000, firstBudget) }), attempts = 1;
  if (signal?.aborted || !retry) return { ...first, attempts };
  let parsed: URL;
  try { parsed = new URL(canonicalServiceProbeUrl(url)); } catch { return { ...first, attempts, reason: 'Некорректный URL проверки' }; }
  const homepage = `${parsed.origin}/`;
  const fallbackBudget = budgetLeft();
  if (fallbackBudget != null && first.verdict === 'blocked' && homepage !== parsed.href && parsed.pathname !== '/') {
    const fallback = await probeSite(homepage, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 8000, fallbackBudget) }); attempts++;
    if (fallback.verdict === 'ok' || fallback.verdict === 'slow') return { ...fallback, attempts,
      reason: `${fallback.reason || 'Главная страница ответила'} · исходный адрес проверки не открылся` };
    if (first.httpStatus == null && fallback.httpStatus != null) first = fallback;
  }
  const retryBudget = budgetLeft();
  if (retryBudget != null && !signal?.aborted && first.verdict === 'blocked' && first.httpStatus == null && !/TLS/i.test(first.reason || '')) {
    const second = await probeSite(first.probeUrl || url, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 8000, retryBudget) }); attempts++;
    if (second.verdict === 'ok' || second.verdict === 'slow') return { ...second, attempts };
    // «Пинг идёт, а сайт не открывается» — разные вещи. Проверяем TCP 443, чтобы
    // честно сказать: маршрут до сервера есть, но страница не отдалась.
    const tcpBudget = budgetLeft();
    if ((options.tcpFallback ?? true) && tcpBudget != null && isNativeApp() && !signal?.aborted) {
      const tcp = await tcpPing(parsed.hostname, parsed.port ? Number(parsed.port) : 443, Math.min(4000, tcpBudget));
      if (tcp.ok) return { ...first, attempts,
        reason: `${first.reason || 'Страница не открылась'} · TCP-порт отвечает: маршрут до сервера есть, но HTTP-ответ не получен (защита от ботов, DPI или блокировка страницы)` };
    }
    return { ...first, attempts, reason: `${first.reason || 'Нет ответа'} · повторная проверка не помогла` };
  }
  return { ...first, attempts };
}
export async function probeControl(timeoutMs = 5000, nativeHttp?: ProbeOptions['nativeHttp']): Promise<boolean> {
  const targets = ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204', 'https://ya.ru/favicon.ico', 'https://www.rbc.ru/favicon.ico'];
  try {
    await Promise.any(targets.map(async (url) => {
      const res = await probeSite(url, { timeoutMs, verifyContent: false, nativeHttp });
      if (res.httpStatus != null && res.httpStatus >= 200 && res.httpStatus < 300) return true;
      throw new Error('control failed');
    })); return true;
  } catch { return false; }
}
