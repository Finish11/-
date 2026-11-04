/**
 * Разбор VPN-подписок и share-ссылок. Чистый TypeScript без Node-зависимостей:
 * используется и сервером (`server/subscription.ts`, загрузка по HTTP), и клиентом
 * в APK (`src/demo/localApi.ts`), где запрос к серверу подписки делает нативный HTTP.
 */

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
};

const TEXT_COUNTRY_HINTS: Array<{ re: RegExp; code: string; name: string }> = [
  { re: /(нидерланд|holland|netherlands|amsterdam|амстердам|ams\b)/i, code: 'NL', name: 'Нидерланды' },
  { re: /(герман|germany|deutschland|frankfurt|франкфурт|berlin|берлин)/i, code: 'DE', name: 'Германия' },
  { re: /(финлянд|finland|helsinki|хельсинки|hel\b)/i, code: 'FI', name: 'Финляндия' },
  { re: /(швец|sweden|stockholm|стокгольм)/i, code: 'SE', name: 'Швеция' },
  { re: /(франц|france|paris|париж)/i, code: 'FR', name: 'Франция' },
  { re: /(великобритан|britain|england|london|лондон|united kingdom|\buk\b)/i, code: 'GB', name: 'Великобритания' },
  { re: /(сша|usa|united states|new york|нью-йорк|dallas|dallas|seattle|los angeles)/i, code: 'US', name: 'США' },
  { re: /(канад|canada|toronto|торонто)/i, code: 'CA', name: 'Канада' },
  { re: /(польш|poland|warsaw|варшава)/i, code: 'PL', name: 'Польша' },
  { re: /(латви|latvia|riga|рига)/i, code: 'LV', name: 'Латвия' },
  { re: /(литв|lithuania|vilnius|вильнюс)/i, code: 'LT', name: 'Литва' },
  { re: /(эстони|estonia|tallinn|таллин)/i, code: 'EE', name: 'Эстония' },
  { re: /(турци|turkey|istanbul|стамбул)/i, code: 'TR', name: 'Турция' },
  { re: /(армени|armenia|yerevan|ереван)/i, code: 'AM', name: 'Армения' },
  { re: /(грузи|georgia|tbilisi|тбилиси)/i, code: 'GE', name: 'Грузия' },
  { re: /(казахстан|kazakhstan|almaty|алматы|astana|астана)/i, code: 'KZ', name: 'Казахстан' },
  { re: /(росси|russia|moscow|москва|spb|петербург)/i, code: 'RU', name: 'Россия' },
  { re: /(швейцар|switzerland|zurich|цюрих)/i, code: 'CH', name: 'Швейцария' },
  { re: /(австри|austria|vienna|вена)/i, code: 'AT', name: 'Австрия' },
  { re: /(итали|italy|milan|милан)/i, code: 'IT', name: 'Италия' },
  { re: /(испани|spain|madrid|мадрид)/i, code: 'ES', name: 'Испания' },
  { re: /(чехи|czech|prague|прага)/i, code: 'CZ', name: 'Чехия' },
  { re: /(япони|japan|tokyo|токио)/i, code: 'JP', name: 'Япония' },
  { re: /(сингапур|singapore)/i, code: 'SG', name: 'Сингапур' },
  { re: /(гонконг|hong kong)/i, code: 'HK', name: 'Гонконг' },
  { re: /(корея|korea|seoul|сеул)/i, code: 'KR', name: 'Южная Корея' },
  { re: /(оаэ|emirates|dubai|дубай)/i, code: 'AE', name: 'ОАЭ' },
  { re: /(молдов|moldova|кишин)/i, code: 'MD', name: 'Молдова' },
  { re: /(серби|serbia|belgrade|белград)/i, code: 'RS', name: 'Сербия' },
  { re: /(румын|romania|bucharest|бухарест)/i, code: 'RO', name: 'Румыния' },
  { re: /(болгари|bulgaria|sofia|софия)/i, code: 'BG', name: 'Болгария' },
  { re: /(греци|greece|athens|афины)/i, code: 'GR', name: 'Греция' },
  { re: /(норвеги|norway|oslo|осло)/i, code: 'NO', name: 'Норвегия' },
  { re: /(дани|denmark|copenhagen|копенгаген)/i, code: 'DK', name: 'Дания' },
  { re: /(бельги|belgium|brussels|брюссель)/i, code: 'BE', name: 'Бельгия' },
  { re: /(израил|israel|tel aviv)/i, code: 'IL', name: 'Израиль' },
  { re: /(китай|china|hongkong|shanghai)/i, code: 'CN', name: 'Китай' },
  { re: /(индия|india|mumbai)/i, code: 'IN', name: 'Индия' },
  { re: /(бразил|brazil|sao paulo)/i, code: 'BR', name: 'Бразилия' },
  { re: /(австрал|australia|sydney)/i, code: 'AU', name: 'Австралия' },
];

