import dns from 'node:dns/promises';
import {
  parseShareLink,
  parseSubscriptionText,
  parseUserInfoHeader,
  safeDecodeBase64,
  type ParsedNode,
} from '../src/lib/subscriptionParser.ts';

export { parseShareLink, parseSubscriptionText, parseUserInfoHeader };
export type { ParsedNode };

export interface SubscriptionPayload {
  nodes: ParsedNode[];
  format: 'base64' | 'plain' | 'json' | 'clash';
  traffic_used_bytes: number;
  traffic_total_bytes: number;
  expires_on: string | null;
  profile_title: string;
  raw_text: string;
}

export async function fetchSubscription(
  url: string,
  timeoutMs = 15000
): Promise<SubscriptionPayload> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Ссылка подписки должна начинаться с http:// или https://');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Многие панели отдают разные форматы в зависимости от User-Agent
        'User-Agent': 'Happ/3.6.0 (PulseNet; Android 14)',
        Accept: '*/*',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? 'сервер подписки не ответил вовремя'
        : 'не удалось подключиться к серверу подписки (возможна блокировка или неверный URL)';
    throw new Error(`Ошибка загрузки: ${reason}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`Сервер подписки вернул ${res.status}. Проверьте ссылку или срок действия ключа.`);
  }

  const rawText = await res.text();
  const info = parseUserInfoHeader(res.headers.get('subscription-userinfo'));

  let profileTitle = '';
  const titleHeader = res.headers.get('profile-title');
  if (titleHeader) {
    profileTitle = titleHeader.startsWith('base64:')
      ? safeDecodeBase64(titleHeader.slice(7))
      : titleHeader;
  }

  const parsed = parseSubscriptionText(rawText);

  return {
    nodes: parsed.nodes,
    format: parsed.format,
    traffic_used_bytes: info.used,
    traffic_total_bytes: info.total,
    expires_on: info.expires_on,
    profile_title: profileTitle.trim(),
    raw_text: rawText,
  };
}

/** Быстрая проверка доступности узла через TCP-хендшейк. */
export async function resolveHost(host: string): Promise<string | null> {
  try {
    const info = await dns.lookup(host);
    return info.address;
  } catch {
    return null;
  }
}
