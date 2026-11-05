import React, { useState } from 'react';
import { Radar, ShieldCheck, Wifi, Sparkles, Lock, Mail, User as UserIcon, MapPin, Smartphone } from 'lucide-react';
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
import { Button, Notice, Segmented } from './ui/kit';

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

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
  };
  const input =
    'w-full px-3.5 py-3 rounded-xl text-[13.5px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)] transition-shadow';

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
        showToast('success', 'Аккаунт создан — 75 сайтов уже в списке');
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
      const res = await apiFetch<AuthBootstrapPayload>('/api/auth/demo', { method: 'POST' });
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
    <div className="min-h-screen flex items-center justify-center px-4 py-8 relative overflow-hidden">
      {/* Мягкие световые пятна вместо тяжёлого градиента */}
      <div
        className="absolute -top-40 -left-28 w-[22rem] h-[22rem] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgb(var(--accent) / 0.20), transparent 70%)' }}
      />
      <div
        className="absolute -bottom-44 -right-24 w-[24rem] h-[24rem] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgb(var(--success) / 0.13), transparent 70%)' }}
      />

      <div className="w-full max-w-sm relative">
        <div className="flex items-center gap-3 justify-center mb-6">
          <div
            className="w-11 h-11 rounded-2xl grid place-items-center"
            style={{ background: 'var(--accent-soft)', color: 'rgb(var(--accent))' }}
          >
            <Radar className="w-6 h-6" />
          </div>
          <div>
            <div className="text-[18px] font-black tracking-tight leading-tight">ПульсСети</div>
            <div className="text-[11px] text-dim leading-tight">Белые списки, ТСПУ и VPN</div>
          </div>
        </div>

        <h1 className="text-center text-[19px] font-extrabold tracking-tight leading-snug">
          Глушат связь или включили
          <br />
          белые списки?
        </h1>
        <p className="text-center text-[12px] text-dim mt-1.5 leading-relaxed">
          Одна кнопка: проверяем 75 сайтов и VPN, показываем понятный итог.
        </p>

        {IS_DEMO_BUILD && (
          <div className="mt-4">
            <Notice tone="warn">
              Демо-режим: вход работает офлайн, проверки имитируются.
            </Notice>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <Button
            variant="primary"
            size="lg"
            block
            loading={demoLoading}
            icon={<Sparkles className="w-4 h-4" />}
            onClick={handleDemoLogin}
          >
            Войти в демо-аккаунт
          </Button>

          <div className="flex items-center gap-3 pt-1">
            <div className="h-px flex-1" style={{ background: 'var(--line)' }} />
            <span className="text-[10.5px] text-muted uppercase tracking-wider">или свой профиль</span>
            <div className="h-px flex-1" style={{ background: 'var(--line)' }} />
          </div>

          <Segmented<'login' | 'register'>
            value={mode}
            onChange={(v) => {
              setMode(v);
              if (v === 'register') {
                setEmail('');
                setPassword('');
              } else {
                setEmail('demo@pulsenet.ru');
                setPassword('demo1234');
              }
            }}
            options={[
              { value: 'login', label: 'Вход' },
              { value: 'register', label: 'Регистрация' },
            ]}
          />

          <form onSubmit={handleSubmit} className="space-y-2.5">
            {mode === 'register' && (
              <>
                <label className="block">
                  <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Имя или ник</span>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Иван Петров"
                      className={`${input} pl-9`}
                      style={inputStyle}
                    />
                  </div>
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Регион</span>
                    <div className="relative">
                      <MapPin className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <select
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                        className={`${input} pl-8 text-[12px]`}
                        style={inputStyle}
                      >
                        {RUSSIAN_REGIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                  <label className="block">
                    <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Оператор</span>
                    <select
                      value={carrier}
                      onChange={(e) => setCarrier(e.target.value)}
                      className={`${input} text-[12px]`}
                      style={inputStyle}
                    >
                      {RUSSIAN_CARRIERS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}

            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Email</span>
              <div className="relative">
                <Mail className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.ru"
                  autoComplete="email"
                  className={`${input} pl-9`}
                  style={inputStyle}
                />
              </div>
            </label>

            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Пароль</span>
              <div className="relative">
                <Lock className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className={`${input} pl-9`}
                  style={inputStyle}
                />
              </div>
            </label>

            <Button type="submit" variant="soft" size="lg" block loading={loading}>
              {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
            </Button>
          </form>

          {mode === 'login' && (
            <p className="text-center text-[10.5px] text-muted">
              Демо-доступ: <span className="font-mono text-dim">demo@pulsenet.ru</span> /{' '}
              <span className="font-mono text-dim">demo1234</span>
            </p>
          )}
        </div>

        <div className="mt-6 grid grid-cols-3 gap-1.5">
          {[
            { Icon: Wifi, text: 'Детектор белых списков' },
            { Icon: ShieldCheck, text: 'Контроль VPN' },
            { Icon: Smartphone, text: 'Удобно с телефона' },
          ].map(({ Icon, text }) => (
            <div
              key={text}
              className="rounded-xl border px-2 py-2 text-center"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              <Icon className="w-3.5 h-3.5 mx-auto mb-1" style={{ color: 'rgb(var(--accent))' }} />
              <div className="text-[9.5px] leading-tight text-dim">{text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
