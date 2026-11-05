import React, { useEffect, useState } from 'react';
import {
  Radar,
  Globe,
  Shield,
  AlertOctagon,
  History,
  LogOut,
  RefreshCw,
  Sun,
  Moon,
  Settings,
  Check,
  ChevronRight,
  Signal,
  Wifi,
  Info,
} from 'lucide-react';
import {
  RUSSIAN_CARRIERS,
  RUSSIAN_REGIONS,
  type ClientConnectionInfo,
  type User,
} from '../types';
import { apiFetch } from '../lib/api';
import { IS_DEMO_BUILD } from '../lib/scanner';
import { UpdateCard } from './UpdateCard';
import { isNativeApp } from '../lib/nativeBridge';
import { SettingsSheet } from './SettingsSheet';
import { Sheet } from './ui/Sheet';
import { Button, Notice } from './ui/kit';

export type NavTab = 'scanner' | 'sites' | 'vpn' | 'incidents' | 'history';

interface LayoutProps {
  user: User;
  onUserUpdate: (u: User) => void;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  connection: ClientConnectionInfo | null;
  connLoading: boolean;
  onRefreshConnection: () => void;
  onLogout: () => void;
  counts: {
    sites: number;
    vpnOnline: number;
    vpnTotal: number;
    activeIncidents: number;
    scans: number;
  };
  darkMode: boolean;
  onToggleTheme: () => void;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
  children: React.ReactNode;
}

interface NavItem {
  id: NavTab;
  label: string;
  mobileLabel: string;
  icon: React.FC<{ className?: string }>;
  badge?: string;
  dot?: boolean;
}

