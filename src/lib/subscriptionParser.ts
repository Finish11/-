/**
 * Разбор VPN-подписок и share-ссылок.
 *
 * Чистый TypeScript без Node-зависимостей: один и тот же код работает и на
 * сервере (`server/subscription.ts`), и в APK (`src/demo/localApi.ts`), где
 * запрос к панели делает нативный HTTP.
 *
 * Форматы, которые понимаем (как это делают v2rayNG, Clash Meta, Streisand,
 * Happ и Hiddify):
 *   1. список share-ссылок в открытом виде;
 *   2. base64 от этого списка (самый частый вариант панелей);
 *   3. base64 внутри base64 (встречается у панелей с «двойной» упаковкой);
 *   4. Clash / mihomo YAML (`proxies:`);
 *   5. sing-box / Xray JSON-конфиг целиком (узлы в `outbounds`);
 *   6. JSON-список ссылок или объектов;
 *   7. SIP002 / Shadowsocks, VMess (base64 JSON), Hysteria2, TUIC, WireGuard.
 *
 * Правило: ни один кривой узел не должен ломать разбор всей подписки.
 */

import { decodeBase64, encodeBase64, looksLikeBase64 } from './base64';

export interface ParsedNode {
  name: string;
  protocol: string;
  host: string;
  port: number;
  country_code: string;
  location: string;
  provider: string;
  dpi_resistance: 'high' | 'medium' | 'low';
  whitelist_bypass: boolean;
  raw_link: string;
  group_name: string;
}

export interface SubscriptionPayload {
  nodes: ParsedNode[];
  format: 'base64' | 'plain' | 'json' | 'clash';
  traffic_used_bytes: number;
  traffic_total_bytes: number;
  expires_on: string | null;
  profile_title: string;
  raw_text: string;
}

const FLAG_TO_COUNTRY: Record<string, { code: string; name: string }> = {
  '🇳🇱': { code: 'NL', name: 'Нидерланды' },
  '🇩🇪': { code: 'DE', name: 'Германия' },
  '🇫🇮': { code: 'FI', name: 'Финляндия' },
  '🇸🇪': { code: 'SE', name: 'Швеция' },
  '🇫🇷': { code: 'FR', name: 'Франция' },
  '🇬🇧': { code: 'GB', name: 'Великобритания' },
  '🇺🇸': { code: 'US', name: 'США' },
  '🇨🇦': { code: 'CA', name: 'Канада' },
  '🇵🇱': { code: 'PL', name: 'Польша' },
  '🇱🇻': { code: 'LV', name: 'Латвия' },
  '🇱🇹': { code: 'LT', name: 'Литва' },
  '🇪🇪': { code: 'EE', name: 'Эстония' },
  '🇹🇷': { code: 'TR', name: 'Турция' },
  '🇦🇪': { code: 'AE', name: 'ОАЭ' },
  '🇦🇲': { code: 'AM', name: 'Армения' },
  '🇬🇪': { code: 'GE', name: 'Грузия' },
  '🇰🇿': { code: 'KZ', name: 'Казахстан' },
  '🇷🇺': { code: 'RU', name: 'Россия' },
  '🇨🇭': { code: 'CH', name: 'Швейцария' },
  '🇦🇹': { code: 'AT', name: 'Австрия' },
  '🇮🇹': { code: 'IT', name: 'Италия' },
  '🇪🇸': { code: 'ES', name: 'Испания' },
  '🇨🇿': { code: 'CZ', name: 'Чехия' },
  '🇯🇵': { code: 'JP', name: 'Япония' },
  '🇸🇬': { code: 'SG', name: 'Сингапур' },
  '🇭🇰': { code: 'HK', name: 'Гонконг' },
  '🇰🇷': { code: 'KR', name: 'Южная Корея' },
  '🇮🇳': { code: 'IN', name: 'Индия' },
  '🇧🇷': { code: 'BR', name: 'Бразилия' },
  '🇦🇺': { code: 'AU', name: 'Австралия' },
  '🇮🇱': { code: 'IL', name: 'Израиль' },
  '🇲🇩': { code: 'MD', name: 'Молдова' },
  '🇷🇸': { code: 'RS', name: 'Сербия' },
  '🇭🇺': { code: 'HU', name: 'Венгрия' },
  '🇷🇴': { code: 'RO', name: 'Румыния' },
  '🇧🇬': { code: 'BG', name: 'Болгария' },
  '🇬🇷': { code: 'GR', name: 'Греция' },
  '🇮🇸': { code: 'IS', name: 'Исландия' },
  '🇳🇴': { code: 'NO', name: 'Норвегия' },
  '🇩🇰': { code: 'DK', name: 'Дания' },
  '🇧🇪': { code: 'BE', name: 'Бельгия' },
  '🇮🇪': { code: 'IE', name: 'Ирландия' },
  '🇵🇹': { code: 'PT', name: 'Португалия' },
  '🇺🇦': { code: 'UA', name: 'Украина' },
  '🇦🇿': { code: 'AZ', name: 'Азербайджан' },
  '🇺🇿': { code: 'UZ', name: 'Узбекистан' },
  '🇰🇬': { code: 'KG', name: 'Кыргызстан' },
  '🇧🇾': { code: 'BY', name: 'Беларусь' },
  '🇨🇳': { code: 'CN', name: 'Китай' },
  '🇹🇭': { code: 'TH', name: 'Таиланд' },
  '🇻🇳': { code: 'VN', name: 'Вьетнам' },
  '🇮🇩': { code: 'ID', name: 'Индонезия' },
  '🇲🇽': { code: 'MX', name: 'Мексика' },
  '🇦🇷': { code: 'AR', name: 'Аргентина' },
  '🇿🇦': { code: 'ZA', name: 'ЮАР' },
  '🇪🇬': { code: 'EG', name: 'Египет' },
  '🇶🇦': { code: 'QA', name: 'Катар' },
  '🇸🇦': { code: 'SA', name: 'Саудовская Аравия' },
  '🇮🇷': { code: 'IR', name: 'Иран' },
  '🇨🇱': { code: 'CL', name: 'Чили' },
  '🇳🇿': { code: 'NZ', name: 'Новая Зеландия' },
  '🇲🇳': { code: 'MN', name: 'Монголия' },
  '🇸🇰': { code: 'SK', name: 'Словакия' },
  '🇸🇮': { code: 'SI', name: 'Словения' },
  '🇭🇷': { code: 'HR', name: 'Хорватия' },
  '🇲🇰': { code: 'MK', name: 'Македония' },
  '🇦🇱': { code: 'AL', name: 'Албания' },
  '🇮🇲': { code: 'IM', name: 'Остров Мэн' },
  '🇱🇺': { code: 'LU', name: 'Люксембург' },
  '🇲🇹': { code: 'MT', name: 'Мальта' },
  '🇨🇾': { code: 'CY', name: 'Кипр' },
};