function detectCountry(label: string): { code: string; name: string } {
  for (const [flag, val] of Object.entries(FLAG_TO_COUNTRY)) {
    if (label.includes(flag)) return val;
  }
  for (const hint of TEXT_COUNTRY_HINTS) {
    if (hint.re.test(label)) return { code: hint.code, name: hint.name };
  }
  return { code: 'XX', name: 'Не определена' };
}

export function safeDecodeBase64(rawInput: string): string {
  const input = normalizeBase64(rawInput);
  const cleaned = input.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function normalizeBase64(input: string): string {
  const cleaned = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = cleaned.length % 4;
  return pad === 0 ? cleaned : cleaned + '='.repeat(4 - pad);
}

function looksLikeBase64(text: string): boolean {
  const t = text.trim();
  if (t.length < 24) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  return /^[A-Za-z0-9+/\-_=\s]+$/.test(t);
}

function protocolMeta(protocol: string): {
  dpi: 'high' | 'medium' | 'low';
  label: string;
} {
  switch (protocol) {
    case 'vless-reality':
      return { dpi: 'high', label: 'VLESS + Reality' };
    case 'vless':
      return { dpi: 'high', label: 'VLESS' };
    case 'vmess':
      return { dpi: 'medium', label: 'VMess' };
    case 'trojan':
      return { dpi: 'high', label: 'Trojan-gRPC' };
    case 'shadowsocks':
      return { dpi: 'medium', label: 'Shadowsocks-2022' };
    case 'hysteria2':
      return { dpi: 'high', label: 'Hysteria2' };
    case 'tuic':
      return { dpi: 'medium', label: 'TUIC v5' };
    case 'wireguard':
      return { dpi: 'low', label: 'WireGuard' };
    default:
      return { dpi: 'medium', label: protocol };
  }
}

function parseHostPort(value: string): { host: string; port: number } | null {
  if (!value) return null;
  // IPv6 в скобках
  const v6 = value.match(/^\[([^\]]+)\]:?(\d+)?$/);
  if (v6) return { host: v6[1], port: Number(v6[2] || 443) };
  const parts = value.split(':');
  const host = parts[0];
  const port = Number(parts[1] || 0);
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
  return {
    name: label.trim() || `${host}:${port}`,
    protocol: meta.label,
    host,
    port,
    country_code: country.code,
    location: country.code === 'XX' ? 'Локация неизвестна' : country.name,
    provider: '',
    dpi_resistance: meta.dpi,
    whitelist_bypass: false,
    raw_link: rawLink,
    group_name: groupName,
  };
}

export function parseShareLink(link: string, groupName = ''): ParsedNode | null {
  const trimmed = link.trim();
  if (!trimmed) return null;
  const scheme = trimmed.split('://')[0].toLowerCase();

  try {
    if (scheme === 'vless' || scheme === 'trojan' || scheme === 'tuic') {
      const url = new URL(trimmed);
      const label = decodeURIComponent(url.hash.replace('#', '')) || `${url.hostname}:${url.port}`;
      const params = url.searchParams;
      const security = (params.get('security') || '').toLowerCase();
      const proto =
        scheme === 'vless' && security === 'reality'
          ? 'vless-reality'
          : scheme === 'tuic'
          ? 'tuic'
          : scheme;
      return buildNode(proto, label, url.hostname, Number(url.port || 443), groupName, trimmed);
    }

    if (scheme === 'ss') {
      const hashIdx = trimmed.indexOf('#');
      const label = hashIdx >= 0 ? decodeURIComponent(trimmed.slice(hashIdx + 1)) : '';
      const withoutHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
      const body = withoutHash.replace('ss://', '');
      // SIP002: ss://base64(method:pass)@host:port  ИЛИ  ss://base64(method:pass@host:port)
      let host = '';
      let port = 0;
      if (body.includes('@')) {
        const at = body.lastIndexOf('@');
        const hostPart = body.slice(at + 1).split('?')[0];
        const hp = parseHostPort(hostPart);
        if (hp) {
          host = hp.host;
          port = hp.port;
        }
      } else {
        const decoded = safeDecodeBase64(body.split('?')[0]);
        const hp = parseHostPort(decoded.split('@')[1] || '');
        if (hp) {
          host = hp.host;
          port = hp.port;
        }
      }
      return buildNode('shadowsocks', label, host, port, groupName, trimmed);
    }

    if (scheme === 'vmess') {
      const payload = safeDecodeBase64(trimmed.replace('vmess://', '').split('#')[0]);
      const json = JSON.parse(payload) as Record<string, unknown>;
      const host = String(json.add || '');
      const port = Number(json.port || 443);
      const label = String(json.ps || json.remark || `${host}:${port}`);
      return buildNode('vmess', label, host, port, groupName, trimmed);
    }

    if (scheme === 'hysteria2' || scheme === 'hy2') {
      const url = new URL(trimmed);
      const label = decodeURIComponent(url.hash.replace('#', '')) || `${url.hostname}:${url.port}`;
      return buildNode('hysteria2', label, url.hostname, Number(url.port || 443), groupName, trimmed);
    }

    if (scheme === 'wireguard' || scheme === 'wg') {
      const url = new URL(trimmed);
      const label = decodeURIComponent(url.hash.replace('#', '')) || `${url.hostname}:${url.port}`;
      return buildNode('wireguard', label, url.hostname, Number(url.port || 51820), groupName, trimmed);
    }
  } catch {
    return null;
  }

  return null;
}

