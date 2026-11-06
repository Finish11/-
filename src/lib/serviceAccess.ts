import type { ScanSiteResult, Site } from '../types';

export interface ServiceAccessContext {
  /** Пользователь явно подтвердил замер через VPN. */
  withVpn: boolean;
  /** Страна внешнего IP на начало замера. */
  countryCode?: string | null;
}

interface RegionPolicy {
  domains: string[];
  service: string;
  sourceUrl: string;
  note: string;
}

/**
 * Справочные ограничения самих провайдеров, а не вывод из одного HTTP-запроса.
 * Россия отсутствует в официальных списках поддерживаемых стран этих сервисов.
 */
const REGION_POLICIES: RegionPolicy[] = [
  {
    domains: ['chatgpt.com', 'chat.openai.com'],
    service: 'ChatGPT',
    sourceUrl: 'https://help.openai.com/en/articles/7947663-chatgpt-supported-countries',
    note:
      'OpenAI не указывает Россию среди поддерживаемых стран ChatGPT. Открытая заставка сайта не доказывает доступ ко входу и чату. Это региональное ограничение сервиса, а не автоматический диагноз «блок РКН».',
  },
  {
    domains: ['claude.ai'],
    service: 'Claude',
    sourceUrl: 'https://www.anthropic.com/legal/supported-regions',
    note:
      'Anthropic не указывает Россию в Supported Regions. Доступ к Claude из RU ограничен правилами самого сервиса; загрузка HTML не подтверждает работу приложения или аккаунта.',
  },
  {
    domains: ['gemini.google.com'],
    service: 'Gemini',
    sourceUrl: 'https://support.google.com/gemini/answer/13575153?hl=ru',
    note:
      'Google не указывает Россию в списке доступности Gemini. Доступность web и мобильного приложения может отличаться, поэтому открытая страница не является проверкой приложения.',
  },
];

const APP_ONLY_DOMAINS = new Set([
  'web.whatsapp.com',
  'whatsapp.com',
  'web.telegram.org',
  'telegram.org',
]);

const normalized = (domain: string) => domain.toLowerCase().replace(/^www\./, '');

function regionPolicyFor(domain: string): RegionPolicy | undefined {
  const host = normalized(domain);
  return REGION_POLICIES.find((policy) => policy.domains.includes(host));
}

/**
 * Отделяет измеренный HTTP-ответ от работоспособности native/web-приложения.
 * Неизвестный результат никогда не превращается ни в успех, ни в доказанный блок.
 */
export function applyServiceAccessPolicy(
  site: Pick<Site, 'domain'>,
  measured: ScanSiteResult,
  context: ServiceAccessContext
): ScanSiteResult {
  const result: ScanSiteResult = {
    ...measured,
    network_status: measured.network_status ?? measured.status,
    network_latency_ms: measured.network_latency_ms ?? measured.latency_ms,
  };
  const regionPolicy = regionPolicyFor(site.domain);
  const directRussia = !context.withVpn && context.countryCode?.toUpperCase() === 'RU';

  if (regionPolicy && directRussia) {
    return {
      ...result,
      status: 'blocked',
      latency_ms: null,
      block_reason: 'provider_region',
      intercepted: false,
      proof: 'opaque',
      access_scope: 'provider_region_ru',
      source_url: regionPolicy.sourceUrl,
      note: `Справочно для прямого RU-IP: ${regionPolicy.note}`,
    };
  }

  const appRelevant = Boolean(regionPolicy) || APP_ONLY_DOMAINS.has(normalized(site.domain));
  if (!appRelevant) return result;

  if (result.status === 'blocked' || result.intercepted) {
    return {
      ...result,
      block_reason: 'unknown',
      intercepted: false,
      proof: 'opaque',
      access_scope: 'app_unconfirmed',
      note:
        'Работа приложения не подтверждена: адрес не дал достаточного распознаваемого ответа. Это не доказательство блокировки. Проверьте вход и отправку сообщения в самом приложении.',
    };
  }

  return {
    ...result,
    proof: 'page',
    access_scope: 'web_only',
    note:
      'Получена ожидаемая веб-страница. Установленное приложение, вход в аккаунт, звонки и отправка сообщений этим замером не проверяются.',
  };
}
