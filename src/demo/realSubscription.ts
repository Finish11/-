import {
  parseSubscriptionText,
  parseUserInfoHeader,
  safeDecodeBase64,
  type ParsedNode,
} from '../lib/subscriptionParser';
import { nativeGet } from '../lib/nativeBridge';

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
  const res = await nativeGet(url, 20000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Сервер подписки вернул ${res.status}. Проверьте ссылку или срок действия ключа.`
    );
  }

  const parsed = parseSubscriptionText(res.text);
  if (parsed.nodes.length === 0) {
    throw new Error(
      'В ответе нет узлов. Возможно, сервер отдал HTML-страницу вместо подписки — проверьте ссылку.'
    );
  }

  const info = parseUserInfoHeader(res.headers['subscription-userinfo'] || null);
  const titleHeader = res.headers['profile-title'];
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
    rawText: res.text,
  };
}
