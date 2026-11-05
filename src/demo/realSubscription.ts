import {
  parseSubscriptionText,
  parseUserInfoHeader,
  safeDecodeBase64,
  type ParsedNode,
} from '../lib/subscriptionParser';
import { fetchTextUniversal, isNativeApp, nativeGet } from '../lib/nativeBridge';

export interface RealSubscription {
  nodes: ParsedNode[];
  format: 'base64' | 'plain' | 'json' | 'clash';
  title: string;
  trafficUsed: number;
  trafficTotal: number;
  expiresOn: string | null;
  rawText: string;
}

/**
 * Скачивает настоящую подписку по URL через нативный HTTP (только в APK).
 * Разбор — общий с сервером модуль, поэтому распознаются те же 79 узлов,
 * что и в полной версии.
 */
export async function importRealSubscription(url: string): Promise<RealSubscription> {
  let text = '';
  let headers: Record<string, string> = {};

  if (isNativeApp()) {
    try {
      const res = await nativeGet(url, 20000);
      if (res.status >= 200 && res.status < 300) {
        text = res.text;
        headers = res.headers;
      } else {
        throw new Error(`сервер ответил ${res.status}`);
      }
    } catch (nativeError) {
      // Вторая попытка — обычный fetch (часть панелей отдаёт CORS-заголовки).
      try {
        text = await fetchTextUniversal(url, 20000);
      } catch (fetchError) {
        throw new Error(
          `Панель не отдала подписку. ${
            nativeError instanceof Error ? nativeError.message : String(nativeError)
          }. ${
            fetchError instanceof Error ? fetchError.message : String(fetchError)
          }`
        );
      }
    }
  } else {
    text = await fetchTextUniversal(url, 20000);
  }

  let parsed = parseSubscriptionText(text);

  // Панели отдают разный формат в зависимости от клиента: v2rayNG часто
  // получает base64-список, Clash — YAML, sing-box — JSON. Если с первого
  // раза узлов нет, пробуем «поговорить» как другие клиенты.
  if (parsed.nodes.length === 0 && isNativeApp()) {
    const agents = [
      'v2rayNG/1.9.16 (Linux; Android 14)',
      'ClashMetaForAndroid/2.10.1 Mihomo/1.18.5',
      'Streisand/1.6 CFNetwork/1494 Darwin/23.4.0',
    ];
    for (const ua of agents) {
      try {
        const retry = await nativeGet(url, 20000, ua);
        if (retry.status >= 200 && retry.status < 300 && retry.text) {
          const again = parseSubscriptionText(retry.text);
          if (again.nodes.length > 0) {
            parsed = again;
            text = retry.text;
            break;
          }
        }
      } catch {
        // пробуем следующий клиент
      }
    }
  }

  if (parsed.nodes.length === 0) {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    const hint = /^\s*</.test(text)
      ? 'Сервер отдал HTML-страницу вместо подписки (обычно так панель требует вход или блокирует клиента).'
      : /^\s*\{/.test(text)
      ? 'Похоже на JSON неизвестной структуры.'
      : 'В ответе не нашлось ни одной ссылки на узлы.';
    throw new Error(
      `${hint} Получено ${text.length} символов. Начало ответа: «${preview}». ` +
        'Уточните ссылку в личном кабинете или вставьте ссылки узлов вручную.'
    );
  }

  const info = parseUserInfoHeader(headers['subscription-userinfo'] || null);
  const titleHeader = headers['profile-title'];
  const title = titleHeader
    ? titleHeader.startsWith('base64:')
      ? safeDecodeBase64(titleHeader.slice(7))
      : titleHeader
    : '';

  return {
    nodes: parsed.nodes,
    format: parsed.format === 'clash' ? 'json' : parsed.format,
    title: title.trim(),
    trafficUsed: info.used,
    trafficTotal: info.total,
    expiresOn: info.expires_on,
    rawText: text,
  };
}
