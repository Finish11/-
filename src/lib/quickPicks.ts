import type { MarkerRole, SiteCategory } from '../types';

/**
 * Популярные сервисы для «быстрого выбора»: один тап — и ресурс попадает в каталог,
 * после чего участвует в замерах и в отчёте.
 *
 * Роль `dpi_target` означает «сервис, который в РФ чаще всего режут/замедляют через
 * ТСПУ» — по нему видно, работает ли DPI-обход. Это не утверждение о блокировке
 * конкретно у вас: статус зависит от оператора, региона и дня, а каталог лишь
 * проверяет доступность с вашего устройства.
 *
 * Проверено 4 ноября 2026 года по публичным статусам сервисов и сообщениям
 * пользователей о замедлении. Даты стоит перепроверять перед публикацией замеров.
 */
export interface QuickPick {
  id: string;
  name: string;
  domain: string;
  probeUrl: string;
  emoji: string;
  hint: string;
  category: SiteCategory;
  role: MarkerRole;
  /** Цвет акцента для карточки (tailwind-классы). */
  tone: string;
  /** Оговорка, если HTTP-проба показывает сервис лишь косвенно. */
  caveat?: string;
  /** Игровой сервер: проверяем TCP-пинг по этому адресу и порту. */
  gameHost?: string;
  gamePort?: number;
  /** Официальные Android-пакеты для запуска и ручного подтверждения работы. */
  packageNames?: string[];
}

export const QUICK_PICKS: QuickPick[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    domain: 'chatgpt.com',
    probeUrl: 'https://chatgpt.com/',
    emoji: '🤖',
    hint: 'AI-чат OpenAI — у части операторов открывается без VPN',
    category: 'dev_ai_vpn',
    role: 'dpi_target',
    tone: 'emerald',
    caveat: 'Проверяем открытие сайта chatgpt.com, а не вход, API и отправку сообщений.',
    packageNames: ['com.openai.chatgpt'],
  },
  {
    id: 'claude',
    name: 'Claude',
    domain: 'claude.ai',
    probeUrl: 'https://claude.ai/',
    emoji: '📝',
    hint: 'AI-чат Anthropic',
    category: 'dev_ai_vpn',
    role: 'dpi_target',
    tone: 'amber',
    packageNames: ['com.anthropic.claude'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    domain: 'gemini.google.com',
    probeUrl: 'https://gemini.google.com/',
    emoji: '✨',
    hint: 'AI-чат Google',
    category: 'dev_ai_vpn',
    role: 'dpi_target',
    tone: 'sky',
    packageNames: ['com.google.android.apps.bard'],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    domain: 'web.telegram.org',
    probeUrl: 'https://web.telegram.org/',
    emoji: '✈️',
    hint: 'Мессенджер и веб-версия',
    category: 'messengers',
    role: 'dpi_target',
    tone: 'sky',
    packageNames: ['org.telegram.messenger'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    domain: 'web.whatsapp.com',
    probeUrl: 'https://web.whatsapp.com/',
    emoji: '💬',
    hint: 'Мессенджер Meta',
    category: 'messengers',
    role: 'dpi_target',
    tone: 'emerald',
    packageNames: ['com.whatsapp'],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    domain: 'youtube.com',
    probeUrl: 'https://www.youtube.com/',
    emoji: '▶️',
    hint: 'Главный индикатор замедления ТСПУ',
    category: 'media_social',
    role: 'dpi_target',
    tone: 'rose',
    packageNames: ['com.google.android.youtube'],
  },
  {
    id: 'brawlstars',
    name: 'Brawl Stars',
    domain: 'store.supercell.com',
    probeUrl: 'https://store.supercell.com/',
    emoji: '🎮',
    hint: 'Игра Supercell (проверяется магазин Supercell)',
    category: 'gaming_stores',
    role: 'dpi_target',
    tone: 'violet',
    caveat:
      'Игровые серверы Supercell стоят в ЕС (Франкфурт, Амстердам, Хельсинки) — ближе всего к Москве европейские узлы. Проверяем TCP 9339 до game.brawlstars.com.',
    packageNames: ['com.supercell.brawlstars'],
    gameHost: 'game.brawlstars.com',
    gamePort: 9339,
  },
];

export const QUICK_PICK_TONES: Record<string, string> = {
  emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30 text-emerald-300',
  amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30 text-amber-300',
  sky: 'from-sky-500/20 to-sky-500/5 border-sky-500/30 text-sky-300',
  rose: 'from-rose-500/20 to-rose-500/5 border-rose-500/30 text-rose-300',
  violet: 'from-violet-500/20 to-violet-500/5 border-violet-500/30 text-violet-300',
};