const TEXT_COUNTRY_HINTS: Array<{ re: RegExp; code: string; name: string }> = [
  { re: /(нидерланд|holland|netherlands|amsterdam|амстердам|\bams\b|nl\b)/i, code: 'NL', name: 'Нидерланды' },
  { re: /(герман|germany|deutschland|frankfurt|франкфурт|berlin|берлин|\bde\b|ger\b)/i, code: 'DE', name: 'Германия' },
  { re: /(финлянд|finland|helsinki|хельсинки|\bfi\b|hel\b)/i, code: 'FI', name: 'Финляндия' },
  { re: /(швец|sweden|stockholm|стокгольм|\bse\b|swe\b)/i, code: 'SE', name: 'Швеция' },
  { re: /(франц|france|paris|париж|\bfr\b|fra\b)/i, code: 'FR', name: 'Франция' },
  { re: /(великобритан|britain|england|london|лондон|united kingdom|\buk\b|\bgb\b)/i, code: 'GB', name: 'Великобритания' },
  { re: /(сша|usa|united states|new york|нью-йорк|dallas|seattle|los angeles|\bus\b)/i, code: 'US', name: 'США' },
  { re: /(канад|canada|toronto|торонто|\bca\b)/i, code: 'CA', name: 'Канада' },
  { re: /(польш|poland|warsaw|варшав|\bpl\b)/i, code: 'PL', name: 'Польша' },
  { re: /(латви|latvia|riga|рига|\blv\b)/i, code: 'LV', name: 'Латвия' },
  { re: /(литв|lithuania|vilnius|вильнюс|\blt\b)/i, code: 'LT', name: 'Литва' },
  { re: /(эстони|estonia|tallinn|таллин|\bee\b)/i, code: 'EE', name: 'Эстония' },
  { re: /(турци|turkey|istanbul|стамбул|\btr\b)/i, code: 'TR', name: 'Турция' },
  { re: /(армени|armenia|yerevan|ереван|\bam\b)/i, code: 'AM', name: 'Армения' },
  { re: /(грузи|georgia|tbilisi|тбилиси|\bge\b)/i, code: 'GE', name: 'Грузия' },
  { re: /(казахстан|kazakhstan|almaty|алматы|astana|астана|\bkz\b)/i, code: 'KZ', name: 'Казахстан' },
  { re: /(росси|russia|moscow|москва|spb|петербург|\bru\b)/i, code: 'RU', name: 'Россия' },
  { re: /(швейцар|switzerland|zurich|цюрих|\bch\b)/i, code: 'CH', name: 'Швейцария' },
  { re: /(австри|austria|vienna|вена|\bat\b)/i, code: 'AT', name: 'Австрия' },
  { re: /(итали|italy|milan|милан|\bit\b)/i, code: 'IT', name: 'Италия' },
  { re: /(испани|spain|madrid|мадрид|\bes\b)/i, code: 'ES', name: 'Испания' },
  { re: /(чехи|czech|prague|прага|\bcz\b)/i, code: 'CZ', name: 'Чехия' },
  { re: /(япони|japan|tokyo|токио|\bjp\b)/i, code: 'JP', name: 'Япония' },
  { re: /(сингапур|singapore|\bsg\b)/i, code: 'SG', name: 'Сингапур' },
  { re: /(гонконг|hong kong|\bhk\b)/i, code: 'HK', name: 'Гонконг' },
  { re: /(корея|korea|seoul|сеул|\bkr\b)/i, code: 'KR', name: 'Южная Корея' },
  { re: /(оаэ|emirates|dubai|дубай|\bae\b)/i, code: 'AE', name: 'ОАЭ' },
  { re: /(молдов|moldova|кишин|\bmd\b)/i, code: 'MD', name: 'Молдова' },
  { re: /(серби|serbia|belgrade|белград|\brs\b)/i, code: 'RS', name: 'Сербия' },
  { re: /(румын|romania|bucharest|бухарест|\bro\b)/i, code: 'RO', name: 'Румыния' },
  { re: /(болгари|bulgaria|sofia|софия|\bbg\b)/i, code: 'BG', name: 'Болгария' },
  { re: /(греци|greece|athens|афины|\bgr\b)/i, code: 'GR', name: 'Греция' },
  { re: /(норвеги|norway|oslo|осло|\bno\b)/i, code: 'NO', name: 'Норвегия' },
  { re: /(дани|denmark|copenhagen|копенгаген|\bdk\b)/i, code: 'DK', name: 'Дания' },
  { re: /(бельги|belgium|brussels|брюссель|\bbe\b)/i, code: 'BE', name: 'Бельгия' },
  { re: /(израил|israel|tel aviv|\bil\b)/i, code: 'IL', name: 'Израиль' },
  { re: /(китай|china|shanghai|\bcn\b)/i, code: 'CN', name: 'Китай' },
  { re: /(индия|india|mumbai|\bin\b)/i, code: 'IN', name: 'Индия' },
  { re: /(бразил|brazil|sao paulo|\bbr\b)/i, code: 'BR', name: 'Бразилия' },
  { re: /(австрал|australia|sydney|\bau\b)/i, code: 'AU', name: 'Австралия' },
  { re: /(люксембург|luxembourg|\blu\b)/i, code: 'LU', name: 'Люксембург' },
  { re: /(кипр|cyprus|\bcy\b)/i, code: 'CY', name: 'Кипр' },
  { re: /(мальт|malta|\bmt\b)/i, code: 'MT', name: 'Мальта' },
  { re: /(словак|slovakia|\bsk\b)/i, code: 'SK', name: 'Словакия' },
  { re: /(венгри|венгрия|hungary|budapest|будапешт|\bhu\b)/i, code: 'HU', name: 'Венгрия' },
  { re: /(хорват|croatia|\bhr\b)/i, code: 'HR', name: 'Хорватия' },
  { re: /(монгол|mongolia|\bmn\b)/i, code: 'MN', name: 'Монголия' },
  { re: /(беларус|белорус|minsk|минск|\bby\b)/i, code: 'BY', name: 'Беларусь' },
  { re: /(таиланд|thailand|bangkok|банкок|\bth\b)/i, code: 'TH', name: 'Таиланд' },
  { re: /(вьетнам|vietnam|\bvn\b)/i, code: 'VN', name: 'Вьетнам' },
  { re: /(индонези|indonesia|jakarta|\bid\b)/i, code: 'ID', name: 'Индонезия' },
  { re: /(мексик|mexico|\bmx\b)/i, code: 'MX', name: 'Мексика' },
  { re: /(аргентин|argentina|\bar\b)/i, code: 'AR', name: 'Аргентина' },
  { re: /(юар|south africa|\bza\b)/i, code: 'ZA', name: 'ЮАР' },
];

