import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'pulsenet.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function makePasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'Москва',
    carrier TEXT NOT NULL DEFAULT 'МТС',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    probe_url TEXT NOT NULL,
    category TEXT NOT NULL,
    marker_role TEXT NOT NULL,
    accessibility TEXT NOT NULL DEFAULT 'ok',
    blocked_since TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT NOT NULL DEFAULT 'unknown',
    last_latency_ms INTEGER,
    last_checked_at TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL,
    verdict_title TEXT NOT NULL,
    verdict_summary TEXT NOT NULL,
    vpn_detected INTEGER NOT NULL DEFAULT 0,
    vpn_mode TEXT NOT NULL DEFAULT 'direct',
    ip_address TEXT NOT NULL,
    country_code TEXT NOT NULL,
    country_name TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT '',
    isp TEXT NOT NULL,
    asn TEXT NOT NULL DEFAULT '',
    total_sites INTEGER NOT NULL,
    ok_sites INTEGER NOT NULL,
    slow_sites INTEGER NOT NULL,
    blocked_sites INTEGER NOT NULL,
    ru_ok_pct INTEGER NOT NULL,
    global_ok_pct INTEGER NOT NULL,
    dpi_ok_pct INTEGER NOT NULL,
    avg_latency_ms INTEGER NOT NULL,
    carrier_label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    results_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vpn_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'base64',
    provider TEXT NOT NULL DEFAULT '',
    auto_update INTEGER NOT NULL DEFAULT 1,
    update_interval_hours INTEGER NOT NULL DEFAULT 12,
    last_synced_at TEXT,
    last_sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_message TEXT NOT NULL DEFAULT '',
    traffic_used_bytes INTEGER NOT NULL DEFAULT 0,
    traffic_total_bytes INTEGER NOT NULL DEFAULT 0,
    expires_on TEXT,
    raw_snapshot TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vpn_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id INTEGER REFERENCES vpn_subscriptions(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    location TEXT NOT NULL,
    country_code TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    provider TEXT NOT NULL DEFAULT '',
    dpi_resistance TEXT NOT NULL DEFAULT 'high',
    whitelist_bypass INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'online',
    latency_ms INTEGER,
    uptime_pct REAL NOT NULL DEFAULT 99.0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    raw_link TEXT NOT NULL DEFAULT '',
    last_latency_all INTEGER,
    last_checked_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    region TEXT NOT NULL,
    carrier TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    upvotes INTEGER NOT NULL DEFAULT 1,
    ru_sites_ok INTEGER NOT NULL DEFAULT 1,
    foreign_sites_ok INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS incident_upvotes (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, user_id)
  );
