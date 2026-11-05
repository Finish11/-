import React, { useEffect, useState } from 'react';
import {
  Check,
  CircleCheck,
  Loader2,
  MapPin,
  MonitorSmartphone,
  Moon,
  Palette,
  RefreshCw,
  Radio,
  Signal,
  Sparkles,
  Sun,
  Wifi,
  Zap,
} from 'lucide-react';
import {
  CITIES,
  ACCENTS,
  OPERATORS,
  useSettings,
  type AccentTheme,
  type NetworkType,
  type ProbeMode,
  type ThemeMode,
} from '../lib/appSettings';
import {
  type UpdateInfo,
  checkForUpdate,
  getCurrentVersion,
  isUpdateSupported,
  RELEASE_PAGE,
} from '../lib/appUpdate';
import { connectionLabel, detectNetworkContext, type NetworkContext } from '../lib/networkInfo';
import { Sheet } from './ui/Sheet';
import { Button, Notice, Segmented, SectionTitle, Toggle } from './ui/kit';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  darkMode: boolean;
  onToggleTheme: () => void;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const Row: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div
    className={`rounded-2xl border p-3 ${className}`}
    style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
  >
    {children}
  </div>
);

const Field: React.FC<{
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, icon, children }) => (
  <label className="block">
    <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-dim mb-1.5">
      {icon}
      {label}
    </span>
    {children}
  </label>
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
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
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

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
    colorScheme: darkMode ? 'dark' : 'light',
  };
  const input =
    'w-full px-3 py-2 rounded-xl text-[12.5px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]';

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
      setAvailable(found);
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
    <Sheet
      open={open}
      onClose={onClose}
      title="Настройки"
      subtitle="Сеть, замеры и оформление"
      size="md"
      icon={
        <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
          <Sparkles className="w-4 h-4" />
        </div>
      }
      footer={
        <Button variant="primary" size="md" block onClick={onClose}>
          Готово
        </Button>
      }
    >
      <div className="space-y-6 pb-2">
        {/* ---------- Оформление ---------- */}
        <section className="space-y-2.5">
          <SectionTitle hint="Тема и акцент применяются сразу">Оформление</SectionTitle>

          <Segmented<ThemeMode>
            value={settings.theme}
            onChange={(v) => update({ theme: v })}
            options={[
              { value: 'dark', label: 'Тёмная', icon: <Moon className="w-3.5 h-3.5" /> },
              { value: 'light', label: 'Светлая', icon: <Sun className="w-3.5 h-3.5" /> },
              { value: 'system', label: 'Системная', icon: <MonitorSmartphone className="w-3.5 h-3.5" /> },
            ]}
          />

          <Row>
            <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-dim mb-2.5">
              <Palette className="w-3.5 h-3.5" /> Акцентный цвет
            </div>
            <div className="flex items-center gap-2.5">
              {ACCENTS.map((a) => {
                const active = settings.accent === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    title={a.name}
                    aria-label={a.name}
                    onClick={() => update({ accent: a.id as AccentTheme })}
                    className="relative w-9 h-9 rounded-full tap grid place-items-center"
                    style={{
                      background: a.swatch,
                      boxShadow: active ? `0 0 0 2.5px var(--bg-elevated), 0 0 0 4.5px ${a.swatch}` : 'none',
                    }}
                  >
                    {active && <Check className="w-4 h-4" style={{ color: '#04121f' }} />}
                  </button>
                );
              })}
            </div>
          </Row>

          <Row>
            <Toggle
              checked={settings.calmMotion}
              onChange={(v) => update({ calmMotion: v })}
              label="Спокойные анимации"
              hint="Меньше движения — легче для батареи и для глаз"
            />
          </Row>
        </section>

        {/* ---------- Профиль сети ---------- */}
        <section className="space-y-2.5">
          <SectionTitle hint="Влияет на трактовку замера: белые списки обычно вводят только в мобильных сетях">
            Профиль сети
          </SectionTitle>

          <Row>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11.5px] text-dim flex items-center gap-1.5 min-w-0">
                <Radio className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {detecting
                    ? 'Определяем сеть…'
                    : ctx
                    ? `${connectionLabel(ctx.kind)}${ctx.isp ? ` · ${ctx.isp}` : ''}`
                    : 'Сеть не определена'}
                </span>
              </div>
              <button
                type="button"
                onClick={redetect}
                disabled={detecting}
                className="text-[11.5px] font-bold accent-text inline-flex items-center gap-1 tap shrink-0"
              >
                {detecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Обновить
              </button>
            </div>
            {ctx?.ip && (
              <div className="text-[10.5px] font-mono text-muted mt-1.5 truncate">
                IP {ctx.ip}
                {ctx.countryCode ? ` · ${ctx.countryCode}` : ''}
                {ctx.city ? ` · ${ctx.city}` : ''}
              </div>
            )}
          </Row>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <Field label="Оператор" icon={<Signal className="w-3.5 h-3.5" />}>
              <select
                className={input}
                style={inputStyle}
                value={settings.operator}
                onChange={(e) => update({ operator: e.target.value })}
              >
                <option value="">
                  {ctx ? `Авто: ${ctx.operator || 'не распознан'}` : 'Определять автоматически'}
                </option>
                {OPERATORS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Город" icon={<MapPin className="w-3.5 h-3.5" />}>
              <select
                className={input}
                style={inputStyle}
                value={settings.city}
                onChange={(e) => update({ city: e.target.value })}
              >
                <option value="">{ctx?.city ? `Авто: ${ctx.city}` : 'Определять автоматически'}</option>
                {CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div>
            <div className="text-[11.5px] font-semibold text-dim mb-1.5 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5" /> Тип подключения
            </div>
            <Segmented<NetworkType>
              size="sm"
              value={settings.networkType}
              onChange={(v) => update({ networkType: v })}
              options={[
                { value: 'auto', label: 'Авто' },
                { value: 'cellular', label: 'Моб. сеть' },
                { value: 'wifi', label: 'Wi-Fi' },
              ]}
            />
          </div>
        </section>

        {/* ---------- Замеры ---------- */}
        <section className="space-y-2.5">
          <SectionTitle hint="В приложении для Android доступны настоящие пробы с телефона">
            Замеры
          </SectionTitle>
          <Segmented<ProbeMode>
            value={settings.probeMode}
            onChange={(v) => update({ probeMode: v })}
            options={[
              { value: 'auto', label: 'Авто' },
              { value: 'real', label: 'Точные', icon: <Zap className="w-3.5 h-3.5" /> },
            ]}
          />
          <p className="text-[10.5px] text-muted leading-relaxed">
            Имитации в замерах нет: приложение всегда проверяет вашу сеть по-настоящему. Если
            содержимое страницы недоступно (например, в веб-предпросмотре), результат помечается как
            оценка.
          </p>
        </section>

        {/* ---------- О приложении ---------- */}
        <section className="space-y-2.5">
          <SectionTitle
            hint="Обновления раздаются через GitHub Releases"
            right={<span className="font-mono text-[11px] text-muted">{version || 'веб-версия'}</span>}
          >
            О приложении
          </SectionTitle>

          <div className="flex gap-2">
            <Button
              variant="soft"
              size="md"
              block
              loading={checking}
              icon={<CircleCheck className="w-4 h-4" />}
              onClick={handleCheckUpdates}
            >
              Проверить обновления
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={() => window.open(RELEASE_PAGE, '_blank', 'noreferrer')}
            >
              Релизы
            </Button>
          </div>

          {available && (
            <a
              href={available.downloadUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl accent-soft text-[12.5px] font-bold tap"
            >
              <span>Скачать {available.version} для Android</span>
              <span className="text-[10px] opacity-80">APK</span>
            </a>
          )}

          <p className="text-[11px] text-muted leading-relaxed">
            Замеры в приложении настоящие: сайты проверяются прямыми запросами с телефона. VPN-туннеля
            внутри приложения пока нет — узлы только проверяются на доступность.
          </p>
        </section>
      </div>
    </Sheet>
  );
};
