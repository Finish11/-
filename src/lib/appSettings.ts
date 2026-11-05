import { useEffect, useState } from 'react';

/**
 * Пользовательские настройки: профиль сети (оператор, город, тип подключения),
 * режим замеров и оформление. Хранятся локально, синхронизируются между
 * компонентами через событие.
 */
export type NetworkType = 'auto' | 'wifi' | 'cellular';
export type ProbeMode = 'auto' | 'real' | 'demo';

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
};

export function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      applyAccent(DEFAULT_SETTINGS.accent);
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    applyAccent(merged.accent);
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