`);

/**
 * Идемпотентные ALTER TABLE для уже существующих баз (SQLite не умеет
 * ADD COLUMN IF NOT EXISTS, поэтому проверяем через PRAGMA table_info).
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('sites', 'accessibility', "TEXT NOT NULL DEFAULT 'ok'");
addColumnIfMissing('sites', 'blocked_since', 'TEXT');
addColumnIfMissing('vpn_profiles', 'subscription_id', 'INTEGER');
addColumnIfMissing('vpn_profiles', 'group_name', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('vpn_profiles', 'raw_link', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('vpn_profiles', 'last_latency_all', 'INTEGER');

export interface DefaultSiteSeed {
  name: string;
  domain: string;
  probe_url: string;
  category: string;
  /** ru_whitelist = в перечне Минцифры (работает при шатдаунах) • global_neutral = не заблокирован в РФ • dpi_target = заблокирован/ограничен РКН */
  marker_role: 'ru_whitelist' | 'global_neutral' | 'dpi_target';
  /** ok = открывается в РФ без VPN • restricted = работает частично/замедлен • blocked = недоступен без VPN */
  accessibility: 'ok' | 'restricted' | 'blocked';
  blocked_since?: string;
  description: string;
}

/**
 * Каталог проверки. Статусы сверены с перечнем Минцифры (белый список мобильного
 * интернета) и реестром блокировок РКН на ноябрь 2026 года.
 * probe_url подобраны так, чтобы отдавать 2xx с любого устройства (без TLS НУЦ Минцифры).
 */
export const DEFAULT_SITES: DefaultSiteSeed[] = [
  // ========== 1. БЕЛЫЙ СПИСОК РФ — официальный перечень Минцифры (22) ==========
  { name: 'Госуслуги', domain: 'gosuslugi.ru', probe_url: 'https://www.gosuslugi.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Портал Госуслуг — с первого дня в перечне Минцифры' },
  { name: 'Яндекс', domain: 'ya.ru', probe_url: 'https://ya.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Поиск и инфраструктура Яндекса (весь блок сервисов в белом списке)' },
  { name: 'Кинопоиск', domain: 'kinopoisk.ru', probe_url: 'https://www.kinopoisk.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Онлайн-кинотеатр Яндекса — в перечне Минцифры' },
  { name: 'ВКонтакте', domain: 'vk.com', probe_url: 'https://vk.com/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Соцсеть VK — в белом списке с 5 сентября 2025' },
  { name: 'Одноклассники', domain: 'ok.ru', probe_url: 'https://ok.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Соцсеть OK — в перечне Минцифры' },
  { name: 'Mail (Mail.ru)', domain: 'mail.ru', probe_url: 'https://mail.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Почта и сервисы VK — в белом списке' },
  { name: 'MAX (мессенджер)', domain: 'max.ru', probe_url: 'https://max.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Национальный мессенджер MAX — добавлен 19 сентября 2025' },
  { name: 'Дзен', domain: 'dzen.ru', probe_url: 'https://dzen.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Контент-платформа Дзен — в перечне Минцифры' },
  { name: 'Rutube', domain: 'rutube.ru', probe_url: 'https://rutube.ru/', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Российский видеохостинг — в белом списке' },
  { name: 'Ozon', domain: 'ozon.ru', probe_url: 'https://st.ozone.ru/assets/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Маркетплейс Ozon — в перечне (CDN отдаёт глобальный сертификат)' },
  { name: 'Wildberries', domain: 'wildberries.ru', probe_url: 'https://www.wildberries.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Маркетплейс Wildberries — в белом списке' },
  { name: 'Авито', domain: 'avito.ru', probe_url: 'https://www.avito.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Доска объявлений Avito — в перечне Минцифры' },
  { name: '2ГИС', domain: '2gis.ru', probe_url: 'https://2gis.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Карты и навигатор 2ГИС — в белом списке (2-й этап)' },
  { name: 'HeadHunter', domain: 'hh.ru', probe_url: 'https://hh.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Поиск работы hh.ru — в перечне Минцифры' },
  { name: 'Gismeteo', domain: 'gismeteo.ru', probe_url: 'https://www.gismeteo.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Погодный сервис Gismeteo — в белом списке' },
  { name: 'РИА Новости', domain: 'ria.ru', probe_url: 'https://ria.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Гос. информагентство — СМИ в белом списке' },
  { name: 'ТАСС', domain: 'tass.ru', probe_url: 'https://tass.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Информагентство ТАСС — в перечне Минцифры' },
  { name: 'Лента.ру', domain: 'lenta.ru', probe_url: 'https://lenta.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Издание Lenta.ru — в белом списке' },
  { name: 'Аэрофлот', domain: 'aeroflot.ru', probe_url: 'https://www.aeroflot.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Авиакомпания Аэрофлот — в перечне (транспорт)' },
  { name: 'Туту.ру', domain: 'tutu.ru', probe_url: 'https://www.tutu.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Билеты Туту.ру — в белом списке' },
  { name: 'Центробанк РФ', domain: 'cbr.ru', probe_url: 'https://www.cbr.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Банк России — в перечне с 3-го обновления (05.12.2025)' },
  { name: 'Сбер (СберБанк)', domain: 'sber.ru', probe_url: 'https://sber.ru/', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Онлайн-банк Сбер — в перечне Минцифры (глобальный TLS-сертификат, в отличие от sberbank.ru)' },
  { name: 'Самокат', domain: 'samokat.ru', probe_url: 'https://samokat.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Доставка Самокат — в белом списке (ритейл и доставка)' },
  { name: 'Иви', domain: 'ivi.ru', probe_url: 'https://www.ivi.ru/favicon.ico', category: 'ru_whitelist', marker_role: 'ru_whitelist', accessibility: 'ok', description: 'Онлайн-кинотеатр Иви — в белом списке' },

  // ========== 2. НЕЙТРАЛЬНАЯ ГЛОБАЛЬНАЯ СЕТЬ (не заблокирована в РФ) (18) ==========
  { name: 'Google Поиск', domain: 'google.com', probe_url: 'https://www.google.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Поиск Google — не заблокирован, работает без VPN' },
  { name: 'Google Переводчик', domain: 'translate.google.com', probe_url: 'https://translate.google.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Google Translate — один из немногих сервисов Google без ограничений' },
  { name: 'Википедия', domain: 'ru.wikipedia.org', probe_url: 'https://ru.wikipedia.org/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Русская Википедия — открывается без VPN (ключевой маркер шатдауна)' },
  { name: 'GitHub', domain: 'github.com', probe_url: 'https://github.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Хостинг кода GitHub — нейтральный маркер' },
  { name: 'Stack Overflow', domain: 'stackoverflow.com', probe_url: 'https://stackoverflow.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'База знаний разработчиков — доступна без VPN' },
  { name: 'Cloudflare', domain: 'cloudflare.com', probe_url: 'https://www.cloudflare.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'CDN Cloudflare — сайт открывается, часть ECH-подсетей фильтруется' },
  { name: 'Cloudflare DNS 1.1.1.1', domain: 'one.one.one.one', probe_url: 'https://one.one.one.one/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Публичный DNS 1.1.1.1 — работает, но не спасает от ТСПУ' },
  { name: 'jsDelivr CDN', domain: 'cdn.jsdelivr.net', probe_url: 'https://cdn.jsdelivr.net/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'CDN веб-библиотек на Fastly' },
  { name: 'NPM Registry', domain: 'registry.npmjs.org', probe_url: 'https://registry.npmjs.org/', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Пакетный реестр JS — доступен без VPN' },
  { name: 'Docker Hub', domain: 'hub.docker.com', probe_url: 'https://hub.docker.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Реестр контейнеров Docker' },
  { name: 'Mozilla', domain: 'mozilla.org', probe_url: 'https://www.mozilla.org/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Сервисы Firefox и DoH' },
  { name: 'Internet Archive', domain: 'archive.org', probe_url: 'https://archive.org/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Веб-архив Wayback Machine — открывается' },
  { name: 'Apple', domain: 'apple.com', probe_url: 'https://www.apple.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Сайт Apple — работает; App Store ограничен только по оплате' },
  { name: 'Microsoft', domain: 'microsoft.com', probe_url: 'https://www.microsoft.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Сайт Microsoft и облако — без блокировки' },
  { name: 'Amazon AWS', domain: 'aws.amazon.com', probe_url: 'https://aws.amazon.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Облако AWS — сайт доступен (часть IP-пулов шейпится)' },
  { name: 'Bing', domain: 'bing.com', probe_url: 'https://www.bing.com/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Поиск Microsoft Bing' },
  { name: 'Zoom', domain: 'zoom.us', probe_url: 'https://zoom.us/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Видеоконференции Zoom — технически не заблокированы' },
  { name: 'AliExpress', domain: 'aliexpress.ru', probe_url: 'https://www.aliexpress.ru/favicon.ico', category: 'global_infra', marker_role: 'global_neutral', accessibility: 'ok', description: 'Маркетплейс AliExpress — не заблокирован' },

  // ========== 3. МЕССЕНДЖЕРЫ И ЗВОНКИ (11) ==========
  { name: 'WhatsApp Web', domain: 'web.whatsapp.com', probe_url: 'https://web.whatsapp.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '12.02.2026', description: 'WhatsApp удалён из НСДИ 12.02.2026 — звонили с авг. 2025, блокировка с 28.11.2025' },
  { name: 'Discord', domain: 'discord.com', probe_url: 'https://discord.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '08.10.2024', description: 'Discord заблокирован РКН полностью с 8 октября 2024' },
  { name: 'Signal', domain: 'signal.org', probe_url: 'https://signal.org/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '09.08.2024', description: 'Signal заблокирован с 9 августа 2024, удалён из сторов' },
  { name: 'Viber', domain: 'viber.com', probe_url: 'https://www.viber.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '13.12.2024', description: 'Viber заблокирован технически с 13 декабря 2024' },
  { name: 'Telegram Web', domain: 'web.telegram.org', probe_url: 'https://web.telegram.org/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'restricted', blocked_since: '10.02.2026', description: 'Telegram под «последовательными ограничениями» с 10.02.2026: звонки и медиа сбоят, трафик замедлен' },
  { name: 'Snapchat', domain: 'snapchat.com', probe_url: 'https://www.snapchat.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '12.2025', description: 'Snapchat ограничен предписанием РКН в декабре 2025' },
  { name: 'Facebook (Meta)', domain: 'facebook.com', probe_url: 'https://www.facebook.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '03.2022', description: 'Meta признана экстремистской, заблокирована с 2022' },
  { name: 'Instagram (Meta)', domain: 'instagram.com', probe_url: 'https://www.instagram.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '03.2022', description: 'Instagram заблокирован с марта 2022' },
  { name: 'X (Twitter)', domain: 'x.com', probe_url: 'https://x.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '04.2022', description: 'X/Twitter замедлен с 2022 и заблокирован' },
  { name: 'LinkedIn', domain: 'linkedin.com', probe_url: 'https://www.linkedin.com/', category: 'messengers', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '11.2016', description: 'LinkedIn заблокирован с 2016 года (первый в списке)' },

  // ========== 4. ВИДЕО, МУЗЫКА И МЕДИА (12) ==========
  { name: 'YouTube', domain: 'youtube.com', probe_url: 'https://www.youtube.com/favicon.ico', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '10.02.2026', description: 'YouTube удалён из НСДИ 10.02.2026 — без VPN не открывается' },
  { name: 'YouTube Video (GGC)', domain: 'googlevideo.com', probe_url: 'https://redirector.googlevideo.com/report_mapping', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '2024', description: 'Кэш-серверы видеопотока — главная цель ТСПУ' },
  { name: 'Twitch', domain: 'twitch.tv', probe_url: 'https://www.twitch.tv/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'restricted', description: 'Twitch не заблокирован, но ТСПУ шейпит видео и режет качество до 720p' },
  { name: 'TikTok', domain: 'tiktok.com', probe_url: 'https://www.tiktok.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'restricted', description: 'TikTok ограничен: нет загрузки контента и прямых эфиров' },
  { name: 'Netflix', domain: 'netflix.com', probe_url: 'https://www.netflix.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '03.2022', description: 'Netflix ушёл из РФ в марте 2022 — нужен VPN' },
  { name: 'Spotify', domain: 'open.spotify.com', probe_url: 'https://open.spotify.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '04.2022', description: 'Spotify закрылся в РФ 11 апреля 2022' },
  { name: 'SoundCloud', domain: 'soundcloud.com', probe_url: 'https://soundcloud.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '10.2022', description: 'SoundCloud заблокирован Генпрокуратурой 2 октября 2022' },
  { name: 'Patreon', domain: 'patreon.com', probe_url: 'https://www.patreon.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '2022', description: 'Patreon заблокирован в РФ' },
  { name: 'Reddit', domain: 'reddit.com', probe_url: 'https://www.reddit.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'restricted', description: 'Reddit доступен, но отдельные разделы в реестре РКН и периодически шейпятся' },
  { name: 'Google News', domain: 'news.google.com', probe_url: 'https://news.google.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '23.03.2022', description: 'Google News заблокирован Генпрокуратурой 23 марта 2022' },
  { name: 'Roblox', domain: 'roblox.com', probe_url: 'https://www.roblox.com/', category: 'media_social', marker_role: 'dpi_target', accessibility: 'blocked', blocked_since: '03.12.2025', description: 'Roblox заблокирован 3 декабря 2025' },

  // ========== 5. ИГРЫ, СТОРЫ И РАЗРАБОТКА (10) ==========
  { name: 'Steam Store', domain: 'store.steampowered.com', probe_url: 'https://store.steampowered.com/favicon.ico', category: 'gaming_stores', marker_role: 'global_neutral', accessibility: 'ok', description: 'Магазин Steam — работает, ограничения только для Community Hub' },
  { name: 'Epic Games Store', domain: 'epicgames.com', probe_url: 'https://store.epicgames.com/', category: 'gaming_stores', marker_role: 'global_neutral', accessibility: 'ok', description: 'Магазин Epic Games — доступен без VPN' },
  { name: 'GOG.com', domain: 'gog.com', probe_url: 'https://www.gog.com/favicon.ico', category: 'gaming_stores', marker_role: 'global_neutral', accessibility: 'ok', description: 'Магазин GOG — работает (ограничены только платежи)' },
  { name: 'Xbox / Microsoft Store', domain: 'xbox.com', probe_url: 'https://www.xbox.com/favicon.ico', category: 'gaming_stores', marker_role: 'global_neutral', accessibility: 'ok', description: 'Экосистема Xbox — сайт доступен' },
  { name: 'App Store', domain: 'apps.apple.com', probe_url: 'https://apps.apple.com/favicon.ico', category: 'gaming_stores', marker_role: 'global_neutral', accessibility: 'ok', description: 'Магазин приложений iOS — работает (оплата только через баланс)' },
  { name: 'Google Play', domain: 'play.google.com', probe_url: 'https://play.google.com/favicon.ico', category: 'gaming_stores', marker_role: 'global_neutral', accessibility: 'ok', description: 'Магазин приложений Android — каталог открывается' },
  { name: 'ChatGPT / OpenAI', domain: 'chatgpt.com', probe_url: 'https://chatgpt.com/', category: 'dev_ai_vpn', marker_role: 'dpi_target', accessibility: 'blocked', description: 'OpenAI закрыл доступ из РФ и блокирует IP — нужен VPN' },
  { name: 'Proton', domain: 'proton.me', probe_url: 'https://proton.me/favicon.ico', category: 'dev_ai_vpn', marker_role: 'dpi_target', accessibility: 'blocked', description: 'Proton Mail/VPN блокируются ТСПУ в РФ' },
  { name: 'Tor Project', domain: 'torproject.org', probe_url: 'https://www.torproject.org/static/images/favicon/favicon.ico', category: 'dev_ai_vpn', marker_role: 'dpi_target', accessibility: 'blocked', description: 'Сеть Tor — мосты и сайт под блокировкой в РФ' },
  { name: 'Mullvad VPN', domain: 'mullvad.net', probe_url: 'https://mullvad.net/favicon.ico', category: 'dev_ai_vpn', marker_role: 'dpi_target', accessibility: 'blocked', description: 'Шведский VPN — сайт блокируется ТСПУ' },
  { name: 'Speedtest.net', domain: 'speedtest.net', probe_url: 'https://www.speedtest.net/', category: 'dev_ai_vpn', marker_role: 'dpi_target', accessibility: 'blocked', description: 'Ookla Speedtest — заблокирован, замеры идут только через VPN' },
  { name: 'Notion', domain: 'notion.so', probe_url: 'https://www.notion.so/', category: 'dev_ai_vpn', marker_role: 'dpi_target', accessibility: 'blocked', description: 'Notion ограничен: часть подсетей AWS в реестре РКН' },
];

/**
 * Заполняет персональный каталог пользователя эталонным набором.
 * `withDemoStatuses` — когда каталог принадлежит демо-аккаунту (там уже есть история).
 */
export function seedDefaultSitesForUser(userId: number, withDemoStatuses = false): void {
  const now = new Date().toISOString();
  const insertSite = db.prepare(`
    INSERT INTO sites (
      user_id, name, domain, probe_url, category, marker_role,
      accessibility, blocked_since, enabled, last_status, last_latency_ms,
      last_checked_at, description, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    DEFAULT_SITES.forEach((s, idx) => {
      let status = 'unknown';
      let latency: number | null = null;
      let checkedAt: string | null = null;

      if (withDemoStatuses) {
        checkedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        if (s.marker_role === 'ru_whitelist' || s.accessibility === 'ok') {
          status = 'ok';
          latency = 28 + ((idx * 7) % 39);
        } else if (s.accessibility === 'restricted') {
          status = 'slow';
          latency = 1240 + ((idx * 13) % 900);
        } else {
          status = 'blocked';
          latency = null;
        }
      }

      insertSite.run(
        userId,
        s.name,
        s.domain,
        s.probe_url,
        s.category,
        s.marker_role,
        s.accessibility,
        s.blocked_since ?? null,
        status,
        latency,
        checkedAt,
        s.description,
        now
      );
    });
  });

  tx();
}

