import { Network } from '@capacitor/network';
import { isNativeApp } from './nativeBridge';
import { readSettings } from './appSettings';

export type ConnectionKind = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';

export interface NetworkContext {
  /** Тип подключения: Wi-Fi или мобильная сеть (это влияет на белые списки). */
  kind: ConnectionKind;
  ip: string;
  city: string;
  region: string;
  countryCode: string;
  /** Провайдер по данным гео-сервиса. */
  isp: string;
  /** Итоговый оператор: из настроек, иначе распознанный по ISP. */
  operator: string;
  /** Откуда взялись оператор и город. */
  source: 'settings' | 'auto' | 'partial';
  note: string;
}


/** Распознаём оператора по строке провайдера из гео-сервиса. */
export function guessOperator(isp: string): string {
  const s = (isp || '').toLowerCase();
  if (/beeline|vympel|вымпелком/.test(s)) return 'Билайн';
  if (/\bmts\b|mts|мтс/.test(s)) return 'МТС';
  if (/megafon|мегафон/.test(s)) return 'МегаФон';
  if (/tele2|\bt2\b/.test(s)) return 'Tele2';
  if (/yota/.test(s)) return 'Yota';
  if (/tinkoff|тбанк|tbank/.test(s)) return 'Тинькофф Мобайл';
  if (/sber|сбер/.test(s)) return 'СберМобайл';
  if (/motiv|мотив/.test(s)) return 'Мотив';
  if (/rostelecom|ertelecom|dom\.ru|mgts|мгтс/.test(s)) return 'Домашний провайдер';
  return '';
}

async function detectKind(): Promise<ConnectionKind> {
  const settings = readSettings();
  if (settings.networkType !== 'auto') return settings.networkType;

  if (isNativeApp()) {
    try {
      const status = await Network.getStatus();
      const type = String(status.connectionType || 'unknown');
      if (!status.connected) return 'none';
      if (type === 'wifi') return 'wifi';
      if (type === 'cellular') return 'cellular';
      if (type === 'ethernet') return 'ethernet';
    } catch {
      // плагин недоступен — падаем в браузерную эвристику
    }
  }

  const nav = navigator as Navigator & { connection?: { type?: string; effectiveType?: string } };
  const t = nav.connection?.type;
  if (t === 'wifi') return 'wifi';
  if (t === 'cellular') return 'cellular';
  if (nav.connection?.effectiveType) return 'cellular';
  return 'unknown';
}

interface IpGeo {
  ip?: string;
  city?: string;
  region?: string;
  country_code?: string;
  connection?: { isp?: string; org?: string };
  success?: boolean;
}

async function detectGeo(): Promise<IpGeo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch('https://ipwho.is/', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as IpGeo;
    if (data.success === false) return null;
    return data;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Контекст сети: тип подключения, оператор и город.
 * Приоритет у настроек пользователя: если оператор или город указаны вручную,
 * они важнее автоматики (гео-сервисы часто показывают хостера, а не оператора).
 */
export async function detectNetworkContext(): Promise<NetworkContext> {
  const settings = readSettings();
  const [kind, geo] = await Promise.all([detectKind(), detectGeo()]);

  const isp = geo?.connection?.isp || geo?.connection?.org || '';
  const autoOperator = guessOperator(isp);
  const autoCity = geo?.city || '';

  const operator = settings.operator || autoOperator;
  const city = settings.city || autoCity;

  let source: NetworkContext['source'] = 'auto';
  if (settings.operator && settings.city) source = 'settings';
  else if (settings.operator || settings.city) source = 'partial';

  const kindLabel =
    kind === 'wifi' ? 'Wi-Fi' : kind === 'cellular' ? 'Мобильная сеть' : kind === 'ethernet' ? 'Ethernet' : 'Сеть';

  const note = !geo
    ? 'Гео-сервис недоступен — оператора и город можно указать в настройках'
    : !autoOperator && !settings.operator
    ? 'Оператор не распознан по IP — выберите его в настройках'
    : `${kindLabel}${operator ? ` · ${operator}` : ''}${city ? ` · ${city}` : ''}`;

  return {
    kind,
    ip: geo?.ip || '',
    city,
    region: geo?.region || '',
    countryCode: geo?.country_code || '',
    isp,
    operator,
    source,
    note,
  };
}

export const connectionLabel = (kind: ConnectionKind): string =>
  kind === 'wifi'
    ? 'Wi-Fi'
    : kind === 'cellular'
    ? 'Моб. сеть'
    : kind === 'ethernet'
    ? 'Ethernet'
    : kind === 'none'
    ? 'Нет сети'
    : 'Сеть';

