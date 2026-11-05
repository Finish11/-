import { CapacitorHttp } from '@capacitor/core';
import { isNativeApp } from './nativeBridge';
import { assessSiteContent } from './siteContent';

/**
 * Проверка доступности сайта «по-настоящему».
 *
 * Зачем это отдельно от старого `measureUrl`: раньше любой ответ (или вообще
 * любой не-таймаут) считался успехом. В реальности при блокировке провайдер
 * часто отвечает сам — отдаёт заглушку, режет TLS или подменяет сертификат,
 * и замер показывал «доступен» там, где сайт открыть нельзя.
 *
 * Теперь для каждого сайта мы требуем доказательство, что ответил именно он:
 *   1. контрольная проба — если сеть мертва целиком, все сайты будут «сеть недоступна»;
 *   2. запрос probe_url и проверка содержимого (HTML/картинка/ожидаемый текст);
 *   3. отдельно ловим подмену TLS и заглушки провайдера — это DPI, а не «нет связи».
 */

export type ProbeVerdict =
  | 'ok' // сайт ответил своим содержимым
  | 'slow' // ответил, но медленно
  | 'blocked' // не ответил: таймаут / разрыв / ошибка TLS
  | 'intercepted' // ответ есть, но это не сайт: заглушка провайдера или подмена TLS
  | 'offline'; // не работает сеть целиком (проверять нечего)

export interface SiteProbeResult {
  verdict: ProbeVerdict;
  latencyMs: number | null;
  /** HTTP-код, если ответ был */
  httpStatus?: number;
  /** Короткая причина для интерфейса */
  reason?: string;
  /** Что именно пришло — для подсказки в карточке сайта */
  detail?: string;
}

const OK_MS = 1500;
const SLOW_MS = 4000;

/** Разбираем текст ошибки в понятную причину. */
const classifyError = (message: string): { verdict: ProbeVerdict; reason: string } => {
  const m = message.toLowerCase();
  if (/timeout|timed out|deadline/.test(m)) {
    return { verdict: 'blocked', reason: 'сервер не ответил (таймаут)' };
  }
  if (
    /certificate|ssl|cert|handshake|tls|err_ssl|trust anchor|hostname/.test(m)
  ) {
    return { verdict: 'intercepted', reason: 'TLS-сертификат не совпадает с сайтом — вероятно DPI' };
  }
  if (/reset|econnreset|connection closed|broken pipe|aborted|unexpected end/.test(m)) {
    return { verdict: 'blocked', reason: 'соединение сброшено (похоже на фильтрацию)' };
  }
  if (/unable to resolve|no address associated|nxdomain|enotfound|dns/.test(m)) {
    return { verdict: 'blocked', reason: 'домен не резолвится (DNS)' };
  }
  if (/cleartext|not permitted/.test(m)) {
    return { verdict: 'blocked', reason: 'Android запретил незашифрованное соединение' };
  }
  return { verdict: 'blocked', reason: 'нет соединения' };
};

export interface ProbeOptions {
  timeoutMs?: number;
  /** Проверять содержимое (по умолчанию да). */
  verifyContent?: boolean;
}

/**
 * Одна проба сайта. В APK — нативный HTTP (не подчиняется CORS),
 * в браузере — no-cors (тогда проверяем только сам факт ответа).
 */
export async function probeSite(
  url: string,
  options: ProbeOptions = {}
): Promise<SiteProbeResult> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const verifyContent = options.verifyContent ?? true;
  const started = Date.now();

  if (!isNativeApp()) {
    // Браузер: содержимое недоступно, поэтому «ответил» ≠ «доступен».
    // Такие данные помечаются как грубая оценка (см. ScannerView).
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      await fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const ms = Date.now() - started;
      return { verdict: ms <= OK_MS ? 'ok' : ms <= SLOW_MS ? 'slow' : 'blocked', latencyMs: ms };
    } catch {
      return { verdict: 'blocked', latencyMs: null, reason: 'нет ответа (браузер)' };
    }
  }

  try {
    const res = await CapacitorHttp.request({
      url,
      method: 'GET',
      responseType: 'text',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      headers: { Accept: '*/*', 'Cache-Control': 'no-cache' },
    });
    const ms = Date.now() - started;
    const text = typeof res.data === 'string' ? res.data : '';
    const finalUrl = (res as unknown as { url?: string }).url || url;

    const content = verifyContent ? assessSiteContent(url, text, res.status) : null;
    if (content && !content.own) {
      return {
        verdict: content.intercepted ? 'intercepted' : 'blocked',
        latencyMs: ms,
        httpStatus: res.status,
        reason: content.reason || 'сайт не открыл своё содержимое',
        detail: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      };
    }

    // Для остальных ресурсов 4xx/5xx от своего сервера — всё-таки его ответ
    // (например, favicon отдаёт 404). У ChatGPT правило строже, см. siteContent.
    return {
      verdict: ms <= OK_MS ? 'ok' : ms <= SLOW_MS ? 'slow' : 'blocked',
      latencyMs: ms,
      httpStatus: res.status,
      detail: finalUrl !== url ? `редирект на ${finalUrl.slice(0, 80)}` : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyError(message);
    return { ...classified, latencyMs: null };
  }
}

/**
 * Контрольная проба: гарантированно нейтральный хост.
 * Если и он не отвечает — сеть мертва целиком, и осуждать сайты нельзя.
 */
export async function probeControl(timeoutMs = 5000): Promise<boolean> {
  // Порядок важен: сначала нейтральные зарубежные адреса, затем российские —
  // при белых списках зарубежные не ответят, а Рунет работает.
  const targets = [
    'https://www.gstatic.com/generate_204',
    'https://cp.cloudflare.com/generate_204',
    'https://ya.ru/favicon.ico',
    'https://www.rbc.ru/favicon.ico',
  ];
  // Ждём первый удачный ответ, остальные адреса идут параллельно. Последовательный
  // перебор раньше добавлял до 20 секунд ещё до появления прогресса по сайтам.
  const attempts = targets.map(async (url) => {
    const res = await probeSite(url, { timeoutMs, verifyContent: false });
    if (res.verdict === 'ok' || res.verdict === 'slow') return true;
    throw new Error('control failed');
  });
  try {
    await Promise.any(attempts);
    return true;
  } catch {
    return false;
  }
}