/**
 * Снимок старых демо-результатов для разных режимов (нужен для seeding истории).
 * Работает по marker_role + accessibility, поэтому не зависит от конкретных доменов.
 */

function buildDemoScanResults(mode: 'whitelist' | 'vpn' | 'dpi' | 'jamming' | 'subnets') {
  const row = (
    s: DefaultSiteSeed,
    i: number,
    status: 'ok' | 'slow' | 'blocked',
    latency_ms: number | null
  ) => ({
    name: s.name,
    domain: s.domain,
    category: s.category,
    marker_role: s.marker_role,
    status,
    latency_ms,
  });

  return DEFAULT_SITES.map((s, i) => {
    // 1. Режим белых списков: доступен только перечень Минцифры
    if (mode === 'whitelist') {
      if (s.marker_role === 'ru_whitelist') return row(s, i, 'ok', 28 + ((i * 9) % 46));
      if (s.domain === 'google.com') return row(s, i, 'slow', 2190);
      return row(s, i, 'blocked', null);
    }

    // 2. Полная проверка через VPN: блокировки РКН обойдены
    if (mode === 'vpn') {
      if (s.domain === 'gosuslugi.ru') return row(s, i, 'blocked', null);
      if (s.domain === 'max.ru') return row(s, i, 'slow', 1240);
      return row(s, i, 'ok', 48 + ((i * 11) % 80));
    }

    // 3. Домашний интернет без VPN: работает всё, кроме заблокированных РКН
    if (mode === 'dpi') {
      if (s.marker_role === 'ru_whitelist') return row(s, i, 'ok', 26 + ((i * 7) % 38));
      if (s.accessibility === 'ok') return row(s, i, 'ok', 44 + ((i * 13) % 90));
      if (s.accessibility === 'restricted') return row(s, i, 'slow', 1180 + ((i * 17) % 900));
      return row(s, i, 'blocked', null);
    }

    // 4. Глушение / шатдаун мобильной сети
    if (mode === 'jamming') {
      if (s.marker_role === 'ru_whitelist' && (s.domain === 'ya.ru' || s.domain === 'gosuslugi.ru')) {
        return row(s, i, 'slow', 2480 + i * 35);
      }
      return row(s, i, 'blocked', null);
    }

    // 5. Частичный сбой: российские сайты живы, зарубежные CDN отвалились
    if (s.marker_role === 'ru_whitelist') {
      return row(s, i, 'ok', 27 + ((i * 5) % 33));
    }
    if (['google.com', 'apple.com', 'microsoft.com', 'ru.wikipedia.org', 'github.com', 'stackoverflow.com', 'bing.com'].includes(s.domain)) {
      return row(s, i, 'ok', 62 + ((i * 9) % 70));
    }
    return row(s, i, 'blocked', null);
  });
}

