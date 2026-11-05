import React, { useState } from 'react';
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
  X,
  Check,
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

  const navItems: Array<{
    id: NavTab;
    label: string;
    mobileLabel: string;
    icon: React.FC<{ className?: string }>;
    badge?: string;
    badgeTone?: string;
  }> = [
    {
      id: 'scanner',
      label: 'Проверка сети',
      mobileLabel: 'Проверка',
      icon: Radar,
      badge: 'РАДАР',
      badgeTone: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    },
    {
      id: 'sites',
      label: 'Каталог сайтов',
      mobileLabel: 'Сайты',
      icon: Globe,
      badge: String(counts.sites),
      badgeTone: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    },
    {
      id: 'vpn',
      label: 'Мониторинг VPN',
      mobileLabel: 'VPN',
      icon: Shield,
      badge: `${counts.vpnOnline}/${counts.vpnTotal}`,
      badgeTone:
        counts.vpnOnline > 0
          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
          : 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    },
    {
      id: 'incidents',
      label: 'Сбои и Белые списки',
      mobileLabel: 'Регионы',
      icon: AlertOctagon,
      badge: counts.activeIncidents > 0 ? String(counts.activeIncidents) : undefined,
      badgeTone: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    },
    {
      id: 'history',
      label: 'История замеров',
      mobileLabel: 'История',
      icon: History,
      badge: counts.scans > 0 ? String(counts.scans) : undefined,
      badgeTone: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    },
  ];

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await apiFetch<{ user: User }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          region: editRegion,
          carrier: editCarrier,
        }),
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

  return (
    <div
      className={`min-h-screen flex flex-col lg:flex-row transition-colors ${
        darkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'
      }`}
    >
      {/* ==================== DESKTOP SIDEBAR ==================== */}
      <aside
        className={`hidden lg:flex lg:w-72 lg:flex-col lg:fixed lg:inset-y-0 z-30 border-r ${
          darkMode
            ? 'bg-slate-900/75 border-slate-800/80 backdrop-blur-xl'
            : 'bg-white border-slate-200'
        }`}
      >
        {/* Brand */}
        <div className="p-5 flex items-center justify-between border-b border-slate-800/40 dark:border-slate-800/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/20 to-cyan-500/20 border border-sky-400/30 flex items-center justify-center relative">
              <Radar className="w-5 h-5 text-sky-400" />
              <span className="w-2 h-2 rounded-full bg-emerald-400 absolute -top-0.5 -right-0.5 animate-pulse" />
            </div>
            <div>
              <div className="font-bold text-base tracking-tight leading-none">ПульсСети</div>
              <div className="text-[11px] text-slate-400 mt-1">Анти-шатдаун & VPN Радар</div>
            </div>
          </div>
          <button
            onClick={onToggleTheme}
            title="Переключить тему"
            className={`p-2 rounded-lg border transition-colors ${
              darkMode
                ? 'border-slate-800 bg-slate-900 text-slate-400 hover:text-white'
                : 'border-slate-200 bg-slate-100 text-slate-600 hover:text-slate-900'
            }`}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>

        {/* Live Connection Telemetry Card */}
        <div className="px-4 pt-4">
          <div
            className={`p-3.5 rounded-2xl border transition-all ${
              connection?.vpn_detected
                ? darkMode
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-amber-50 border-amber-300'
                : darkMode
                ? 'bg-slate-950/70 border-slate-800'
                : 'bg-slate-100/80 border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${
                  connection?.vpn_detected
                    ? 'text-amber-500'
                    : 'text-emerald-500'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    connection?.vpn_detected ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                  }`}
                />
                {connLoading
                  ? 'Проверка IP...'
                  : connection?.vpn_detected
                  ? 'VPN включён'
                  : 'Прямая сеть'}
              </span>
              <button
                onClick={onRefreshConnection}
                disabled={connLoading}
                title="Обновить статус подключения"
                className="text-slate-400 hover:text-sky-400 transition-colors p-0.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${connLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="font-mono text-xs font-semibold truncate">
              {connection?.ip || 'Определение...'}
            </div>
            <div className="text-[11px] text-slate-400 truncate mt-0.5">
              {connection
                ? `${connection.country_name}${connection.city ? `, ${connection.city}` : ''} • ${connection.isp}`
                : 'Анализ маршрута...'}
            </div>
          </div>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? darkMode
                      ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30 shadow-sm'
                      : 'bg-sky-50 text-sky-700 border border-sky-200 shadow-sm'
                    : darkMode
                    ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 border border-transparent'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-sky-400' : ''}`} />
                  <span>{item.label}</span>
                </span>
                {item.badge && (
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${item.badgeTone}`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User Footer */}
        <div
          className={`p-4 border-t ${
            darkMode ? 'border-slate-800/80' : 'border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => {
                setEditName(user.name);
                setEditRegion(user.region);
                setEditCarrier(user.carrier);
                setProfileOpen(true);
              }}
              className="flex items-center gap-2.5 min-w-0 text-left group flex-1"
            >
              <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-500 text-white font-bold text-xs flex items-center justify-center shrink-0">
                {user.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate group-hover:text-sky-400 transition-colors flex items-center gap-1">
                  <span className="truncate">{user.name}</span>
                  <Settings className="w-3 h-3 opacity-50 shrink-0" />
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {user.carrier} • {user.region}
                </div>
              </div>
            </button>

            <button
              onClick={onLogout}
              title="Выйти / Сменить аккаунт"
              className={`p-2 rounded-lg border transition-colors ${
                darkMode
                  ? 'border-slate-800 hover:bg-rose-500/10 hover:border-rose-500/30 text-slate-400 hover:text-rose-400'
                  : 'border-slate-200 hover:bg-rose-50 text-slate-500 hover:text-rose-600'
              }`}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ==================== MOBILE TOP HEADER ==================== */}
      <header
        className={`lg:hidden sticky top-0 z-30 px-4 pb-3 pt-safe border-b backdrop-blur-xl flex items-center justify-between ${
          darkMode
            ? 'bg-slate-950/85 border-slate-800/80'
            : 'bg-white/90 border-slate-200'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center">
            <Radar className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <div className="font-bold text-sm leading-none">ПульсСети</div>
            <div className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[140px]">
              {connection?.ip ? `${connection.country_code} • ${connection.ip}` : 'Проверка сети РФ'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onRefreshConnection}
            className={`px-3 py-2 rounded-full text-[11px] font-semibold border flex items-center gap-1.5 active:scale-95 transition-transform ${
              connection?.vpn_detected
                ? 'bg-amber-500/15 border-amber-500/35 text-amber-400'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                connection?.vpn_detected ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
              }`}
            />
            {connLoading ? 'IP...' : connection?.vpn_detected ? 'VPN ВКЛ' : 'БЕЗ VPN'}
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            className={`p-2.5 rounded-xl border active:scale-95 transition-transform ${
              darkMode ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600'
            }`}
            aria-label="Настройки"
          >
            <Settings className="w-4 h-4" />
          </button>

          <button
            onClick={onToggleTheme}
            className={`p-2.5 rounded-xl border active:scale-95 transition-transform ${
              darkMode ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600'
            }`}
            aria-label="Тема"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            onClick={onLogout}
            className={`p-2.5 rounded-xl border active:scale-95 transition-transform ${
              darkMode ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600'
            }`}
            title="Выйти / Аккаунт"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* ==================== MAIN CONTENT ==================== */}
      <main className="flex-1 lg:pl-72 pb-24 lg:pb-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <UpdateCard darkMode={darkMode} showToast={showToast} />
        </div>

        {IS_DEMO_BUILD && demoBanner && !isNativeApp() && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-[11px] sm:text-xs leading-snug text-amber-200">
            <span className="shrink-0">🧪</span>
            <span className="flex-1">
              <strong className="font-bold">Автономный демо-режим.</strong> Данные хранятся локально,
              живые замеры сайтов имитируются «как при белых списках». Полная версия с реальными
              проверками — в предпросмотре сайта.
            </span>
            <button
              type="button"
              onClick={() => setDemoBanner(false)}
              className="shrink-0 rounded-lg px-1.5 py-0.5 text-amber-300/80 hover:bg-amber-500/20 hover:text-amber-100"
              aria-label="Скрыть"
            >
              ✕
            </button>
          </div>
        )}

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7">{children}</div>
      </main>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        darkMode={darkMode}
        onToggleTheme={onToggleTheme}
        showToast={showToast}
      />

      {/* ==================== MOBILE BOTTOM TAB BAR ==================== */}
      <nav
        className={`lg:hidden fixed bottom-0 inset-x-0 z-30 border-t backdrop-blur-xl pb-safe ${
          darkMode
            ? 'bg-slate-950/90 border-slate-800/90'
            : 'bg-white/95 border-slate-200'
        }`}
      >
        <div className="grid grid-cols-5 px-1 pt-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`flex flex-col items-center justify-center py-1.5 rounded-xl transition-colors relative ${
                  isActive
                    ? 'text-sky-400'
                    : darkMode
                    ? 'text-slate-400 hover:text-slate-200'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <div
                  className={`p-1 rounded-xl ${
                    item.id === 'scanner' && isActive ? 'bg-sky-500/15' : ''
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-semibold mt-0.5">{item.mobileLabel}</span>
                {item.id === 'incidents' && counts.activeIncidents > 0 && (
                  <span className="absolute top-1 right-3 w-2 h-2 rounded-full bg-rose-500" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* ==================== PROFILE EDIT MODAL ==================== */}
      {profileOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
              darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">Настройки профиля</h3>
              <button
                onClick={() => setProfileOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Имя / Никнейм</label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Домашний регион РФ</label>
                <select
                  value={editRegion}
                  onChange={(e) => setEditRegion(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                >
                  {RUSSIAN_REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Основной оператор</label>
                <select
                  value={editCarrier}
                  onChange={(e) => setEditCarrier(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                >
                  {RUSSIAN_CARRIERS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setProfileOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-slate-200"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