interface ClashProxy {
  name?: string;
  type?: string;
  server?: string;
  port?: number | string;
  tls?: boolean;
  network?: string;
  'reality-opts'?: unknown;
  'grpc-opts'?: unknown;
}

export function parseClashYaml(text: string, groupName: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const proxyBlocks = text.split(/\n(?=\s*-\s*\{?\s*name:|\s*-\s*name:)/);
  for (const block of proxyBlocks) {
    const pick = (key: string) => {
      const m = block.match(new RegExp(`${key}:\\s*"?([^"\\n,}]+)"?`));
      return m ? m[1].trim() : '';
    };
    const name = pick('name');
    const type = pick('type').toLowerCase();
    const server = pick('server');
    const port = Number(pick('port') || 0);
    if (!server || !port) continue;

    let protocol = 'vmess';
    if (type === 'vless') {
      protocol = /reality/i.test(block) ? 'vless-reality' : 'vless';
    } else if (type === 'trojan') protocol = 'trojan';
    else if (type === 'ss' || type === 'shadowsocks') protocol = 'shadowsocks';
    else if (type === 'hysteria2') protocol = 'hysteria2';
    else if (type === 'tuic') protocol = 'tuic';
    else if (type === 'wireguard') protocol = 'wireguard';
    else if (type === 'vmess') protocol = 'vmess';
    else continue;

    const node = buildNode(protocol, name || `${server}:${port}`, server, port, groupName, '');
    if (node) nodes.push(node);
  }
  return nodes;
}

export function parseSubscriptionText(
  text: string,
  groupName = '',
  formatHint?: 'base64' | 'plain' | 'json' | 'clash'
): { nodes: ParsedNode[]; format: 'base64' | 'plain' | 'json' | 'clash' } {
  const trimmed = text.trim();
  if (!trimmed) return { nodes: [], format: 'plain' };

  let body = trimmed;
  let format: SubscriptionPayload['format'] = formatHint || 'plain';

  if (format === 'clash' || /^proxies:/m.test(body)) {
    return { nodes: parseClashYaml(body, groupName), format: 'clash' };
  }

  // JSON-подписка
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const json = JSON.parse(body) as unknown;
      const list = Array.isArray(json)
        ? json
        : ((json as Record<string, unknown>).servers as unknown[]) ||
          ((json as Record<string, unknown>).nodes as unknown[]) ||
          [];
      const links = (list as Array<unknown>)
        .map((item) =>
          typeof item === 'string'
            ? item
            : String((item as Record<string, unknown>)?.link || (item as Record<string, unknown>)?.url || '')
        )
        .filter(Boolean);
      const nodes = links
        .map((l) => parseShareLink(l, groupName))
        .filter((n): n is ParsedNode => Boolean(n));
      if (nodes.length > 0) return { nodes, format: 'json' };
    } catch {
      // ignore
    }
  }

  // Base64-подписка (стандарт v2rayN / Hiddify / Streisand)
  if (looksLikeBase64(body)) {
    const decoded = safeDecodeBase64(body);
    if (decoded && /:\/\//.test(decoded)) {
      body = decoded;
      format = 'base64';
    } else if (decoded && /^proxies:/m.test(decoded)) {
      return { nodes: parseClashYaml(decoded, groupName), format: 'clash' };
    }
  }

  const links = body
    .split(/[\r\n\s]+/)
    .map((l) => l.trim())
    .filter((l) => /^[a-z][a-z0-9+.-]*:\/\//i.test(l));

  const nodes = links
    .map((l) => parseShareLink(l, groupName))
    .filter((n): n is ParsedNode => Boolean(n));

  return { nodes, format };
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
    const key = (rawKey || '').trim();
    const num = Number((rawVal || '').trim());
    if (!Number.isFinite(num)) continue;
    if (key === 'upload' || key === 'download') result.used += num;
    if (key === 'total') result.total = num;
    if (key === 'expire' && num > 0) result.expires_on = new Date(num * 1000).toISOString();
  }
  return result;
}