function seedDatabaseIfNeeded() {
  const existingUsers = db.prepare(`SELECT COUNT(*) as cnt FROM users`).get() as { cnt: number };
  if (existingUsers.cnt > 0) return;

  const now = Date.now();
  const iso = (offsetHours: number) => new Date(now + offsetHours * 3600 * 1000).toISOString();

  const demoPassHash = makePasswordHash('demo1234');
  const userRes = db
    .prepare(
      `INSERT INTO users (email, name, region, carrier, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run('demo@pulsenet.ru', 'Алексей Морозов', 'Москва', 'МТС', demoPassHash, iso(-168));

  const demoUserId = Number(userRes.lastInsertRowid);

  // Seed 50 websites
  seedDefaultSitesForUser(demoUserId, true);

  // Seed 5 realistic VPN profiles
  const insertVpn = db.prepare(`
    INSERT INTO vpn_profiles (
      user_id, name, protocol, location, country_code, host, port,
      provider, dpi_resistance, whitelist_bypass, status, latency_ms,
      uptime_pct, is_primary, notes, last_checked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertVpn.run(
    demoUserId,
    'NL-AMS Основной • Reality',
    'VLESS + Reality',
    'Амстердам, Нидерланды',
    'NL',
    'nl-edge-01.aeza-node.net',
    443,
    'Aeza International (AS210644)',
    'high',
    0,
    'online',
    64,
    99.8,
    1,
    'Маскировка под TLS 1.3 (SNI microsoft.com). Отлично обходит обычный ТСПУ, но недоступен при жёстких белых списках без RU-каскада.',
    iso(-0.4),
    iso(-140)
  );

  insertVpn.run(
    demoUserId,
    'RU→FI Каскад (Анти-Белый список)',
    'VLESS + Reality',
    'Москва (Яндекс.Облако) → Хельсинки',
    'FI',
    'ru-bridge-msk.yc-relay.ru',
    443,
    'Yandex Cloud → Hetzner FI',
    'high',
    1,
    'online',
    49,
    99.4,
    0,
    'Входная нода находится в российской подсети из белого списка и перенаправляет трафик в Финляндию. Спасает при региональных шатдаунах!',
    iso(-0.3),
    iso(-120)
  );

  insertVpn.run(
    demoUserId,
    'FI-HEL Резерв • AmneziaWG',
    'AmneziaWG',
    'Хельсинки, Финляндия',
    'FI',
    'fi-awg.hetzner-gw.org',
    51820,
    'Hetzner Online (AS24940)',
    'high',
    0,
    'online',
    57,
    97.9,
    0,
    'Модифицированный WireGuard с мусорными пакетами (Jc/Jmin/Jmax) против сигнатурного анализа DPI.',
    iso(-1.1),
    iso(-96)
  );

  insertVpn.run(
    demoUserId,
    'DE-FRA Медиа 4K • Hysteria2',
    'Hysteria2',
    'Франкфурт, Германия',
    'DE',
    'de-quic-04.fastnode.eu',
    8443,
    'M247 Europe (AS9009)',
    'medium',
    0,
    'degraded',
    188,
    87.5,
    0,
    'Высокая скорость для YouTube 4K по UDP/QUIC, однако мобильные операторы вечером шейпят UDP-поток.',
    iso(-1.5),
    iso(-80)
  );

  insertVpn.run(
    demoUserId,
    'LV-RIX Старый туннель • WG',
    'WireGuard',
    'Рига, Латвия',
    'LV',
    '185.212.141.90',
    51820,
    'Serveris LV',
    'low',
    0,
    'blocked',
    null,
    24.0,
    0,
    'Чистый протокол WireGuard без обфускации — хендшейк блокируется ТСПУ на МТС, МегаФон и Т2.',
    iso(-2.0),
    iso(-160)
  );

  // Seed historical scans
  const insertScan = db.prepare(`
    INSERT INTO scans (
      user_id, verdict, verdict_title, verdict_summary, vpn_detected, vpn_mode,
      ip_address, country_code, country_name, city, isp, asn,
      total_sites, ok_sites, slow_sites, blocked_sites,
      ru_ok_pct, global_ok_pct, dpi_ok_pct, avg_latency_ms,
      carrier_label, note, pinned, results_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertScan.run(
    demoUserId,
    'WHITELIST_ACTIVE',
    'Обнаружены белые списки!',
    'Доступны все 12 сайтов из белого списка РФ (Госуслуги, Яндекс, ВК, банки, маркетплейсы), но заблокированы 97% зарубежных ресурсов, включая нейтральные (Википедия, GitHub, Cloudflare, Steam).',
    0,
    'vpn_turned_off',
    '213.87.132.48',
    'RU',
    'Россия',
    'Краснодар',
    'PJSC MTS Mobile',
    'AS8359',
    50,
    12,
    1,
    37,
    100,
    4,
    0,
    47,
    'МТС 4G LTE • Краснодар',
    'Вечером перестал работать даже обычный зарубежный VPN и открываются только сайты РФ.',
    1,
    JSON.stringify(buildDemoScanResults('whitelist')),
    iso(-2.2)
  );

  insertScan.run(
    demoUserId,
    'OPEN_INTERNET',
    'Свободный доступ (через VPN)',
    'Через VPN доступны 48 из 50 сайтов (96%), включая YouTube, Discord, Instagram и глобальные CDN. Только Госуслуги ограничили вход с нидерландского IP.',
    1,
    'with_vpn',
    '185.236.201.74',
    'NL',
    'Нидерланды',
    'Amsterdam',
    'Aeza International Ltd',
    'AS210644',
    50,
    48,
    1,
    1,
    83,
    100,
    100,
    79,
    'VLESS Reality • Amsterdam',
    'Проверка после включения каскадного туннеля — всё летает.',
    0,
    JSON.stringify(buildDemoScanResults('vpn')),
    iso(-5.5)
  );

  insertScan.run(
    demoUserId,
    'DPI_THROTTLING',
    'Работает ТСПУ / Точечные блокировки DPI',
    'Белых списков нет: российские (100%) и нейтральные зарубежные сайты (100%) открываются штатно. Заблокированы целевые сервисы РКН/ТСПУ (YouTube GGC, Discord, Instagram, X, Signal).',
    0,
    'direct',
    '95.165.118.203',
    'RU',
    'Россия',
    'Москва',
    'PJSC Rostelecom',
    'AS12389',
    50,
    38,
    1,
    11,
    100,
    100,
    8,
    56,
    'Ростелеком GPON • Дом',
    'Обычный домашний интернет без VPN — стандартная фильтрация ТСПУ.',
    0,
    JSON.stringify(buildDemoScanResults('dpi')),
    iso(-19)
  );

  insertScan.run(
    demoUserId,
    'TOTAL_JAMMING',
    'Глушение сети / Шатдаун мобильного интернета',
    'Критическая деградация: недоступны 96% ресурсов, включая российские сервисы. Огромные задержки (>2400 мс) указывают на радиоэлектронное ограничение 4G/LTE или перевод базовых станций в 2G.',
    0,
    'direct',
    '85.26.234.19',
    'RU',
    'Россия',
    'Ростов-на-Дону',
    'PJSC MegaFon',
    'AS31133',
    50,
    0,
    2,
    48,
    0,
    0,
    0,
    2515,
    'МегаФон EDGE/LTE • Трасса М-4',
    'Полное отключение мобильной передачи данных ночью.',
    1,
    JSON.stringify(buildDemoScanResults('jamming')),
    iso(-41)
  );

  insertScan.run(
    demoUserId,
    'SEVERE_RESTRICTIONS',
    'Массовая блокировка зарубежных CDN и подсетей',
    'Российские сайты работают (100%), но отвалились сайты на Cloudflare ECH, AWS и Hetzner (доступно лишь 26% зарубежного сегмента). Пограничный режим перед белыми списками.',
    0,
    'direct',
    '176.59.42.110',
    'RU',
    'Россия',
    'Санкт-Петербург',
    'T2 Mobile (Tele2)',
    'AS42610',
    50,
    19,
    0,
    31,
    100,
    26,
    0,
    68,
    'T2 4G • Санкт-Петербург',
    'Отвалились сайты за Cloudflare и игровые серверы на AWS.',
    0,
    JSON.stringify(buildDemoScanResults('subnets')),
    iso(-68)
  );

  // Seed regional community incidents
  const insertIncident = db.prepare(`
    INSERT INTO incidents (
      user_id, author_name, region, carrier, incident_type, severity,
      status, title, description, upvotes, ru_sites_ok, foreign_sites_ok, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const inc1 = insertIncident.run(
    demoUserId,
    'Алексей Морозов',
    'Краснодарский край',
    'МТС',
    'whitelist',
    'critical',
    'active',
    'Включены белые списки на мобильной сети МТС и Билайн',
    'Открываются только Яндекс, ВК, Госуслуги, Ozon и Сбер. Любые зарубежные IP (Cloudflare, GitHub, Википедия, прямые зарубежные VPN) уходят в таймаут на этапе TCP/TLS.',
    84,
    1,
    0,
    iso(-1.8)
  );
  db.prepare(`INSERT INTO incident_upvotes (incident_id, user_id) VALUES (?, ?)`).run(inc1.lastInsertRowid, demoUserId);

  insertIncident.run(
    null,
    'Дмитрий К.',
    'Ростовская область',
    'МегаФон',
    'mobile_shutdown',
    'critical',
    'active',
    'Ночное отключение мобильного интернета 4G/LTE',
    'После 23:00 значок LTE горит, но пакеты не ходят вообще — не грузятся даже российские банки и такси. По проводному Wi-Fi всё работает штатно.',
    61,
    0,
    0,
    iso(-3.4)
  );

  insertIncident.run(
    null,
    'Магомед А.',
    'Республика Дагестан',
    'Билайн',
    'whitelist',
    'critical',
    'active',
    'Фильтрация по белым спискам + блок зарубежных протоколов',
    'Без каскадного VPN через российский VPS внешний интернет недоступен полностью. Мессенджеры без прокси не подключаются.',
    112,
    1,
    0,
    iso(-5.1)
  );

  insertIncident.run(
    null,
    'Екатерина В.',
    'Воронежская область',
    'T2 (Tele2)',
    'mobile_shutdown',
    'high',
    'active',
    'Сильное глушение мобильного интернета в городе',
    'Мобильная сеть периодически сбрасывается в EDGE (2G). Во время ограничений работают только СМС и голосовые вызовы.',
    47,
    0,
    0,
    iso(-6.7)
  );

  insertIncident.run(
    null,
    'Илья Смирнов',
    'Ставропольский край',
    'МТС',
    'cdn_block',
    'high',
    'active',
    'Массовый блок подсетей Cloudflare, Hetzner и AWS на ТСПУ',
    'Википедия и Google открываются, но все сайты за Cloudflare TLS ECH и зарубежные хостинги зависают на TLS Handshake.',
    39,
    1,
    0,
    iso(-9.2)
  );

  insertIncident.run(
    null,
    'Антон П.',
    'Нижегородская область',
    'МегаФон',
    'whitelist',
    'high',
    'active',
    'В отдельных районах работают только сервисы из белого списка РФ',
    'В верхней части города и промзоне на мобильном интернете открываются только ВК, Яндекс.Такси и Госуслуги.',
    53,
    1,
    0,
    iso(-11.5)
  );

  insertIncident.run(
    null,
    'Сергей Л.',
    'Москва и МО',
    'Ростелеком',
    'vpn_block',
    'moderate',
    'active',
    'Усиление блокировок WireGuard и OpenVPN на домашнем интернете',
    'Чистый WireGuard и OpenVPN перестали поднимать хендшейк с первой секунды. AmneziaWG и VLESS Reality продолжают работать стабильно.',
    28,
    1,
    1,
    iso(-15.0)
  );

  insertIncident.run(
    null,
    'Ольга Н.',
    'Ленинградская область',
    'Yota',
    'mobile_shutdown',
    'moderate',
    'resolved',
    'Утренние ограничения мобильного 4G сняты',
    'С 05:30 до 09:40 наблюдался режим белых списков в области, сейчас глобальный трафик и зарубежные CDN полностью восстановились.',
    19,
    1,
    1,
    iso(-22.0)
  );
}

seedDatabaseIfNeeded();

/**
 * Миграция каталога: заменяет старый набор из 50 сайтов на актуальный
 * (75 ресурсов с проверенными статусами белый список / нейтральный / РКН).
 * Выполняется один раз на пользователя — помечаем в таблице meta.
 */
function migrateSiteCatalog(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const done = db
    .prepare(`SELECT value FROM app_meta WHERE key = 'site_catalog_v2'`)
    .get() as { value: string } | undefined;
  if (done) return;

  const users = db.prepare(`SELECT id FROM users`).all() as Array<{ id: number }>;
  for (const user of users) {
    const count = (
      db.prepare(`SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?`).get(user.id) as {
        cnt: number;
      }
    ).cnt;
    if (count > 0) {
      db.prepare(`DELETE FROM sites WHERE user_id = ?`).run(user.id);
      seedDefaultSitesForUser(user.id, user.id === 1);
    }
  }

  // Свежие демо-замеры пересобираем на новом каталоге
  const hasScanTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scans'`)
    .get() as { name: string } | undefined;
  if (hasScanTable) {
    db.prepare(`DELETE FROM scans`).run();
  }

  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('site_catalog_v2', ?)`).run(
    new Date().toISOString()
  );
}

migrateSiteCatalog();

/** Если у демо-аккаунта нет истории (например, после миграции каталога) — восстановим её. */
function seedDemoScansIfEmpty(): void {
  const demo = db
    .prepare(`SELECT id FROM users WHERE email = 'demo@pulsenet.ru'`)
    .get() as { id: number } | undefined;
  if (!demo) return;
  const cnt = (
    db.prepare(`SELECT COUNT(*) as cnt FROM scans WHERE user_id = ?`).get(demo.id) as {
      cnt: number;
    }
  ).cnt;
  if (cnt > 0) return;

  const now = Date.now();
  const iso = (offsetHours: number) => new Date(now + offsetHours * 3600 * 1000).toISOString();

  const insertScan = db.prepare(`
    INSERT INTO scans (
      user_id, verdict, verdict_title, verdict_summary, vpn_detected, vpn_mode,
      ip_address, country_code, country_name, city, isp, asn,
      total_sites, ok_sites, slow_sites, blocked_sites,
      ru_ok_pct, global_ok_pct, dpi_ok_pct, avg_latency_ms,
      carrier_label, note, pinned, results_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rowsOf = (mode: 'whitelist' | 'vpn' | 'dpi' | 'jamming' | 'subnets') => {
    const res = buildDemoScanResults(mode);
    const ok = res.filter((r) => r.status === 'ok').length;
    const slow = res.filter((r) => r.status === 'slow').length;
    const blocked = res.filter((r) => r.status === 'blocked').length;
    const pct = (role: string) => {
      const set = res.filter((r) => r.marker_role === role);
      const alive = set.filter((r) => r.status !== 'blocked').length;
      return set.length ? Math.round((alive / set.length) * 100) : 100;
    };
    return { res, ok, slow, blocked, ru: pct('ru_whitelist'), glob: pct('global_neutral'), dpi: pct('dpi_target') };
  };

  const whitelist = rowsOf('whitelist');
  insertScan.run(
    demo.id, 'WHITELIST_ACTIVE', 'ВНИМАНИЕ: ЕСТЬ БЕЛЫЕ СПИСКИ!',
    'Открываются сервисы из перечня Минцифры (Госуслуги, Яндекс, ВК, MAX, Ozon, банки), а нейтральный зарубежный интернет режется: Google, Википедия, GitHub, Cloudflare недоступны. Это режим белых списков на мобильной сети.',
    0, 'vpn_turned_off', '213.87.132.48', 'RU', 'Россия', 'Краснодар', 'PJSC MTS Mobile', 'AS8359',
    whitelist.res.length, whitelist.ok, whitelist.slow, whitelist.blocked, whitelist.ru, whitelist.glob, whitelist.dpi, 49,
    'МТС 4G LTE • Краснодар', 'Вечером перестали открываться все зарубежные сайты.', 1,
    JSON.stringify(whitelist.res), iso(-2.2)
  );

  const dpi = rowsOf('dpi');
  insertScan.run(
    demo.id, 'DPI_THROTTLING', 'Белых списков нет • Работает ТСПУ / DPI',
    'Нейтральный интернет открыт полностью, белые списки не активны. Недоступны только сервисы из реестра РКН (YouTube, Discord, Instagram, WhatsApp) — стандартная фильтрация ТСПУ на домашнем интернете.',
    0, 'direct', '95.165.118.203', 'RU', 'Россия', 'Москва', 'PJSC Rostelecom', 'AS12389',
    dpi.res.length, dpi.ok, dpi.slow, dpi.blocked, dpi.ru, dpi.glob, dpi.dpi, 62,
    'Ростелеком GPON • Дом', 'Обычный домашний интернет без VPN.', 0,
    JSON.stringify(dpi.res), iso(-19)
  );

  const vpn = rowsOf('vpn');
  insertScan.run(
    demo.id, 'OPEN_INTERNET', 'Свободный доступ через VPN',
    'Через туннель открываются все заблокированные РКН сервисы (YouTube, Discord, Instagram), а также нейтральные ресурсы. Блокировка успешно обходится.',
    1, 'with_vpn', '185.236.201.74', 'NL', 'Нидерланды', 'Amsterdam', 'Aeza International Ltd', 'AS210644',
    vpn.res.length, vpn.ok, vpn.slow, vpn.blocked, vpn.ru, vpn.glob, vpn.dpi, 84,
    'VLESS Reality • Amsterdam', 'Проверка через каскадный туннель.', 0,
    JSON.stringify(vpn.res), iso(-30)
  );

  const jam = rowsOf('jamming');
  insertScan.run(
    demo.id, 'TOTAL_JAMMING', 'Глушение сети / Шатдаун мобильного интернета',
    'Не открываются ни российские, ни зарубежные сайты. Задержки >2400 мс указывают на ограничение LTE или перевод базовых станций в 2G.',
    0, 'direct', '85.26.234.19', 'RU', 'Россия', 'Ростов-на-Дону', 'PJSC MegaFon', 'AS31133',
    jam.res.length, jam.ok, jam.slow, jam.blocked, jam.ru, jam.glob, jam.dpi, 2515,
    'МегаФон EDGE/LTE • Трасса М-4', 'Полное отключение мобильной передачи данных ночью.', 1,
    JSON.stringify(jam.res), iso(-41)
  );

  const sub = rowsOf('subnets');
  insertScan.run(
    demo.id, 'SEVERE_RESTRICTIONS', 'Частичные ограничения / сбой CDN',
    'Российские сайты работают, но отвалилась часть сайтов за Cloudflare и AWS. Пограничный режим, похожий на региональные ограничения подсетей.',
    0, 'direct', '176.59.42.110', 'RU', 'Россия', 'Санкт-Петербург', 'T2 Mobile (Tele2)', 'AS42610',
    sub.res.length, sub.ok, sub.slow, sub.blocked, sub.ru, sub.glob, sub.dpi, 71,
    'T2 4G • Санкт-Петербург', 'Отвалились сайты за Cloudflare.', 0,
    JSON.stringify(sub.res), iso(-68)
  );
}

seedDemoScansIfEmpty();
