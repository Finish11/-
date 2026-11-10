import { useEffect, useState } from 'react';
import type { ScanSpeed } from './scanBudget';

/**
 * Пользовательские настройки: профиль сети (оператор, город, тип подключения),
 * режим замеров и оформление. Хранятся локально, синхронизируются между
 * компонентами через событие.
 */
export type NetworkType = 'auto' | 'wifi' | 'cellular';
export type ProbeMode = 'auto' | 'real';
/** Тема оформления: тёмная, светлая или как в системе. */
export type ThemeMode = 'dark' | 'light' | 'system';
/** Единицы в замере скорости: как в Ookla — биты или байты. */
export type SpeedUnit = 'mbps' | 'MBps';
/** Потолок шкалы спидометра: авто или фиксированный, как в оригинале. */
export type GaugeMax = 'auto' | 100 | 250 | 500 | 1000;

export interface AppSettings {
  /** Оператор: '' — определять автоматически */
  operator: string;
  /** Город: '' — определять автоматически */
  city: string;
  networkType: NetworkType;
  /** auto — настоящие пробы, когда доступны; real — принудительно настоящие */
  probeMode: ProbeMode;
  /** Акцентный цвет интерфейса */
  accent: AccentTheme;
  /** Тема: dark / light / system */
  theme: ThemeMode;
  /** Меньше анимации — для слабых устройств и для тех, кого укачивает */
  calmMotion: boolean;
  /** Насколько глубоко и долго проверять сайты. */
  scanSpeed: ScanSpeed;
  /** Единицы скорости: Мбит/с или МБ/с. */
  speedUnit: SpeedUnit;
  /** Предел шкалы спидометра. */
  gaugeMax: GaugeMax;
  /** Экономный замер скорости по умолчанию. */
  speedLite: boolean;
}

export type AccentTheme = 'sky' | 'violet' | 'emerald' | 'amber' | 'rose';

export const ACCENTS: Array<{ id: AccentTheme; name: string; swatch: string }> = [
  { id: 'sky', name: 'Мята', swatch: '#52c798' },
  { id: 'violet', name: 'Индиго', swatch: '#9e89e8' },
  { id: 'emerald', name: 'Изумруд', swatch: '#52c798' },
  { id: 'amber', name: 'Янтарь', swatch: '#e2b04a' },
  { id: 'rose', name: 'Роза', swatch: '#e2848c' },
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
  scanSpeed: 'fast',
  speedUnit: 'mbps',
  gaugeMax: 'auto',
  speedLite: false,
};

const SCAN_SPEEDS: ScanSpeed[] = ['fast', 'balanced', 'thorough'];
const SPEED_UNITS: SpeedUnit[] = ['mbps', 'MBps'];
const GAUGE_MAXES: GaugeMax[] = ['auto', 100, 250, 500, 1000];
const THEMES: ThemeMode[] = ['dark', 'light', 'system'];
const NETWORK_TYPES: NetworkType[] = ['auto', 'wifi', 'cellular'];

/**
 * Приводит любые данные к корректным настройкам.
 *
 * Раньше значения проверялись только при чтении: `writeSettings({gaugeMax: 999})`
 * сохранял мусор и рассылал его подписчикам, и экран замера получал потолок,
 * которого нет в списке. Теперь проверка одна на оба пути — и старое хранилище,
 * и испорченный JSON, и неверный вызов дают предсказуемый результат.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T,>(value: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const text = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 120) : '');
  return {
    operator: text(parsed.operator),
    city: text(parsed.city),
    networkType: pick(parsed.networkType, NETWORK_TYPES, DEFAULT_SETTINGS.networkType),
    // Старое значение 'demo' больше не существует: имитации в замерах нет.
    probeMode: parsed.probeMode === 'real' ? 'real' : 'auto',
    accent: pick(parsed.accent, ACCENTS.map((a) => a.id), DEFAULT_SETTINGS.accent),
    theme: pick(parsed.theme, THEMES, DEFAULT_SETTINGS.theme),
    calmMotion: Boolean(parsed.calmMotion),
    scanSpeed: pick(parsed.scanSpeed, SCAN_SPEEDS, DEFAULT_SETTINGS.scanSpeed),
    speedUnit: pick(parsed.speedUnit, SPEED_UNITS, DEFAULT_SETTINGS.speedUnit),
    gaugeMax: pick(parsed.gaugeMax, GAUGE_MAXES, DEFAULT_SETTINGS.gaugeMax),
    speedLite: Boolean(parsed.speedLite),
  };
}

export function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      applyAccent(DEFAULT_SETTINGS.accent);
      applyTheme(DEFAULT_SETTINGS.theme);
      return DEFAULT_SETTINGS;
    }
    const merged = sanitizeSettings(JSON.parse(raw));
    applyAccent(merged.accent);
    applyTheme(merged.theme);
    applyMotion(merged.calmMotion);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  // Проверяем и то, что пришло из интерфейса: неверный потолок шкалы или
  // единицы не должны попасть ни в хранилище, ни к подписчикам.
  const next = sanitizeSettings({ ...readSettings(), ...patch });
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
