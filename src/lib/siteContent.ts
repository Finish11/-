import type { SiteProof } from '../types';

/**
 * Проверка содержимого HTTP-ответа отдельно от сетевого кода.
 * Это чистые функции: их можно регрессионно тестировать без Android.
 */

export interface SiteContentAssessment {
  own: boolean;
  /** Ответ пришёл, но принадлежит заглушке/посреднику, а не запрошенному сайту. */
  intercepted: boolean;
  reason?: string;
  proof?: SiteProof;
}

const STUB_MARKERS = [
  'доступ ограничен',
  'доступ к ресурсу ограничен',
  'запрещен',
  'запрещён',
  'блокиров',
  'роскомнадзор',
  'rkn.gov.ru',
  'eais.rkn',
  'zapret-info',
  'данный ресурс',
  'ресурс недоступен',
  'site blocked',
  'access denied by',
  'согласно требованиям законодательства',
  'портал провайдера',
  'vpn landing page',
];

// Это не подмена провайдером: так может отвечать сам сайт или Cloudflare.
// Но и успехом это не является — приложение пользователь всё равно не открыл.
const ACCESS_DENIED_MARKERS = [
  'just a moment',
  'checking your browser',
  'verify you are human',
  'verification you are human',
  'cf-chl',
  'challenge-platform',
  'captcha',
  'enable javascript and cookies to continue',
  'you have been blocked',
  'attention required!',
  'проверка браузера',
  'подтвердите, что вы человек',
  'доступ к сервису ограничен',
  'not available in your country',
  'country not supported',
  'unsupported_country',
];

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function expectedBrand(url: string): string {
  const host = hostname(url);
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return host;
  const suffix = parts.slice(-2).join('.');
  const secondLevelSuffixes = new Set(['co.uk', 'org.uk', 'com.au', 'net.au', 'co.jp', 'com.br']);
  const brand = secondLevelSuffixes.has(suffix)
    ? parts[parts.length - 3] || host
    : parts[parts.length - 2] || host;
  return brand.length >= 3 ? brand : host;
}

function isChatGpt(url: string): boolean {
  const host = hostname(url);
  return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
}

function looksLikeChatGptApp(lower: string): boolean {
  // Слабого слова ChatGPT недостаточно: оно есть и в заголовке страницы блокировки.
  if (
    lower.includes('cdn.oaistatic.com') ||
    lower.includes('chatgpt.com/backend-api') ||
    lower.includes('auth.openai.com')
  ) return true;
  return lower.includes('<title>chatgpt') &&
    (lower.includes('__next_f') || lower.includes('openai'));
}

function strictService(url: string, lower: string): { name: string; matches: boolean } | null {
  const host = hostname(url);
  if (isChatGpt(url)) return { name: 'ChatGPT', matches: looksLikeChatGptApp(lower) };
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return {
      name: 'YouTube',
      matches: lower.includes('youtube') && (
        lower.includes('ytcfg') || lower.includes('youtubei') ||
        lower.includes('googlevideo') || lower.includes('youtube.com/s/')
      ),
    };
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    return {
      name: 'Claude',
      matches: lower.includes('claude') && (
        lower.includes('anthropic') || lower.includes('claude.ai/') || lower.includes('/assets/')
      ),
    };
  }
  if (host === 'gemini.google.com') {
    return {
      name: 'Gemini',
      matches: lower.includes('gemini') && lower.includes('google') &&
        (lower.includes('<script') || lower.includes('accounts.google.com')),
    };
  }
  if (host === 'telegram.org' || host.endsWith('.telegram.org')) {
    return {
      name: 'Telegram',
      matches: lower.includes('telegram') && (
        lower.includes('webogram') || lower.includes('tdweb') ||
        lower.includes('web.telegram.org') || lower.includes('telegram.org/')
      ),
    };
  }
  if (host === 'whatsapp.com' || host.endsWith('.whatsapp.com')) {
    return {
      name: 'WhatsApp',
      matches: lower.includes('whatsapp') && (
        lower.includes('static.whatsapp.net') || lower.includes('web.whatsapp.com') ||
        lower.includes('/assets/')
      ),
    };
  }
  return null;
}

export function assessSiteContent(
  url: string,
  text: string,
  httpStatus = 200,
  contentType = ''
): SiteContentAssessment {
  const lower = text.toLowerCase();
  if (httpStatus === 204) return { own: true, intercepted: false, proof: 'endpoint' };

  if (ACCESS_DENIED_MARKERS.some((marker) => lower.includes(marker))) {
    return {
      own: false,
      intercepted: false,
      reason: 'сервис вернул проверку или отказ доступа, а не приложение',
    };
  }
  if (STUB_MARKERS.some((marker) => lower.includes(marker))) {
    return {
      own: false,
      intercepted: true,
      reason: 'вместо сайта открылась заглушка',
    };
  }

  const isImage = /^image\//i.test(contentType) || /favicon\.(ico|png|svg)|\.(ico|png|jpg|jpeg|gif|webp)(\?|$)/i.test(url);
  if (isImage) {
    // Бинарную картинку нативный HTTP отдаёт строкой; HTML вместо неё — не успех.
    return httpStatus >= 200 && httpStatus < 300 && (/^image\//i.test(contentType) || text.trim().length > 0) && !/<!doctype|<html|<head/i.test(lower)
      ? { own: true, intercepted: false, proof: 'endpoint' }
      : { own: false, intercepted: false, reason: 'вместо значка сайта пришла HTML-страница или отказ' };
  }

  const strict = strictService(url, lower);
  if (strict) {
    if (httpStatus >= 400) {
      return {
        own: false,
        intercepted: false,
        reason: `${strict.name} вернул HTTP ${httpStatus} — страница не открыта`,
      };
    }
    if (!strict.matches) {
      return {
        own: false,
        intercepted: false,
        reason: `Ответ ${strict.name} не распознан; это не доказательство подмены`,
      };
    }
    return { own: true, intercepted: false, proof: 'app' };
  }

  if (httpStatus >= 400) {
    return {
      own: false,
      intercepted: false,
      reason: `сервер вернул HTTP ${httpStatus} — страница не открыта`,
    };
  }
  if (!text.trim()) {
    return { own: false, intercepted: false, reason: 'сервер вернул пустой ответ; содержимое не подтверждено' };
  }
  const looksLikeHtml = /<!doctype|<html|<head|<title|<script|<body/i.test(lower);
  if (!looksLikeHtml) {
    return {
      own: true,
      intercepted: false,
      proof: 'endpoint',
      reason: 'адрес ответил текстом или данными, но не веб-страницей',
    };
  }
  const brand = expectedBrand(url);
  if (brand && !lower.includes(brand.toLowerCase())) {
    return {
      own: false,
      intercepted: false,
      reason: `HTML получен, но признаков сайта ${brand} недостаточно для подтверждения`,
    };
  }
  return { own: true, intercepted: false, proof: 'page' };
}