export const Layout: React.FC<LayoutProps> = ({
  user,
  onUserUpdate,
  activeTab,
  onSelectTab,
  connection,
  connLoading,
  onRefreshConnection,
  onLogout,
  counts,
  darkMode,
  onToggleTheme,
  showToast,
  children,
}) => {
  const [profileOpen, setProfileOpen] = useState(false);
  const [demoBanner, setDemoBanner] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editName, setEditName] = useState(user.name);
  const [editRegion, setEditRegion] = useState(user.region);
  const [editCarrier, setEditCarrier] = useState(user.carrier);
  const [savingProfile, setSavingProfile] = useState(false);

  // При смене вкладки всегда возвращаемся наверх — иначе новая страница
  // открывается посреди списка и выглядит «сломанной».
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeTab]);

  const navItems: NavItem[] = [
    { id: 'scanner', label: 'Проверка сети', mobileLabel: 'Проверка', icon: Radar },
    { id: 'sites', label: 'Каталог сайтов', mobileLabel: 'Сайты', icon: Globe },
    { id: 'vpn', label: 'VPN-узлы', mobileLabel: 'VPN', icon: Shield },
    {
      id: 'incidents',
      label: 'Сбои и белые списки',
      mobileLabel: 'Сбои',
      icon: AlertOctagon,
      dot: counts.activeIncidents > 0,
    },
    { id: 'history', label: 'История', mobileLabel: 'История', icon: History },
  ];

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await apiFetch<{ user: User }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: editName, region: editRegion, carrier: editCarrier }),
      });
      onUserUpdate(res.user);
      setProfileOpen(false);
      showToast('success', 'Профиль обновлён');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSavingProfile(false);
    }
  };

  const vpnOn = Boolean(connection?.vpn_detected);

  const fieldStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
    colorScheme: darkMode ? 'dark' : 'light',
  };
  const field = 'w-full px-3.5 py-2.5 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.35)]';

  return (
    <div className="app-bg min-h-screen flex flex-col lg:flex-row">
      {/* ==================== DESKTOP SIDEBAR ==================== */}
      <aside
        className="hidden lg:flex lg:w-[17.5rem] lg:flex-col lg:fixed lg:inset-y-0 z-30 border-r"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)', backdropFilter: 'blur(18px)' }}
      >
        <div className="px-5 pt-6 pb-4 flex items-center gap-3">
          <div className="relative w-10 h-10 rounded-2xl grid place-items-center accent-gradient accent-glow shrink-0">
            <Radar className="w-5 h-5" style={{ color: 'var(--accent-contrast)' }} />
          </div>
          <div className="min-w-0">
            <div className="font-extrabold text-[15px] tracking-tight leading-none">ПульсСети</div>
            <div className="text-[11px] text-muted mt-1 truncate">радар доступности интернета</div>
          </div>
        </div>

        {/* Плашка соединения */}
        <div className="px-4">
          <button
            onClick={onRefreshConnection}
            disabled={connLoading}
            className="w-full text-left rounded-2xl border p-3 tap hover:brightness-105"
            style={{
              background: vpnOn ? 'rgb(var(--warning) / 0.09)' : 'var(--surface-2)',
              borderColor: vpnOn ? 'rgb(var(--warning) / 0.3)' : 'var(--line)',
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <span
                className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider"
                style={{ color: vpnOn ? 'rgb(var(--warning))' : 'rgb(var(--success))' }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: vpnOn ? 'rgb(var(--warning))' : 'rgb(var(--success))' }}
                />
                {connLoading ? 'Проверяем IP' : vpnOn ? 'VPN включён' : 'Прямое подключение'}
              </span>
              <RefreshCw className={`w-3 h-3 text-muted ${connLoading ? 'animate-spin' : ''}`} />
            </div>
            <div className="font-mono text-[12px] font-semibold truncate">
              {connection?.ip || 'определяем…'}
            </div>
            <div className="text-[11px] text-dim truncate mt-0.5">
              {connection
                ? `${connection.country_name}${connection.city ? `, ${connection.city}` : ''} · ${connection.isp}`
                : 'анализ маршрута…'}
            </div>
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto no-scrollbar">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 h-10 rounded-xl text-[13.5px] font-semibold tap ${
                  isActive ? 'accent-soft' : 'text-dim hover:text-[color:var(--text)]'
                }`}
                style={isActive ? undefined : { background: 'transparent' }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--surface-2)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                <Icon className="w-[18px] h-[18px]" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.dot && (
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgb(var(--danger))' }} />
                )}
                {isActive && <ChevronRight className="w-3.5 h-3.5 opacity-70" />}
              </button>
            );
          })}
        </nav>

        <div className="px-3 pb-4 space-y-2">
          <div className="flex gap-1.5">
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex-1 h-9 rounded-xl border text-[12px] font-semibold text-dim hover:text-[color:var(--text)] tap inline-flex items-center justify-center gap-1.5"
              style={{ borderColor: 'var(--line)' }}
            >
              <Settings className="w-3.5 h-3.5" /> Настройки
            </button>
            <button
              onClick={onToggleTheme}
              title="Сменить тему"
              className="w-9 h-9 rounded-xl border grid place-items-center text-dim hover:text-[color:var(--text)] tap"
              style={{ borderColor: 'var(--line)' }}
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>

          <div
            className="flex items-center gap-2 rounded-xl border p-2"
            style={{ borderColor: 'var(--line)' }}
          >
            <button
              onClick={() => {
                setEditName(user.name);
                setEditRegion(user.region);
                setEditCarrier(user.carrier);
                setProfileOpen(true);
              }}
              className="flex items-center gap-2 min-w-0 flex-1 text-left"
            >
              <div className="w-8 h-8 rounded-full accent-gradient grid place-items-center text-[11px] font-bold shrink-0" style={{ color: 'var(--accent-contrast)' }}>
                {user.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold truncate">{user.name}</div>
                <div className="text-[10.5px] text-muted truncate">
                  {user.carrier} · {user.region}
                </div>
              </div>
            </button>
            <button
              onClick={onLogout}
              title="Выйти"
              className="p-1.5 rounded-lg text-muted hover:text-[rgb(var(--danger))] tap"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ==================== MOBILE TOP BAR ==================== */}
      <header
        className="lg:hidden sticky top-0 z-30 pt-safe"
        style={{ background: 'color-mix(in srgb, var(--bg) 88%, transparent)', borderColor: 'var(--line)', borderBottom: '1px solid var(--line)', backdropFilter: 'blur(18px)' }}
      >
        <div className="px-4 pb-2.5 flex items-center gap-3">
          <div className="relative w-9 h-9 rounded-xl grid place-items-center accent-gradient shrink-0">
            <Radar className="w-[18px] h-[18px]" style={{ color: 'var(--accent-contrast)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-extrabold text-[14.5px] leading-none tracking-tight">ПульсСети</div>
            <div className="text-[10.5px] text-muted mt-1 truncate flex items-center gap-1">
              {connection?.ip ? (
                <>
                  <span className="font-mono">{connection.country_code} · {connection.ip.slice(0, 15)}</span>
                </>
              ) : (
                'определяем сеть…'
              )}
            </div>
          </div>

          <button
            onClick={onRefreshConnection}
            disabled={connLoading}
            className="h-8 px-2.5 rounded-full text-[10.5px] font-bold border inline-flex items-center gap-1.5 tap shrink-0"
            style={{
              background: vpnOn ? 'rgb(var(--warning) / 0.12)' : 'rgb(var(--success) / 0.1)',
              borderColor: vpnOn ? 'rgb(var(--warning) / 0.32)' : 'rgb(var(--success) / 0.28)',
              color: vpnOn ? 'rgb(var(--warning))' : 'rgb(var(--success))',
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: vpnOn ? 'rgb(var(--warning))' : 'rgb(var(--success))' }}
            />
            {connLoading ? 'IP…' : vpnOn ? 'VPN' : 'БЕЗ VPN'}
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            className="w-8 h-8 rounded-xl border grid place-items-center text-dim tap shrink-0"
            style={{ borderColor: 'var(--line)' }}
            aria-label="Настройки"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* ==================== CONTENT ==================== */}
      <main className="flex-1 lg:pl-[17.5rem] pb-safe-page lg:pb-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-3">
          <UpdateCard darkMode={darkMode} showToast={showToast} />
        </div>

        {IS_DEMO_BUILD && demoBanner && !isNativeApp() && (
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mt-3">
            <Notice
              tone="warn"
              icon={<Info className="w-3.5 h-3.5" />}
              onClose={() => setDemoBanner(false)}
            >
              <strong className="font-bold">Веб-предпросмотр.</strong> Браузер не может читать
              содержимое сайтов — статусы здесь оценочные. Точные замеры — в приложении для Android.
            </Notice>
          </div>
        )}

        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4">{children}</div>
      </main>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        darkMode={darkMode}
        onToggleTheme={onToggleTheme}
        showToast={showToast}
      />

      {/* ==================== MOBILE TAB BAR ==================== */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t pb-safe"
        style={{
          background: 'color-mix(in srgb, var(--bg) 92%, transparent)',
          borderColor: 'var(--line)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <div className="grid grid-cols-5 px-1.5 pt-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`relative flex flex-col items-center justify-center gap-0.5 py-1 rounded-xl tap ${
                  isActive ? 'accent-text' : 'text-muted'
                }`}
              >
                <span
                  className="relative grid place-items-center w-11 h-7 rounded-full transition-colors"
                  style={{ background: isActive ? 'var(--accent-soft)' : 'transparent' }}
                >
                  <Icon className="w-[19px] h-[19px]" />
                  {item.dot && (
                    <span
                      className="absolute top-0 right-2 w-1.5 h-1.5 rounded-full ring-2"
                      style={{ background: 'rgb(var(--danger))', boxShadow: '0 0 0 2px var(--bg)' }}
                    />
                  )}
                </span>
                <span className="text-[10px] font-semibold leading-none">{item.mobileLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* ==================== PROFILE ==================== */}
      <Sheet
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Профиль"
        subtitle="Регион и оператор нужны, чтобы верно трактовать замер"
        icon={
          <div className="w-9 h-9 rounded-xl accent-gradient grid place-items-center text-[12px] font-bold" style={{ color: 'var(--accent-contrast)' }}>
            {user.name.slice(0, 2).toUpperCase()}
          </div>
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="md" block onClick={() => setProfileOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="md"
              block
              loading={savingProfile}
              icon={<Check className="w-4 h-4" />}
              onClick={() => {
                const form = document.getElementById('profile-form') as HTMLFormElement | null;
                form?.requestSubmit();
              }}
            >
              Сохранить
            </Button>
          </>
        }
      >
        <form id="profile-form" onSubmit={handleSaveProfile} className="space-y-3.5 pt-1">
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Имя</span>
            <input
              type="text"
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={field}
              style={fieldStyle}
            />
          </label>
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5 flex items-center gap-1.5">
              <Signal className="w-3.5 h-3.5" /> Оператор
            </span>
            <select
              value={editCarrier}
              onChange={(e) => setEditCarrier(e.target.value)}
              className={field}
              style={fieldStyle}
            >
              {RUSSIAN_CARRIERS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5" /> Регион
            </span>
            <select
              value={editRegion}
              onChange={(e) => setEditRegion(e.target.value)}
              className={field}
              style={fieldStyle}
            >
              {RUSSIAN_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={onLogout}
            className="w-full h-11 rounded-xl text-[13px] font-semibold tap inline-flex items-center justify-center gap-2"
            style={{
              background: 'rgb(var(--danger) / 0.1)',
              border: '1px solid rgb(var(--danger) / 0.3)',
              color: 'rgb(var(--danger))',
            }}
          >
            <LogOut className="w-4 h-4" /> Выйти из аккаунта
          </button>
        </form>
      </Sheet>
    </div>
  );
};
