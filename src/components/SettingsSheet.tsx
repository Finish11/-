import React, { useEffect, useState } from 'react';
import {
  Check,
  CircleCheck,
  Loader2,
  MapPin,
  Moon,
  Radio,
  RefreshCw,
  Sun,
  Wifi,
  X,
} from 'lucide-react';
import {
  CITIES,
  OPERATORS,
  useSettings,
  type NetworkType,
  type ProbeMode,
} from '../lib/appSettings';
import {
  checkForUpdate,
  getCurrentVersion,
  isUpdateSupported,
  RELEASE_PAGE,
} from '../lib/appUpdate';
import { connectionLabel, detectNetworkContext, type NetworkContext } from '../lib/networkInfo';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  darkMode: boolean;
  onToggleTheme: () => void;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode; dark: boolean }> = ({
  title,
  hint,
  children,
  dark,
}) => (
  <div className="space-y-2.5">
    <div>
      <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">{title}</div>
      {hint && <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{hint}</p>}
    </div>
    {children}
  </div>
);

/** Компактный сегментированный переключатель. */
const Segmented = <T extends string>({
  value,
  options,
  onChange,
  dark,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  dark: boolean;
}) => (
  <div
    className={`grid gap-1 p-1 rounded-xl border ${options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} ${
      dark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-100 border-slate-200'
    }`}
  >
    {options.map((o) => {
      const active = value === o.value;
      return (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`py-1.5 rounded-lg text-[11px] font-bold transition-all active:scale-95 ${
            active
              ? 'bg-sky-500 text-slate-950 shadow-sm'
              : dark
              ? 'text-slate-400 hover:text-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

export const SettingsSheet: React.FC<SettingsSheetProps> = ({
  open,
  onClose,
  darkMode,
  onToggleTheme,
  showToast,
}) => {
  const [settings, update] = useSettings();
  const [ctx, setCtx] = useState<NetworkContext | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!open) return;
    getCurrentVersion().then(setVersion).catch(() => undefined);
    setDetecting(true);
    detectNetworkContext()
      .then(setCtx)
      .catch(() => undefined)
      .finally(() => setDetecting(false));
  }, [open]);

  if (!open) return null;

  const field = `w-full px-3 py-2 rounded-xl border text-xs outline-none focus:ring-2 focus:ring-sky-500/40 ${
    darkMode
      ? 'bg-slate-950/70 border-slate-800 text-slate-100'
      : 'bg-white border-slate-200 text-slate-900'
  }`;

  const redetect = async () => {
    setDetecting(true);
    try {
      setCtx(await detectNetworkContext());
      showToast('info', 'Профиль сети обновлён');
    } finally {
      setDetecting(false);
    }
  };

  const handleCheckUpdates = async () => {
    setChecking(true);
    try {
      if (!isUpdateSupported()) {
        showToast('info', 'Проверка обновлений работает в приложении для Android');
        return;
      }
      const found = await checkForUpdate();
      showToast(
        found ? 'success' : 'info',
        found ? `Доступна версия ${found.version}` : 'Установлена последняя версия'
      );
    } catch {
      showToast('error', 'Не удалось проверить обновления');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div
        className={`relative w-full sm:max-w-lg max-h-[88vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border p-5 pb-safe ${
          darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-extrabold">Настройки</h2>
          <button
            type="button"
            onClick={onClose}
            className={`p-2 rounded-xl ${darkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-5">
          {/* Профиль сети */}
          <Section
            title="Профиль сети"
            hint="Влияет на то, как приложение трактует замер: белые списки обычно вводят только в мобильных сетях."
            dark={darkMode}
          >
            <div className={`rounded-2xl border p-3 space-y-2.5 ${darkMode ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5" />
                  {detecting
                    ? 'Определяем сеть…'
                    : ctx
                    ? `${connectionLabel(ctx.kind)}${ctx.isp ? ` · ${ctx.isp}` : ''}`
                    : 'Сеть не определена'}
                </div>
                <button
                  type="button"
                  onClick={redetect}
                  disabled={detecting}
                  className="text-[11px] font-bold text-sky-400 inline-flex items-center gap-1 active:scale-95"
                >
                  {detecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Обновить
                </button>
              </div>
              {ctx?.ip && (
                <div className="text-[10px] font-mono text-slate-500">
                  IP {ctx.ip} {ctx.countryCode ? `· ${ctx.countryCode}` : ''}
                  {ctx.city ? ` · ${ctx.city}` : ''}
                </div>
              )}
            </div>

            <label className="block">
              <span className="text-[11px] text-slate-500 flex items-center gap-1 mb-1">
                <Wifi className="w-3 h-3" /> Оператор
              </span>
              <select
                className={field}
                value={settings.operator}
                onChange={(e) => update({ operator: e.target.value })}
              >
                <option value="">
                  {ctx ? `Определён автоматически: ${ctx.operator || 'не распознан'}` : 'Определять автоматически'}
                </option>
                {OPERATORS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] text-slate-500 flex items-center gap-1 mb-1">
                <MapPin className="w-3 h-3" /> Город
              </span>
              <select
                className={field}
                value={settings.city}
                onChange={(e) => update({ city: e.target.value })}
              >
                <option value="">
                  {ctx?.city ? `Определён автоматически: ${ctx.city}` : 'Определять автоматически'}
                </option>
                {CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="text-[11px] text-slate-500 mb-1 block">Тип подключения</span>
              <Segmented<NetworkType>
                value={settings.networkType}
                onChange={(v) => update({ networkType: v })}
                dark={darkMode}
                options={[
                  { value: 'auto', label: 'Авто' },
                  { value: 'cellular', label: 'Моб. сеть' },
                  { value: 'wifi', label: 'Wi-Fi' },
                ]}
              />
            </div>
          </Section>

          {/* Замеры */}
          <Section
            title="Замеры"
            hint="Реальные пробы работают в приложении для Android: сайты проверяются прямыми запросами с телефона."
            dark={darkMode}
          >
            <Segmented<ProbeMode>
              value={settings.probeMode}
              onChange={(v) => update({ probeMode: v })}
              dark={darkMode}
              options={[
                { value: 'auto', label: 'Авто' },
                { value: 'real', label: 'Реальные' },
                { value: 'demo', label: 'Демо' },
              ]}
            />
          </Section>

          {/* Оформление */}
          <Section title="Оформление" dark={darkMode}>
            <button
              type="button"
              onClick={onToggleTheme}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-xs font-semibold ${
                darkMode ? 'border-slate-800 bg-slate-950/40 text-slate-200' : 'border-slate-200 bg-slate-50 text-slate-800'
              }`}
            >
              <span className="flex items-center gap-2">
                {darkMode ? <Moon className="w-4 h-4 text-sky-400" /> : <Sun className="w-4 h-4 text-amber-500" />}
                {darkMode ? 'Тёмная тема' : 'Светлая тема'}
              </span>
              <span className="text-[11px] text-slate-500">переключить</span>
            </button>
          </Section>

          {/* О приложении */}
          <Section title="О приложении" dark={darkMode}>
            <div className={`rounded-2xl border p-3 space-y-2 ${darkMode ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">Версия</span>
                <span className="font-mono">{version || 'веб-версия'}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCheckUpdates}
                  disabled={checking}
                  className="flex-1 py-2 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400 text-[11px] font-bold inline-flex items-center justify-center gap-1.5 active:scale-95"
                >
                  {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CircleCheck className="w-3.5 h-3.5" />}
                  Проверить обновления
                </button>
                <a
                  href={RELEASE_PAGE}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded-xl border border-slate-700/50 text-[11px] font-bold text-slate-400 inline-flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  Релизы
                </a>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};
