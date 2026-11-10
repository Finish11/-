import type { NetworkReport, Site, SiteGroup, VpnNode } from './types'

export const REPO_URL = 'https://github.com/Finish11/-'
export const GROUP_LABELS: Record<SiteGroup, string> = {
  ru: 'Российские ресурсы',
  global: 'Мировая инфраструктура',
  services: 'Медиа и сервисы',
}

// The public catalog comes from Finish11/- (MIT). Group names describe
// the original test sets, not a claim about a site's current legal status.
const catalogRows = `Госуслуги|gosuslugi.ru|ru
Яндекс|ya.ru|ru
Кинопоиск|kinopoisk.ru|ru
ВКонтакте|vk.com|ru
Одноклассники|ok.ru|ru
Mail|mail.ru|ru
MAX|max.ru|ru
Дзен|dzen.ru|ru
Rutube|rutube.ru|ru
Ozon|ozon.ru|ru
Wildberries|wildberries.ru|ru
Авито|avito.ru|ru
2ГИС|2gis.ru|ru
HeadHunter|hh.ru|ru
Gismeteo|gismeteo.ru|ru
РИА Новости|ria.ru|ru
ТАСС|tass.ru|ru
Лента.ру|lenta.ru|ru
Аэрофлот|aeroflot.ru|ru
Туту.ру|tutu.ru|ru
Центробанк РФ|cbr.ru|ru
Сбер|sber.ru|ru
Самокат|samokat.ru|ru
Иви|ivi.ru|ru
Google|google.com|global
Google Переводчик|translate.google.com|global
Википедия|ru.wikipedia.org|global
GitHub|github.com|global
Stack Overflow|stackoverflow.com|global
Cloudflare|cloudflare.com|global
Cloudflare DNS|one.one.one.one|global
jsDelivr|cdn.jsdelivr.net|global
NPM Registry|registry.npmjs.org|global
Docker Hub|hub.docker.com|global
Mozilla|mozilla.org|global
Internet Archive|archive.org|global
Apple|apple.com|global
Microsoft|microsoft.com|global
Amazon AWS|aws.amazon.com|global
Bing|bing.com|global
Zoom|zoom.us|global
AliExpress|aliexpress.ru|global
WhatsApp|web.whatsapp.com|services
Discord|discord.com|services
Signal|signal.org|services
Viber|viber.com|services
Telegram|web.telegram.org|services
Snapchat|snapchat.com|services
Facebook|facebook.com|services
Instagram|instagram.com|services
X (Twitter)|x.com|services
LinkedIn|linkedin.com|services
YouTube|youtube.com|services
YouTube Video|googlevideo.com|services
Twitch|twitch.tv|services
TikTok|tiktok.com|services
Netflix|netflix.com|services
Spotify|open.spotify.com|services
SoundCloud|soundcloud.com|services
Patreon|patreon.com|services
Reddit|reddit.com|services
Google News|news.google.com|services
Roblox|roblox.com|services
Steam|store.steampowered.com|global
Epic Games|epicgames.com|global
GOG.com|gog.com|global
Xbox|xbox.com|global
App Store|apps.apple.com|global
Google Play|play.google.com|global
ChatGPT|chatgpt.com|services
Proton|proton.me|services
Tor Project|torproject.org|services
Mullvad VPN|mullvad.net|services
Speedtest|speedtest.net|services
Notion|notion.so|services`

const probeOverrides: Record<string, string> = {
  'gosuslugi.ru': 'https://www.gosuslugi.ru/favicon.ico',
  'google.com': 'https://www.google.com/favicon.ico',
  'cloudflare.com': 'https://www.cloudflare.com/favicon.ico',
  'ozon.ru': 'https://st.ozone.ru/assets/favicon.ico',
  'googlevideo.com': 'https://redirector.googlevideo.com/report_mapping',
  'registry.npmjs.org': 'https://registry.npmjs.org/',
  'cdn.jsdelivr.net': 'https://cdn.jsdelivr.net/npm/normalize.css@8.0.1/normalize.css',
  'epicgames.com': 'https://store.epicgames.com/',
  'torproject.org': 'https://www.torproject.org/static/images/favicon/favicon.ico',
}

