import {
  explainEmptyParse,
  parseSubscriptionText,
  parseUserInfoHeader,
  safeDecodeBase64,
  type ParsedNode,
} from '../lib/subscriptionParser';
import { fetchTextUniversal, humanizeNetworkError, isNativeApp, nativeGet } from '../lib/nativeBridge';

export interface RealSubscription {
  nodes: ParsedNode[];
  format: 'base64' | 'plain' | 'json' | 'clash';
  title: string;
  trafficUsed: number;
  trafficTotal: number;
  expiresOn: string | null;
  rawText: string;
  /** Каким клиентом удалось получить подписку — полезно в диагностике. */
  via?: string;
}

/**
 * Заголовки, под которыми ходят популярные клиенты. Панели (Marzban, 3x-ui,
 * Remnawave, Happ, Oversub) отдают разный формат в зависимости от этого:
 * v2rayNG получает base64-список, Clash Meta — YAML, sing-box — JSON-конфиг.
 * Поэтому мы пробуем «поговорить» как каждый из них, пока не найдём узлы.
 */
const CLIENT_PROBES: Array<{ ua: string; accept?: string; via: string }> = [
  {
    ua: 'Happ/3.6.0 (PulseNet; Android 14)',
    via: 'Happ',
  },
  {
    ua: 'v2rayNG/1.9.16 (Linux; Android 14)',
    accept: '*/*',
    via: 'v2rayNG',
  },
  {
    ua: 'ClashMetaForAndroid/2.11.1 Mihomo/1.19.0',
    accept: '*/*',
    via: 'Clash Meta',
  },
  {
    ua: 'Streisand/1.6 CFNetwork/1494 Darwin/23.4.0',
    accept: '*/*',
    via: 'Streisand',
  },
  {
    ua: 'sing-box/1.11.0 (Android 14)',
    accept: 'application/json',
    via: 'sing-box',
  },
  {
    ua: 'Hiddify/2.5.7 (Android 14)',
    accept: '*/*',
    via: 'Hiddify',
  },
];

/**
 * Нормализуем ссылку: убираем пробелы и «умные» кавычки из вставленного текста.
 * Если схему забыли («panel.example.com/sub/abc») — подставляем https.
 */
export function cleanSubscriptionUrl(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^[«"'`\s]+|[»"'`\s]+$/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!cleaned) return cleaned;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  // Забыли схему — это самая частая причина «ссылка не принимается».
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|\?|:|$)/i.test(cleaned)) return `https://${cleaned}`;
  return cleaned;
}

/**
 * Скачивает настоящую подписку и разбирает её.
 *
 * Порядок:
 *  1. первый запрос «как Happ» — самый частый формат у панелей этого типа;
 *  2. если узлов нет — перебираем остальных клиентов (v2rayNG, Clash Meta…);
 *  3. если сеть вообще не отвечает — сразу понятная ошибка с советом.
 *
 * В браузере (не APK) работает обычный fetch: часть панелей отдаёт CORS-заголовки.
 */
