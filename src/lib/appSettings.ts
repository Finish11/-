import { useEffect, useState } from 'react';

/**
 * Пользовательские настройки: профиль сети (оператор, город, тип подключения),
 * режим замеров и оформление. Хранятся локально, синхронизируются между
 * компонентами через событие.
 */
export type NetworkType = 'auto' | 'wifi' | 'cellular';
export type ProbeMode = 'auto' | 'real' | 'demo';
/** Тема оформления: тёмная, светлая или как в системе. */
export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppSettings {
  /** Оператор: '' — определять автоматически */
  operator: string;
  /** Город: '' — определять автоматически */
  city: string;
  networkType: NetworkType;
  /** real — настоящие пробы (в APK), demo — симуляция, auto — как получится */
  probeMode: ProbeMode;
  /** Акцентный цвет интерфейса */
  accent: AccentTheme;
  /** Тема: dark / light / system */
  theme: ThemeMode;
  /** Меньше анимации — для слабых устройств и для тех, кого укачивает */
  calmMotion: boolean;
}

export type AccentTheme = 'sky' | 'violet' | 'emerald' | 'amber' | 'rose';

export const ACCENTS: Array<{ id: AccentTheme; name: string; swatch: string }> = [
  { id: 'sky', name: 'Небо', swatch: '#38bdf8' },
  { id: 'violet', name: 'Индиго', swatch: '#a78bfa' },
  { id: 'emerald', name: 'Изумруд', swatch: '#34d399' },
  { id: 'amber', name: 'Янтарь', swatch: '#fbbf24' },
  { id: 'rose', name: 'Роза', swatch: '#fb7185' },
];

/** Красит интерфейс в выбранный акцент (см. переменные в index.css). */
export function applyAccent(accent: AccentTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.accent = accent;
}

/** Тёмная или светлая тема — с учётом системной настройки. */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(mode: ThemeMode): 'dark' | 'light' {
  const resolved = resolveTheme(mode);
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('light', resolved === 'light');
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    // Иконки/скроллбары WebView тоже перекрашиваются
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f5f7fb' : '#05070f');
  }
  return resolved;
}

/** Уважаем системное «уменьшить движение» + ручной переключатель. */
export function applyMotion(calm: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('calm-motion', calm);
}

const KEY = 'pulsenet_settings_v1';
const EVENT = 'pulsenet-settings-changed';

export const OPERATORS = [
  'МТС',
  'Билайн',
  'МегаФон',
  'Tele2',
  'Тинькофф Мобайл',
  'Yota',
  'СберМобайл',
  'Мотив',
  'Другой',
];

export const CITIES = [
  'Москва',
  'Санкт-Петербург',
  'Новосибирск',
  'Екатеринбург',
  'Казань',
  'Нижний Новгород',
  'Челябинск',
  'Самара',
  'Омск',
  'Ростов-на-Дону',
  'Уфа',
  'Красноярск',
  'Воронеж',
  'Пермь',
  'Волгоград',
];

export const DEFAULT_SETTINGS: AppSettings = {
  operator: '',
  city: '',
  networkType: 'auto',
  probeMode: 'auto',
  accent: 'sky',
  theme: 'dark',
  calmMotion: false,
};

export function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      applyAccent(DEFAULT_SETTINGS.accent);
      applyTheme(DEFAULT_SETTINGS.theme);
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    applyAccent(merged.accent);
    applyTheme(merged.theme);
    applyMotion(merged.calmMotion);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // приватный режим — просто не сохраняем
  }
  applyAccent(next.accent);
  applyTheme(next.theme);
  applyMotion(next.calmMotion);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings>(() => readSettings());

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AppSettings>).detail;
      setSettings(detail || readSettings());
    };
    window.addEventListener(EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  return [settings, (patch) => writeSettings(patch)];
}