export const CATALOG: Site[] = catalogRows.split('\n').map((row, index) => {
  const [name, domain, group] = row.split('|')
  return { id: `site-${index + 1}`, name, domain, group: group as SiteGroup, probeUrl: probeOverrides[domain] || `https://${domain}/favicon.ico` }
})

export const DEMO_REPORTS: NetworkReport[] = [
  {
    id: 'demo-6', title: 'Проверка мобильного интернета', date: '2026-11-04T12:52:02.198Z',
    region: 'Краснодар', operator: 'МТС', status: 'limited', total: 75, available: 25, slow: 1,
    latency: 49, source: 'demo', note: 'Демонстрационный сценарий белых списков: российские ресурсы отвечают, большинство зарубежных — нет. Это пример из репозитория, а не сообщение о текущем состоянии сети.',
    vpn: false, groups: { ru: 100, global: 4, services: 0 },
  },
  {
    id: 'demo-7', title: 'Домашнее подключение', date: '2026-11-03T20:04:02.198Z',
    region: 'Москва', operator: 'Ростелеком', status: 'partial', total: 75, available: 52, slow: 4,
    latency: 62, source: 'demo', note: 'Пример домашнего подключения с частичной доступностью медиа и сервисов. Данные взяты из демонстрационной базы проекта.',
    vpn: false, groups: { ru: 100, global: 100, services: 15 },
  },
  {
    id: 'demo-8', title: 'Проверка соединения через VPN', date: '2026-11-03T09:04:02.198Z',
    region: 'Амстердам', operator: 'VLESS Reality', status: 'stable', total: 75, available: 74, slow: 1,
    latency: 84, source: 'demo', note: 'Демонстрационный замер через VPN-туннель из исходного репозитория. 73 ресурса ответили быстро, один — медленно, один не ответил.',
    vpn: true, groups: { ru: 96, global: 100, services: 100 },
  },
  {
    id: 'demo-9', title: 'Недоступность мобильной сети', date: '2026-11-02T22:04:02.198Z',
    region: 'Ростов-на-Дону', operator: 'МегаФон', status: 'offline', total: 75, available: 2, slow: 2,
    latency: 2515, source: 'demo', note: 'Демонстрационный сценарий массового отсутствия ответов. По браузерному тесту нельзя достоверно установить причину сбоя.',
    vpn: false, groups: { ru: 8, global: 0, services: 0 },
  },
  {
    id: 'demo-10', title: 'Частичная доступность ресурсов', date: '2026-11-01T19:04:02.198Z',
    region: 'Санкт-Петербург', operator: 'T2', status: 'limited', total: 75, available: 31, slow: 0,
    latency: 71, source: 'demo', note: 'Пример частичной доступности сайтов из демонстрационной базы проекта. Не является актуальным сообщением об ограничениях.',
    vpn: false, groups: { ru: 100, global: 29, services: 0 },
  },
]

export const DEMO_NODES: VpnNode[] = [
  { id: 'demo-nl', name: 'Amsterdam · Основной', host: 'nl-edge-01.aeza-node.net', port: 443, protocol: 'VLESS Reality', location: 'Амстердам, Нидерланды', country: 'NL', demo: true, status: 'online', latency: 63, primary: true },
  { id: 'demo-fi', name: 'Helsinki · Каскад', host: 'ru-bridge-msk.yc-relay.ru', port: 443, protocol: 'VLESS Reality', location: 'Москва → Хельсинки', country: 'FI', demo: true, status: 'online', latency: 49 },
  { id: 'demo-awg', name: 'Helsinki · Резервный', host: 'fi-awg.hetzner-gw.org', port: 51820, protocol: 'AmneziaWG', location: 'Хельсинки, Финляндия', country: 'FI', demo: true, status: 'online', latency: 57 },
  { id: 'demo-de', name: 'Frankfurt · Медиа', host: 'de-quic-04.fastnode.eu', port: 8443, protocol: 'Hysteria2', location: 'Франкфурт, Германия', country: 'DE', demo: true, status: 'degraded', latency: 188 },
  { id: 'demo-lv', name: 'Riga · WireGuard', host: '185.212.141.90', port: 51820, protocol: 'WireGuard', location: 'Рига, Латвия', country: 'LV', demo: true, status: 'offline', latency: null },
]