const COUNTRY_BY_CODE: Record<string, string> = {
  NL: 'Нидерланды',
  DE: 'Германия',
  FI: 'Финляндия',
  SE: 'Швеция',
  FR: 'Франция',
  GB: 'Великобритания',
  US: 'США',
  CA: 'Канада',
  PL: 'Польша',
  LV: 'Латвия',
  LT: 'Литва',
  EE: 'Эстония',
  TR: 'Турция',
  AE: 'ОАЭ',
  AM: 'Армения',
  GE: 'Грузия',
  KZ: 'Казахстан',
  RU: 'Россия',
  CH: 'Швейцария',
  AT: 'Австрия',
  IT: 'Италия',
  ES: 'Испания',
  CZ: 'Чехия',
  JP: 'Япония',
  SG: 'Сингапур',
  HK: 'Гонконг',
  KR: 'Южная Корея',
  IN: 'Индия',
  BR: 'Бразилия',
  AU: 'Австралия',
  IL: 'Израиль',
  MD: 'Молдова',
  RS: 'Сербия',
  HU: 'Венгрия',
  RO: 'Румыния',
  BG: 'Болгария',
  GR: 'Греция',
  IS: 'Исландия',
  NO: 'Норвегия',
  DK: 'Дания',
  BE: 'Бельгия',
  IE: 'Ирландия',
  PT: 'Португалия',
  UA: 'Украина',
  AZ: 'Азербайджан',
  UZ: 'Узбекистан',
  KG: 'Кыргызстан',
  BY: 'Беларусь',
  CN: 'Китай',
  TH: 'Таиланд',
  VN: 'Вьетнам',
  ID: 'Индонезия',
  MX: 'Мексика',
  AR: 'Аргентина',
  ZA: 'ЮАР',
  EG: 'Египет',
  QA: 'Катар',
  SA: 'Саудовская Аравия',
  IR: 'Иран',
  CL: 'Чили',
  NZ: 'Новая Зеландия',
};

