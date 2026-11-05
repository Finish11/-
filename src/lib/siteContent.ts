/**
 * Проверка содержимого HTTP-ответа отдельно от сетевого кода.
 * Это чистые функции: их можно регрессионно тестировать без Android.
 */

export interface SiteContentAssessment {
  own: boolean;
  /** Ответ пришёл, но принадлежит заглушке/посреднику, а не запрошенному сайту. */
  intercepted: boolean;
  reason?: string;
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

export function assessSiteContent(
  url: string,
  text: string,
  httpStatus = 200
): SiteContentAssessment {
  const lower = text.toLowerCase();

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

  const isImage = /favicon\.(ico|png|svg)|\.(ico|png|jpg|jpeg|gif|webp)(\?|$)/i.test(url);
  if (isImage) {
    // Бинарную картинку нативный HTTP отдаёт строкой; HTML вместо неё — не успех.
    return text.trim().length > 0 && !/<!doctype|<html|<head/i.test(lower)
      ? { own: true, intercepted: false }
      : { own: false, intercepted: true, reason: 'вместо значка сайта пришла HTML-страница' };
  }

  if (isChatGpt(url)) {
    if (httpStatus >= 400) {
      return {
        own: false,
        intercepted: false,
        reason: `ChatGPT вернул HTTP ${httpStatus} — приложение не открыто`,
      };
    }
    if (!looksLikeChatGptApp(lower)) {
      return {
        own: false,
        intercepted: true,
        reason: 'вместо приложения ChatGPT пришла другая страница',
      };
    }
  }

  return text.trim().length > 0
    ? { own: true, intercepted: false }
    : { own: false, intercepted: true, reason: 'сервер вернул пустой ответ' };
}