export async function importRealSubscription(rawUrl: string): Promise<RealSubscription> {
  const url = cleanSubscriptionUrl(rawUrl);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      'Это не похоже на ссылку подписки. Нужен адрес вида https://panel.example.com/sub/xxxx — либо вставьте сами ссылки узлов (vless://, vmess://) на вкладке «Ссылки узлов».'
    );
  }

  // Общий бюджет времени: шесть попыток по 20 секунд — слишком долго для телефона.
  const deadline = Date.now() + 35000;

  const attempts: string[] = [];
  let bestEmpty = '';
  let text = '';
  let headers: Record<string, string> = {};
  let via = '';

  for (const probe of CLIENT_PROBES) {
    if (Date.now() > deadline) {
      attempts.push('время ожидания истекло');
      break;
    }
    try {
      const res = isNativeApp()
        ? await nativeGet(url, 20000, probe.ua, probe.accept ? { Accept: probe.accept } : {})
        : await legacyFetch(url, probe.ua);

      if (res.status < 200 || res.status >= 300) {
        attempts.push(`${probe.via}: ответ ${res.status}`);
        // 401/403/404 — дальше перебирать клиентов бессмысленно
        if ([401, 403, 404, 410].includes(res.status)) break;
        continue;
      }

      if (!res.text || res.text.trim().length === 0) {
        attempts.push(`${probe.via}: пустой ответ`);
        continue;
      }

      const parsed = parseSubscriptionText(res.text);
      if (parsed.nodes.length > 0) {
        text = res.text;
        headers = res.headers;
        via = probe.via;
        break;
      }

      // Запоминаем «содержательный, но бесполезный» ответ для диагностики
      if (!bestEmpty) {
        bestEmpty = res.text;
        headers = res.headers;
      }
      attempts.push(`${probe.via}: узлов не найдено в ответе`);
    } catch (err) {
      // Сетевые ошибки повторяем у следующего клиента только один раз:
      // если домен не резолвится, шесть попыток ничего не изменят.
      const reason = humanizeNetworkError(err);
      attempts.push(`${probe.via}: ${reason}`);
      if (/не резолвится|не ответил вовремя|TLS/i.test(reason)) break;
    }
  }

  if (!text) {
    // Сеть ответила, но разобрать не удалось — показываем, что именно пришло
    if (bestEmpty) {
      const preview = bestEmpty.replace(/\s+/g, ' ').trim().slice(0, 160);
      const title = readTitle(headers);
      throw new Error(
        [
          explainEmptyParse(bestEmpty),
          `Размер ответа: ${bestEmpty.length} символов.`,
          title ? `Панель представилась как «${title}».` : '',
          `Начало ответа: «${preview}».`,
          attempts.length ? `Попытки: ${attempts.slice(0, 3).join('; ')}.` : '',
          'Скопируйте ссылку узла из личного кабинета и вставьте её вручную — импорт по ссылкам работает без панели.',
        ]
          .filter(Boolean)
          .join(' ')
      );
    }
    throw new Error(
      [
        'Не удалось скачать подписку.',
        attempts[0] ? attempts[0].replace(/^[^:]+:\s*/, '').replace(/^\w/, (c) => c.toUpperCase()) + '.' : '',
        'Если адрес панели не открывается у вашего оператора — включите VPN и нажмите «Загрузить подписку» ещё раз.',
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  const parsed = parseSubscriptionText(text);
  const info = parseUserInfoHeader(headers['subscription-userinfo'] || null);

  return {
    nodes: parsed.nodes,
    format: parsed.format === 'clash' ? 'json' : parsed.format,
    title: readTitle(headers),
    trafficUsed: info.used,
    trafficTotal: info.total,
    expiresOn: info.expires_on,
    rawText: text,
    via,
  };
}

/** Заголовки панели: Profile-Title / profile-title, иногда в base64. */
function readTitle(headers: Record<string, string>): string {
  const raw =
    headers['profile-title'] ||
    headers['profile-username'] ||
    headers['x-profile-title'] ||
    '';
  if (!raw) return '';
  const value = raw.startsWith('base64:') ? safeDecodeBase64(raw.slice(7)) : raw;
  // Часть панелей отдаёт нестроковый JSON — тогда просто игнорируем
  return value && !value.startsWith('{') ? value.trim().slice(0, 80) : '';
}

/** Обычный fetch для браузера: пробуем с указанным UA, если не вышло — без него. */
async function legacyFetch(
  url: string,
  userAgent: string
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': userAgent, Accept: '*/*' },
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, text, headers };
  } catch (err) {
    // Браузер мог заблокировать нестандартный UA в CORS-предзапросе — пробуем без него
    if (isNativeApp()) throw err;
    try {
      return await fetchTextUniversal(url, 20000).then((t) => ({
        status: 200,
        text: t,
        headers: {} as Record<string, string>,
      }));
    } catch {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}
