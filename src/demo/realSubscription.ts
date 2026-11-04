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

  const parsed = parseSubscriptionText(text);
  if (parsed.nodes.length === 0) {
    throw new Error(
      'В ответе нет узлов. Возможно, сервер отдал HTML-страницу вместо подписки — проверьте ссылку.'
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
