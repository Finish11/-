import React, { useState } from 'react';
import {
  Radar,
  ShieldCheck,
  Wifi,
  ArrowRight,
  Sparkles,
  Lock,
  Mail,
  User as UserIcon,
  MapPin,
  Smartphone,
  Loader2,
} from 'lucide-react';
import {
  RUSSIAN_CARRIERS,
  RUSSIAN_REGIONS,
  type Incident,
  type ScanRecord,
  type Site,
  type User,
  type VpnProfile,
  type VpnSubscription,
} from '../types';
import { apiFetch, setStoredToken } from '../lib/api';
import { IS_DEMO_BUILD } from '../lib/scanner';

export interface AuthBootstrapPayload {
  user: User;
  token: string;
  sites?: Site[];
  scans?: ScanRecord[];
  profiles?: VpnProfile[];
  incidents?: Incident[];
  subscriptions?: VpnSubscription[];
}

interface AuthViewProps {
  onAuthenticated: (payload: AuthBootstrapPayload) => void;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({ onAuthenticated, showToast }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@pulsenet.ru');
  const [password, setPassword] = useState('demo1234');
  const [name, setName] = useState('');
  const [region, setRegion] = useState('Москва и МО');
  const [carrier, setCarrier] = useState('МТС');
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === 'login') {
        const res = await apiFetch<AuthBootstrapPayload>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        setStoredToken(res.token);
        showToast('success', `С возвращением, ${res.user.name}!`);
        onAuthenticated(res);
      } else {
        const res = await apiFetch<AuthBootstrapPayload>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password, name, region, carrier }),
        });
        setStoredToken(res.token);
        showToast('success', `Аккаунт создан! Загружено 75 сайтов для проверки.`);
        onAuthenticated(res);
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка авторизации');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = async () => {
    setDemoLoading(true);
    try {
      const res = await apiFetch<AuthBootstrapPayload>('/api/auth/demo', {
        method: 'POST',
      });
      setStoredToken(res.token);
      showToast('success', 'Вход в демо-аккаунт выполнен');
      onAuthenticated(res);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось войти в демо');
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col lg:flex-row relative">
      {IS_DEMO_BUILD && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,28rem)] rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-[11px] leading-snug text-amber-200 text-center">
          Автономный демо-режим: вход работает офлайн, проверки имитируются. Полная версия — в
          предпросмотре сайта.
        </div>
      )}
      {/* Left Hero Panel */}
      <div className="lg:w-1/2 p-6 sm:p-12 flex flex-col justify-between relative overflow-hidden border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950/30">
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-sky-500/10 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />

        <div className="relative z-10">
          <div className="inline-flex items-center gap-3 mb-8">
            <div className="w-11 h-11 rounded-2xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center shadow-lg shadow-sky-500/10">
              <Radar className="w-6 h-6 text-sky-400" />
            </div>
            <div>
              <span className="text-xl font-bold tracking-tight text-white">ПульсСети</span>
              <span className="block text-xs text-sky-400 font-medium">
                Мониторинг белых списков, ТСПУ и VPN
              </span>
            </div>
          </div>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white leading-tight mb-4">
            Проверьте за 3 секунды: <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-400">
              глушат связь или включили белые списки?
            </span>
          </h1>

          <p className="text-slate-400 text-base leading-relaxed max-w-xl mb-8">
            Нажмите одну кнопку на телефоне — приложение определит активный VPN, предложит проверить
            чистую сеть оператора или туннель, пропингует 75 российских и глобальных сайтов и вынесет
            точный вердикт.
          </p>

          <div className="grid sm:grid-cols-3 gap-3 max-w-xl">
            <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800/80">
              <Wifi className="w-5 h-5 text-rose-400 mb-2" />
              <div className="text-sm font-semibold text-white">Детектор Белых списков</div>
              <p className="text-xs text-slate-400 mt-1">
                Сравнивает доступность сайтов РФ с глобальными нейтральными CDN
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800/80">
              <ShieldCheck className="w-5 h-5 text-amber-400 mb-2" />
              <div className="text-sm font-semibold text-white">Умный контроль VPN</div>
              <p className="text-xs text-slate-400 mt-1">
                Распознаёт включённый VPN, утечки WebRTC и доступность ваших нод
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800/80">
              <Smartphone className="w-5 h-5 text-emerald-400 mb-2" />
              <div className="text-sm font-semibold text-white">Удобно с телефона</div>
              <p className="text-xs text-slate-400 mt-1">
                Проверка в 1 тап, история замеров и карта шатдаунов по регионам РФ
              </p>
            </div>
          </div>
        </div>

        <div className="relative z-10 mt-8 pt-6 border-t border-slate-800/60 hidden lg:flex items-center justify-between text-xs text-slate-500">
          <span>75 проверочных узлов в 6 категориях</span>
          <span>Локальные замеры из браузера + серверная проверка IP/ASN</span>
        </div>
      </div>

      {/* Right Auth Form Panel */}
      <div className="lg:w-1/2 p-6 sm:p-12 flex items-center justify-center">
        <div className="w-full max-w-md">
          <div className="mb-6">
            <button
              type="button"
              onClick={handleDemoLogin}
              disabled={demoLoading}
              className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-400 hover:to-cyan-400 text-slate-950 font-bold text-sm shadow-lg shadow-sky-500/20 flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
            >
              {demoLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              Быстрый вход в демо-аккаунт (Алексей Морозов)
            </button>
          </div>

          <div className="relative flex items-center justify-center my-6">
            <div className="border-t border-slate-800 w-full" />
            <span className="bg-slate-950 px-3 text-xs text-slate-500 uppercase tracking-wider whitespace-nowrap">
              или личный профиль
            </span>
            <div className="border-t border-slate-800 w-full" />
          </div>

          <div className="flex p-1 rounded-xl bg-slate-900 border border-slate-800 mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setEmail('demo@pulsenet.ru');
                setPassword('demo1234');
              }}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                mode === 'login'
                  ? 'bg-slate-800 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setEmail('');
                setPassword('');
              }}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                mode === 'register'
                  ? 'bg-slate-800 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Регистрация
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">
                    Ваше имя или ник
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Иван Петров"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Ваш регион
                    </label>
                    <div className="relative">
                      <MapPin className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <select
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                        className="w-full pl-9 pr-2 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-sky-500"
                      >
                        {RUSSIAN_REGIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Оператор связи
                    </label>
                    <select
                      value={carrier}
                      onChange={(e) => setCarrier(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-sky-500"
                    >
                      {RUSSIAN_CARRIERS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.ru"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Пароль</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-slate-100 hover:bg-white text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 transition-all"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <span>{mode === 'login' ? 'Войти в панель' : 'Создать аккаунт'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {mode === 'login' && (
            <p className="mt-4 text-center text-xs text-slate-500">
              Демо-доступ: <span className="text-slate-300 font-mono">demo@pulsenet.ru</span> /{' '}
              <span className="text-slate-300 font-mono">demo1234</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
