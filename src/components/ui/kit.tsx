import React from 'react';
import {
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  ShieldAlert,
  WifiOff,
  XCircle,
} from 'lucide-react';

/* Небольшой набор базовых элементов интерфейса.
   Все цвета — из CSS-переменных (см. src/index.css), поэтому смена акцента
   и светлой/тёмной темы работает без перерисовки классов в каждом компоненте. */

type ButtonVariant = 'primary' | 'soft' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  block?: boolean;
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-[12.5px] gap-1.5 rounded-xl',
  md: 'h-11 px-4 text-[13.5px] gap-2 rounded-xl',
  lg: 'h-12 px-5 text-sm gap-2 rounded-2xl',
};

export const Button: React.FC<ButtonProps> = ({
  variant = 'soft',
  size = 'md',
  loading = false,
  icon,
  block = false,
  className = '',
  children,
  disabled,
  ...rest
}) => {
  const base =
    'inline-flex items-center justify-center font-semibold press-spring select-none disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap focus-accent';
  const variants: Record<ButtonVariant, string> = {
    primary: 'accent-solid accent-glow hover:brightness-[1.04]',
    soft: 'accent-soft hover:brightness-110',
    ghost:
      'text-[color:var(--text-dim)] hover:text-[color:var(--text)] hover:bg-[color:var(--surface-2)] border border-transparent',
    outline:
      'border text-[color:var(--text)] hover:bg-[color:var(--surface-2)]',
    danger:
      'bg-[rgb(var(--danger)/0.14)] border border-[rgb(var(--danger)/0.35)] text-[rgb(var(--danger))] hover:bg-[rgb(var(--danger)/0.2)]',
  };
  const outlineStyle = variant === 'outline' ? { borderColor: 'var(--line-strong)' } : undefined;

  return (
    <button
      type="button"
      disabled={disabled || loading}
      style={outlineStyle}
      className={`${base} ${SIZE[size]} ${variants[variant]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  );
};

/** Карточка-контейнер: единая поверхность для блоков данных.
    По умолчанию получает подъём (elevation) и внутреннюю верхнюю подсветку
    (фрост), чтобы поверхности не смотрелись плоскими. Кликабельная карточка
    поднимается на наведение (десктоп) и отдаётся пружинным нажатием. */
export const Card: React.FC<{
  children: React.ReactNode;
  className?: string;
  /** Внутренняя подсветка-акцент (для главных блоков, как главный экран). */
  accent?: boolean;
  onClick?: () => void;
  /** Сила подъёма: 1 — минимально, 2 — по умолчанию, 3 — сильный (главный блок). */
  elev?: 1 | 2 | 3;
}> = ({ children, className = '', accent = false, onClick, elev = 2 }) => (
  <div
    onClick={onClick}
    className={`relative rounded-[1.5rem] border p-4 sm:p-5 ${className} ${
      onClick ? 'hover-lift press-spring' : ''
    }`}
    style={{
      borderColor: 'var(--line)',
      background: accent
        ? 'radial-gradient(120% 90% at 50% -20%, rgb(var(--accent) / 0.16), transparent 60%), var(--surface)'
        : 'var(--surface)',
      boxShadow: `var(--shadow-${elev}), inset 0 1px 0 var(--inset-hi)`,
    }}
  >
    {children}
  </div>
);

/** Небольшой чип-переключатель (фильтры, теги). */
export const Chip: React.FC<{
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ active = false, onClick, children, className = '', title }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    aria-pressed={active}
    className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-semibold border press-spring ${
      active
        ? 'accent-soft'
        : 'text-[color:var(--text-dim)] hover:text-[color:var(--text)]'
    } ${className}`}
    style={active ? undefined : { borderColor: 'var(--line)' }}
  >
    {children}
  </button>
);

/** Сегментированный переключатель на N вариантов со скользящим индикатором.
    Индикатор — плывущая акцентная плита (spring), которая проезжает к активному
    варианту при смене: переключение читается мгновенно, без перерисовывания
    контекста. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const pad = size === 'sm' ? 'py-1.5' : 'py-2';
  return (
    <div
      className="relative grid rounded-xl border p-1"
      style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
    >
      {/* Скользящий индикатор: позиционируется по активному варианту. */}
      <span
        aria-hidden="true"
        className="absolute top-1 bottom-1 left-1 rounded-lg accent-solid transition-all duration-200 ease-spring"
        style={{
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(calc(${activeIndex} * 100%))`,
          boxShadow: 'var(--shadow-2), inset 0 1px 0 var(--inset-hi-strong)',
        }}
      />
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`relative inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold tap ${pad} ${
              size === 'sm' ? 'text-[11.5px]' : 'text-[12.5px]'
            }`}
            style={{
              color: active ? 'var(--accent-contrast)' : 'var(--text-dim)',
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Плавный переключатель (галка). */
export const Toggle: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  hint?: React.ReactNode;
}> = ({ checked, onChange, label, hint }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    role="switch"
    aria-checked={checked}
    className="w-full flex items-start gap-3 text-left tap"
  >
    <span
      className="relative mt-0.5 shrink-0 w-10 h-6 rounded-full transition-colors"
      style={{
        background: checked ? 'rgb(var(--accent))' : 'var(--line-strong)',
        boxShadow: checked ? 'inset 0 0 0 1px rgb(var(--accent) / 0.45)' : 'inset 0 0 0 1px rgb(255 255 255 / 0.06)',
      }}
    >
      <span
        className="absolute top-1/2 -translate-y-1/2 rounded-full bg-white transition-all duration-200"
        style={{
          width: '1.125rem',
          height: '1.125rem',
          left: checked ? 'calc(100% - 1.25rem)' : '0.185rem',
          boxShadow: '0 1px 4px rgba(0,0,0,.4)',
        }}
      />
    </span>
    <span className="min-w-0 flex-1">
      {label && <span className="block text-[13px] font-semibold leading-snug">{label}</span>}
      {hint && <span className="block text-[11.5px] text-muted leading-snug mt-0.5">{hint}</span>}
    </span>
  </button>
);

/** Заголовок раздела внутри страницы. */
export const SectionTitle: React.FC<{
  children: React.ReactNode;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}> = ({ children, hint, right, className = '' }) => (
  <div className={`flex items-start justify-between gap-3 ${className}`}>
    <div className="min-w-0">
      <h3 className="text-[13px] font-bold uppercase tracking-wider text-muted">{children}</h3>
      {hint && <p className="text-[12px] text-dim mt-0.5 leading-snug">{hint}</p>}
    </div>
    {right && <div className="shrink-0">{right}</div>}
  </div>
);

/** Пустое состояние с иконкой. */
export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  text?: React.ReactNode;
  action?: React.ReactNode;
}> = ({ icon, title, text, action }) => (
  <div className="flex flex-col items-center text-center px-6 py-10">
    {icon && (
      <div
        className="w-12 h-12 rounded-2xl grid place-items-center mb-3 text-dim"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
      >
        {icon}
      </div>
    )}
    <div className="text-sm font-bold">{title}</div>
    {text && <p className="text-[12.5px] text-dim mt-1 max-w-sm leading-relaxed">{text}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

/** Скелетон загрузки. */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div
    className={`rounded-xl shimmer ${className}`}
    style={{ background: 'var(--surface-2)' }}
    aria-hidden="true"
  />
);

/** Строка-скелетон (для списков и форм). */
export const SkeletonLine: React.FC<{ className?: string; w?: string }> = ({
  className = '',
  w = 'w-full',
}) => (
  <div
    className={`h-3.5 rounded shimmer ${w} ${className}`}
    style={{ background: 'var(--surface-2)' }}
    aria-hidden="true"
  />
);

/** Полоса загрузки для активного процесса (замер, синхронизация). */
export const LoadingBar: React.FC<{ pct?: number; label?: React.ReactNode }> = ({
  pct,
  label,
}) => (
  <div className="space-y-1.5">
    {label && <div className="text-[11.5px] font-semibold text-dim">{label}</div>}
    <div
      className="w-full rounded-full overflow-hidden"
      style={{ height: 6, background: 'var(--surface-2)' }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{
          width: `${pct != null ? Math.max(0, Math.min(100, pct)) : 100}%`,
          background: 'rgb(var(--accent))',
        }}
      />
    </div>
  </div>
);

/** Состояние ошибки с проигрывателем действия: повторить или отменить. */
export const ErrorState: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  text?: React.ReactNode;
  action?: React.ReactNode;
}> = ({ icon, title, text, action }) => (
  <div className="flex flex-col items-center text-center px-6 py-10">
    {icon && (
      <div
        className="w-12 h-12 rounded-2xl grid place-items-center mb-3"
        style={{
          background: 'rgb(var(--danger) / 0.12)',
          border: '1px solid rgb(var(--danger) / 0.3)',
          color: 'rgb(var(--danger))',
        }}
      >
        {icon}
      </div>
    )}
    <div className="text-sm font-bold">{title}</div>
    {text && <p className="text-[12.5px] text-dim mt-1 max-w-sm leading-relaxed">{text}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

/** Цветной статус-индикатор (точка + подпись). */
export const StatusDot: React.FC<{
  tone: 'ok' | 'warn' | 'bad' | 'idle';
  children?: React.ReactNode;
  pulse?: boolean;
}> = ({ tone, children, pulse }) => {
  const color =
    tone === 'ok'
      ? 'rgb(var(--success))'
      : tone === 'warn'
      ? 'rgb(var(--warning))'
      : tone === 'bad'
      ? 'rgb(var(--danger))'
      : 'var(--text-muted)';
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className={`relative flex w-2 h-2 shrink-0`}>
        {pulse && (
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-60"
            style={{ background: color }}
          />
        )}
        <span className="relative w-2 h-2 rounded-full" style={{ background: color }} />
      </span>
      {children}
    </span>
  );
};

/** Плашка-уведомление внутри контента. */
export const Notice: React.FC<{
  tone?: 'info' | 'warn' | 'bad' | 'ok';
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}> = ({ tone = 'info', icon, children, onClose }) => {
  const rgb =
    tone === 'warn'
      ? 'var(--warning)'
      : tone === 'bad'
      ? 'var(--danger)'
      : tone === 'ok'
      ? 'var(--success)'
      : 'var(--accent)';
  return (
    <div
      className="flex items-start gap-2.5 rounded-2xl px-3.5 py-2.5 text-[12px] leading-snug"
      style={{
        background: `rgb(${rgb} / 0.1)`,
        border: `1px solid rgb(${rgb} / 0.28)`,
        color: `rgb(${rgb})`,
      }}
    >
      {icon && <span className="shrink-0 mt-0.5">{icon}</span>}
      <div className="min-w-0 flex-1" style={{ color: 'var(--text)' }}>
        {children}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="tap-icon tap shrink-0 opacity-60 hover:opacity-100 text-[13px] leading-none"
          aria-label="Скрыть"
        >
          ✕
        </button>
      )}
    </div>
  );
};

/* ---------------------------------------------------------------------------
   Иконка статуса: тонированный квадрат вместо «сырых» emoji.
   Emoji-флаги в Android WebView рисуются квадратиками, поэтому страны
   показываем через двухбуквенный код в цветном бейдже.
   ------------------------------------------------------------------------- */

const FLAG_COLORS: Record<string, string> = {
  NL: '#f97316', DE: '#facc15', FI: '#38bdf8', SE: '#22d3ee', FR: '#6366f1',
  GB: '#3b82f6', US: '#ef4444', CA: '#dc2626', PL: '#f472b6', LV: '#be123c',
  LT: '#f59e0b', EE: '#0ea5e9', TR: '#e11d48', AE: '#10b981', AM: '#f43f5e',
  GE: '#f87171', KZ: '#0ea5e9', RU: '#2563eb', CH: '#ef4444', AT: '#dc2626',
  IT: '#22c55e', ES: '#f59e0b', CZ: '#2563eb', JP: '#ef4444', SG: '#f43f5e',
  HK: '#e11d48', KR: '#3b82f6', IN: '#f59e0b', BR: '#22c55e', AU: '#2563eb',
  IL: '#3b82f6', MD: '#f59e0b', RS: '#ef4444', HU: '#22c55e', RO: '#3b82f6',
  BG: '#22c55e', GR: '#3b82f6', IS: '#38bdf8', NO: '#ef4444', DK: '#ef4444',
  BE: '#f59e0b', IE: '#22c55e', PT: '#22c55e', UA: '#fbbf24', BY: '#ef4444',
  CN: '#ef4444', TH: '#3b82f6', VN: '#ef4444', ID: '#ef4444', MX: '#22c55e',
  AR: '#38bdf8', ZA: '#22c55e', XX: '#64748b',
};

export const CountryBadge: React.FC<{ code?: string; size?: number }> = ({ code, size = 26 }) => {
  const cc = (code || 'XX').toUpperCase().slice(0, 2);
  const color = FLAG_COLORS[cc] || '#64748b';
  if (!cc || cc === 'XX') {
    return (
      <span
        className="grid place-items-center shrink-0 rounded-lg"
        style={{
          width: size,
          height: size,
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          color: 'var(--text-muted)',
        }}
        aria-hidden="true"
      >
        <Globe style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    );
  }
  return (
    <span
      className="grid place-items-center shrink-0 rounded-lg font-black tabular-nums"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `color-mix(in srgb, ${color} 18%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
        color,
      }}
      aria-label={cc}
    >
      {cc}
    </span>
  );
};

