export type VerdictType =
  | 'WHITELIST_ACTIVE'
  | 'TOTAL_JAMMING'
  | 'SEVERE_RESTRICTIONS'
  | 'DPI_THROTTLING'
  | 'OPEN_INTERNET';

export type SiteCategory =
  | 'ru_whitelist'
  | 'global_infra'
  | 'messengers'
  | 'media_social'
  | 'gaming_stores'
  | 'dev_ai_vpn'
  | 'custom';

export type MarkerRole = 'ru_whitelist' | 'global_neutral' | 'dpi_target' | 'custom';

/** Доступность ресурса в РФ без VPN: ok — открывается, restricted — с ограничениями, blocked — заблокирован РКН */
export type Accessibility = 'ok' | 'restricted' | 'blocked';

/** Причина, по которой сайт не открылся во время проверки */
export type SiteBlockReason = 'ok' | 'rkn' | 'whitelist' | 'network' | 'throttled' | 'unknown';

export type SiteStatus = 'ok' | 'slow' | 'blocked' | 'unknown' | 'checking';

export type SimulationMode =
  | 'live'
  | 'sim_whitelist'
  | 'sim_vpn'
  | 'sim_dpi'
  | 'sim_jamming';

export interface User {
  id: number;
  email: string;
  name: string;
  region: string;
  carrier: string;
  created_at: string;
}

export interface Site {
  id: number;
  user_id: number;
  name: string;
  domain: string;
  probe_url: string;
  category: SiteCategory;
  marker_role: MarkerRole;
  accessibility?: Accessibility;
  blocked_since?: string | null;
  enabled: number | boolean;
  last_status: SiteStatus;
  last_latency_ms: number | null;
  last_checked_at: string | null;
  description: string;
  created_at: string;
}

export interface ScanSiteResult {
  site_id?: number;
  name: string;
  domain: string;
  category: SiteCategory | string;
  marker_role: MarkerRole | string;
  status: 'ok' | 'slow' | 'blocked';
  latency_ms: number | null;
  /** Почему не открылось — показываем в детальном списке */
  block_reason?: SiteBlockReason;
  /** Ответила заглушка/подмена TLS, а не сам сайт */
  intercepted?: boolean;
  /** Короткое пояснение для интерфейса */
  note?: string;
}

export interface ScanRecord {
  id: number;
  user_id: number;
  verdict: VerdictType;
  verdict_title: string;
  verdict_summary: string;
  vpn_detected: boolean;
  vpn_mode: 'direct' | 'with_vpn' | 'vpn_turned_off' | 'simulated';
  ip_address: string;
  country_code: string;
  country_name: string;
  city: string;
  isp: string;
  asn: string;
  total_sites: number;
  ok_sites: number;
  slow_sites: number;
  blocked_sites: number;
  ru_ok_pct: number;
  global_ok_pct: number;
  dpi_ok_pct: number;
  avg_latency_ms: number;
  carrier_label: string;
  note: string;
  pinned: boolean;
  results: ScanSiteResult[];
  created_at: string;
  /**
   * Замер из примерного набора демо-сборки, а не реальная проверка сети.
   * Такие записи показываем только как «пример», чтобы не выдавать их
   * за измерение пользователя.
   */
  demo?: boolean;
}

export interface VpnProfile {
  id: number;
  user_id: number;
  name: string;
  subscription_id?: number | null;
  group_name?: string;
  protocol: string;
  location: string;
  country_code: string;
  host: string;
  port: number;
  provider: string;
  dpi_resistance: 'high' | 'medium' | 'low';
  whitelist_bypass: boolean;
  status: 'online' | 'degraded' | 'blocked' | 'unknown';
  latency_ms: number | null;
  uptime_pct: number;
  is_primary: boolean;
  notes: string;
  raw_link?: string;
  last_checked_at: string | null;
  last_latency_all?: number | null;
  created_at: string;
}

/** Подписка (subscription URL) в стиле Happ / v2rayN / Hiddify / Streisand */
export interface VpnSubscription {
  id: number;
  user_id: number;
  name: string;
  url: string;
  format: 'base64' | 'plain' | 'json';
  provider: string;
  auto_update: boolean;
  update_interval_hours: number;
  last_synced_at: string | null;
  last_sync_status: 'ok' | 'error' | 'pending';
  last_sync_message: string;
  traffic_used_bytes: number;
  traffic_total_bytes: number;
  expires_on: string | null;
  node_count: number;
  created_at: string;
}