const KNOWN_CODES = new Set(Object.keys(COUNTRY_BY_CODE));

function countryName(code: string): string {
  return COUNTRY_BY_CODE[code] || 'Локация неизвестна';
}

export function detectCountry(label: string): { code: string; name: string } {
  const hay = label || '';
  // 1. Флаг-эмодзи в имени узла — самый точный признак
  for (const [flag, val] of Object.entries(FLAG_TO_COUNTRY)) {
    if (hay.includes(flag)) return val;
  }
  // 2. Отдельный код страны в имени: "NL-1", "[DE] Frankfurt", "🇩🇪…"
  const codeHit = hay.match(/(?:^|[\s\-_|([/])([A-Z]{2})(?:$|[\s\-_|)\]/.\d])/);
  if (codeHit && KNOWN_CODES.has(codeHit[1])) {
    return { code: codeHit[1], name: countryName(codeHit[1]) };
  }
  // 3. Название города/страны
  for (const hint of TEXT_COUNTRY_HINTS) {
    if (hint.re.test(hay)) return { code: hint.code, name: hint.name };
  }
  return { code: 'XX', name: 'Локация неизвестна' };
}

export function safeDecodeBase64(rawInput: string): string {
  return decodeBase64(rawInput);
}

function protocolMeta(protocol: string): { dpi: 'high' | 'medium' | 'low'; label: string } {
  switch (protocol) {
    case 'vless-reality':
      return { dpi: 'high', label: 'VLESS + Reality' };
    case 'vless':
      return { dpi: 'high', label: 'VLESS' };
    case 'vmess':
      return { dpi: 'medium', label: 'VMess' };
    case 'trojan':
      return { dpi: 'high', label: 'Trojan' };
    case 'shadowsocks':
      return { dpi: 'medium', label: 'Shadowsocks' };
    case 'hysteria2':
      return { dpi: 'high', label: 'Hysteria2' };
    case 'tuic':
      return { dpi: 'medium', label: 'TUIC v5' };
    case 'wireguard':
      return { dpi: 'low', label: 'WireGuard' };
    case 'socks':
      return { dpi: 'low', label: 'SOCKS' };
    case 'http':
      return { dpi: 'low', label: 'HTTP-прокси' };
    default:
      return { dpi: 'medium', label: protocol };
  }
}

function parseHostPort(value: string): { host: string; port: number } | null {
  if (!value) return null;
  const v6 = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: Number(v6[2] || 443) };
  const lastColon = value.lastIndexOf(':');
  if (lastColon < 0) return { host: value, port: 443 };
  const host = value.slice(0, lastColon);
  const port = Number(value.slice(lastColon + 1));
  if (!host) return null;
  return { host, port: port > 0 && port <= 65535 ? port : 443 };
}

function buildNode(
  protocol: string,
  label: string,
  host: string,
  port: number,
  groupName: string,
  rawLink: string
): ParsedNode | null {
  if (!host || !port) return null;
  const meta = protocolMeta(protocol);
  const country = detectCountry(label || groupName || host);
  const tlsish = protocol === 'vless-reality' || protocol === 'trojan' || protocol === 'hysteria2';
  return {
    name: (label || '').trim() || `${host}:${port}`,
    protocol: meta.label,
    host,
    port,
    country_code: country.code,
    location: country.name,
    provider: '',
    dpi_resistance: meta.dpi,
    whitelist_bypass: tlsish,
    raw_link: rawLink,
    group_name: groupName,
  };
}

function decodeUriPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Разбор одной share-ссылки в любом из поддерживаемых форматов. */
export function parseShareLink(link: string, groupName = ''): ParsedNode | null {
  const trimmed = link.trim();
  if (!trimmed || !trimmed.includes('://')) return null;
  const scheme = trimmed.split('://')[0].toLowerCase();

  const withHash = (base: string, fallback: string) => {
    const hashIdx = base.indexOf('#');
    if (hashIdx < 0) return fallback;
    return decodeUriPart(base.slice(hashIdx + 1)) || fallback;
  };
  const stripHash = (s: string) => {
    const i = s.indexOf('#');
    return i < 0 ? s : s.slice(0, i);
  };

  try {
    if (scheme === 'vless' || scheme === 'trojan' || scheme === 'tuic' || scheme === 'hysteria2' || scheme === 'hy2' || scheme === 'hysteria' || scheme === 'wireguard' || scheme === 'wg') {
      const noHash = stripHash(trimmed);
      const label = withHash(trimmed, '');
      const url = new URL(noHash.replace(/^hy2:\/\//, 'hysteria2://').replace(/^wg:\/\//, 'wireguard://'));
      const params = url.searchParams;
      const security = (params.get('security') || '').toLowerCase();
      const hasReality = security === 'reality' || params.has('pbk') || params.has('public-key');
      let proto: string;
      if (scheme === 'vless') proto = hasReality ? 'vless-reality' : 'vless';
      else if (scheme === 'hy2' || scheme === 'hysteria' || scheme === 'hysteria2') proto = 'hysteria2';
      else if (scheme === 'wg' || scheme === 'wireguard') proto = 'wireguard';
      else proto = scheme;
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const port = Number(url.port || (scheme === 'wireguard' ? 51820 : 443));
      const fallbackLabel = `${host}:${port}`;
      return buildNode(proto, label || fallbackLabel, host, port, groupName, trimmed);
    }

    if (scheme === 'ss') {
      const label = withHash(trimmed, '');
      const body = stripHash(trimmed).slice('ss://'.length);
      let host = '';
      let port = 0;
      if (body.includes('@')) {
        const at = body.lastIndexOf('@');
        const hp = parseHostPort(body.slice(at + 1).split('?')[0]);
        if (hp) {
          host = hp.host;
          port = hp.port;
        }
      } else {
        // Вся часть до ? — base64(method:pass@host:port)
        const decoded = decodeBase64(body.split('?')[0]);
        const afterAt = decoded.includes('@') ? decoded.split('@').pop() || '' : '';
        const hp = parseHostPort(afterAt.split('/')[0]);
        if (hp) {
          host = hp.host;
          port = hp.port;
        }
      }
      return buildNode('shadowsocks', label, host, port, groupName, trimmed);
    }

    if (scheme === 'vmess') {
      const payload = decodeBase64(stripHash(trimmed).slice('vmess://'.length));
      if (!payload) return null;
      const json = JSON.parse(payload) as Record<string, unknown>;
      const host = String(json.add || json.address || '');
      const port = Number(json.port || 443);
      const label = String(json.ps || json.remark || json.name || `${host}:${port}`);
      const tls = String(json.tls || '').toLowerCase();
      const proto = tls ? 'vmess' : 'vmess';
      return buildNode(proto, label, host, port, groupName, trimmed);
    }

    if (scheme === 'socks' || scheme === 'socks5' || scheme === 'http' || scheme === 'https') {
      const url = new URL(stripHash(trimmed));
      const label = withHash(trimmed, '');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const proto = scheme.startsWith('socks') ? 'socks' : 'http';
      return buildNode(proto, label || `${host}:${url.port || 1080}`, host, Number(url.port || 1080), groupName, trimmed);
    }
  } catch {
    return null;
  }

  return null;
}

/* ============================================================================
   Clash / mihomo YAML
   ----------------------------------------------------------------------------
   Прошлый разбор регулярками промахивался на вложенных полях (`reality-opts`,
   `ws-opts`) и на inline-словарях `- {name: "NL-1", type: vless, ...}`.
   Здесь честный построчный разбор блока `proxies:` с учётом отступов и
   inline-словарей.
   ========================================================================== */

interface YamlProxy {
  name: string;
  type: string;
  server: string;
  port: number;
  raw: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Разбирает inline-словарь `{name: x, type: vless, server: y, port: 443}`. */
function parseInlineMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = text.trim().replace(/^\{/, '').replace(/\}$/, '');
  // Разбиваем по запятым вне кавычек
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = unquote(part.slice(0, idx));
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = unquote(val);
  }
  return out;
}

function extractProxies(yaml: string): YamlProxy[] {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n');
  const proxies: YamlProxy[] = [];

  let inProxies = false;
  let baseIndent = -1;
  let itemIndent = -1;
  let current: { fields: Record<string, string>; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const f = current.fields;
    if (f.server && f.port) {
      proxies.push({
        name: f.name || `${f.server}:${f.port}`,
        type: (f.type || '').toLowerCase(),
        server: f.server,
        port: Number(f.port) || 443,
        raw: current.lines.join('\n'),
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const top = line.match(/^(\s*)(proxies|proxy-providers)\s*:/);
    if (top) {
      flush();
      inProxies = top[2] === 'proxies';
      baseIndent = top[1].length;
      itemIndent = -1;
      continue;
    }

    // Любой другой ключ верхнего уровня выключает блок
    if (inProxies && /^\S/.test(line) && !/^-\s/.test(line)) {
      flush();
      inProxies = false;
      continue;
    }
    if (!inProxies) continue;

    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    // Начало нового элемента списка
    const itemStart = line.match(/^(\s*)-\s*(.*)$/);
    if (itemStart && (itemIndent < 0 || indent <= itemIndent + 1)) {
      flush();
      itemIndent = indent;
      const rest = itemStart[2];
      if (rest.trim().startsWith('{')) {
        current = { fields: parseInlineMap(rest), lines: [line] };
      } else {
        current = { fields: {}, lines: [line] };
        const pair = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        if (pair) current.fields[pair[1]] = unquote(pair[2]);
      }
      continue;
    }

    if (!current) continue;
    current.lines.push(line);

    // Пары `key: value` на своём уровне (вложенные тоже запоминаем —
    // по ним видно reality/tls, их читаем текстом блока)
    const pair = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
    if (pair) {
      const key = pair[1];
      const val = unquote(pair[2]);
      if (!(key in current.fields) && val) current.fields[key] = val;
    }
  }
  flush();

  return proxies;
}

export function parseClashYaml(text: string, groupName: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  for (const proxy of extractProxies(text)) {
    const { type, raw } = proxy;
    let protocol: string | null = null;
    if (type === 'vless') protocol = /reality-opts|reality/i.test(raw) ? 'vless-reality' : 'vless';
    else if (type === 'vmess') protocol = 'vmess';
    else if (type === 'trojan') protocol = 'trojan';
    else if (type === 'ss' || type === 'shadowsocks') protocol = 'shadowsocks';
    else if (type === 'hysteria2' || type === 'hysteria') protocol = 'hysteria2';
    else if (type === 'tuic') protocol = 'tuic';
    else if (type === 'wireguard' || type === 'wg') protocol = 'wireguard';
    else if (type === 'socks5' || type === 'socks') protocol = 'socks';
    else if (type === 'http') protocol = 'http';
    // Остальные типы (direct, reject, selector, url-test) — не узлы
    if (!protocol) continue;

    const node = buildNode(protocol, proxy.name, proxy.server, proxy.port, groupName, '');
    if (node) nodes.push(node);
  }
  return nodes;
}

/* ============================================================================
   sing-box / Xray JSON
   ========================================================================== */

const JSON_PROXY_TYPES = new Set([
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria2',
  'hysteria',
  'tuic',
  'wireguard',
  'socks',
  'http',
]);

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function buildRawLink(
  protocol: string,
  tag: string,
  server: string,
  port: number,
  ob: Record<string, unknown>
): string {
  const tls = (ob.tls && typeof ob.tls === 'object' ? ob.tls : {}) as Record<string, unknown>;
  const tlsEnabled = Boolean(tls.enabled);
  const sni = firstString(tls.server_name, tls.server);
  const transport = (ob.transport && typeof ob.transport === 'object'
    ? ob.transport
    : {}) as Record<string, unknown>;
  const net = firstString(transport.type) || 'tcp';
  const params = new URLSearchParams();
  if (sni) params.set('sni', sni);
  if (net && net !== 'tcp') params.set('type', net);
  if (tlsEnabled) params.set('security', 'tls');

  const reality = (tls.reality || ob['reality-opts'] || null) as Record<string, unknown> | null;
  if (reality && typeof reality === 'object') {
    const pbk = firstString(reality.public_key, reality.publicKey);
    const sid = firstString(reality.short_id, reality.shortId);
    if (pbk) {
      params.set('security', 'reality');
      params.set('pbk', pbk);
    }
    if (sid) params.set('sid', sid);
  }
  const qs = params.toString();

  if (protocol === 'vless') {
    const uuid = firstString(ob.uuid, ob.id, ob.password);
    const flow = firstString(ob.flow);
    if (flow) params.set('flow', flow);
    return `vless://${uuid}@${server}:${port}${qs ? `?${qs}` : ''}#${encodeURIComponent(tag)}`;
  }
  if (protocol === 'trojan') {
    return `trojan://${firstString(ob.password)}@${server}:${port}${qs ? `?${qs}` : ''}#${encodeURIComponent(tag)}`;
  }
  if (protocol === 'vmess') {
    return `vmess://${encodeBase64(
      JSON.stringify({
        v: '2',
        ps: tag,
        add: server,
        port: String(port),
        id: firstString(ob.uuid, ob.id),
        net,
        tls: tlsEnabled ? 'tls' : '',
        sni,
      })
    )}`;
  }
  if (protocol === 'shadowsocks') {
    const method = firstString(ob.method) || 'aes-256-gcm';
    const password = firstString(ob.password);
    return `ss://${encodeBase64(`${method}:${password}`)}@${server}:${port}${qs ? `?${qs}` : ''}#${encodeURIComponent(tag)}`;
  }
  if (protocol === 'hysteria2') {
    return `hysteria2://${firstString(ob.password, ob.auth, ob.up_mbps)}@${server}:${port}${qs ? `?${qs}` : ''}#${encodeURIComponent(tag)}`;
  }
  if (protocol === 'tuic') {
    return `tuic://${firstString(ob.uuid)}@${server}:${port}${qs ? `?${qs}` : ''}#${encodeURIComponent(tag)}`;
  }
  return `${protocol}://${firstString(ob.password, ob.uuid)}@${server}:${port}${qs ? `?${qs}` : ''}#${encodeURIComponent(tag)}`;
}

function nodeFromJsonProxy(ob: Record<string, unknown>, groupName: string): ParsedNode | null {
  const type = String(ob.type || ob.protocol || '').toLowerCase();
  if (!JSON_PROXY_TYPES.has(type)) return null;

  const server = firstString(ob.server, ob.address, ob.host, ob.server_address);
  const port = Number(ob.server_port ?? ob.port ?? ob.serverPort ?? 0);
  if (!server || !port) return null;

  const tag = firstString(ob.tag, ob.name, ob.remark, ob.ps) || `${type} ${server}`;
  const protocol = type === 'hysteria' ? 'hysteria2' : type;

  let raw = '';
  try {
    raw = buildRawLink(protocol, tag, server, port, ob);
  } catch {
    raw = '';
  }

  const tls = (ob.tls && typeof ob.tls === 'object' ? ob.tls : {}) as Record<string, unknown>;
  const hasReality = Boolean(tls.reality || ob['reality-opts']);
  const country = detectCountry(tag);
  const meta = protocolMeta(hasReality && protocol === 'vless' ? 'vless-reality' : protocol);

  return {
    name: tag,
    protocol: hasReality && protocol === 'vless' ? 'VLESS + Reality' : meta.label,
    host: server,
    port,
    country_code: country.code,
    location: country.name,
    provider: firstString(ob.provider, ob.group),
    dpi_resistance: meta.dpi,
    whitelist_bypass: Boolean(tls.enabled || hasReality),
    raw_link: raw,
    group_name: groupName || 'Подписка',
  };
}

/**
 * Рекурсивно вытаскивает узлы из JSON любой вложенности.
 * Панели кладут их в `outbounds` (sing-box), `proxies` (mihomo-config),
 * `servers`/`nodes`/`config` — поэтому просто обходим всё дерево.
 */
function deepCollectNodes(value: unknown, groupName: string, out: ParsedNode[], depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const looksLikeProxy =
          typeof rec.type === 'string' ||
          typeof rec.protocol === 'string' ||
          (typeof rec.server === 'string' && (rec.port !== undefined || rec.server_port !== undefined));
        if (looksLikeProxy) {
          const node = nodeFromJsonProxy(rec, groupName);
          if (node) {
            out.push(node);
            continue; // внутрь узла не лезем — там transport/tls, а не узлы
          }
        }
        if (typeof item === 'string') continue;
      }
      deepCollectNodes(item, groupName, out, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepCollectNodes(v, groupName, out, depth + 1);
    }
  }
}

function dedupe(nodes: ParsedNode[]): ParsedNode[] {
  const seen = new Map<string, ParsedNode>();
  for (const n of nodes) {
    const key = `${n.host}:${n.port}:${n.protocol}`;
    const prev = seen.get(key);
    if (!prev || prev.name.length > n.name.length) seen.set(key, n);
  }
  return Array.from(seen.values());
}

/* ============================================================================
   Точка входа
   ========================================================================== */

function collectLinks(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => /^[a-z][a-z0-9+.-]*:\/\//i.test(l));
}

function parseLinkList(text: string, groupName: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  for (const link of collectLinks(text)) {
    // В одной строке иногда несколько ссылок через пробел
    const parts = link.includes(' ') ? link.split(/\s+/) : [link];
    for (const part of parts) {
      const node = parseShareLink(part, groupName);
      if (node) nodes.push(node);
    }
  }
  return nodes;
}

/** JSON-массив строк-ссылок или объектов со ссылкой. */
function nodesFromJsonLinkList(json: unknown, groupName: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
    ? ((json as Record<string, unknown>).links as unknown[]) ||
      ((json as Record<string, unknown>).servers as unknown[]) ||
      ((json as Record<string, unknown>).nodes as unknown[]) ||
      []
    : [];
  for (const item of Array.isArray(list) ? list : []) {
    const link =
      typeof item === 'string'
        ? item
        : firstString(
            (item as Record<string, unknown>)?.link,
            (item as Record<string, unknown>)?.url,
            (item as Record<string, unknown>)?.uri
          );
    if (link) {
      const node = parseShareLink(link, groupName);
      if (node) nodes.push(node);
    }
  }
  return nodes;
}

function tryParseJson(body: string, groupName: string): { nodes: ParsedNode[]; ok: boolean } {
  try {
    const json = JSON.parse(body) as unknown;
    const collected: ParsedNode[] = [];
    deepCollectNodes(json, groupName, collected);
    if (collected.length > 0) return { nodes: dedupe(collected), ok: true };
    const fromLinks = nodesFromJsonLinkList(json, groupName);
    if (fromLinks.length > 0) return { nodes: dedupe(fromLinks), ok: true };
    return { nodes: [], ok: true };
  } catch {
    return { nodes: [], ok: false };
  }
}

export function parseSubscriptionText(
  text: string,
  groupName = '',
  formatHint?: 'base64' | 'plain' | 'json' | 'clash'
): { nodes: ParsedNode[]; format: 'base64' | 'plain' | 'json' | 'clash' } {
  const trimmed = (text || '').trim();
  if (!trimmed) return { nodes: [], format: 'plain' };

  // 1. Clash / mihomo YAML
  if (formatHint === 'clash' || /^\s*proxies\s*:/m.test(trimmed) || /^\s*proxy-groups\s*:/m.test(trimmed)) {
    const nodes = parseClashYaml(trimmed, groupName);
    if (nodes.length > 0) return { nodes: dedupe(nodes), format: 'clash' };
  }

  // 2. JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed, groupName);
    if (parsed.nodes.length > 0) return { nodes: parsed.nodes, format: 'json' };
  }

  // 3. Открытый список ссылок
  const plainNodes = parseLinkList(trimmed, groupName);
  if (plainNodes.length > 0) return { nodes: dedupe(plainNodes), format: 'plain' };

  // 4. base64 (возможна двойная упаковка — панели иногда кодируют дважды)
  let body = trimmed;
  let format: 'base64' | 'plain' = 'base64';
  let decodedAny = false;

  for (let round = 0; round < 2; round += 1) {
    if (!looksLikeBase64(body)) break;
    const decoded = decodeBase64(body);
    if (!decoded) break;
    decodedAny = true;
    body = decoded.trim();

    const linkNodes = parseLinkList(body, groupName);
    if (linkNodes.length > 0) return { nodes: dedupe(linkNodes), format: 'base64' };

    if (/^\s*proxies\s*:/m.test(body)) {
      const clashNodes = parseClashYaml(body, groupName);
      if (clashNodes.length > 0) return { nodes: dedupe(clashNodes), format: 'clash' };
    }

    if (body.startsWith('{') || body.startsWith('[')) {
      const parsed = tryParseJson(body, groupName);
      if (parsed.nodes.length > 0) return { nodes: parsed.nodes, format: 'json' };
    }
  }

  return { nodes: [], format: decodedAny ? format : 'plain' };
}

export function parseUserInfoHeader(value: string | null): {
  used: number;
  total: number;
  expires_on: string | null;
} {
  const result = { used: 0, total: 0, expires_on: null as string | null };
  if (!value) return result;
  for (const part of value.split(';')) {
    const [rawKey, rawVal] = part.split('=');
    const key = (rawKey || '').trim().toLowerCase();
    const num = Number((rawVal || '').trim());
    if (!Number.isFinite(num)) continue;
    if (key === 'upload' || key === 'download') result.used += num;
    if (key === 'total') result.total = num;
    if (key === 'expire' && num > 0) result.expires_on = new Date(num * 1000).toISOString();
  }
  return result;
}

/**
 * Диагностика: почему из ответа не получились узлы.
 * Нужна, чтобы в приложении показывать причину, а не «нет узлов».
 */
export function explainEmptyParse(text: string): string {
  const body = (text || '').trim();
  if (!body) return 'Сервер вернул пустой ответ.';
  if (/^<(!doctype|html)/i.test(body)) {
    return 'Сервер вернул HTML-страницу — обычно так панель просит войти или блокирует клиента.';
  }
  if (/^\s*\{/.test(body) || /^\s*\[/.test(body)) {
    return 'Ответ похож на JSON, но узлов в нём не нашлось — возможно, панель отдала конфиг другого клиента.';
  }
  if (looksLikeBase64(body)) {
    return 'Ответ похож на base64, но внутри не оказалось ссылок на узлы.';
  }
  if (/error|unauthorized|forbidden|expired/i.test(body.slice(0, 500))) {
    return 'Панель сообщила об ошибке: проверьте, что подписка активна и ссылка не истекла.';
  }
  return 'В ответе не нашлось ни одной ссылки на узлы.';
}