/** Статус узла / сайта одной иконкой. */
export const StatusIcon: React.FC<{
  status: 'online' | 'degraded' | 'blocked' | 'ok' | 'slow' | 'unknown' | 'checking' | null;
  className?: string;
}> = ({ status, className = 'w-4 h-4' }) => {
  if (status === 'online' || status === 'ok') {
    return <CheckCircle2 className={className} style={{ color: 'rgb(var(--success))' }} />;
  }
  if (status === 'degraded' || status === 'slow') {
    return <Clock className={className} style={{ color: 'rgb(var(--warning))' }} />;
  }
  if (status === 'blocked') {
    return <XCircle className={className} style={{ color: 'rgb(var(--danger))' }} />;
  }
  if (status === 'checking') {
    return <Loader2 className={`${className} animate-spin`} style={{ color: 'rgb(var(--accent))' }} />;
  }
  return <Clock className={className} style={{ color: 'var(--text-muted)' }} />;
};

/** Плашка «VPN / без VPN». */
export const NetBadge: React.FC<{ vpn: boolean; compact?: boolean }> = ({ vpn, compact }) => (
  <span
    className="inline-flex items-center gap-1.5 rounded-full font-bold"
    style={{
      padding: compact ? '2px 8px' : '4px 10px',
      fontSize: compact ? 10.5 : 11.5,
      background: vpn ? 'rgb(var(--warning) / 0.14)' : 'rgb(var(--success) / 0.12)',
      border: `1px solid ${vpn ? 'rgb(var(--warning) / 0.3)' : 'rgb(var(--success) / 0.26)'}`,
      color: vpn ? 'rgb(var(--warning))' : 'rgb(var(--success))',
    }}
  >
    {vpn ? <ShieldAlert className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
    {vpn ? 'VPN' : 'без VPN'}
  </span>
);

/** Иконка-плитка для заголовков блоков. */
export const TileIcon: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = 'rgb(var(--accent))',
}) => (
  <span
    className="w-8 h-8 rounded-xl grid place-items-center shrink-0 press-spring"
    style={{
      background: `color-mix(in srgb, ${color} 14%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 26%, transparent)`,
      color,
      boxShadow: 'inset 0 1px 0 var(--inset-hi)',
    }}
  >
    {children}
  </span>
);