export interface Incident {
  id: number;
  user_id: number | null;
  author_name: string;
  region: string;
  carrier: string;
  incident_type: 'whitelist' | 'mobile_shutdown' | 'dpi_wave' | 'vpn_block' | 'cdn_block';
  severity: 'critical' | 'high' | 'moderate';
  status: 'active' | 'resolved';
  title: string;
  description: string;
  upvotes: number;
  ru_sites_ok: boolean;
  foreign_sites_ok: boolean;
  user_upvoted: boolean;
  is_owner: boolean;
  created_at: string;
  /**
   * Отметка, добавленная приложением для примера (демо-сборка), а не живой
   * отчёт пользователя. Такие записи показываем с явной пометкой.
   */
  demo?: boolean;
}

export interface ClientConnectionInfo {
  ip: string;
  country_code: string;
  country_name: string;
  region: string;
  city: string;
  isp: string;
  org: string;
  asn: string;
  is_hosting: boolean;
  is_proxy: boolean;
  is_mobile: boolean;
  vpn_detected: boolean;
  vpn_confidence: 'high' | 'medium' | 'none';
  vpn_reasons: string[];
  split_tunnel?: boolean;
  webrtc_ips?: string[];
}

export const CATEGORY_META: Record<
  SiteCategory,
  { label: string; shortLabel: string; badgeColor: string; description: string }
> = {
  ru_whitelist: {
    label: '🇷🇺 Белый список РФ (Рунет)',
    shortLabel: 'Белый список РФ',
    badgeColor: 'text-sky-400 bg-sky-500/10 border-sky-500/25',
    description:
      'Официальный перечень Минцифры: Госуслуги, Яндекс, ВК, MAX, маркетплейсы, банки, СМИ — работают даже при отключениях мобильного интернета',
  },
  global_infra: {
    label: '🌐 Глобальная сеть и CDN',
    shortLabel: 'Глобальные / CDN',
    badgeColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
    description:
      'Сайты, которые в РФ НЕ заблокированы: Google, Википедия, GitHub, Cloudflare, Steam. Если они лежат — включены белые списки или глушат сеть',
  },
  messengers: {
    label: '💬 Мессенджеры и звонки',
    shortLabel: 'Мессенджеры',
    badgeColor: 'text-violet-400 bg-violet-500/10 border-violet-500/25',
    description:
      'Telegram (ограничен), WhatsApp, Discord, Signal, Viber, Snapchat, Instagram, X — заблокированы или ограничены РКН',
  },
  media_social: {
    label: '🎬 Видео, соцсети и медиа',
    shortLabel: 'Видео и соцсети',
    badgeColor: 'text-rose-400 bg-rose-500/10 border-rose-500/25',
    description:
      'YouTube (удалён из НСДИ 10.02.2026), GGC-кэш, Twitch, TikTok, Netflix, Spotify, Reddit, Roblox',
  },
  gaming_stores: {
    label: '🎮 Игры, сторы и облака',
    shortLabel: 'Игры и сторы',
    badgeColor: 'text-amber-400 bg-amber-500/10 border-amber-500/25',
    description:
      'Steam, Epic Games, GOG, Xbox, App Store, Google Play — не заблокированы, ограничена только оплата',
  },
  dev_ai_vpn: {
    label: '🛠 IT, AI и VPN-ресурсы',
    shortLabel: 'IT / AI / VPN',
    badgeColor: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/25',
    description:
      'ChatGPT, Proton, Tor, Mullvad, Speedtest, Notion — блокируются; GitHub, Docker, NPM, StackOverflow — нет',
  },
  custom: {
    label: '⭐ Пользовательские сайты',
    shortLabel: 'Мои сайты',
    badgeColor: 'text-fuchsia-400 bg-fuchsia-500/10 border-fuchsia-500/25',
    description: 'Добавленные вами серверы, API и сайты для персональной проверки',
  },
};

export const RUSSIAN_REGIONS = [
  'Москва и МО',
  'Санкт-Петербург',
  'Ленинградская область',
  'Краснодарский край',
  'Ростовская область',
  'Республика Дагестан',
  'Ставропольский край',
  'Воронежская область',
  'Нижегородская область',
  'Республика Татарстан',
  'Свердловская область',
  'Новосибирская область',
  'Самарская область',
  'Белгородская область',
  'Курская область',
  'Брянская область',
  'Саратовская область',
  'Волгоградская область',
  'Челябинская область',
  'Республика Башкортостан',
  'Пермский край',
  'Приморский край',
  'Калининградская область',
  'Другой регион РФ',
];

export const RUSSIAN_CARRIERS = [
  'МТС',
  'МегаФон',
  'Билайн',
  'T2 (Tele2)',
  'Yota',
  'Ростелеком',
  'Дом.ру',
  'МГТС',
  'Т-Мобайл',
  'СберМобайл',
  'Другой провайдер',
];
